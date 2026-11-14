// Live View completeness (LINK-19.4, LINK-19.5, decisions 289 and 291): every text the firmware draws on a screen shows
// in Console's Live View drawn from that screen's readback with the screen as drawn (`readback_texts`, as the radio sends
// it). The screens and their texts come from ferrite's simulator
// (sim/tests/liveview_corpus.rs writes ../ferrite/target/liveview/corpus.json; built here when missing or older than
// this run). A screen the radio changes and Console's look-alike doesn't follow fails here, with the missing texts.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Entry = { name: string; texts: string[]; readback: string; readback_texts?: string };

const FERRITE = join(import.meta.dirname, "..", "..", "..", "ferrite");
const CORPUS = join(FERRITE, "target", "liveview", "corpus.json");
/** Known gaps, screen -> texts. `FERRITE_LIVEVIEW_BASELINE=write` writes one from this run, for a gap to be allowed
 * while it's fixed. None now (Oct 28: the `card` line's `lasthit` closed the last one). */
const BASELINE = join(import.meta.dirname, "liveview-gaps.json");

/** Texts compared without case, spaces or the separators the two draw differently. */
const norm = (s: string) => s.toLowerCase().replace(/[\s·•…▸▶◀▲▼‹›<>|,:'"`]+/g, "");

/** Texts that are drawn decoration, not content: single symbols, arrows, keycap glyphs. */
const meaningful = (s: string) => /[\p{L}\p{N}]{2,}/u.test(s);

/** A drawn text is shown when it, or every word of it, is in the screen's text. */
function shown(text: string, screen: string): boolean {
  const n = norm(text);
  if (screen.includes(n)) return true;
  const words = text.split(/[\s·•…▸▶◀▲▼‹›<>|,:]+/).map(norm).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length > 1 && words.every((w) => screen.includes(w));
}

test.beforeAll(() => {
  if (process.env.FERRITE_LIVEVIEW_CORPUS_KEEP && existsSync(CORPUS)) return;
  execFileSync("cargo", ["test", "-q", "-p", "ferrite-sim", "--test", "liveview_corpus"], { cwd: FERRITE, stdio: "inherit" });
});

test("live view shows every text the radio draws, on every screen", async ({ page }) => {
  test.setTimeout(120_000);
  const corpus: Entry[] = JSON.parse(readFileSync(CORPUS, "utf8"));
  await page.goto("/?readback-harness");
  await page.waitForFunction(() => "__readback" in window);
  const known: Record<string, string[]> = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  const all: Record<string, string[]> = {};
  const misses: string[] = [];
  for (const e of corpus) {
    await page.evaluate((t) => (window as unknown as { __readback: (t: string) => Promise<void> }).__readback(t), e.readback_texts ?? e.readback);
    const dom = norm(await page.locator("[data-readback-screen]").textContent() ?? "");
    const missing = [...new Set(e.texts.filter(meaningful).filter((t) => !shown(t, dom)))];
    if (missing.length) all[e.name] = missing;
    const fresh = missing.filter((m) => !(known[e.name] ?? []).includes(m));
    if (fresh.length) misses.push(`${e.name}: ${fresh.map((m) => JSON.stringify(m)).join(", ")}`);
  }
  if (process.env.FERRITE_LIVEVIEW_BASELINE === "write") writeFileSync(BASELINE, JSON.stringify(all, null, 1) + "\n");
  const left = Object.values(all).reduce((a, v) => a + v.length, 0);
  console.log(`${corpus.length} screens; known gaps left: ${left} texts on ${Object.keys(all).length} screens`);
  expect(misses, `new gaps (texts the radio draws that Live View doesn't show):\n${misses.join("\n")}`).toEqual([]);
});
