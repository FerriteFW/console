// The owner's lists as Svelte state (LINK-54 – LINK-56): the quick messages (APRS › Quick messages), the waypoints
// (APRS › Waypoints, and the map) and the DTMF memories (Radio Settings › DTMF memories). Each as Channels & Zones
// keeps its table: what the radio held when read (`base`), the list being edited (`items`), undo, the unwritten
// edits kept in IndexedDB for the next visit, and Write: a fresh read saved as a backup file, the diff with
// ferrite's own checks, the records on confirm (`WRITE_MANY`), then a read back. Records, checks and the waypoints'
// write order are the core's (core/src/lists.rs); only a radio whose HELLO says caps 128 has them.
import {
  dtmfCheck,
  dtmfFromRecord,
  dtmfRecord,
  P,
  quickCheck,
  quickFactory,
  quickFromRecord,
  quickRecord,
  waypointCheck,
  waypointFromRecord,
  waypointRecord,
  waypointWrites,
  type DtmfMemory,
  type QuickMessage,
  type Waypoint,
} from "./core";
import { download, stamp } from "./channels.svelte";
import { dtmfJson, quickJson, readDtmf, readQuick, readWaypoints, WAYPOINTS_MAX, waypointsJson } from "./codeplug";
import { radio } from "./radio.svelte";

export type ListField = { field: string; from: string; to: string };
export type ListChange = { kind: "added" | "changed" | "deleted"; label: string; name: string; fields: ListField[] };
export type Rec = { index: number; record: Uint8Array };
/** What a write does: the diff, the records in order, and what the radio would refuse (ferrite's words). */
export type ListPlan = { changes: ListChange[]; writes: Rec[]; problems: string[] };
export type ListWriteStep =
  | { step: "backup" }
  | { step: "review"; plan: ListPlan; backupName: string; drifted: boolean }
  | { step: "writing"; plan: ListPlan; done: number }
  | { step: "done"; plan: ListPlan; verified: boolean; error: string; written: number };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

/** A check's answer kept by the item's JSON: each runs ferrite's own link session, too slow for every render. None
 *  until the core has loaded. */
function memo<T>(check: (v: T) => string | undefined): (v: T) => string | undefined {
  const m = new Map<string, string | undefined>();
  return (v) => {
    if (!P) return undefined;
    const k = canon(v);
    if (!m.has(k)) {
      if (m.size > 2000) m.clear();
      m.set(k, check(v));
    }
    return m.get(k);
  };
}

/** The parts' `radio` block: what the radio said about itself, without its unique ID. */
function partRadio(): Record<string, string> {
  const i = radio.info;
  const m: Record<string, string> = { connection: radio.label };
  if (i) {
    m.firmware = i.firmware;
    m.callsign = i.callsign;
  }
  return m;
}

function fileBase() {
  const i = radio.info;
  const who = (i?.callsign || i?.uid_text?.replace(/\s/g, "").slice(0, 10) || "radio").replace(/[^A-Za-z0-9-]/g, "");
  return `ferrite-${who}-${stamp()}`;
}

export type ListKey = "quick" | "waypoints" | "dtmf";

abstract class ListEditor<T> {
  abstract readonly key: ListKey;
  /** "quick messages", for the words around it. */
  abstract readonly noun: string;
  abstract what(): number;
  /** The indexes a read covers (READ_MANY's end). */
  abstract readonly end: number;
  /** The list a radio with none of the owner's own would hold (the factory texts, no waypoints, no memories). */
  abstract empty(): T[];
  abstract decode(records: Map<number, Uint8Array>): T[];
  /** The diff from `base` (the radio's) to `want`; `checks` adds the records and what the radio would refuse (the
   *  core's: only once it has loaded, as a write's review does; the diff alone needs no core). */
  abstract plan(base: T[], want: T[], checks: boolean): ListPlan;
  /** The codeplug part's JSON, and back. */
  abstract fileText(list: T[], saved: string, radio: Record<string, string>): string;
  abstract parseFile(text: string): T[];

  /** What the radio held when last read (or written and read back); null before a read. */
  base = $state.raw<T[] | null>(null);
  /** The list being edited. */
  items = $state.raw<T[]>([]);
  /** The list before each edit, newest last (not kept across visits). */
  history = $state.raw<T[][]>([]);
  source = $state("");
  busy = $state("");
  error = $state("");
  write = $state<ListWriteStep | null>(null);
  /** Unwritten changes brought back from the last visit (for the notice), 0 once seen to. */
  restored = $state(0);
  /** False until the last visit's edits are looked for (the page's auto-read waits for it). */
  ready = $state(typeof indexedDB === "undefined");
  private forLink: unknown = null;

