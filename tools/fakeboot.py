#!/usr/bin/env python3
"""A fake RT-950 Pro stock bootloader, for testing Firmware Update against the simulator (never a radio).

The bridge (`tools/bridge.py --tcp ... --fakeboot MODE.json`) switches to it once the simulator has accepted a link
REBOOT (LINK-24), and back to the simulator after END. It speaks the protocol of ferrite's analysis/bootloader.md:
frames `AA cmd seq(2) len(2) data CRC16-XMODEM(cmd..data) 55`, replies `AA cmd 00 result 00 00 crc crc 55`.
It checks every frame as the real one does (CRC, length, model tag, block order, the 0xFD000 limit) and keeps the
blocks; at END it writes what it got to MODE.json's `.result.json` sibling for the test to compare.

MODE.json (read at each REBOOT; missing = defaults): {"reboot": "ok" | "busy", "nak_block": N (once, E3),
"deaf_ms": 300 (probes ignored at first, as the radio saving before its reset)}.

The Install page's tests go further. An image holding the reader's mark (zero-key packed, so its text is plain) starts
[FakeReader], hwtest's console with `sys`, `flash`, `flashcrc`, `fdump` (fdump_proto.py's binary dump, ACK/NAK),
`mdump` (the MCU's flash: only the marker sector's 16 bytes, MODE.json's "marker" as 32 hex digits, erased when left
out; BACKUP-12) and `reboot` (back to a FakeBoot). Its chip is MODE.json's "flash" (a file; 4 MB), with "corrupt_every": N spoiling
every Nth dump frame once. A link `STOCK_RESTORE` START starts [FakeRestore] (the bridge answers it, not the
simulator): Ferrite's restore over the link (ferrite decision 261) on a chip made from "flash" with Ferrite's ranges
scrambled; its FINISH hands the cable to a FakeBoot. Every END appends to MODE.results.json; FakeRestore writes
MODE.restore.json.

    python3 tools/fakeboot.py selftest
"""
import hashlib
import json
import os
import random
import struct
import sys
import time
import zlib

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

    def image(self):
        return b"".join(self.blocks)

    def write_result(self):
        r = self.result()
        self.log(f"fakeboot: END after {r['blocks']} blocks, errors {r['errors']}")
        if self.result_path:
            with open(self.result_path, "w") as f:
                json.dump(r, f)
            many = self.result_path.replace(".result.json", ".results.json")
            try:
                with open(many) as f:
                    rs = json.load(f)
            except (OSError, ValueError):
                rs = []
            r["reader"] = READER_MARK in self.image()
            rs.append(r)
            with open(many, "w") as f:
                json.dump(rs, f)

    def after(self, mode_path):
        """What has the cable after END: the reader's console for the reader image, else None (the simulator)."""
        if READER_MARK in self.image():
            return FakeReader(read_mode(mode_path), self.log, mode_path, z=READER_Z_MARK in self.image())
        return None


READER_MARK = b"fdump <addr> <len>"
# The Rust reader's help line (ferrite decision 264): it has fdumpz (BACKUP-9.6); hwtest's reader doesn't.
READER_Z_MARK = b"fdumpz <addr> <len>"
ZCHUNK = 16384
Z_RAW, Z_ERASED, Z_DEFLATE = 0, 1, 4
FD_ACK, FD_NAK, FD_CAN = 0x06, 0x15, 0x18
CAL, UPDATE = (0xF000, 0x10000), (0x300000, 0x400000)
# Ferrite's layout::WRITABLE (the header to the contacts, the scratch ring).
WRITABLE = [(0x02C000, 0x076000), (0x1E0000, 0x200000)]


def load_flash(mode):
    try:
        with open(mode["flash"], "rb") as f:
            return bytearray(f.read())
    except (KeyError, OSError):
        b = bytearray(random.Random(5).randbytes(4 << 20))
        b[0x300000:0x300002] = b"\xff\xff"
        return b


def fd_frame(kind, addr, payload):
    h = b"FD" + kind + b"\x00" + struct.pack("<IH", addr, len(payload))
    return h + payload + struct.pack("<I", zlib.crc32(h + payload))


def zcode(chunk):
    """The Rust reader's fdumpz chunk (reader.rs zcode_into): erased, raw DEFLATE when it is shorter, else raw."""
    if chunk == b"\xff" * len(chunk):
        return bytes([Z_ERASED])
    c = zlib.compressobj(6, zlib.DEFLATED, -15)
    d = c.compress(chunk) + c.flush()
    return bytes([Z_DEFLATE]) + d if len(d) < len(chunk) - 1 else bytes([Z_RAW]) + chunk


