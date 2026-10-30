// src/lib/zip.ts (NeonPlug's zip writer and reader): a round trip, stored and deflated entries, and damaged
// archives refused. Node's own CompressionStream does the deflate, as the browser's does in Console.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { crc32, createZip, readZip } from "../../src/lib/zip.ts";

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

test("round trip: names, text, binary, an empty entry", async () => {
  const big = JSON.stringify({ channels: Array.from({ length: 200 }, (_, i) => ({ number: i + 1, name: `Channel ${i}` })) });
  const bin = new Uint8Array([0, 1, 2, 250, 255]);
  const zip = await bytes(await createZip([
    { name: "manifest.json", data: '{"a":1}' },
    { name: "parts/big.json", data: big },
    { name: "bin", data: bin },
    { name: "empty", data: "" },
    { name: "naïve ✓.txt", data: "UTF-8 name" },
  ]));
  const files = await readZip(zip);
  assert.deepEqual([...files.keys()], ["manifest.json", "parts/big.json", "bin", "empty", "naïve ✓.txt"]);
  assert.equal(text(files.get("manifest.json")), '{"a":1}');
  assert.equal(text(files.get("parts/big.json")), big);
  assert.deepEqual(files.get("bin"), bin);
  assert.equal(files.get("empty")!.length, 0);
  assert.equal(text(files.get("naïve ✓.txt")), "UTF-8 name");
  // The big entry deflated (method 8), the tiny ones stored (method 0).
  assert.ok(zip.length < big.length / 2, `${zip.length} bytes`);
});

test("crc32: the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("reads another writer's archive (a trailing comment, deflate from zlib)", async () => {
  // One entry written by hand as another tool would, with a 5-byte archive comment after the end record.
  const enc = new TextEncoder();
  const name = enc.encode("a.txt");
  const raw = enc.encode("hello hello hello hello");
  const comp = deflateRawSync(raw);
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(14, crc32(raw), true);
  lv.setUint32(18, comp.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc32(raw), true);
  cv.setUint32(20, comp.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, name.length, true);
  central.set(name, 46);
  const end = new Uint8Array(22 + 5);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + comp.length, true);
  ev.setUint16(20, 5, true);
  end.set(enc.encode("notes"), 22);
  const zip = new Uint8Array([...local, ...comp, ...central, ...end]);
  assert.equal(text((await readZip(zip)).get("a.txt")), "hello hello hello hello");
});

test("a damaged archive is refused", async () => {
  const zip = await bytes(await createZip([{ name: "x.json", data: "x".repeat(1000) + "y".repeat(1000) }]));
  // A byte of the deflated data changed: the CRC (or the inflate) catches it.
  const flipped = zip.slice();
  flipped[40] ^= 0xff;
  await assert.rejects(readZip(flipped), /Corrupt ZIP/);
  // Cut short: no end record.
  await assert.rejects(readZip(zip.slice(0, zip.length - 10)), /Not a ZIP archive/);
  // The central directory's offset pointing past the end.
  const bad = zip.slice();
  new DataView(bad.buffer).setUint32(bad.length - 22 + 16, 1 << 30, true);
  await assert.rejects(readZip(bad), /Corrupt ZIP/);
  // Not a zip at all.
  await assert.rejects(readZip(new TextEncoder().encode('{"format":"ferrite-console-channels"}')), /Not a ZIP archive/);
  // An unsupported method (as bzip2's 12).
  const m12 = zip.slice();
  const eocd = m12.length - 22;
  const cd = new DataView(m12.buffer).getUint32(eocd + 16, true);
  new DataView(m12.buffer).setUint16(cd + 10, 12, true);
  await assert.rejects(readZip(m12), /Unsupported ZIP compression method 12/);
});