  #plan = $derived.by(() => this.plan(this.base ?? this.empty(), this.items, false));

  /** The changes Write would make (against the radio as read; the factory list when nothing was read). */
  get changes(): ListChange[] {
    return this.#plan.changes;
  }
  get pending() {
    return this.#plan.changes.length;
  }

  /** A radio is connected: it has these lists over the link (LINK-54 – LINK-56). */
  get supported() {
    return !!radio.connectedLink;
  }

  /** Reads once a connection is up (and the page open), unless unwritten edits would be dropped. */
  ensure() {
    const link = radio.connectedLink;
    if (!link || !this.ready || this.forLink === link || this.busy || this.write) return;
    this.forLink = link;
    if (this.supported && !this.pending) void this.read();
  }

  /** The list as the radio holds it now. Holds the link (the Live View pauses). */
  async readRadio(): Promise<T[]> {
    const link = radio.connectedLink;
    if (!link) throw new Error("Connect to a radio first.");
    if (!this.supported) throw new Error(`This radio's firmware has no ${this.noun} over the link: update Ferrite.`);
    radio.busy = `Reading ${this.noun}`;
    this.busy = `Reading ${this.noun}`;
    try {
      return this.decode(await link.readMany(this.what(), 0, this.end));
    } finally {
      radio.busy = "";
      this.busy = "";
    }
  }

  /** Into the list (and base); unwritten edits are dropped (the page asks first). */
  async read() {
    this.error = "";
    try {
      const got = await this.readRadio();
      this.base = clone(got);
      this.items = clone(got);
      this.history = [];
      this.restored = 0;
      this.source = `Read from ${radio.label} at ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** The list as it is now onto the undo list: before each edit. */
  protected remember() {
    this.history = [...this.history.slice(-99), clone(this.items)];
  }

  /** The list with one edit: `next` replaces it when it differs (one undo). */
  set(next: T[]) {
    if (same(next, this.items)) return;
    this.remember();
    this.items = next;
  }

  undo() {
    const prev = this.history.at(-1);
    if (!prev) return;
    this.history = this.history.slice(0, -1);
    this.items = prev;
  }

  /** Every unwritten change dropped: back to what was read. Undoable. */
  revert() {
    this.remember();
    this.items = clone(this.base ?? this.empty());
    this.restored = 0;
    this.source = this.base ? "Changes discarded: the list as read" : "";
  }

  /** The list as the codeplug part, unwritten changes too. */
  text(saved: string, radio: Record<string, string> = partRadio()): string {
    return this.fileText(this.items, saved, radio);
  }

  /** Whether Save as… has something of this list to save (read, opened or edited). */
  get any() {
    return this.base !== null || this.pending > 0;
  }

  /** A codeplug part (or an older single-part backup) into the list as unwritten changes: true when loaded, else
   *  `error` says why. */
  loadFile(text: string, from: string): boolean {
    this.error = "";
    try {
      const list = this.parseFile(text);
      this.remember();
      this.items = list;
      this.source = `Loaded from ${from}`;
      return true;
    } catch (e) {
      this.error = `${from}: ${(e as Error).message}`;
      return false;
    }
  }

  /** Step 1 of a write: a fresh read, saved as a backup file, then the plan against it for review. */
  async startWrite() {
    this.error = "";
    this.write = { step: "backup" };
    try {
      const fresh = this.rekey(await this.readRadio(), this.base);
      const backupName = `${fileBase()}-${this.key}-backup.json`;
      download(backupName, this.fileText(fresh, new Date().toISOString(), partRadio()), "application/json");
      const drifted = !!this.base && this.plan(this.base, fresh, false).changes.length > 0;
      this.write = { step: "review", plan: this.plan(fresh, this.items, true), backupName, drifted };
    } catch (e) {
      this.write = null;
      this.error = `Nothing written: the backup read failed (${(e as Error).message}).`;
    }
  }

  /** Step 2, on confirm: the records, then a read back to check. */
  async commitWrite() {
    const w = this.write;
    const link = radio.connectedLink;
    if (!w || w.step !== "review" || !link || w.plan.problems.length) return;
    const { plan } = w;
    this.write = { step: "writing", plan, done: 0 };
    let error = "";
    let written = plan.writes.length;
    radio.busy = `Writing ${this.noun}`;
    try {
      await link.writeRecords(this.what(), plan.writes, (done) => {
        written = done;
        this.write = { step: "writing", plan, done };
      });
      written = plan.writes.length;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      radio.busy = "";
    }
    let verified = false;
    try {
      const back = this.rekey(await this.readRadio(), this.items);
      verified = !error && this.plan(back, this.items, false).changes.length === 0;
      this.base = clone(back);
      if (!error) {
        this.items = clone(back);
        this.history = [];
        this.restored = 0;
      }
      this.source = `Written to ${radio.label} and read back at ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      error ||= `the read back failed: ${(e as Error).message}`;
    }
    this.write = { step: "done", plan, verified, error, written };
  }

