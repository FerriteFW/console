// The .ferrite codeplug: one zip holding a manifest and the JSON Console already writes for each part (channels and
// zones, range presets, Radio Settings, APRS settings, APRS contacts, quick messages, waypoints, DTMF memories). Pure: no Svelte state, no DOM (unit-tested in Node:
// tests/unit/codeplug.test.ts). The format is docs/dev/codeplug-format.md in the docs repo; codeplug.svelte.ts
// gathers the parts from the pages and loads them back.
import { createZip, readZip } from "./zip.ts";

export const FORMAT = "ferrite-codeplug";
/** The format version this Console writes and the newest it reads. */
export const VERSION = 1;
/** The parts, in the order they are written; each is `<part>.json` in the zip. */
export const PARTS = ["channels", "presets", "settings", "aprs", "contacts", "quick", "waypoints", "dtmf"] as const;
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

// The owner's lists (LINK-54 – LINK-56): quick.json, waypoints.json, dtmf.json. Written here as contacts.json is;
// the records and checks are the core's, so these only shape the JSON (each is checked again when written).

export const QUICK_FORMAT = "ferrite-console-quick";
export const WAYPOINTS_FORMAT = "ferrite-console-waypoints";
export const DTMF_FORMAT = "ferrite-console-dtmf";
/** TEXT-7: `own` false is the factory text (`text` then shows it, for reading). */
export type QuickEntry = { own: boolean; text: string };
/** GPS-10: lat and lon in degrees (to 1e-7), north and east positive; source "marked", "aprs", "link" or "grid". */
export type WaypointEntry = { name: string; lat: number; lon: number; source: string };
/** DTMF-12: a memory by its number (1-16): its symbols and name. */
export type DtmfEntry = { number: number; symbols: string; name: string };
type ListFile<F extends string, K extends string, T> = { format: F; version: 1; saved: string; radio: Record<string, string> } & Record<K, T[]>;
export type QuickFile = ListFile<typeof QUICK_FORMAT, "messages", QuickEntry>;
export type WaypointsFile = ListFile<typeof WAYPOINTS_FORMAT, "waypoints", WaypointEntry>;
export type DtmfFile = ListFile<typeof DTMF_FORMAT, "memories", DtmfEntry>;

/** The quick messages part: all nine, in order. */
export function quickJson(list: QuickEntry[], saved: string, radio: Record<string, string>): string {
  const f: QuickFile = { format: QUICK_FORMAT, version: 1, saved, radio, messages: list.map((q) => ({ own: q.own, text: q.text })) };
  return JSON.stringify(f, null, 2);
}

/** The waypoints part: newest first, as the radio lists them. */
export function waypointsJson(list: WaypointEntry[], saved: string, radio: Record<string, string>): string {
  const f: WaypointsFile = {
    format: WAYPOINTS_FORMAT,
    version: 1,
    saved,
    radio,
    waypoints: list.map((w) => ({ name: w.name, lat: w.lat, lon: w.lon, source: w.source })),
  };
  return JSON.stringify(f, null, 2);
}

/** The DTMF memories part: the ones set, by number. */
export function dtmfJson(list: DtmfEntry[], saved: string, radio: Record<string, string>): string {
  const f: DtmfFile = { format: DTMF_FORMAT, version: 1, saved, radio, memories: list.map((m) => ({ number: m.number, symbols: m.symbols, name: m.name })) };
  return JSON.stringify(f, null, 2);
}

function listFile(text: string, format: string, what: string, key: string): Record<string, unknown> {
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error(`not a ${what} file (not JSON)`);
  }
  if (f?.format !== format) throw new Error(`not a ${what} file (format ${JSON.stringify(f?.format)})`);
  if (f.version !== 1) throw new Error(`${what} version ${f.version} is newer than this Console reads`);
  if (!Array.isArray(f[key])) throw new Error(`its ${key} aren't a list`);
  return f;
}

const isStr = (v: unknown) => typeof v === "string";
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** The quick messages part back, or why not (nine of {own, text}). */
export function readQuick(text: string): QuickFile {
  const f = listFile(text, QUICK_FORMAT, "quick messages", "messages") as QuickFile;
  if (!f.messages.every((q) => typeof q?.own === "boolean" && isStr(q?.text))) throw new Error("its messages aren't a list of {own, text}");
  if (f.messages.length !== 9) throw new Error(`${f.messages.length} quick messages: the radio has 9`);
  return f;
}

/** The waypoints part back, or why not (at most 256 of {name, lat, lon, source}). */
export function readWaypoints(text: string): WaypointsFile {
  const f = listFile(text, WAYPOINTS_FORMAT, "waypoints", "waypoints") as WaypointsFile;
  if (!f.waypoints.every((w) => isStr(w?.name) && isNum(w?.lat) && isNum(w?.lon) && isStr(w?.source)))
    throw new Error("its waypoints aren't a list of {name, lat, lon, source}");
  if (f.waypoints.length > 256) throw new Error(`${f.waypoints.length} waypoints: the radio keeps 256`);
  return f;
}

/** The DTMF memories part back, or why not (numbers 1-16, each once). */
export function readDtmf(text: string): DtmfFile {
  const f = listFile(text, DTMF_FORMAT, "DTMF memories", "memories") as DtmfFile;
  if (!f.memories.every((m) => Number.isInteger(m?.number) && m.number >= 1 && m.number <= 16 && isStr(m?.symbols) && isStr(m?.name)))
    throw new Error("its memories aren't a list of {number (1-16), symbols, name}");
  if (new Set(f.memories.map((m) => m.number)).size !== f.memories.length) throw new Error("a memory number is there twice");
  return f;
}
