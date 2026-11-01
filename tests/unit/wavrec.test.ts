// src/lib/wavrec.ts: Listen's recorder (12 kHz 16-bit mono WAV, gaps as silence so it keeps time).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, size, WavRecorder, wavHeader, wavName } from "../../src/lib/wavrec.ts";

const block = (v = 1000, n = 192) => new Int16Array(n).fill(v);

test("wav header: RIFF, PCM mono 16-bit at the rate, sizes", () => {
  const h = wavHeader(12_000, 100);
  const v = new DataView(h.buffer);
  assert.equal(String.fromCharCode(...h.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...h.subarray(8, 16)), "WAVEfmt ");
  assert.equal(v.getUint32(4, true), 236);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 12_000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 200);
});

test("recorder: blocks in time are written as they come; small jitter adds nothing", () => {
  const r = new WavRecorder(12_000, 0);
  for (let i = 0; i < 50; i++) r.push(block(), i * 16 + (i % 3) * 20); // 16 ms blocks, up to 40 ms late
  assert.equal(r.samples, 50 * 192);
});

test("recorder: a gap is silence, so a second recorded lasts a second", async () => {
  const r = new WavRecorder(12_000, 0);
  r.push(block(), 16);
  r.push(block(), 1016); // nothing for a second (the squelch closed)
  assert.ok(Math.abs(r.samples - 12_192) <= 192, `${r.samples}`);
  const wav = new Uint8Array(await r.finish(3000).arrayBuffer());
  const samples = (wav.length - 44) / 2;
  assert.equal(samples, 36_000, "quiet to the end: padded to the clock");
  const v = new DataView(wav.buffer);
  assert.equal(v.getInt16(44, true), 1000);
  assert.equal(v.getInt16(44 + 400 * 2, true), 0, "the gap");
  assert.equal(r.bytes, wav.length);
});

test("names and labels", () => {
  assert.equal(wavName(new Date(2026, 9, 31, 14, 32)), "listen-2026-10-31-1432.wav");
  assert.equal(clock(42_500), "0:42");
  assert.equal(clock(3_600_000), "1:00:00");
  assert.equal(size(1_400_000), "1.4 MB");
  assert.equal(size(820_000), "820 kB");
});
