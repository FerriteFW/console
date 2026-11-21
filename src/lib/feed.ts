// UPD-25 (ferrite decision 394): the release feed, format `ferrite-feed-1`: the latest Ferrite's version, the link
// protocol it speaks, its .ffw (name, https URL, SHA-256); and the latest Console's version. The .ffw is still checked
// whole before use (UPD-21: Ferrite's signature inside), so the feed only says where to look. Pure, for the tests.
import { olderThan } from "./version.ts";

export type Feed = {
  format: "ferrite-feed-1";
  ferrite: { version: string; protocol: number; file: string; url: string; sha256: string };
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
