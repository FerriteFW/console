// src/lib/feed.ts: UPD-25's release feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { downgrade, isFeed, newerIn, releaseProblem, type Feed } from "../../src/lib/feed.ts";

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
  // UPD-27: a signed update file only, never a bare .btf (it would install without a signature)
  assert.ok(!isFeed({ ...feed("0.8.6"), ferrite: { ...feed("0.8.6").ferrite, file: "ferrite-0.8.6.btf" } }), ".ffw only");
  assert.ok(isFeed({ ...feed("0.8.6"), ferrite: { ...feed("0.8.6").ferrite, file: "FERRITE-0.8.6.FFW" } }), "the extension in any case");
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

test("feed: a .btf named anywhere in the file name but its end is still not a .ffw (UPD-27)", () => {
  assert.ok(!isFeed({ ...feed("0.8.6"), ferrite: { ...feed("0.8.6").ferrite, file: "ferrite.ffw.btf" } }));
});

// UPD-25.1 (console#84): the release Update offers is checked against its signed manifest once the signature verifies.

test("feed: a feed naming an older signed file is refused (UPD-25.1)", () => {
  // The feed claims 0.9.8 but the signed file it points at is 0.9.5: the versions differ.
  assert.match(releaseProblem("0.9.5", "0.9.8", true, "0.9.7"), /not the 0\.9\.8/);
  // Even if the feed names the old version honestly, a feed release must be newer than the bundled one.
  assert.match(releaseProblem("0.9.5", "0.9.5", true, "0.9.7"), /isn't newer/);
  assert.match(releaseProblem("0.9.7", "0.9.7", true, "0.9.7"), /isn't newer/);
});

test("feed: a version that doesn't match the signed manifest is refused (UPD-25.1)", () => {
  assert.match(releaseProblem("0.9.9", "0.9.8", true, "0.9.7"), /not the 0\.9\.8/, "newer but not what the feed says");
  assert.match(releaseProblem("", "0.9.8", true, "0.9.7"), /no version/);
  assert.match(releaseProblem("0.9.6", "0.9.7", false, "0.9.7"), /release manifest/, "the bundled release too");
});

test("feed: a newer release that matches its signed manifest is accepted (UPD-25.1)", () => {
  assert.equal(releaseProblem("0.9.8", "0.9.8", true, "0.9.7"), "");
  assert.equal(releaseProblem("v0.9.8", "0.9.8", true, "0.9.7"), "", "a v in front is the same version");
  assert.equal(releaseProblem("0.9.8", "0.9.8", true, ""), "", "no bundled release");
  assert.equal(releaseProblem("0.9.7", "0.9.7", false, "0.9.7"), "", "the bundled release itself");
});

test("feed: older than the radio: a release refused, a file chosen by hand allowed with a note (UPD-25.1)", () => {
  assert.ok(downgrade("0.9.6", "v0.9.7 bench-dac", false) && "refuse" in downgrade("0.9.6", "v0.9.7", false)!);
  const d = downgrade("0.9.6", "0.9.7", true);
  assert.ok(d && "note" in d && /downgrade/i.test(d.note));
  assert.equal(downgrade("0.9.8", "0.9.7", false), null, "newer");
  assert.equal(downgrade("0.9.7", "0.9.7", false), null, "the same: install again");
  assert.equal(downgrade("0.9.6", "", false), null, "the radio's version unknown");
});
