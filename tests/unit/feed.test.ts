// src/lib/feed.ts: UPD-25's release feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFeed, newerIn, type Feed } from "../../src/lib/feed.ts";

const feed = (version: string, protocol = 1): Feed => ({
  format: "ferrite-feed-1",
  ferrite: { version, protocol, file: `ferrite-${version}.ffw`, url: `https://ferritefw.dev/releases/ferrite-${version}.ffw`, sha256: "a".repeat(64) },
  console: { version },
});

test("feed: a well-formed feed passes; a bad one doesn't", () => {
  assert.ok(isFeed(feed("0.8.6")));
  assert.ok(!isFeed({ ...feed("0.8.6"), format: "other" }));
  assert.ok(!isFeed({ ...feed("0.8.6"), ferrite: { ...feed("0.8.6").ferrite, url: "http://x/y.ffw" } }), "https only");
  assert.ok(!isFeed({ ...feed("0.8.6"), ferrite: { ...feed("0.8.6").ferrite, sha256: "zz" } }));
  assert.ok(!isFeed(null));
});

test("feed: offers a newer Ferrite on this protocol, asks for Console on another, nothing when not newer", () => {
  assert.deepEqual(newerIn(feed("0.8.6"), "0.8.5", 1), { usable: feed("0.8.6").ferrite });
  assert.deepEqual(newerIn(feed("0.8.6", 2), "0.8.5", 1), { needsConsole: "0.8.6" });
  assert.equal(newerIn(feed("0.8.5"), "0.8.5", 1), null);
  assert.equal(newerIn(feed("0.8.4"), "0.8.5", 1), null);
  assert.equal(newerIn(null, "0.8.5", 1), null);
  assert.deepEqual(newerIn(feed("0.8.6"), "", 1), { usable: feed("0.8.6").ferrite }, "no bundled release: the feed's");
});
