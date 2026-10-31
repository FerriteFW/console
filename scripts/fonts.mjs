// The web fonts: ferrite's own TTFs (../ferrite/fonts, used from the checkout, not copied) cut down to the
// characters Console shows and written as WOFF2 into src/fonts/ (not in git), which app.css loads. Every build runs
// this first; it fails loudly when a font or subset-font is missing rather than building without fonts.
//   node scripts/fonts.mjs
// JetBrains Mono keeps Latin-1, general punctuation and every other character the source uses (scanned from src/
// and index.html, so a new arrow or symbol in the UI comes along by itself); Ferrite Mono Tight (frequency digits)
// and Barlow (the wordmark) keep printable ASCII, as the radio's own fonts do (ferrite tools/fontgen.py).
// subset-font (harfbuzz in wasm, pinned in package.json) needs nothing outside node_modules.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fonts = join(root, "../ferrite/fonts");
const out = join(root, "src/fonts");

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)).join("");
const ascii = range(0x20, 0x7e);

// Every non-ASCII character in the UI's source (comments too: a few spare glyphs cost less than a missing one).
function used(p, found) {
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) if (f !== "core-wasm" && f !== "fonts") used(join(p, f), found);
  } else if (/\.(svelte|ts|js|css|html)$/.test(p)) {
    for (const c of readFileSync(p, "utf8")) if (c.codePointAt(0) > 0x7e) found.add(c);
  }
  return found;
}
const symbols = [...used(join(root, "index.html"), used(join(root, "src"), new Set()))].join("");
const text = ascii + range(0xa0, 0xff) + range(0x2010, 0x2044) + symbols;

const faces = [
  ["JetBrainsMono-Regular", text],
  ["JetBrainsMono-Medium", text],
  ["JetBrainsMono-Bold", text],
  ["FerriteMonoTight-Bold", ascii],
  // Large enough to need no hinting (about a third of its size); JetBrains Mono keeps it for small text on Windows.
  ["BarlowSemiCondensed-SemiBold", ascii, { noHinting: true }],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, chars, opts] of faces) {
  const woff2 = await subsetFont(readFileSync(join(fonts, `${name}.ttf`)), chars, { targetFormat: "woff2", ...opts });
  writeFileSync(join(out, `${name}.woff2`), woff2);
}
