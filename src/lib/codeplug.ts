// The .ferrite codeplug: one zip holding a manifest and the JSON Console already writes for each part (channels and
// zones, Radio Settings, APRS settings, APRS contacts). Pure: no Svelte state, no DOM (unit-tested in Node:
// tests/unit/codeplug.test.ts). The format is docs/dev/codeplug-format.md in the docs repo; codeplug.svelte.ts
// gathers the parts from the pages and loads them back.
import { createZip, readZip } from "./zip.ts";

export const FORMAT = "ferrite-codeplug";
/** The format version this Console writes and the newest it reads. */
export const VERSION = 1;
/** The parts, in the order they are written; each is `<part>.json` in the zip. */
export const PARTS = ["channels", "settings", "aprs", "contacts"] as const;
export type Part = (typeof PARTS)[number];

/** What the radio said about itself when the file was saved (each only when known). Never its unique ID: codeplugs
 *  get shared, and the ID is a permanent hardware serial (the manifest's `radio_fingerprint` stands for it). */
export type RadioMeta = { callsign?: string; firmware?: string; build?: string };

export type Manifest = {
  format: typeof FORMAT;
  version: number;
  /** When the file was saved (ISO 8601, UTC). */
  created: string;
  /** The Console version that saved it. */
  console: string;
  radio: RadioMeta;
  /** The first 8 hex digits of SHA-256 over the radio's unique ID bytes (INFO's 12), when known: which radio, without
   *  the serial. Stored for later; nothing reads it yet. */
  radio_fingerprint?: string;
  /** The parts in the zip, in PARTS order. */
  parts: Part[];
};

/** Each part's JSON text, as the part's own save writes it. */
export type Parts = Partial<Record<Part, string>>;

export const CONTACTS_FORMAT = "ferrite-console-contacts";
export type Contact = { call: string; name: string };
export type ContactsFile = { format: typeof CONTACTS_FORMAT; version: 1; saved: string; radio: Record<string, string>; contacts: Contact[] };

/** The contacts part (APRS-37: the radio's address book). */
export function contactsJson(list: Contact[], saved: string, radio: Record<string, string>): string {
  const f: ContactsFile = { format: CONTACTS_FORMAT, version: 1, saved, radio, contacts: list.map((c) => ({ call: c.call, name: c.name })) };
  return JSON.stringify(f, null, 2);
}

/** The contacts part back, or why not (the calls and names are checked again when written). */
export function readContacts(text: string): ContactsFile {
  const f = JSON.parse(text) as ContactsFile;
  if (f?.format !== CONTACTS_FORMAT) throw new Error(`not a contacts file (format ${JSON.stringify(f?.format)})`);
  if (f.version !== 1) throw new Error(`contacts version ${f.version} is newer than this Console reads`);
  if (!Array.isArray(f.contacts) || !f.contacts.every((c) => typeof c?.call === "string" && typeof c?.name === "string"))
    throw new Error("its contacts aren't a list of {call, name}");
  return f;
}

/** `<who>-<yyyymmdd-hhmm>.ferrite`: the callsign, else "radio". */
export function codeplugName(who: string | undefined, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const w = (who ?? "").replace(/[^A-Za-z0-9-]/g, "") || "radio";
  return `${w}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.ferrite`;
}

/** The radio's fingerprint: SHA-256 over its unique ID's bytes as INFO gives them (12), the first 8 hex digits. */
export async function fingerprint(uid: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(uid)));
  return [...h.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function manifest(parts: Parts, radio: RadioMeta, console: string, created = new Date(), radioFingerprint?: string): Manifest {
  const r: RadioMeta = {};
  for (const k of ["callsign", "firmware", "build"] as const) if (radio[k]) r[k] = radio[k];
  // Key order as the doc shows it (JSON.stringify keeps insertion order).
  return {
    format: FORMAT,
    version: VERSION,
    created: created.toISOString(),
    console,
    radio: r,
    ...(radioFingerprint ? { radio_fingerprint: radioFingerprint } : {}),
    parts: PARTS.filter((p) => parts[p] !== undefined),
  };
}

/** The .ferrite file: manifest.json first, then each part present. */
export async function buildCodeplug(parts: Parts, m: Manifest): Promise<Blob> {
  const entries = [{ name: "manifest.json", data: JSON.stringify(m, null, 2) }];
  for (const p of m.parts) {
    const text = parts[p];
    if (text === undefined) throw new Error(`the manifest lists ${p} but there is no ${p}.json`);
    entries.push({ name: `${p}.json`, data: text });
  }
  const z = await createZip(entries);
  return new Blob([z], { type: "application/x-ferrite-codeplug" });
}

/** Whether the bytes start as a zip does (a local file header), not as JSON. */
export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** A .ferrite back to its manifest and parts' JSON text; refused (with a reason a person can act on) when it isn't
 *  one, is damaged, or is a newer format version than this Console reads. */
export async function readCodeplug(bytes: Uint8Array): Promise<{ manifest: Manifest; parts: Parts }> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(bytes);
  } catch (e) {
    throw new Error(`not a Ferrite codeplug: ${(e as Error).message}`);
  }
  const dec = new TextDecoder();
  const mf = files.get("manifest.json");
  if (!mf) throw new Error("not a Ferrite codeplug: a zip without manifest.json");
  let m: Manifest;
  try {
    m = JSON.parse(dec.decode(mf));
  } catch {
    throw new Error("not a Ferrite codeplug: its manifest.json isn't JSON");
  }
  if (m?.format !== FORMAT) throw new Error(`not a Ferrite codeplug: its manifest says format ${JSON.stringify(m?.format)}`);
  if (!Number.isInteger(m.version) || m.version < 1) throw new Error(`not a Ferrite codeplug: format version ${JSON.stringify(m.version)}`);
  if (m.version > VERSION)
    throw new Error(`a newer codeplug (format version ${m.version}) than this Console reads (version ${VERSION}): update Ferrite Console to open it`);
  const parts: Parts = {};
  // Parts this Console doesn't know (added later without a version change) are left alone.
  for (const p of PARTS) {
    if (!m.parts?.includes(p)) continue;
    const f = files.get(`${p}.json`);
    if (!f) throw new Error(`damaged codeplug: the manifest lists ${p} but there is no ${p}.json`);
    parts[p] = dec.decode(f);
  }
  return { manifest: m, parts };
}
