// src/lib/installGuard.ts: the Install page's guards over the owner's stock data (console#81, console#82).
import { test } from "node:test";
import assert from "node:assert/strict";
import { installIdProblem, otherRadio, restoreProgress, stockOnlyAllowed, uidKey } from "../../src/lib/installGuard.ts";

const MINE = "N0EQ8 0R081 H4T84 MXM3G";
const OTHER = "7D440 123AB CDEF0 12345";

test("BACKUP-2.1: an ID reads the same however it is written", () => {
  assert.equal(uidKey("n0eq8-0r081 h4t84mxm3g"), "N0EQ80R081H4T84MXM3G");
  assert.equal(uidKey(""), "");
  assert.equal(uidKey("N0EQ80R081H4T84MXM3U"), "", "U isn't one of the digits");
  assert.equal(uidKey(null), "");
});

test("BACKUP-2.1: Ferrite goes into the radio the backup is from", () => {
  assert.equal(installIdProblem(MINE, "N0EQ80R081H4T84MXM3G"), "");
  assert.equal(otherRadio(MINE, MINE), false);
});

test("BACKUP-2.1: another radio on the cable is refused, and its backup forgotten", () => {
  const why = installIdProblem(MINE, OTHER);
  assert.match(why, /different radio \(ID 7D440 123AB CDEF0 12345\) from the one you backed up \(ID N0EQ8 0R081 H4T84 MXM3G\)/);
  assert.match(why, /Nothing was written/);
  assert.equal(otherRadio(MINE, OTHER), true);
});

test("BACKUP-2.1: a radio that doesn't say its ID is refused, the backup kept", () => {
  assert.match(installIdProblem(MINE, null), /couldn't read this radio's ID/);
  assert.equal(otherRadio(MINE, null), false);
});

test("BACKUP-2.1: a backup with no ID can't be checked: refused", () => {
  assert.match(installIdProblem("", MINE), /doesn't say which radio/);
  assert.equal(otherRadio("", MINE), false);
});

test("BACKUP-8.1: stock alone only after every range is read back and stock started going in", () => {
  const p = { ranges: 3, verified: 3, finished: true, stockBlocks: 1 };
  assert.equal(stockOnlyAllowed(p), true);
  assert.equal(stockOnlyAllowed({ ...p, verified: 2 }), false, "a cut during the writes");
  assert.equal(stockOnlyAllowed({ ...p, finished: false }), false, "FINISH not accepted");
  assert.equal(stockOnlyAllowed({ ...p, stockBlocks: 0 }), false, "the bootloader window missed: Ferrite may have started");
  assert.equal(stockOnlyAllowed(restoreProgress()), false, "nothing done");
  assert.equal(stockOnlyAllowed({ ...p, ranges: 0, verified: 0 }), false, "no ranges is no proof");
});
