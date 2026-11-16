// src/lib/chirpzone.ts: a CHIRP import's channels that name no zone go in the zone CHIRP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { intoChirpZone } from "../../src/lib/chirpzone.ts";

const nz = (n: number, name: string) => ({ number: n, name });
const ch = (zone: number | null) => ({ zone });

test("chirp zone: a new one after the table's, for the channels that named none", () => {
  const r = intoChirpZone([nz(1, "Local"), nz(2, "Repeaters")], [ch(null), ch(1), ch(null)], 512, nz);
  assert.deepEqual(r.zones.map((z) => z.name), ["Local", "Repeaters", "CHIRP"]);
  assert.deepEqual(r.channels.map((c) => c.zone), [2, 1, 2]);
});

test("chirp zone: the table's own when it has one (any case), and nothing when every channel named a zone", () => {
  const r = intoChirpZone([nz(1, "chirp ")], [ch(null)], 512, nz);
  assert.equal(r.zones.length, 1);
  assert.deepEqual(r.channels.map((c) => c.zone), [0]);
  const z = [nz(1, "Local")];
  const same = intoChirpZone(z, [ch(0)], 512, nz);
  assert.equal(same.zones, z);
});

test("chirp zone: no room for another zone: they stay in none", () => {
  const r = intoChirpZone([nz(1, "A")], [ch(null)], 1, nz);
  assert.deepEqual(r.channels.map((c) => c.zone), [null]);
});