class FakeReader:
    """hwtest's console and its fdump, fed bytes (no threads, no rates: the bridge's TCP has none); with `z` (the
    Rust reader's image), fdumpz too (BACKUP-9.6), unless MODE.json says "no_fdumpz" (answered `?`, as hwtest).
    "corrupt_every": N spoils every Nth frame once (NAKed); "cut_every": N sends every Nth frame once 100 bytes short
    (Console asks again once the frame's time is up)."""

    def __init__(self, mode, log=lambda *a: None, mode_path=None, z=False):
        self.mode, self.log, self.mode_path = mode, log, mode_path
        self.z = z and not mode.get("no_fdumpz")
        self.kinds = {}  # fdumpz: chunk modes sent, for the tests
        self.flash = bytes(load_flash(mode))
        self.line = b""
        self.reader_screen = False  # `reader`: Console asked for the plain screen
        self.dump = None  # (addr, len, next offset, frames sent, synced, end sent)
        self.dump_z = False
        self.sync = b""
        self.spoiled = set()
        self.next = None
        self.done = False
        self.frames = 0

    def console(self, text):
        return text.replace("\n", "\r\n").encode()

    def feed(self, data):
        if self.dump is not None:
            return self.fdump(data)
        out = b""
        for c in data:
            if c in (0x0D, 0x0A):
                out += self.console("\n") + self.command(self.line.decode("latin1").split()) + b"> "
                self.line = b""
                if self.dump is not None or self.next is not None:
                    return out
            else:
                self.line += bytes([c])
                out += bytes([c])  # the echo
        return out

    def command(self, w):
        if not w:
            return b""
        if w[0] == "sys":
            return self.console("v0.9  FreeRTOS 11  clock HEXT 8 MHz  reset cause 00  flash 1024 KB  uid 3F2A91C07D44012389ABCDEF\n")
        if w[0] == "flash":
            return self.console(f"flash id 5E4016 (Zbit, {len(self.flash) // 1024} KB) status 00 uid 0011223344556677\n")
        if w[0] == "reader":
            self.reader_screen = True
            return self.console("reader screen on\n")
        if w[0] == "flashcrc":
            return self.console(f"flash crc32 {zlib.crc32(self.flash):08X} over {len(self.flash) // 1024} KB, 1 s\n")
        if w[0] == "mdump" and len(w) >= 3:
            addr, n = int(w[1], 0), int(w[2], 0)
            if (addr, n) != (0x080F0000, 16):
                return self.console("mdump: the fake knows 0x080F0000 16 only\n")
            m = bytes.fromhex(read_mode(self.mode_path).get("marker", "FF" * 16))
            return self.console(f"80F0000:{m.hex().upper()}*{sum(m) & 0xFF:02X}\ndump: end\n")
        if w[0] == "reboot":
            self.log("fakereader: reboot into the bootloader")
            self.next = FakeBoot({"deaf_ms": 300, **read_mode(self.mode_path)}, result_path(self.mode_path), self.log)
            return b""
        if w[0] in ("fdump", "fdumpz") and len(w) >= 3:
            z = w[0] == "fdumpz"
            if z and not self.z:
                return self.console("?  (help)\n")
            addr, n = int(w[1], 0), int(w[2], 0)
            if addr + n > len(self.flash):
                return self.console("fdump: range outside the chip\n")
            self.dump = [addr, n, 0, False, False]
            self.dump_z = z
            self.sync = b""
            self.log(f"fakereader: {w[0]} {addr:06X}+{n:X}")
            rate = w[3] if len(w) > 3 else 230400 if z else 500000
            return self.console(f"fdump {addr:06X} {n:X} {rate} ready, clock 120 MHz\n")
        return self.console("?  (help)\n")

    def step(self):
        """The bytes one frame covers."""
        return ZCHUNK if self.dump_z else 4096

    def write_kinds(self):
        """MODE.dump.json: how the dump went (fdumpz or not, its chunk modes), for the tests."""
        if self.mode_path:
            with open(result_path(self.mode_path).replace(".result.json", ".dump.json"), "w") as f:
                json.dump({"z": self.dump_z, "kinds": {str(k): v for k, v in self.kinds.items()}}, f)

    def frame(self):
        addr, n, off, _, _ = self.dump
        if off >= n:
            end = struct.pack("<IIII", addr, n, zlib.crc32(self.flash[addr:addr + n]), 0)
            return fd_frame(b"E", addr, end)
        k = min(self.step(), n - off)
        chunk = self.flash[addr + off:addr + off + k]
        if self.dump_z:
            coded = zcode(chunk)
            self.kinds[coded[0]] = self.kinds.get(coded[0], 0) + 1
            f = bytearray(fd_frame(b"Z", addr + off, coded))
        else:
            f = bytearray(fd_frame(b"B", addr + off, chunk))
        self.frames += 1
        every, cut = self.mode.get("corrupt_every"), self.mode.get("cut_every")
        if every and self.frames % every == 0 and off not in self.spoiled:
            self.spoiled.add(off)
            f[len(f) // 2] ^= 0x40
        elif cut and self.frames % cut == 0 and len(f) > 200 and ("cut", off) not in self.spoiled:
            self.spoiled.add(("cut", off))
            del f[len(f) // 2:len(f) // 2 + 100]
        return bytes(f)

    def fdump(self, data):
        d = self.dump
        if not d[4]:  # waiting for FDS1
            self.sync = (self.sync + data)[-8:]
            if b"FDS1" in self.sync:
                d[4] = True
                return b"FDOK" + self.frame()
            return b""
        out = b""
        for c in data:
            if c == FD_CAN:
                self.dump = None
                return out + self.console("\nfdump stopped: cancelled\n> ")
            if c == FD_NAK:
                out += self.frame()
            elif c == FD_ACK:
                if d[2] >= d[1]:
                    crc = zlib.crc32(self.flash[d[0]:d[0] + d[1]])
                    self.dump = None
                    self.log(f"fakereader: fdump end (chunk modes {self.kinds})")
                    self.write_kinds()
                    return out + self.console(f"\nfdump end crc32 {crc:08X}, {d[1]} bytes, 0 resends\n> ")
                d[2] += min(self.step(), d[1] - d[2])
                out += self.frame()
        return out


def link_crc(data):
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
        out += b[i + 1:i + n]
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
            if len(block) == 254:
                out += b"\xff" + block
                block = bytearray()
    return bytes(out + bytes([len(block) + 1]) + block)


def link_frame(ty, seq, payload):
    body = bytes([ty, seq]) + payload
    return cobs_encode(body + struct.pack("<H", link_crc(body))) + b"\x00"


STOCK_RESTORE = 0x60


class FakeRestore:
    """Ferrite's side of STOCK_RESTORE after START: erase, program, CRC, FINISH, on a 4 MB chip whose Ferrite
    ranges were scrambled (as after using Ferrite). Anything that would touch calibration or the update area is
    recorded as an error and refused, as the radio's guard refuses it."""

    def __init__(self, mode, log=lambda *a: None, mode_path=None):
        self.mode, self.log, self.mode_path = mode, log, mode_path
        self.want = bytes(load_flash(mode))
        chip = bytearray(self.want)
        rng = random.Random(3)
        for s, e in WRITABLE:
            chip[s:e] = rng.randbytes(e - s)
        self.chip = chip
        self.buf = b""
        self.errors, self.erased, self.programmed, self.crcs = [], 0, 0, 0
        self.next = None
        self.done = False

    def start_answer(self, seq):
        cal = zlib.crc32(self.chip[CAL[0]:CAL[1]])
        rest = struct.pack("<IIB", len(self.chip), cal, len(WRITABLE))
        for s, e in WRITABLE:
            rest += struct.pack("<II", s, e)
        # The MCU's unique ID last (decision 263): the simulator's own (sim/src/fake.rs), as its INFO says, unless
        # the mode names another ("uid": 24 hex digits, the three words lowest first; "" for an older Ferrite).
        uid = self.mode.get("uid", "3F2A91C07D440E18A2B65C93")
        if uid:
            rest += struct.pack("<III", *(int(uid[8 * i:8 * i + 8], 16) for i in range(3)))
        return link_frame(STOCK_RESTORE | 0x80, seq, b"\x00" + rest)

    @staticmethod
    def allowed(addr, n):
        if any(addr < e and s < addr + n for s, e in (CAL, UPDATE)):
            return False
        return any(addr >= s and addr + n <= e for s, e in WRITABLE)

    def feed(self, data):
        self.buf += data
        *parts, self.buf = self.buf.split(b"\x00")
        out = b""
        for p in parts:
            body = cobs_decode(p) if p else None
            if not body or len(body) < 4 or link_crc(body[:-2]) != struct.unpack("<H", body[-2:])[0]:
                continue
            ty, seq, pl = body[0], body[1], body[2:-2]
            if ty != STOCK_RESTORE:
                out += link_frame(ty | 0x80, seq, b"\x07")
                continue
            out += link_frame(STOCK_RESTORE | 0x80, seq, self.serve(pl))
            if pl[:1] == b"\x04":
                self.write_result()
                self.next = FakeBoot({"deaf_ms": 300, **read_mode(self.mode_path)}, result_path(self.mode_path), self.log)
                break
        return out

    def serve(self, p):
        op = p[0] if p else 0xFF
        if op in (1, 2):
            addr = struct.unpack("<I", p[1:5])[0]
            n = 4096 if op == 1 else len(p) - 5
            if not self.allowed(addr, n):
                self.errors.append(f"{'erase' if op == 1 else 'program'} {addr:06X}+{n:X} refused")
                return b"\x04"
            if op == 1:
                self.chip[addr:addr + n] = b"\xff" * n
                self.erased += 1
            else:
                for i, b in enumerate(p[5:]):
                    self.chip[addr + i] &= b
                self.programmed += 1
            return b"\x00"
        if op == 3:
            addr, n = struct.unpack("<II", p[1:9])
            self.crcs += 1
            return b"\x00" + struct.pack("<I", zlib.crc32(self.chip[addr:addr + n]))
        if op == 4:
            return b"\x00"
        if op == 0:
            return b"\x00"  # START again: answered by the bridge's first one
        return b"\x03"

    def write_result(self):
        r = {"errors": self.errors, "erased": self.erased, "programmed": self.programmed, "crcs": self.crcs,
             "equal": bytes(self.chip) == self.want,
             "cal_untouched": self.chip[CAL[0]:CAL[1]] == self.want[CAL[0]:CAL[1]],
             "update_untouched": self.chip[UPDATE[0]:] == self.want[UPDATE[0]:]}
        self.log(f"fakerestore: FINISH {r}")
        if self.mode_path:
            with open(self.mode_path.replace(".json", ".restore.json"), "w") as f:
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
    # The reader: sys, flash, a dump with a spoiled frame NAKed and sent again, the end.
    rd = FakeReader({"corrupt_every": 2})
    assert b"uid 3F2A" in rd.feed(b"sys\r")
    assert b"4096 KB" in rd.feed(b"flash\r")
    assert b"ready" in rd.feed(b"fdump 0x0 0x2000 500000\r")
    f1 = rd.feed(b"FDS1")
    assert f1.startswith(b"FDOK")
    f2 = rd.feed(bytes([FD_ACK]))
    assert zlib.crc32(f2[:-4]) != struct.unpack("<I", f2[-4:])[0], "the second frame spoiled"
    f2 = rd.feed(bytes([FD_NAK]))
    assert zlib.crc32(f2[:-4]) == struct.unpack("<I", f2[-4:])[0], "sent again whole"
    end = rd.feed(bytes([FD_ACK]))
    assert end[2:3] == b"E"
    assert b"fdump end" in rd.feed(bytes([FD_ACK])) and rd.dump is None
    # fdumpz: erased, DEFLATE and raw chunks, a spoiled one NAKed; hwtest's reader answers `?`.
    flash = bytearray(random.Random(1).randbytes(3 * ZCHUNK))
    flash[:ZCHUNK] = b"\xff" * ZCHUNK
    flash[ZCHUNK:2 * ZCHUNK] = (b"Ferrite " * ZCHUNK)[:ZCHUNK]
    rz = FakeReader({"corrupt_every": 3}, z=True)
    rz.flash = bytes(flash)
    assert b"ready" in rz.feed(b"fdumpz 0x0 0xC000 230400\r")
    got, f = b"", rz.feed(b"FDS1")[4:]
    while f[2:3] == b"Z":
        if zlib.crc32(f[:-4]) != struct.unpack("<I", f[-4:])[0]:
            f = rz.feed(bytes([FD_NAK]))
            continue
        coded = f[10:-4]
        got += {Z_ERASED: lambda: b"\xff" * ZCHUNK, Z_RAW: lambda: coded[1:],
                Z_DEFLATE: lambda: zlib.decompress(coded[1:], -15)}[coded[0]]()
        f = rz.feed(bytes([FD_ACK]))
    assert got == flash and rz.kinds == {Z_ERASED: 1, Z_DEFLATE: 1, Z_RAW: 2}, rz.kinds  # the raw one twice: NAKed
    assert b"fdump end" in rz.feed(bytes([FD_ACK]))
    assert b"?  (help)" in FakeReader({}).feed(b"fdumpz 0x0 0x1000\r")
    # The restore: protected ranges refused and recorded.
    rs = FakeRestore({})
    assert rs.serve(b"\x01" + struct.pack("<I", 0xF000)) == b"\x04" and rs.errors
    assert rs.serve(b"\x01" + struct.pack("<I", 0x2C000)) == b"\x00" and rs.chip[0x2C000:0x2D000] == b"\xff" * 4096
    print("fakeboot selftest: all passed")


if __name__ == "__main__":
    if sys.argv[1:] == ["selftest"]:
        selftest()
    else:
        sys.exit(__doc__)