  closeWrite() {
    this.write = null;
  }

  /** A fresh read's items matched to `like`'s (their keys, where a list has them): by default as they are. */
  protected rekey(list: T[], _like: T[] | null): T[] {
    return list;
  }

  forget() {
    this.forLink = null;
  }

  // ---- unwritten edits kept across visits ----

  async restore() {
    try {
      const saved = (await kept.get(this.key)) as { base: T[] | null; items: T[]; at: number } | undefined;
      if (saved && this.base === null && !this.history.length) {
        this.base = saved.base;
        this.items = saved.items;
        this.source = `Restored from your last visit (${new Date(saved.at).toLocaleString()})`;
        this.restored = this.pending;
        if (!this.restored) void kept.clear(this.key).catch(() => {});
      }
    } catch {
      /* nothing kept, or storage blocked */
    } finally {
      this.ready = true;
    }
  }

  keep() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    $effect.root(() => {
      $effect(() => {
        const n = this.pending;
        if (!this.ready) return;
        const snap = n ? { base: $state.snapshot(this.base), items: $state.snapshot(this.items), at: Date.now() } : null;
        clearTimeout(timer);
        timer = setTimeout(() => void (snap ? kept.put(this.key, snap) : kept.clear(this.key)).catch(() => {}), 250);
      });
    });
  }
}

/** Quick messages (TEXT-7, LINK-54): nine, by number; each the owner's text or the factory one. */
class QuickMessages extends ListEditor<QuickMessage> {
  readonly key = "quick";
  readonly noun = "quick messages";
  readonly end = 9;
  /** The factory texts, in order (TEXT-7). */
  factory: string[] = [];
  what() {
    return P.what.QUICK;
  }
  empty() {
    if (!this.factory.length && P) this.factory = quickFactory();
    return Array.from({ length: 9 }, (_, i) => ({ own: false, text: this.factory[i] ?? "" }));
  }
  decode(m: Map<number, Uint8Array>) {
    const out = this.empty();
    for (const [i, r] of m) {
      const q = quickFromRecord(r);
      if (q && i < out.length) out[i] = q;
    }
    return out;
  }
  /** The text the radio uses for one: its own, or the factory one. */
  shown(q: QuickMessage, i: number) {
    return q.own ? q.text : (this.factory[i] ?? q.text);
  }
  problem = memo((q: QuickMessage) => quickCheck(q));
  plan(base: QuickMessage[], want: QuickMessage[], checks: boolean): ListPlan {
    const changes: ListChange[] = [];
    const writes: Rec[] = [];
    const problems: string[] = [];
    const say = (q: QuickMessage | undefined, i: number) => (!q ? "" : q.own ? q.text : `factory: ${this.factory[i] ?? q.text}`);
    want.forEach((q, i) => {
      const b = base[i];
      if (b && b.own === q.own && (!q.own || b.text === q.text)) return;
      changes.push({ kind: "changed", label: `Quick ${i + 1}`, name: "", fields: [{ field: "text", from: say(b, i), to: say(q, i) }] });
      if (!checks) return;
      writes.push({ index: i, record: quickRecord(q) });
      const p = this.problem(q);
      if (p) problems.push(`quick message ${i + 1}: ${p.replace(/^quick message: /, "")}`);
    });
    return { changes, writes, problems };
  }
  fileText(list: QuickMessage[], saved: string, r: Record<string, string>) {
    return quickJson(list.map((q, i) => ({ own: q.own, text: this.shown(q, i) })), saved, r);
  }
  parseFile(text: string) {
    this.empty();
    return readQuick(text).messages.map((q, i) => ({ own: q.own, text: q.own ? q.text : (this.factory[i] ?? q.text) }));
  }
  /** One message's text as the owner's own. */
  setText(i: number, text: string) {
    const next = [...this.items];
    next[i] = { own: true, text };
    this.set(next);
  }
  /** One message back to the factory text. */
  factoryText(i: number) {
    const next = [...this.items];
    next[i] = { own: false, text: this.factory[i] ?? "" };
    this.set(next);
  }
}

