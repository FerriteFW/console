// src/lib/cluster.ts: the "near me" map's grid clusterer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridCluster } from "../../src/lib/cluster.ts";

const at = (p: { x: number; y: number }) => p;

test("cluster: same cell together, apart alone, order kept", () => {
  const a = { x: 5, y: 5 };
  const b = { x: 30, y: 12 };
  const c = { x: 70, y: 5 };
  const d = { x: 39, y: 39 };
  assert.deepEqual(gridCluster([a, b, c, d], at, 40), [[a, b, d], [c]]);
});

test("cluster: negative points and a cell of one pixel", () => {
  const a = { x: -1, y: 0 };
  const b = { x: 0, y: 0 };
  assert.deepEqual(gridCluster([a, b], at, 40), [[a], [b]]);
  assert.equal(gridCluster([a, b, { x: 0.5, y: 0.2 }], at, 1).length, 2);
  assert.deepEqual(gridCluster([], at, 40), []);
});
