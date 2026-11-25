// UPD-25.2 (console#42): Ferrite's release notes with Firmware › Update. They come in the update feed itself
// (`ferrite.notes`, written by tools/release-files.mjs from the docs repo's release-notes/X.Y.Z.md), so they always
// match the version offered. Pure, for the tests: which notes to show, and a small Markdown renderer that escapes
// everything it doesn't make itself.
import { olderThan, sameVersion } from "./version.ts";

/** One release's notes: its version, and the Ferrite part of its notes in Markdown. */
export type ReleaseNote = { version: string; date?: string; markdown: string };

/** The feed's notes, the well-formed entries only (an older feed has none: []). */
export function feedNotes(f: unknown): ReleaseNote[] {
  const n = (f as { ferrite?: { notes?: unknown } } | null)?.ferrite?.notes;
  if (!Array.isArray(n)) return [];
  return n.filter(
    (x): x is ReleaseNote =>
      typeof x?.version === "string" && /^v?\d+\.\d+\.\d+$/.test(x.version.trim()) && typeof x.markdown === "string" && (x.date === undefined || typeof x.date === "string"),
  );
}

/**
 * The notes Update shows for `offered` (the release on offer, or the file chosen by hand) on a radio running `running`
 * ("" when unknown or not connected): every release newer than the radio's up to the one offered, newest first (none
 * when the radio is up to date); just the offered one when the radio's version is unknown or the file was chosen by
 * hand. `before`: the oldest version
 * listed when the radio is older still (the feed keeps the last few releases), so the page can say the earlier ones
 * aren't shown; "" otherwise.
 */
export function notesToShow(all: ReleaseNote[], running: string, offered: string, byHand: boolean): { show: ReleaseNote[]; before: string } {
  if (!offered || (!byHand && running && !olderThan(running, offered))) return { show: [], before: "" }; // up to date
  const ranged = !byHand && !!running && olderThan(running, offered);
  const show = all
    .filter((n) => (ranged ? olderThan(running, n.version) && !olderThan(offered, n.version) : sameVersion(n.version, offered)))
    .sort((a, b) => (olderThan(a.version, b.version) ? 1 : olderThan(b.version, a.version) ? -1 : 0));
  const oldest = show.at(-1)?.version ?? "";
  return { show, before: ranged && oldest && olderThan(running, oldest) && !isNext(running, oldest, all) ? oldest : "" };
}

/** `b` directly follows `a` in the list of notes (nothing listed between them): not used when `a` isn't listed. */
function isNext(a: string, b: string, all: ReleaseNote[]): boolean {
  return all.some((n) => sameVersion(n.version, a)) && !all.some((n) => olderThan(a, n.version) && olderThan(n.version, b));
}

/** Notes are wanted (and their absence worth a line): a release newer than the radio's, or the radio unknown. */
export function notesWanted(running: string, offered: string, byHand: boolean): boolean {
  return !!offered && !byHand && (!running || olderThan(running, offered));
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

// `code`, **bold**, [text](https://…), or a bare https:// address (not its trailing punctuation)
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;
const link = (href: string, text: string) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

function inline(s: string): string {
  let out = "";
  let at = 0;
  for (const m of s.matchAll(INLINE)) {
    out += escapeHtml(s.slice(at, m.index));
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[2] !== undefined) out += `<strong>${inline(m[2])}</strong>`;
    else if (m[3] !== undefined) out += link(m[4], escapeHtml(m[3]));
    else out += link(m[5], escapeHtml(m[5]));
    at = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(at));
}

/**
 * The release notes' Markdown as HTML: headings (## and ###), lists (- or *, continued on indented lines), paragraphs,
 * and inline `code`, **bold** and http(s) links. Everything else is text, escaped: the notes can't inject markup.
 */
export function renderMarkdown(md: string): string {
  const html: string[] = [];
  let para: string[] = [];
  let items: string[] | null = null;
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (items) html.push(`<ul>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`);
    items = null;
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      const level = Math.min(h[1].length + 2, 5); // # -> h3, ## -> h4, ### -> h5: under the page's own headings
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (li) {
      flushPara();
      (items ??= []).push(li[1]);
    } else if (items && /^\s/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return html.join("\n");
}
