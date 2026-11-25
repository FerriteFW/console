// src/lib/notes.ts and tools/release-notes.mjs: UPD-25.2's release notes with Update (console#42).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feedNotes, notesToShow, notesWanted, renderMarkdown, type ReleaseNote } from "../../src/lib/notes.ts";
// @ts-expect-error: a plain .mjs tool, no types
import { ferritePart, releaseNotes } from "../../tools/release-notes.mjs";

const n = (version: string): ReleaseNote => ({ version, markdown: `Notes for ${version}.` });
const all = [n("0.9.7"), n("0.9.6"), n("0.9.5"), n("0.9.4"), n("0.9.3")];
const versions = (r: { show: ReleaseNote[] }) => r.show.map((x) => x.version);

test("UPD-25.2: radio on 0.9.5, 0.9.7 offered: the notes for 0.9.7 and 0.9.6, newest first", () => {
  assert.deepEqual(versions(notesToShow(all, "0.9.5", "0.9.7", false)), ["0.9.7", "0.9.6"]);
  assert.deepEqual(versions(notesToShow([...all].reverse(), "v0.9.5", "0.9.7", false)), ["0.9.7", "0.9.6"], "any order in the feed, a v prefix");
  assert.equal(notesToShow(all, "0.9.5", "0.9.7", false).before, "", "0.9.5 is listed: nothing between is missing");
});

test("UPD-25.2: one behind, up to date, unknown radio, a file chosen by hand", () => {
  assert.deepEqual(versions(notesToShow(all, "0.9.6", "0.9.7", false)), ["0.9.7"]);
  assert.deepEqual(versions(notesToShow(all, "0.9.7", "0.9.7", false)), [], "up to date: none");
  assert.deepEqual(versions(notesToShow(all, "", "0.9.7", false)), ["0.9.7"], "not connected: the offered one");
  assert.deepEqual(versions(notesToShow(all, "0.9.3", "0.9.5", true)), ["0.9.5"], "by hand: only the matching one");
  assert.deepEqual(versions(notesToShow(all, "0.9.3", "0.9.9-dev", true)), [], "by hand, no notes for it: none");
  assert.deepEqual(versions(notesToShow(all, "0.9.5", "", false)), []);
});

test("UPD-25.2: a radio older than the notes listed: the page says the earlier ones aren't shown", () => {
  const r = notesToShow(all, "0.8.3", "0.9.7", false);
  assert.deepEqual(versions(r), ["0.9.7", "0.9.6", "0.9.5", "0.9.4", "0.9.3"]);
  assert.equal(r.before, "0.9.3");
});

test("UPD-25.2: notes missing are worth a line only when a newer release is on offer", () => {
  assert.ok(notesWanted("0.9.5", "0.9.7", false));
  assert.ok(notesWanted("", "0.9.7", false));
  assert.ok(!notesWanted("0.9.7", "0.9.7", false));
  assert.ok(!notesWanted("0.9.5", "0.9.7", true), "a file chosen by hand: no line");
});

test("UPD-25.2: the feed's notes: well-formed entries only; an older feed has none", () => {
  assert.deepEqual(feedNotes({ ferrite: { notes: [n("0.9.7"), { version: "x", markdown: "" }, { version: "0.9.6" }, null] } }), [n("0.9.7")]);
  assert.deepEqual(feedNotes({ ferrite: {} }), []);
  assert.deepEqual(feedNotes(null), []);
});

test("UPD-25.2: the Markdown renders the notes' subset and escapes any HTML in them", () => {
  const h = renderMarkdown("Lede <b>x</b> & more.\n\n## Fixed\n\n- **Bold** item with `code<i>`\n  carried on\n- [Link](https://example.com/a?b=1&c=\"2\")\n\nSee https://discord.gg/abc.");
  assert.match(h, /^<p>Lede &lt;b&gt;x&lt;\/b&gt; &amp; more\.<\/p>/);
  assert.match(h, /<h4>Fixed<\/h4>/);
  assert.match(h, /<li><strong>Bold<\/strong> item with <code>code&lt;i&gt;<\/code> carried on<\/li>/);
  assert.match(h, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=&quot;2&quot;" target="_blank" rel="noopener noreferrer">Link<\/a>/);
  assert.match(h, /<a href="https:\/\/discord\.gg\/abc" [^>]*>https:\/\/discord\.gg\/abc<\/a>\.<\/p>$/, "a bare address, its full stop outside");
  for (const evil of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "[x](javascript:alert(1))", "**<svg onload=alert(1)>**"]) {
    const out = renderMarkdown(evil);
    assert.doesNotMatch(out, /<(script|img|svg)/i, evil);
    assert.doesNotMatch(out, /href="javascript/i, evil);
  }
});

test("UPD-25.2: release-files takes the Ferrite part of the notes: no title, Console or Install section, AI line", () => {
  const md = "# Ferrite 0.9.7\n\nLede.\n\n## New\n\n- A thing.\n\n## Ferrite Console 0.9.7\n\n- Console thing.\n\n## Install\n\nUse Console.\n\nBuilt with the help of AI.\n";
  assert.equal(ferritePart(md), "Lede.\n\n## New\n\n- A thing.");
  assert.equal(ferritePart("Lede.\n\n## Known issues\n\n- One.\n\nBuilt with the help of AI.\n"), "Lede.\n\n## Known issues\n\n- One.");
});

test("UPD-25.2: release-files reads the last releases' notes up to the one released, newest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-"));
  for (const v of ["0.8.3", "0.9.5", "0.9.6", "0.9.7", "0.9.10", "0.10.0"]) writeFileSync(join(dir, `${v}.md`), `# Ferrite ${v}\n\nNotes ${v}.\n`);
  writeFileSync(join(dir, "0.9.6-issue-replies.md"), "not notes");
  const r = releaseNotes(dir, "0.9.10", 4);
  assert.deepEqual(r.map((x: ReleaseNote) => x.version), ["0.9.10", "0.9.7", "0.9.6", "0.9.5"]);
  assert.equal(r[0].markdown, "Notes 0.9.10.");
  assert.throws(() => releaseNotes(dir, "0.9.8"), /no release notes for Ferrite 0\.9\.8/);
});
