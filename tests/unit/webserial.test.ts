// src/lib/transport/webserial.ts: writes queued (issue #33). A Web Serial stream has one writer at a time; two
// windowed WRITE_MANY frames sent back to back found it locked, and the second was never sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSerialTransport } from "../../src/lib/transport/webserial.ts";

/** A port whose writable refuses a second writer while one is held, and takes `ms` per write. */
function fakePort(ms: number, failFirst = false) {
  const sent: number[][] = [];
  let locked = false;
  let n = 0;
  const writable = {
    getWriter() {
      if (locked) throw new TypeError("Failed to execute 'getWriter' on 'WritableStream': Cannot create writer when WritableStream is locked");
      locked = true;
      return {
        async write(b: Uint8Array) {
          await new Promise((r) => setTimeout(r, ms));
          if (failFirst && n++ === 0) throw new Error("the cable went away");
          sent.push(Array.from(b));
        },
        releaseLock() {
          locked = false;
        },
      };
    },
  };
  return { port: { writable }, sent };
}

const make = (port: unknown) => new (WebSerialTransport as unknown as new (p: unknown) => WebSerialTransport)(port);

test("webserial: two writes back to back both go out, in order", async () => {
  const { port, sent } = fakePort(5);
  const t = make(port);
  await Promise.all([t.write(Uint8Array.of(1, 2)), t.write(Uint8Array.of(3)), t.write(Uint8Array.of(4))]);
  assert.deepEqual(sent, [[1, 2], [3], [4]]);
});

test("webserial: a failed write rejects for its caller, and the next one still goes", async () => {
  const { port, sent } = fakePort(2, true);
  const t = make(port);
  const first = t.write(Uint8Array.of(9));
  const second = t.write(Uint8Array.of(8));
  await assert.rejects(first, /went away/);
  await second;
  assert.deepEqual(sent, [[8]]);
});
