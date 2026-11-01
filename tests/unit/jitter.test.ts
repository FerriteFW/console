// src/lib/jitter.ts: Listen's jitter buffer (LINK-13.5, decision 331), the same source the AudioWorklet runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JITTER } from "../../src/lib/jitter.ts";

type J = {
  push(s: Float32Array): void;
  pull(o: Float32Array): void;
  n: number;
  playing: boolean;
  underruns: number;
  gaps: number;
};
const Jitter = new Function(`${JITTER}; return Jitter;`)() as new (rate: number, outRate: number, start: number, cap: number, stop: number) => J;

// 12 kHz in, 12 kHz out (step 1) so counts read as samples; 16 ms blocks of 192; start 250 ms, cap 750, stop 500.
const block = (v = 0.5) => new Float32Array(192).fill(v);
const make = () => new Jitter(12_000, 12_000, 3_000, 9_000, 6_000);
const pull = (j: J, k: number) => {
  const o = new Float32Array(k);
  j.pull(o);
  return o;
};

test("jitter: silent until 250 ms waits, then plays", () => {
  const j = make();
  for (let i = 0; i < 15; i++) j.push(block());
  assert.ok(pull(j, 128).every((x) => x === 0), "2880 of 3000: not yet");
  assert.equal(j.playing, false);
  j.push(block());
  assert.ok(pull(j, 128).every((x) => x === 0.5));
  assert.equal(j.playing, true);
});

test("jitter: a lost block is a short silence, and the next plays at once without refilling", () => {
  const j = make();
  for (let i = 0; i < 16; i++) j.push(block());
  pull(j, 192 * 16 - 1); // drained to the last sample
  const gap = pull(j, 192); // the lost block's time
  assert.equal(j.underruns, 1);
  assert.ok(gap.every((x) => Math.abs(x) <= 0.5) && Math.abs(gap[191]) < 0.2, "faded towards silence");
  assert.equal(j.playing, true, "still playing: no re-buffering");
  j.push(block(0.25));
  const next = pull(j, 64);
  assert.ok(next.slice(8).every((x) => x === 0.25), "the next block plays straight away");
  assert.equal(j.gaps, 1, "a short gap played through: Listen's health counts it");
});

test("jitter: a real stop (500 ms dry) waits for 250 ms again", () => {
  const j = make();
  for (let i = 0; i < 16; i++) j.push(block());
  pull(j, 192 * 16 + 6_000);
  assert.equal(j.playing, false);
  j.push(block());
  assert.ok(pull(j, 64).every((x) => Math.abs(x) < 1e-6), "refilling: silence");
  for (let i = 0; i < 16; i++) j.push(block());
  pull(j, 64);
  assert.equal(j.gaps, 0, "a real stop (the squelch closed) isn't a gap");
});

test("jitter: never more than the cap; an overflow drops back to the start level", () => {
  const j = make();
  for (let i = 0; i < 60; i++) j.push(block());
  assert.ok(j.n <= 9_000 && j.n >= 3_000, `${j.n} waiting`);
});
