// src/lib/linkbits.ts: the link's answer timer (issue #92), a retried stream's late frames (issue #95, item 2) and
// the BT module's `!!!!` (issue #95, item 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { STREAM_RETRY_SKIP, UnlockStrip, answerTimer, streamFate } from "../../src/lib/linkbits.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A transport whose writes wait in a queue `ms` each (the desktop shell's, a paced BLE write). */
function slowTransport(ms: number) {
  let queue: Promise<void> = Promise.resolve();
  return {
    write() {
      const r = queue.then(() => sleep(ms));
      queue = r;
      return r;
    },
  };
}

test("answerTimer: the time-out starts once the write is done, so a queued write doesn't eat it", async () => {
  const t = slowTransport(60);
  let answer: (a: string | null) => void = () => {};
  const { got, arm } = answerTimer<string>((resolve) => (answer = resolve));
  await t.write(); // a write before it in the queue
  await t.write(); // this request's own
  arm(50);
  setTimeout(() => answer("ok"), 30); // 150 ms after the request was made: past a timer armed before the write
  assert.equal(await got, "ok");
});

test("answerTimer: no answer resolves null after the time-out", async () => {
  const { got, arm } = answerTimer<string>(() => {});
  arm(10);
  assert.equal(await got, null);
});

test("streamFate: next, a gap ahead, and a late frame of the stream before", () => {
  assert.equal(streamFate(10, 10, 0), "next");
  assert.equal(streamFate(12, 10, 2), "next");
  assert.equal(streamFate(13, 10, 2), "gap");
  assert.equal(streamFate(0, 250, 6), "next", "wraps");
  // a stream from seq 10 lost its 3rd frame; the retry starts past STREAM_RETRY_SKIP (and the resync's HELLO)
  const old = 10;
  const retry = (old + 2 + STREAM_RETRY_SKIP + 1) % 256;
  for (let j = 0; j < 30; j++) assert.equal(streamFate((old + j) % 256, retry, 0), "stray", `old frame ${j}`);
  for (let j = 0; j < 30; j++) assert.equal(streamFate((old + j) % 256, retry, 5), "stray", `old frame ${j} mid-stream`);
  assert.equal(streamFate(retry, retry, 0), "next");
  // the same near the wrap
  const old2 = 230;
  const retry2 = (old2 + 2 + STREAM_RETRY_SKIP + 1) % 256;
  for (let j = 0; j < 30; j++) assert.equal(streamFate((old2 + j) % 256, retry2, 0), "stray");
});

const b = (s: string) => new TextEncoder().encode(s);
const s = (u: Uint8Array) => new TextDecoder().decode(u);

test("UnlockStrip: `!!!!` anywhere in a read is cut out, once", () => {
  const u = new UnlockStrip();
  assert.equal(s(u.take(b("ab!!!!cd"))), "ab!!!!cd", "not armed: untouched");
  u.arm();
  assert.equal(s(u.take(b("ab!!!!cd"))), "abcd");
  assert.equal(s(u.take(b("!!!!"))), "!!!!", "only the first");
  u.arm();
  assert.equal(s(u.take(b("!!!!"))), "");
  assert.equal(s(u.disarm()), "");
});

test("UnlockStrip: split across reads", () => {
  const u = new UnlockStrip();
  u.arm();
  assert.equal(s(u.take(b("xy!!"))), "xy");
  assert.equal(s(u.take(b("!!\x00z"))), "\x00z");
  u.arm();
  assert.equal(s(u.take(b("!"))), "");
  assert.equal(s(u.take(b("!"))), "");
  assert.equal(s(u.take(b("!!q"))), "q");
});

test("UnlockStrip: `!` held at a read's end goes on when it isn't the answer", () => {
  const u = new UnlockStrip();
  u.arm();
  assert.equal(s(u.take(b("a!!"))), "a");
  assert.equal(s(u.take(b("b"))), "!!b");
  assert.equal(s(u.take(b("c!"))), "c");
  assert.equal(s(u.disarm()), "!", "given back when the wait ends");
  assert.equal(s(u.take(b("!!!!"))), "!!!!", "disarmed");
});
