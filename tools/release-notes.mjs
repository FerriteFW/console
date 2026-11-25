// UPD-25.2 (console#42): the release notes the update feed carries (`ferrite.notes`), from the docs repo's
// release-notes/X.Y.Z.md: the Ferrite part only (no title, no "## Ferrite Console …" or "## Install" section, no
// closing "Built with the help of AI."), the last few releases up to the one released, newest first.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const parse = (v) => v.split(".").map(Number);
const cmp = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** The Ferrite part of one release's notes (Markdown). */
export function ferritePart(md) {
  const out = [];
  let skip = false;
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^# /.test(line)) continue; // the title: Console shows the version itself
    const h = /^##\s+(.*)$/.exec(line);
    if (h) skip = /^(Ferrite Console\b|Install\b)/i.test(h[1].trim());
    if (!skip) out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n\s*Built with the help of AI\.\s*$/, "")
    .trim();
}

/** The notes of the last `count` releases up to `version` (newest first) in `dir`; throws when `version`'s is missing. */
export function releaseNotes(dir, version, count = 5) {
  if (!existsSync(join(dir, `${version}.md`))) throw new Error(`no release notes for Ferrite ${version} in ${dir} (pass --no-notes to leave them out)`);
  return readdirSync(dir)
    .map((f) => /^(\d+\.\d+\.\d+)\.md$/.exec(f)?.[1])
    .filter((v) => v && cmp(v, version) <= 0)
    .sort((a, b) => cmp(b, a))
    .slice(0, count)
    .map((v) => ({ version: v, markdown: ferritePart(readFileSync(join(dir, `${v}.md`), "utf8")) }));
}
