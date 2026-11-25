// src/lib/bootflash.ts's resend rule (INST-1.1, FerriteFW/console#89): a block whose reply was lost and whose resend
// the bootloader answers E2 (out of order) counts as written; any other E2 still fails the flash. A scripted port
// stands in for the bootloader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync } from "../../src/core-wasm/core.js";
import { ACK, BAD_FRAME, command, E_ORDER, sendAll, type BootPort } from "../../src/lib/bootflash.ts";
import type { BootStep, FirmwareUpdate } from "../../src/lib/core.ts";

initSync({ module: readFileSync(new URL("../../src/core-wasm/core_bg.wasm", import.meta.url)) });

/** A port that answers each send with the next scripted reply (null: none, the reply lost). */
function port(replies: (number | null)[]) {
  let sends = 0;
  const p = {
    t: {
      async write() {
        sends++;
      },
    },
    clear() {},
    async next() {
      return replies.shift() ?? null;
    },
  };
  return { port: p as unknown as BootPort, sends: () => sends };
}

const block: BootStep = { cmd: 0x57, what: "block", block: 4, timeout_ms: 10 };
const frame = Uint8Array.of(1, 2, 3);

test("bootflash: a lost reply, then E2 to the resend: written, flash goes on", async () => {
  const p = port([null, E_ORDER]);
  assert.equal(await command(p.port, frame, block), ACK);
  assert.equal(p.sends(), 2);
});

test("bootflash: E2 to a first send still fails", async () => {
  assert.equal(await command(port([E_ORDER]).port, frame, block), E_ORDER);
});

test("bootflash: E2 after a garbled-frame reply still fails (the block wasn't taken)", async () => {
  assert.equal(await command(port([BAD_FRAME, E_ORDER]).port, frame, block), E_ORDER);
});

test("bootflash: E2 after a lost reply to a step that isn't a block still fails", async () => {
  assert.equal(await command(port([null, E_ORDER]).port, frame, { ...block, what: "count", block: null }), E_ORDER);
});

test("bootflash: three lost replies give up", async () => {
  const p = port([null, null, null]);
  assert.equal(await command(p.port, frame, block), null);
  assert.equal(p.sends(), 3);
});

/** An update of `n` blocks, one step each. */
function update(n: number) {
  return {
    blocks: () => n,
    steps: () => n,
    step: (i: number) => JSON.stringify({ ...block, block: i }),
    frame: () => frame,
  } as unknown as FirmwareUpdate;
}

test("bootflash: sendAll goes past a resent block the bootloader already had", async () => {
  const p = port([ACK, null, E_ORDER, ACK]);
  await sendAll(p.port, update(3), () => {});
  assert.equal(p.sends(), 4);
});

test("bootflash: sendAll stops at an E2 that isn't a resend's", async () => {
  await assert.rejects(sendAll(port([ACK, E_ORDER]).port, update(3), () => {}), /Block 2 of 3: block out of order/);
});
