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

/** A port whose readable errors with `name` once, then gives a stream with [7, 8]. */
function readPort(name: string) {
  let n = 0;
  return {
    async open() {},
    getInfo: () => ({ usbVendorId: 0x1a86 }),
    addEventListener() {},
    get readable() {
      n++;
      if (n === 1)
        return new ReadableStream<Uint8Array>({
          start(c) {
            setTimeout(() => {
              c.enqueue(Uint8Array.of(1));
              c.error(Object.assign(new Error("a bad byte"), { name }));
            }, 10);
          },
        });
      if (n === 2) return new ReadableStream<Uint8Array>({ start: (c) => void setTimeout(() => c.enqueue(Uint8Array.of(7, 8)), 10) });
      return null;
    },
    writable: null,
  };
}

test("webserial: a framing error ends one stream, and reading goes on with the next", async () => {
  const t = await (WebSerialTransport as unknown as { fromPort(p: unknown): Promise<WebSerialTransport> }).fromPort(readPort("FramingError"));
  const got: number[] = [];
  let closed = "";
  t.onData = (b) => got.push(...b);
  t.onClose = (w) => (closed = w);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.slice(-2), [7, 8]); // (the 1 before the error may come before onData is set)
  assert.equal(closed, "");
});

test("webserial: another read error closes the cable", async () => {
  const t = await (WebSerialTransport as unknown as { fromPort(p: unknown): Promise<WebSerialTransport> }).fromPort(readPort("NetworkError"));
  let closed = "";
  t.onClose = (w) => (closed = w);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(closed, /The cable stopped: a bad byte/);
});

/** A port that can be closed and opened again at another rate; each open gives a stream with that open's bytes. */
function ratePort() {
  const rates: number[] = [];
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let readable: ReadableStream<Uint8Array> | null = null;
  return {
    rates,
    send: (b: number[]) => ctrl!.enqueue(Uint8Array.from(b)),
    port: {
      async open(o: { baudRate: number }) {
        rates.push(o.baudRate);
        readable = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
      },
      async close() {
        readable = null;
      },
      getInfo: () => ({ usbVendorId: 0x1a86 }),
      addEventListener() {},
      get readable() {
        return readable;
      },
    },
  };
}

test("webserial: after a rate switch the port is read at the new rate (High speed)", async () => {
  const p = ratePort();
  const t = await (WebSerialTransport as unknown as { fromPort(p: unknown): Promise<WebSerialTransport> }).fromPort(p.port);
  const got: number[] = [];
  t.onData = (b) => got.push(...b);
  let closed = "";
  t.onClose = (why) => (closed = why);
  p.send([1]);
  await new Promise((r) => setTimeout(r, 5));
  await t.setBaud(230400);
  p.send([2, 3]);
  await new Promise((r) => setTimeout(r, 5));
  await t.setBaud(115200);
  p.send([4]);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(p.rates, [115200, 230400, 115200]);
  assert.deepEqual(got, [1, 2, 3, 4]);
  assert.equal(closed, "");
});
