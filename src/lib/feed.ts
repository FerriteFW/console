// UPD-25 (ferrite decision 394): the release feed, format `ferrite-feed-1`: the latest Ferrite's version, the link
// protocol it speaks, its .ffw (name, https URL, SHA-256); and the latest Console's version. The .ffw is still checked
// whole before use (UPD-21: Ferrite's signature inside), so the feed only says where to look. Pure, for the tests.
import { olderThan, sameVersion } from "./version.ts";

export type Feed = {
  format: "ferrite-feed-1";
  // `notes` (UPD-25.2, console#42): the recent releases' notes, newest first; optional, so a feed without them (and a
  // Console that doesn't know them) still works. Checked by notes.ts's feedNotes, not here.
  ferrite: { version: string; protocol: number; file: string; url: string; sha256: string; notes?: unknown };
  console: { version: string };
};

export function isFeed(j: unknown): j is Feed {
  const f = j as Feed;
  return (
    f?.format === "ferrite-feed-1" &&
    typeof f.ferrite?.version === "string" &&
    typeof f.ferrite.protocol === "number" &&
    typeof f.ferrite.url === "string" &&
    /^https:\/\//.test(f.ferrite.url) &&
    typeof f.ferrite.file === "string" &&
    /\.ffw$/i.test(f.ferrite.file) && // UPD-27: a signed update file, never a bare .btf
    /^[0-9a-f]{64}$/i.test(f.ferrite.sha256 ?? "") &&
    typeof f.console?.version === "string"
  );
}

/**
 * What the feed offers over `than` (the bundled release's version, "" for none): the release to use, a newer one that
 * needs another Console (decision 385: another link protocol), or nothing.
 */
export function newerIn(f: Feed | null, than: string, protocol: number): { usable: Feed["ferrite"] } | { needsConsole: string } | null {
  if (!f || (than && !olderThan(than, f.ferrite.version))) return null;
  return f.ferrite.protocol === protocol ? { usable: f.ferrite } : { needsConsole: f.ferrite.version };
}

/**
 * UPD-25.1 (console#84): a release Update offers (not a file picked by hand), checked once its signature verified:
 * the signed manifest's version (`signed`) must be the one the feed or Console's own manifest names (`claimed`),
 * and one from the feed must be newer than the release Console carries (`bundled`, "" for none). The reason it is
 * refused, or "".
 */
export function releaseProblem(signed: string, claimed: string, fromFeed: boolean, bundled: string): string {
  const src = fromFeed ? "the update feed" : "Console's release manifest";
  if (!sameVersion(signed, claimed)) return `The signed file is Ferrite ${signed || "(no version)"}, not the ${claimed} ${src} names: Console won't use it.`;
  if (fromFeed && bundled && !olderThan(bundled, signed)) return `Ferrite ${signed} from the update feed isn't newer than the ${bundled} Console carries: Console won't use it.`;
  return "";
}

/**
 * UPD-25.1: a file older than the radio's running Ferrite (`running`, "" when unknown). A release Update offers is
 * refused (`refuse`); a file picked by hand is a deliberate downgrade, allowed with a note.
 */
export function downgrade(file: string, running: string, byHand: boolean): { refuse: string } | { note: string } | null {
  if (!file || !running || !olderThan(file, running)) return null;
  return byHand
    ? { note: `A downgrade: this file is Ferrite ${file}, older than the ${running} on the radio. Install it only if you mean to go back.` }
    : { refuse: `The radio runs Ferrite ${running}, newer than this release (${file}). To go back on purpose, choose the file under Advanced.` };
}