/** A waypoint as the editor holds it: `key` says which is which across edits and reads (not sent). */
export type WaypointItem = Waypoint & { key: number };
let nextKey = 1;
const bare = (w: Waypoint): Waypoint => ({ name: w.name, lat: w.lat, lon: w.lon, source: w.source });
/** "45.50900, -75.85900": degrees from 1e-7. */
export const degrees = (w: Waypoint): [number, number] => [w.lat / 1e7, w.lon / 1e7];
export const SOURCE_WORDS: Record<string, string> = { marked: "Marked on the radio", aprs: "From an APRS station", link: "From Console", grid: "From a grid square" };

/** Waypoints (GPS-10, LINK-55): up to 2,032 (layout 3), newest first; added here they go on top, as the radio adds them. */
class Waypoints extends ListEditor<WaypointItem> {
  readonly key = "waypoints";
  readonly noun = "waypoints";
  readonly end = WAYPOINTS_MAX;
  readonly max = WAYPOINTS_MAX;
  what() {
    return P.what.WAYPOINT;
  }
  empty() {
    return [];
  }
  decode(m: Map<number, Uint8Array>) {
    return [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, r]) => waypointFromRecord(r))
      .filter((w): w is Waypoint => !!w)
      .map((w) => ({ ...w, key: nextKey++ }));
  }
  problem = memo((w: Waypoint) => waypointCheck(bare(w)));
  protected rekey(list: WaypointItem[], like: WaypointItem[] | null): WaypointItem[] {
    const free = [...(like ?? [])];
    return list.map((w) => {
      const k = free.findIndex((x) => same(bare(x), bare(w)));
      return k < 0 ? w : { ...w, key: free.splice(k, 1)[0].key };
    });
  }
  plan(base: WaypointItem[], want: WaypointItem[], checks: boolean): ListPlan {
    const writes = checks ? waypointWrites(base.map(bare), want.map(bare)) : [];
    const changes: ListChange[] = [];
    const byKey = new Map(base.map((w) => [w.key, w]));
    const wantKeys = new Set(want.map((w) => w.key));
    const added = want.filter((w) => !byKey.has(w.key));
    const deleted = base.filter((w) => !wantKeys.has(w.key));
    // One deleted and one added that are the same waypoint (a file opened, then read): no change.
    for (const a of [...added]) {
      const k = deleted.findIndex((d) => same(bare(d), bare(a)));
      if (k >= 0) {
        deleted.splice(k, 1);
        added.splice(added.indexOf(a), 1);
      }
    }
    const where = (w: Waypoint) => {
      const [la, lo] = degrees(w);
      return `${la.toFixed(5)}, ${lo.toFixed(5)}`;
    };
    for (const w of want) {
      const b = byKey.get(w.key);
      if (added.includes(w)) changes.push({ kind: "added", label: "Waypoint", name: w.name, fields: [{ field: "position", from: "", to: where(w) }] });
      else if (b && !same(bare(b), bare(w))) {
        const fields: ListField[] = [];
        if (b.name !== w.name) fields.push({ field: "name", from: b.name, to: w.name });
        if (b.lat !== w.lat || b.lon !== w.lon) fields.push({ field: "position", from: where(b), to: where(w) });
        if (b.source !== w.source) fields.push({ field: "source", from: b.source, to: w.source });
        changes.push({ kind: "changed", label: "Waypoint", name: w.name, fields });
      }
    }
    for (const d of deleted) changes.push({ kind: "deleted", label: "Waypoint", name: d.name, fields: [] });
    const problems: string[] = [];
    if (checks) {
      if (want.length > this.max) problems.push(`${want.length} waypoints: the radio keeps ${this.max}`);
      for (const w of want) {
        const p = this.problem(w);
        if (p) problems.push(`waypoint "${w.name}": ${p}`);
      }
    }
    // A list only reordered (a write that would add nothing new): the records still say so.
    if (checks && !changes.length && writes.length) changes.push({ kind: "changed", label: "Waypoints", name: "their order", fields: [] });
    return { changes, writes, problems };
  }
  fileText(list: WaypointItem[], saved: string, r: Record<string, string>) {
    return waypointsJson(list.map((w) => ({ name: w.name, lat: w.lat / 1e7, lon: w.lon / 1e7, source: w.source })), saved, r);
  }
  parseFile(text: string) {
    return readWaypoints(text).waypoints.map((w) => ({ name: w.name, lat: Math.round(w.lat * 1e7), lon: Math.round(w.lon * 1e7), source: w.source, key: nextKey++ }));
  }
  /** A new one on top (the newest), from Console. Its key. */
  add(name: string, pos: [number, number]): number {
    const key = nextKey++;
    this.set([{ name, lat: Math.round(pos[0] * 1e7), lon: Math.round(pos[1] * 1e7), source: "link", key }, ...this.items]);
    return key;
  }
  edit(key: number, patch: Partial<Waypoint>) {
    this.set(this.items.map((w) => (w.key === key ? { ...w, ...patch } : w)));
  }
  remove(key: number) {
    this.set(this.items.filter((w) => w.key !== key));
  }
}

