// src/lib/installGuard.ts readerProblem: Install's Back up says why it can't start before it is pressed (console#102:
// an unsigned reader with Allow unsigned files off left the button looking dead).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readerProblem } from "../../src/lib/installGuard.ts";

test("install: a usable reader leaves Back up free", () => {
  assert.equal(readerProblem(true, []), "");
  assert.equal(readerProblem(true, undefined), "");
});

test("install: no reader image says where to choose one", () => {
  assert.match(readerProblem(false, undefined), /no reader image.*under Advanced/);
});

test("install: a refused reader gives the reason and what to do", () => {
  const why = "unsigned: only a release signed with Ferrite's key installs; your own build needs Allow unsigned files (Advanced).";
  const m = readerProblem(true, [why]);
  assert.ok(m.includes(why), m);
  assert.match(m, /refused.*under Advanced on the Install page/);
});
