#!/usr/bin/env python3
"""A fake RT-950 Pro stock bootloader, for testing Firmware Update against the simulator (never a radio).

The bridge (`tools/bridge.py --tcp ... --fakeboot MODE.json`) switches to it once the simulator has accepted a link
REBOOT (LINK-24), and back to the simulator after END. It speaks the protocol of ferrite's analysis/bootloader.md:
frames `AA cmd seq(2) len(2) data CRC16-XMODEM(cmd..data) 55`, replies `AA cmd 00 result 00 00 crc crc 55`.
It checks every frame as the real one does (CRC, length, model tag, block order, the 0xFD000 limit) and keeps the
blocks; at END it writes what it got to MODE.json's `.result.json` sibling for the test to compare.

MODE.json (read at each REBOOT; missing = defaults): {"reboot": "ok" | "busy", "nak_block": N (once, E3),
"deaf_ms": 300 (probes ignored at first, as the radio saving before its reset)}.

    python3 tools/fakeboot.py selftest
"""
import hashlib
import json
import os
import struct
import sys
import time

TAG = b"RT-950      "
LIMIT = 0xFD000
PROBE, HELLO, MODEL, COUNT, DATA, END = 0x42, 0x0A, 0x02, 0x04, 0x03, 0x45
ACK, E_FRAME, E_ORDER, E_WRITE, E_STATE, E_MODEL = 0x06, 0xE1, 0xE2, 0xE3, 0xE5, 0xE6


def crc16(data):
    c = 0
    for x in data:
        c ^= x << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    return c


def reply(cmd, result):
    body = bytes([cmd, 0, result, 0, 0])
    return b"\xAA" + body + struct.pack(">H", crc16(body)) + b"\x55"


def frame(cmd, seq=0, data=b""):
    body = bytes([cmd]) + struct.pack(">HH", seq, len(data)) + data
    return b"\xAA" + body + struct.pack(">H", crc16(body)) + b"\x55"


