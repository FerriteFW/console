// src/lib/version.ts: is the radio's Ferrite older than the bundled release (the top bar's "available").
import { test } from "node:test";
import assert from "node:assert/strict";
import { atLeast, olderThan } from "../../src/lib/version.ts";

test("version: older by number, with or without the v", () => {
  assert.equal(olderThan("v0.8.3", "v0.8.4"), true);
  assert.equal(olderThan("0.8.3", "v0.8.4"), true);
  assert.equal(olderThan("v0.7.9", "v0.8.0"), true);
  assert.equal(olderThan("v0.8.9", "v0.8.10"), true, "by number, not as text");
});

test("version: the same or newer is never older", () => {
  assert.equal(olderThan("v0.8.4", "v0.8.4"), false);
  assert.equal(olderThan("v0.8.5", "v0.8.4"), false);
  assert.equal(olderThan("v0.8.10", "v0.8.9"), false);
  assert.equal(olderThan("v1.0.0", "v0.9.9"), false);
});

test("version: an unreadable version never asks for an update", () => {
  assert.equal(olderThan("", "v0.8.4"), false);
  assert.equal(olderThan("dev", "v0.8.4"), false);
  assert.equal(olderThan("v0.8.3", ""), false);
  assert.equal(olderThan("v0.8", "v0.8.4"), false);
});

test("version: at least, for what a firmware can take (SSTV pictures from 0.9.1)", () => {
  assert.equal(atLeast("v0.9.1", "0.9.1"), true);
  assert.equal(atLeast("0.10.0", "0.9.1"), true);
  assert.equal(atLeast("v0.9.0", "0.9.1"), false);
  assert.equal(atLeast("", "0.9.1"), false, "no version never counts");
  assert.equal(atLeast("dev", "0.9.1"), false);
});
