// src/lib/sstv.ts: the radio's SSTV picture slots (ferrite manual 27a, SSTV-4).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverRect,
  decodeHeader,
  encodeHeader,
  fromRgb565,
  modeName,
  nameOf,
  pixelsAddr,
  sendHeader,
  slotAddr,
  toRgb565,
  writePlan,
  type Header,
} from "../../src/lib/sstv.ts";

test("sstv: slot addresses (SSTV-4)", () => {
  assert.equal(slotAddr(0), 0x0c0000);
  assert.equal(slotAddr(1), 0x0e9000);
  assert.equal(slotAddr(5), 0x18d000);
  assert.equal(slotAddr(5) + 0x29000 - 1, 0x1b5fff);
  assert.equal(pixelsAddr(2), 0x112000 + 0x1000);
});

test("sstv: the header both ways, its bytes where SSTV-4.3 puts them", () => {
  const h: Header = { kind: 1, vis: 44, flags: 0xfe, width: 320, lines: 248, time: 1_800_000_000, freq: 14_580_000, name: "ISS", seq: 7 };
  const b = encodeHeader(h);
  assert.equal(b.length, 64);
  assert.deepEqual([...b.subarray(0, 12)], [0x53, 0x53, 0x54, 0x56, 1, 1, 44, 0xfe, 0x40, 0x01, 248, 0]);
  const d = new DataView(b.buffer);
  assert.equal(d.getUint32(12, true), 1_800_000_000);
  assert.equal(d.getUint32(16, true), 14_580_000);
  assert.deepEqual([...b.subarray(20, 24)], [0x49, 0x53, 0x53, 0]);
  assert.equal(d.getUint32(36, true), 7);
  assert.ok(b.subarray(40).every((x) => x === 0xff));
  assert.deepEqual(decodeHeader(b), h);
  assert.equal(modeName(44), "Martin M1");
  assert.equal(modeName(0), "");
});

test("sstv: an empty slot or another format has no header", () => {
  assert.equal(decodeHeader(new Uint8Array(64).fill(0xff)), null);
  const b = encodeHeader(sendHeader("x.png", 0));
  b[4] = 2;
  assert.equal(decodeHeader(b), null);
});

test("sstv: a picture to send's header: complete, 320 x 256, the name from the file", () => {
  const h = sendHeader("C:\\Pictures\\Field day at the park, 2026.jpeg", 1_800_000_000_500);
  assert.deepEqual(h, { kind: 2, vis: 0, flags: 0xfe, width: 320, lines: 256, time: 1_800_000_000, freq: 0, name: "Field day at the", seq: 0 });
  assert.equal(nameOf("/a/b/café.png"), "caf");
});

test("sstv: RGB565 both ways", () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0x12, 0x34, 0x56, 255]);
  const px = toRgb565(rgba);
  assert.deepEqual([...px.subarray(0, 10)], [0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0xff, 0xff, 0x00, 0x00]);
  const back = fromRgb565(px);
  assert.deepEqual([...back.subarray(0, 20)], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  // any colour comes back within the 565 steps, and stays put the second time
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[20 + i] - rgba[20 + i]) <= (i === 1 ? 3 : 7));
  assert.deepEqual(toRgb565(back), px);
});

test("sstv: cover crop to 320 x 256", () => {
  assert.deepEqual(coverRect(320, 256), { sx: 0, sy: 0, sw: 320, sh: 256 });
  assert.deepEqual(coverRect(1920, 1080), { sx: 285, sy: 0, sw: 1350, sh: 1080 }); // wide: the sides cut
  assert.deepEqual(coverRect(1000, 1000), { sx: 0, sy: 100, sw: 1000, sh: 800 }); // square: top and bottom
  assert.deepEqual(coverRect(600, 800), { sx: 0, sy: 160, sw: 600, sh: 480 }); // tall
});

test("sstv: the write: 41 erases, the pixels in aligned 64-byte programs, the header last", () => {
  const px = new Uint8Array(320 * 256 * 2).fill(0xff);
  px.fill(0x12, 0, 640); // the first row only; the rest stays erased and isn't sent
  const h = sendHeader("test.png", 0);
  const { body, header } = writePlan(1, px, h);
  const erases = body.filter((o) => o.what === "erase");
  assert.equal(erases.length, 41);
  assert.equal(erases[0].addr, slotAddr(1));
  assert.equal(erases[40].addr, slotAddr(1) + 40 * 4096);
  assert.deepEqual([...erases[0].payload], [0, 0x00, 0x90, 0x0e, 0x00]);
  const progs = body.filter((o) => o.what === "program");
  assert.equal(progs.length, 10);
  for (const p of progs) {
    assert.equal(p.payload[0], 1);
    assert.equal(p.addr % 64, 0);
    assert.equal(p.payload.length, 5 + 64);
  }
  assert.equal(progs[0].addr, pixelsAddr(1));
  assert.equal(header.length, 1);
  assert.equal(header[0].addr, slotAddr(1));
  assert.deepEqual(decodeHeader(header[0].payload.subarray(5)), h);
  assert.throws(() => writePlan(2, px, h));
  assert.throws(() => writePlan(0, px.subarray(1), h));
});