/** DTMF memories (DTMF-12, LINK-56): 16 by number, each empty (null) or its symbols and a name. */
class DtmfMemories extends ListEditor<DtmfMemory | null> {
  readonly key = "dtmf";
  readonly noun = "DTMF memories";
  readonly end = 16;
  what() {
    return P.what.DTMF;
  }
  empty() {
    return Array.from({ length: 16 }, () => null);
  }
  decode(m: Map<number, Uint8Array>) {
    const out: (DtmfMemory | null)[] = this.empty();
    for (const [i, r] of m) if (i < 16) out[i] = dtmfFromRecord(r);
    return out;
  }
  problem = memo((m: DtmfMemory) => dtmfCheck(m));
  plan(base: (DtmfMemory | null)[], want: (DtmfMemory | null)[], checks: boolean): ListPlan {
    const changes: ListChange[] = [];
    const writes: Rec[] = [];
    const problems: string[] = [];
    want.forEach((m, i) => {
      const b = base[i] ?? null;
      if (same(b, m)) return;
      const label = `Memory ${i + 1}`;
      if (!b && m) changes.push({ kind: "added", label, name: m.name, fields: [{ field: "symbols", from: "", to: m.symbols }] });
      else if (b && !m) changes.push({ kind: "deleted", label, name: b.name, fields: [] });
      else if (b && m) {
        const fields: ListField[] = [];
        if (b.symbols !== m.symbols) fields.push({ field: "symbols", from: b.symbols, to: m.symbols });
        if (b.name !== m.name) fields.push({ field: "name", from: b.name, to: m.name });
        changes.push({ kind: "changed", label, name: m.name, fields });
      }
      if (!checks) return;
      writes.push({ index: i, record: dtmfRecord(m) });
      const p = m ? this.problem(m) : undefined;
      if (p) problems.push(`memory ${i + 1}: ${p}`);
    });
    return { changes, writes, problems };
  }
  fileText(list: (DtmfMemory | null)[], saved: string, r: Record<string, string>) {
    return dtmfJson(
      list.flatMap((m, i) => (m ? [{ number: i + 1, symbols: m.symbols, name: m.name }] : [])),
      saved,
      r,
    );
  }
  parseFile(text: string) {
    const out: (DtmfMemory | null)[] = this.empty();
    for (const m of readDtmf(text).memories) out[m.number - 1] = { symbols: m.symbols.toUpperCase(), name: m.name };
    return out;
  }
  /** One memory's symbols or name; empty symbols and name clear it (the radio clears both together). */
  edit(i: number, patch: Partial<DtmfMemory>) {
    const cur = this.items[i] ?? { symbols: "", name: "" };
    const m = { ...cur, ...patch };
    m.symbols = m.symbols.toUpperCase().replace(/\s/g, ""); // the radio takes lower case as capitals
    const next = [...this.items];
    next[i] = !m.symbols && !m.name ? null : m;
    this.set(next);
  }
  clear(i: number) {
    const next = [...this.items];
    next[i] = null;
    this.set(next);
  }
}

/** One IndexedDB record a list: the list being edited and what it was read as. */
const kept = (() => {
  const open = () =>
    new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open("ferrite-console-lists", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((ok, fail) => {
        const q = f(db.transaction("kv", mode).objectStore("kv"));
        q.onsuccess = () => ok(q.result);
        q.onerror = () => fail(q.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (k: string) => run<unknown>("readonly", (s) => s.get(k)),
    put: (k: string, v: unknown) => run("readwrite", (s) => s.put(v, k)),
    clear: (k: string) => run("readwrite", (s) => s.delete(k)),
  };
})();

export const quick = new QuickMessages();
export const waypoints = new Waypoints();
export const dtmf = new DtmfMemories();
export const lists = { quick, waypoints, dtmf };

if (typeof indexedDB !== "undefined" && typeof window !== "undefined") {
  for (const l of [quick, waypoints, dtmf]) {
    l.keep();
    void l.restore();
  }
  // A page closed with changes not written asks first.
  window.addEventListener("beforeunload", (e) => {
    if (quick.pending + waypoints.pending + dtmf.pending) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}
