// src/lib/backupError.ts: a write that stops at its backup says whether the read or the file save failed, with the
// reason (a save that failed on Linux, Console run as root, read "the backup read failed", Nov 24, 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { backupFailed, SaveError } from "../../src/lib/backupError.ts";

test("backup: a save that failed says so, with the path and the reason", () => {
  const m = backupFailed(new SaveError("Couldn't save /root/Downloads/radio-backup.json: Permission denied (os error 13)."));
  assert.equal(m, "Nothing written: the backup file couldn't be saved. Couldn't save /root/Downloads/radio-backup.json: Permission denied (os error 13).");
});

test("backup: a read that failed stays a read", () => {
  assert.equal(backupFailed(new Error("the radio didn't answer")), "Nothing written: the backup read failed (the radio didn't answer).");
});

test("backup: a plain string is its own message, never undefined", () => {
  assert.equal(backupFailed("timed out"), "Nothing written: the backup read failed (timed out).");
});
