// src/lib/reorder.ts: moving a channel in the table or in its zone, and moving a zone: which numbers change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { moveMap, orderMap, spanText, zoneMap } from "../../src/lib/reorder.ts";

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const pairs = (m: Map<number, number>) => [...m].sort((x, y) => x[0] - y[0]);

test("move up: the channels from the drop to the old place shift down one", () => {
  // 15 dropped on 5: 5..14 become 6..15.
  assert.deepEqual(pairs(moveMap(range(1, 20), 15, 5)), [[5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [15, 5]]);
});

test("move down: the channels after the old place up to the drop shift up one", () => {
  assert.deepEqual(pairs(moveMap(range(1, 10), 3, 6)), [[3, 6], [4, 3], [5, 4], [6, 5]]);
});

test("a free number is just a renumber", () => {
  assert.deepEqual(pairs(moveMap([1, 2, 3, 10], 2, 7)), [[2, 7]]);
});

test("a gap stops the shift: nothing past it changes", () => {
  // 1..5 and 8..12; 12 dropped on 2: 2..5 shift to 3..6 (6 was free), 8..11 stay.
  assert.deepEqual(pairs(moveMap([1, 2, 3, 4, 5, 8, 9, 10, 11, 12], 12, 2)), [[2, 3], [3, 4], [4, 5], [5, 6], [12, 2]]);
});

test("neighbours just trade", () => {
  assert.deepEqual(pairs(moveMap(range(1, 5), 3, 2)), [[2, 3], [3, 2]]);
  assert.deepEqual(pairs(moveMap(range(1, 5), 3, 4)), [[3, 4], [4, 3]]);
  assert.equal(moveMap(range(1, 5), 3, 3).size, 0);
});

test("every move is a renumbering: no two channels end on one number", () => {
  const used = [1, 2, 4, 5, 6, 9, 10, 11];
  for (const from of used)
    for (let to = 1; to <= 12; to++) {
      const m = moveMap(used, from, to);
      const after = used.map((n) => m.get(n) ?? n);
      assert.equal(new Set(after).size, used.length, `${from} -> ${to}`);
      assert.equal(m.get(from) ?? from, to);
    }
});

test("in a zone: only the zone's own numbers are shared out again", () => {
  // A zone of 3, 7, 12, 20: 20 to the top takes 3; the others move down a place.
  assert.deepEqual(pairs(orderMap([3, 7, 12, 20], 3, 0)), [[3, 7], [7, 12], [12, 20], [20, 3]]);
  // One place: a trade, as ▲ ▼ did.
  assert.deepEqual(pairs(orderMap([3, 7, 12, 20], 1, 2)), [[7, 12], [12, 7]]);
  assert.equal(orderMap([3, 7], 0, 5).size, 0);
});

test("zones: the moved one and the ones it passes", () => {
  assert.deepEqual(pairs(zoneMap(5, 4, 1)), [[1, 2], [2, 3], [3, 4], [4, 1]]);
  assert.deepEqual(pairs(zoneMap(5, 0, 2)), [[0, 2], [1, 0], [2, 1]]);
});

test("the notice's span", () => {
  assert.equal(spanText([5, 6, 7]), "5–7");
  assert.equal(spanText([9]), "9");
});