def read_mode(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return {}


class FakeBoot:
    """Bytes in, reply bytes out. `done` after END (the radio resets into the new image)."""

    def __init__(self, mode=None, result_path=None, log=lambda *a: None):
        self.mode = mode or {}
        self.result_path = result_path
        self.log = log
        self.buf = b""
        self.entered = False
        self.model = None
        self.count = None
        self.expected = 0
        self.blocks = []
        self.naked = False
        self.errors = []
        self.done = False
        self.deaf_until = time.monotonic() + self.mode.get("deaf_ms", 300) / 1000

    def feed(self, data):
        if time.monotonic() < self.deaf_until:
            return b""  # still the app saving, then the reset: nothing listens
        self.buf += data
        out = b""
        while True:
            i = self.buf.find(b"\xAA")
            if i < 0:
                self.buf = b""
                break
            self.buf = self.buf[i:]
            if len(self.buf) < 6:
                break
            cmd = self.buf[1]
            seq, n = struct.unpack(">HH", self.buf[2:6])
            if n > 1100:  # not a frame start
                self.buf = self.buf[1:]
                continue
            if len(self.buf) < 6 + n + 3:
                break
            f, self.buf = self.buf[: 9 + n], self.buf[9 + n :]
            if f[-1] != 0x55 or crc16(f[1 : 6 + n]) != struct.unpack(">H", f[6 + n : 8 + n])[0]:
                self.errors.append(f"bad frame (cmd {cmd:02X})")
                out += reply(cmd, E_FRAME)
                continue
            out += self.command(cmd, seq, f[6 : 6 + n])
        return out

    def command(self, cmd, seq, data):
        if cmd == PROBE:
            r = E_STATE if self.entered else ACK
            self.entered = True
            return reply(cmd, r)
        if not self.entered:
            return b""  # the app would be starting: nobody answers
        if cmd == HELLO:
            return reply(cmd, ACK)
        if cmd == MODEL:
            if data[:12] != TAG:
                return reply(cmd, E_MODEL)
            self.model = bytes(data)
            return reply(cmd, ACK)
        if cmd == COUNT:
            if self.model is None or len(data) < 2:
                return reply(cmd, E_STATE)
            self.count = struct.unpack(">H", data[:2])[0]
            self.expected, self.blocks = 0, []
            self.log(f"fakeboot: count {self.count}")
            return reply(cmd, ACK)
        if cmd == DATA:
            if self.count is None:
                return reply(cmd, E_STATE)
            if len(data) != 1024:
                self.errors.append(f"block {seq}: {len(data)} bytes")
                return reply(cmd, E_FRAME)
            if seq != self.expected or max(seq - 1, 0) * 0x400 >= LIMIT or seq > self.count + 1:
                self.errors.append(f"block {seq} out of order (expected {self.expected})")
                return reply(cmd, E_ORDER)
            if self.mode.get("nak_block") == seq and not self.naked:
                self.naked = True
                self.log(f"fakeboot: block {seq} refused (E3), as asked")
                return reply(cmd, E_WRITE)
            self.blocks.append(bytes(data))
            self.expected += 1
            return reply(cmd, ACK)
        if cmd == END:
            self.done = True
            self.write_result()
            return reply(cmd, ACK)
        return reply(cmd, E_STATE)

    def result(self):
        img = b"".join(self.blocks)
        errs = list(self.errors)
        if self.count is None or len(self.blocks) != self.count + 1:
            errs.append(f"{len(self.blocks)} blocks for count {self.count}")
        if img[0x3E0:0x3EC] != TAG:
            errs.append("no model tag at 0x3E0 of block 0")
        if self.model != img[0x3E0:0x400]:
            errs.append("the model frame isn't the file's 32 bytes at 0x3E0")
        if img[0xBE0:0xBEC] != TAG:
            errs.append("no model tag at image 0x7E0 (file 0xBE0)")
        return {"blocks": len(self.blocks), "count": self.count, "bytes": len(img),
                "sha256": hashlib.sha256(img).hexdigest(), "naked": self.naked, "errors": errs}

    def write_result(self):
        r = self.result()
        self.log(f"fakeboot: END after {r['blocks']} blocks, errors {r['errors']}")
        if self.result_path:
            with open(self.result_path, "w") as f:
                json.dump(r, f)


def result_path(mode_path):
    base, _ = os.path.splitext(mode_path)
    return base + ".result.json"


def selftest():
    blk = lambda i: bytes([i]) * 1024  # noqa: E731
    first = bytearray(blk(0))
    first[0x3E0:0x3EC] = TAG
    third = bytearray(blk(2))
    third[0x3E0:0x3EC] = TAG
    file = bytes(first) + blk(1) + bytes(third) + blk(3)
    fb = FakeBoot({"deaf_ms": 0, "nak_block": 2})
    assert fb.feed(frame(HELLO)) == b"", "deaf until the probe"
    assert fb.feed(frame(PROBE)) == reply(PROBE, ACK)
    assert fb.feed(frame(PROBE)) == reply(PROBE, E_STATE)
    bad = bytearray(frame(HELLO))
    bad[-2] ^= 1
    assert fb.feed(bytes(bad)) == reply(HELLO, E_FRAME)
    assert fb.feed(frame(MODEL, 0, b"XX" + TAG[2:] + bytes(20))) == reply(MODEL, E_MODEL)
    assert fb.feed(frame(MODEL, 0, file[0x3E0:0x400])) == reply(MODEL, ACK)
    assert fb.feed(frame(COUNT, 0, struct.pack(">H", 3))) == reply(COUNT, ACK)
    assert fb.feed(frame(DATA, 1, blk(1))) == reply(DATA, E_ORDER)
    assert fb.feed(frame(DATA, 0, file[:1024]) + frame(DATA, 1, file[1024:2048])) == reply(DATA, ACK) * 2
    assert fb.feed(frame(DATA, 2, file[2048:3072])) == reply(DATA, E_WRITE), "the NAK, once"
    assert fb.feed(frame(DATA, 2, file[2048:3072])) == reply(DATA, ACK)
    assert fb.feed(frame(DATA, 3, file[3072:])) == reply(DATA, ACK)
    whole = frame(END)
    assert fb.feed(whole[:4]) == b"" and fb.feed(whole[4:]) == reply(END, ACK)
    r = fb.result()
    assert fb.done and r["blocks"] == 4 and r["sha256"] == hashlib.sha256(file).hexdigest(), r
    assert r["errors"] == ["bad frame (cmd 0A)", "block 1 out of order (expected 0)"], r["errors"]
    print("fakeboot selftest: all passed")


if __name__ == "__main__":
    if sys.argv[1:] == ["selftest"]:
        selftest()
    else:
        sys.exit(__doc__)
