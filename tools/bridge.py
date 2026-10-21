#!/usr/bin/env python3
"""Ferrite Console's development bridge: a local WebSocket that relays the link's raw bytes to a serial port or to
the simulator's TCP cable, so scripts (and a browser that was never shown a port chooser) can drive Console.

    tools/bridge.py --tcp 127.0.0.1:7300                 # the simulator (ferrite-sim --term-headless N --term-tcp 7300)
    tools/bridge.py --serial /dev/cu.usbserial-114220    # the radio's cable, 115200 8N1 to start

Then open Console with `?bridge` (http://localhost:1420/?bridge) and press Bridge.

The WebSocket (ws://127.0.0.1:8765 by default, 127.0.0.1 only):
- binary frames are the link's bytes, both ways, as they are;
- text frames are JSON control messages. The bridge sends {"bridge": 1, "target": "serial"|"tcp", "name": ...,
  "baud": 115200} on connect. Console sends {"baud": N} for the link's BAUD (LINK-11); the bridge sets the serial
  port's rate (after the bytes before it are out) and answers {"baud": N, "ok": true} ("ignored": true on TCP,
  which has no rate).
- One client at a time; another is refused while one is connected. Only pages from localhost or 127.0.0.1 (or
  clients that send no Origin, such as scripts) may connect, so no web page you happen to visit can drive the radio.

With `--fakeboot MODE.json` (the simulator only): once the simulator accepts a link REBOOT (LINK-24), the bytes go
to a fake stock bootloader (tools/fakeboot.py) instead, until its END; then back to the simulator, which restarted
meanwhile. The e2e tests run Firmware Update that way. MODE.json says how it behaves (see fakeboot.py).

Python 3 standard library only, plus pyserial for --serial.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import os
import struct
import sys
import threading
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fakeboot  # noqa: E402

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OK_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}


def log(*a):
    print("bridge:", *a, file=sys.stderr, flush=True)


class WsClosed(Exception):
    pass


class Ws:
    """The server side of one WebSocket (RFC 6455): enough for binary and text frames, ping and close."""

    def __init__(self, r, w):
        self.r, self.w = r, w
        self.lock = asyncio.Lock()

    async def send(self, op, data: bytes):
        n = len(data)
        head = bytes([0x80 | op])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        async with self.lock:
            self.w.write(head + data)
            await self.w.drain()

    async def send_json(self, obj):
        await self.send(1, json.dumps(obj).encode())

    async def recv(self):
        """The next message: (opcode, bytes); 1 text, 2 binary. Pings answered here."""
        parts, first = [], None
        while True:
            try:
                b0, b1 = await self.r.readexactly(2)
                n = b1 & 0x7F
                if n == 126:
                    (n,) = struct.unpack(">H", await self.r.readexactly(2))
                elif n == 127:
                    (n,) = struct.unpack(">Q", await self.r.readexactly(8))
                mask = await self.r.readexactly(4) if b1 & 0x80 else b"\0\0\0\0"
                data = bytearray(await self.r.readexactly(n))
            except (asyncio.IncompleteReadError, ConnectionError):
                raise WsClosed()
            for i in range(n):
                data[i] ^= mask[i & 3]
            op = b0 & 0x0F
            if op == 8:
                try:
                    await self.send(8, bytes(data[:2]))
                except ConnectionError:
                    pass
                raise WsClosed()
            if op == 9:
                await self.send(10, bytes(data))
                continue
            if op == 10:
                continue
            if op != 0:
                first = op
            parts.append(bytes(data))
            if b0 & 0x80:
                return first, b"".join(parts)


async def handshake(r, w, allow_origins):
    """Reads the HTTP upgrade; answers 101, or 403/400. Returns True when it is a WebSocket now."""
    try:
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 5)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        return False
    lines = head.decode("latin-1").split("\r\n")
    hdr = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            hdr[k.strip().lower()] = v.strip()
    origin = hdr.get("origin")
    if origin and origin not in allow_origins and urlparse(origin).hostname not in OK_HOSTS:
        log(f"refused a page from {origin} (only localhost pages; --allow-origin for others)")
        w.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        await w.drain()
        return False
    key = hdr.get("sec-websocket-key")
    if not key or "websocket" not in hdr.get("upgrade", "").lower():
        body = b"Ferrite Console bridge: connect with a WebSocket.\n"
        w.write(b"HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
        await w.drain()
        return False
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    w.write(
        (
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode()
    )
    await w.drain()
    return True


class SerialTarget:
    """The cable: pyserial, read on a thread (pyserial has no asyncio)."""

    kind = "serial"

    def __init__(self, path, baud):
        self.path, self.baud = path, baud

    async def open(self, on_data, on_close):
        import serial  # pyserial: only needed here

        loop = asyncio.get_running_loop()
        self.ser = serial.Serial(self.path, self.baud, bytesize=8, parity="N", stopbits=1, timeout=0.05)
        self.stop = False

        def reader():
            try:
                while not self.stop:
                    b = self.ser.read(4096)
                    if b:
                        loop.call_soon_threadsafe(on_data, b)
            except Exception as e:  # unplugged
                if not self.stop:
                    loop.call_soon_threadsafe(on_close, f"serial: {e}")

        self.thread = threading.Thread(target=reader, daemon=True)
        self.thread.start()

    @property
    def name(self):
        return self.path

    async def write(self, b):
        await asyncio.to_thread(self.ser.write, b)

    async def set_baud(self, rate):
        def apply():
            self.ser.flush()  # the bytes before (the BAUD request's answer has been read; this is the write side)
            self.ser.baudrate = rate

        await asyncio.to_thread(apply)
        self.baud = rate
        return {"baud": rate, "ok": True}

    async def close(self):
        self.stop = True
        await asyncio.to_thread(self.thread.join, 1)
        try:
            self.ser.close()
        except Exception:
            pass


class TcpTarget:
    """The simulator's cable (ferrite-sim --term-tcp PORT): bytes as they are; the rate means nothing."""

    kind = "tcp"

    def __init__(self, host, port):
        self.host, self.port = host, port
        self.baud = 115200

    @property
    def name(self):
        return f"{self.host}:{self.port}"

    async def open(self, on_data, on_close):
        self.r, self.w = await asyncio.open_connection(self.host, self.port)

        async def reader():
            try:
                while True:
                    b = await self.r.read(4096)
                    if not b:
                        break
                    on_data(b)
            except (ConnectionError, asyncio.CancelledError):
                pass
            on_close("tcp: the other side closed")

        self.task = asyncio.create_task(reader())

    async def write(self, b):
        self.w.write(b)
        await self.w.drain()

    async def set_baud(self, rate):
        self.baud = rate
        return {"baud": rate, "ok": True, "ignored": True}

    async def close(self):
        self.task.cancel()
        self.w.close()


REBOOT = 0x21


def link_crc(data):
    """CRC-16/CCITT-FALSE, the link's."""
    c = 0xFFFF
    for x in data:
        c ^= x << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    return c


def cobs_decode(b):
    out, i = bytearray(), 0
    while i < len(b):
        n = b[i]
        if n == 0 or i + n > len(b):
            return None
        out += b[i + 1 : i + n]
        i += n
        if n < 0xFF and i < len(b):
            out.append(0)
    return bytes(out)


def cobs_encode(b):
    out, block = bytearray(), bytearray()
    for x in b:
        if x == 0:
            out += bytes([len(block) + 1]) + block
            block = bytearray()
        else:
            block.append(x)
    return bytes(out + bytes([len(block) + 1]) + block)


def link_answer(ty, seq, status):
    body = bytes([ty | 0x80, seq, status])
    return cobs_encode(body + struct.pack("<H", link_crc(body))) + b"\x00"


class LinkFrames:
    """Link frames (COBS between 0x00s, CRC last) in a byte stream, as (type, seq, payload)."""

    def __init__(self):
        self.buf = b""

    def feed(self, data):
        self.buf += data
        *parts, self.buf = self.buf.split(b"\x00")
        out = []
        for p in parts:
            body = cobs_decode(p) if p else None
            if body and len(body) >= 4 and link_crc(body[:-2]) == struct.unpack("<H", body[-2:])[0]:
                out.append((body[0], body[1], body[2:-2]))
        return out


class Bridge:
    def __init__(self, make_target, allow_origins, verbose, fakeboot_mode=None):
        self.make_target = make_target
        self.allow_origins = set(allow_origins)
        self.verbose = verbose
        self.fakeboot_mode = fakeboot_mode
        self.boot = None
        self.busy = False

    async def client(self, r, w):
        peer = w.get_extra_info("peername")
        try:
            if not await handshake(r, w, self.allow_origins):
                return
            ws = Ws(r, w)
            if self.busy:
                log(f"refused {peer}: a client is connected already")
                await ws.send(8, struct.pack(">H", 1013) + b"busy: one client at a time")
                return
            self.busy = True
            try:
                await self.relay(ws, peer)
            finally:
                self.busy = False
        except ConnectionError:
            pass
        finally:
            w.close()

    async def relay(self, ws, peer):
        target = self.make_target()
        gone = asyncio.get_running_loop().create_future()
        # --fakeboot: REBOOT requests seen (seq) and the simulator's answers watched. The fake bootloader itself is
        # the bridge's (self.boot): it stays across clients, as a radio stays in its bootloader when the cable reopens.
        sent, heard, pending = LinkFrames(), LinkFrames(), set()

        def on_data(b):
            if self.boot is not None:
                return  # the simulator restarting meanwhile: the cable belongs to the bootloader
            if self.verbose:
                log(f"<- {b.hex(' ')}")
            asyncio.ensure_future(ws.send(2, b))
            if self.fakeboot_mode and pending:
                for ty, seq, payload in heard.feed(b):
                    if ty == REBOOT | 0x80 and seq in pending and payload[:1] == b"\x00":
                        mode = fakeboot.read_mode(self.fakeboot_mode)
                        self.boot = fakeboot.FakeBoot(mode, fakeboot.result_path(self.fakeboot_mode), log)
                        pending.clear()
                        log(f"fakeboot: REBOOT accepted; the fake bootloader has the cable ({mode})")

        async def to_boot(data):
            boot = self.boot
            out = boot.feed(data)
            if out:
                await ws.send(2, out)
            if boot.done:
                await asyncio.sleep(0.2)  # the reset; the simulator restarted at REBOOT and runs on
                self.boot = None
                heard.buf = b""
                log("fakeboot: END; the cable is the simulator's again")

        def on_close(why):
            if not gone.done():
                gone.set_result(why)

        try:
            await target.open(on_data, on_close)
        except Exception as e:
            log(f"couldn't open {target.name}: {e}")
            await ws.send_json({"error": f"couldn't open {target.name}: {e}"})
            await ws.send(8, struct.pack(">H", 1011))
            return
        log(f"{peer} connected; relaying to {target.kind} {target.name}")
        await ws.send_json({"bridge": 1, "target": target.kind, "name": target.name, "baud": target.baud})

        async def from_ws():
            while True:
                op, data = await ws.recv()
                if op == 2:
                    if self.verbose:
                        log(f"-> {data.hex(' ')}")
                    if self.boot is not None:
                        await to_boot(data)
                        continue
                    if self.fakeboot_mode:
                        reboots = [seq for ty, seq, _ in sent.feed(data) if ty == REBOOT]
                        if reboots and fakeboot.read_mode(self.fakeboot_mode).get("reboot") == "busy":
                            log("fakeboot: REBOOT answered busy, as asked (the radio transmitting)")
                            await ws.send(2, link_answer(REBOOT, reboots[-1], 7))
                            continue
                        pending.update(reboots)
                    await target.write(data)
                elif op == 1:
                    try:
                        msg = json.loads(data)
                    except ValueError:
                        await ws.send_json({"error": "not JSON"})
                        continue
                    if "baud" in msg:
                        rate = int(msg["baud"])
                        try:
                            ans = await target.set_baud(rate)
                        except Exception as e:
                            ans = {"baud": rate, "ok": False, "error": str(e)}
                        log(f"rate {rate}: {ans}")
                        await ws.send_json(ans)
                    else:
                        await ws.send_json({"error": "unknown control message"})

        task = asyncio.create_task(from_ws())
        done, _ = await asyncio.wait({task, gone}, return_when=asyncio.FIRST_COMPLETED)
        if gone in done:
            log(f"{target.name} went away: {gone.result()}")
            try:
                await ws.send_json({"closed": gone.result()})
                await ws.send(8, struct.pack(">H", 1011))
            except ConnectionError:
                pass
        task.cancel()
        await target.close()
        log(f"{peer} disconnected")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--serial", metavar="PORT", help="a serial port, e.g. /dev/cu.usbserial-114220 (115200 8N1)")
    g.add_argument("--tcp", metavar="HOST:PORT", help="the simulator's cable, e.g. 127.0.0.1:7300")
    ap.add_argument("--port", type=int, default=8765, help="the WebSocket's port on 127.0.0.1 (default 8765)")
    ap.add_argument("--baud", type=int, default=115200, help="the serial rate to start at (default 115200)")
    ap.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                    help="also allow pages from this origin (e.g. https://console.ferritefw.dev)")
    ap.add_argument("-v", "--verbose", action="store_true", help="log every byte")
    ap.add_argument("--fakeboot", metavar="MODE.json",
                    help="the simulator only: a fake bootloader takes the cable after REBOOT (tools/fakeboot.py)")
    a = ap.parse_args()
    if a.fakeboot and a.serial:
        ap.error("--fakeboot is for the simulator (--tcp) only: a radio has its own bootloader")
    if a.serial:
        make = lambda: SerialTarget(a.serial, a.baud)  # noqa: E731
    else:
        host, _, port = a.tcp.rpartition(":")
        make = lambda: TcpTarget(host or "127.0.0.1", int(port))  # noqa: E731
    bridge = Bridge(make, a.allow_origin, a.verbose, a.fakeboot)

    async def serve():
        server = await asyncio.start_server(bridge.client, "127.0.0.1", a.port)
        log(f"ws://127.0.0.1:{a.port} -> {'serial ' + a.serial if a.serial else 'tcp ' + a.tcp}")
        async with server:
            await server.serve_forever()

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
