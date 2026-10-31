// Channels & Zones as Svelte state: the set read from the radio (`base`), the table being edited (`table`), and the
// flows around them: read (READ records over the link, part by part), write (a fresh read saved as a backup file
// first, then the diff, then the write session on confirm), CHIRP CSV in and out, backup files out and back in.
// Unwritten edits are kept in IndexedDB (restored on the next visit); each table edit can be undone (`undo`).
// Every record layout, check, diff and conversion is the Rust core's; this file only moves them and the files.
import {
  P,
  backupFile,
  checkPreset,
  chirpExport,
  chirpImport,
  type ChirpNewZone,
  decodePresets,
  decodeSet,
  newChannel,
  newPreset,
  newZone,
  normalizeChannel,
  normalizePreset,
  normalizeZone,
  positionFromRecord,
  positionRecord,
  presetSkipsFromRecord,
  presetSkipsRecord,
  presetsFile,
  presetsPlan,
  presetsRestore,
  restoreFile,
  settingsHome,
  writePlan,
  type Channel,
  type ChannelSet,
  type ChirpImport,
  type LibraryAdded,
  type Plan,
  type Preset,
  type PresetPlan,
  type Zone,
} from "./core";
import { WriteError } from "./link";
import { radio } from "./radio.svelte";

/** A read's progress; total 0 is an indeterminate bar (how much is to come isn't known yet). */
export type Progress = { label: string; done: number; total: number };
/** CHAN-17: the radio's home channel (1-1000), null for none, undefined when not known (not read: a demo radio). */
export type Home = number | null | undefined;
/** The home channel a write sets (`home N` on the terminal after the records: the settings record isn't the table's). */
export type HomeOp = { from: number | null; to: number | null };
/** A read: the set, its home channel, whether the radio stores positions (LINK-53: HELLO caps 64), and its range
 *  presets (null: the radio didn't give them), with their skip lists when the radio gives those (`canSkips`,
 *  LINK-58: caps2 1). */
export type ReadResult = { set: ChannelSet; home: Home; canPos: boolean; presets: Preset[] | null; canSkips: boolean };
/** The table, its home channel and the range presets, as the undo list keeps them. */
type Snap = { set: ChannelSet; home: Home; presets: Preset[] };
/** The write dialog's steps. */
/** The range presets' part of a write (null when the table has none to write); `skipsKept`: the table has skip lists
 *  the radio's firmware can't take (LINK-58), left out of the write and kept in the table. */
type Pre = { presets: PresetPlan | null; skipsKept?: boolean };
export type WriteStep =
  | { step: "backup" }
  | ({ step: "review"; plan: Plan; home: HomeOp | null; canPos: boolean; fresh: ChannelSet; backupName: string; drifted: boolean } & Pre)
  | ({ step: "writing"; plan: Plan; home: HomeOp | null; canPos: boolean; done: number } & Pre)
  | ({ step: "done"; plan: Plan; home: HomeOp | null; canPos: boolean; verified: boolean; error: string; written: number } & Pre);

/** How many changes a write makes: the plan's records, the positions (to a radio that stores them), the range
 *  presets and the home channel. */
export const writeCount = (w: { plan: Plan; home: HomeOp | null; canPos: boolean } & Pre) =>
  w.plan.ops.length + (w.canPos ? w.plan.positions.length : 0) + (w.presets?.ops.length ?? 0) + (w.presets?.skips.length ?? 0) + (w.home ? 1 : 0);
/** Position changes a write leaves out: the radio's firmware can't store them (no caps 64). */
export const skippedPositions = (w: { plan: Plan; canPos: boolean }) => (w.canPos ? 0 : w.plan.positions.length);

/** LINK-53: a radio that can't store positions keeps none, so Console keeps them: each channel read gets the
 *  position `from` has for it (same number, frequency and name). */
function carryPositions(set: ChannelSet, from: ChannelSet | null) {
  if (!from) return;
  const by = new Map(from.channels.map((c) => [c.number, c]));
  for (const c of set.channels) {
    const f = by.get(c.number);
    if (!c.pos && f?.pos && f.rx === c.rx && f.name === c.name) c.pos = [...f.pos];
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** JSON with keys sorted: the core's objects come with keys in either struct or sorted order. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  );
const sameJson = (a: unknown, b: unknown) => canon(a) === canon(b);
/** A preset's record as the diff compares it: its fields, not its place in the list or where it was read. */
const presetRecord = (p: Preset | undefined) => p && { name: p.name, low: p.low, high: p.high, step: p.step, mode: p.mode, resume: p.resume };
/** A preset as the table's changes count it: its record and its skip list (SCAN-10). */
const presetFields = (p: Preset | undefined) => p && { ...presetRecord(p), skips: p.skips ?? [] };

/** A file to the user's downloads. */
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The channels part's JSON, as far as Console counts it (core/src/plan.rs `Backup`). */
export type ChannelsFile = { format: string; version: number; zones: unknown[]; channels: unknown[] };

/** A channel's `pos` as an object to spread: none leaves the key out (the core's JSON has no `pos` without one). */
const posOf = (p: [number, number] | undefined): { pos?: [number, number] } => (p ? { pos: p } : {});

export function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class Channels {
  /** What the radio held when last read (or written and read back); null before a read. */
  base = $state<ChannelSet | null>(null);
  /** The table: the set being edited. */
  table = $state<ChannelSet>({ zones: [], channels: [] });
  /** The home channel as read (CHAN-17: in the settings record, read with the channels). */
  baseHome = $state<Home>(undefined);
  /** The home channel the table wants: it follows its channel through swaps and renumbers (CHAN-18). */
  home = $state<Home>(undefined);
  /** The range presets as read (MENU 0 1 4); null before a read, or from a radio that didn't give them. */
  basePresets = $state<Preset[] | null>(null);
  /** The range presets being edited, numbered in order. */
  presets = $state<Preset[]>([]);
  /** Where the table came from, for the status line. */
  source = $state("");
  progress = $state<Progress | null>(null);
  error = $state("");
  /** Notes from the last read or import. */
  notes = $state<string[]>([]);
  write = $state<WriteStep | null>(null);
  imported = $state<(ChirpImport & { file: string }) | null>(null);
  /** The table before each edit, newest last, for `undo` (not kept across visits). */
  history = $state.raw<Snap[]>([]);
  /** Unwritten changes brought back from the last visit (for the notice), 0 once seen to. */
  restored = $state(0);
  /** False until the last visit's edits are looked for (the page's auto-read waits for it). */
  ready = $state(typeof indexedDB === "undefined");
  #reading: Promise<void> | null = null;

  #dirty = $derived.by(() => {
    const base = this.base ?? { zones: [], channels: [] };
    const bc = new Map(base.channels.map((c) => [c.number, c]));
    const tc = new Set(this.table.channels.map((c) => c.number));
    const changed = new Set<number>();
    for (const c of this.table.channels) if (!sameJson(bc.get(c.number), c)) changed.add(c.number);
    const deleted = base.channels.filter((c) => !tc.has(c.number)).length;
    const zones = new Set<number>();
    for (const z of this.table.zones) if (!sameJson(base.zones[z.number - 1], z)) zones.add(z.number);
    const zonesDeleted = Math.max(0, base.zones.length - this.table.zones.length);
    const home = this.homeChanged;
    // Range presets: by where each was read (origin), so one deleted doesn't count the ones after it as changed.
    const bp = this.basePresets ?? [];
    const presets = new Set<number>();
    for (const p of this.presets) if (!p.origin || !sameJson(presetFields(bp[p.origin - 1]), presetFields(p))) presets.add(p.number);
    const kept = new Set(this.presets.map((p) => p.origin));
    const presetsDeleted = bp.filter((p) => !kept.has(p.number)).length;
    const count = changed.size + deleted + zones.size + zonesDeleted + presets.size + presetsDeleted + (home ? 1 : 0);
    return { changed, deleted, zones, zonesDeleted, presets, presetsDeleted, home, count, any: count > 0 };
  });

  /** Whether the table's home channel differs from the one read (only when both are known). */
  get homeChanged() {
    return this.home !== undefined && this.baseHome !== undefined && this.home !== this.baseHome;
  }

  /** Rows (by number) that differ from what was read: changed, added; and how many were deleted. */
  get dirty() {
    return this.#dirty;
  }

  /** How many changes Write would make (channels and zones changed, added or deleted). */
  get pending() {
    return this.#dirty.count;
  }

  /** The table as it is now onto the undo list: called before each edit. */
  private remember() {
    this.history = [
      ...this.history.slice(-99),
      { set: clone($state.snapshot(this.table) as ChannelSet), home: this.home, presets: clone($state.snapshot(this.presets) as Preset[]) },
    ];
  }

  /** The last edit undone. */
  undo() {
    const prev = this.history.at(-1);
    if (!prev) return;
    this.history = this.history.slice(0, -1);
    this.table = prev.set;
    this.home = prev.home;
    this.presets = prev.presets;
  }

  private radioMeta(): Record<string, string> {
    const i = radio.info;
    const m: Record<string, string> = { connection: radio.label };
    if (i) {
      m.firmware = i.firmware;
      m.callsign = i.callsign;
      if (i.uid_text) m.uid = i.uid_text;
    }
    return m;
  }

  private fileBase() {
    const i = radio.info;
    const who = (i?.callsign || i?.uid_text?.replace(/\s/g, "").slice(0, 10) || "radio").replace(/[^A-Za-z0-9-]/g, "");
    return `ferrite-${who}-${stamp()}`;
  }

  /** Every zone and channel on the radio, read record by record, and its home channel (CHAN-17, from the settings
   *  record). Holds the link (the Live View pauses). */
  async readRadio(): Promise<ReadResult> {
    const link = radio.connectedLink;
    if (!link) throw new Error("Connect to a radio first.");
    const { ZONE, CHANNEL, POSITION } = P.what;
    radio.busy = "Reading channels";
    // Something shows at once (an indeterminate bar: total 0), before INFO's answer.
    this.progress = { label: "Reading zones…", done: 0, total: 0 };
    try {
      const info = await link.info();
      // LINK-40: several whole records an answer; the progress moves as each answer arrives.
      const zmap = info.zones
        ? await link.readMany(ZONE, 0, info.zones, (_at, got) => {
            this.progress = { label: `Reading zones: ${got} of ${info.zones}`, done: got, total: info.zones };
          })
        : new Map<number, Uint8Array>();
      this.progress = { label: "Reading channels…", done: 0, total: info.channels || 0 };
      const cmap = await link.readMany(CHANNEL, 0, 1000, (at, got) => {
        // By count (INFO's channels); by number only when the radio didn't say how many.
        this.progress = info.channels
          ? { label: `Reading channels: ${got} of ${info.channels}`, done: got, total: info.channels }
          : { label: `Reading channels: at ${Math.min(at, 1000)} of 1000`, done: at, total: 1000 };
      });
      const zones: Uint8Array[] = [];
      for (let i = 0; i < info.zones; i++) {
        const r = zmap.get(i);
        if (!r) throw new Error(`Zone ${i + 1} wasn't there (the radio said ${info.zones} zones).`);
        zones.push(r);
      }
      const chans = [...cmap.entries()].sort((x, y) => x[0] - y[0]).map(([, r]) => r);
      const { set, bad } = decodeSet(zones, chans);
      this.notes = bad;
      // LINK-53: positions, only from a radio that has them (an older one refuses what 7). A read lists only the
      // channels that have one.
      const canPos = (link.caps & P.caps.POSITION) !== 0;
      if (canPos) {
        this.progress = { label: "Reading positions…", done: 0, total: 0 };
        const pmap = await link.readMany(POSITION, 0, 1000, (at, got) => {
          // How many have one isn't known before the end: the count so far, the bar by channel number.
          this.progress = { label: `Reading positions: ${got}`, done: Math.min(at, 1000), total: 1000 };
        });
        for (const c of set.channels) {
          const r = pmap.get(c.number - 1);
          const p = r ? positionFromRecord(r) : null;
          if (p) c.pos = p;
        }
      }
      // Range presets (MENU 0 1 4): INFO says how many.
      let presets: Preset[] | null = null;
      try {
        this.progress = { label: "Reading range presets…", done: 0, total: info.presets || 0 };
        const pmap = info.presets ? await link.readMany(P.what.PRESET, 0, info.presets) : new Map<number, Uint8Array>();
        const recs = [...pmap.entries()].sort((x, y) => x[0] - y[0]).map(([, r]) => r);
        const got = decodePresets(recs);
        presets = got.presets;
        this.notes = [...this.notes, ...got.bad];
      } catch {
        presets = null; // a radio that doesn't give them: the table's stay as they are, and none are written
      }
      // LINK-58: each preset's skipped frequencies, from a radio whose second caps byte says so (a read lists the
      // presets that have any).
      const canSkips = !!presets && (link.caps2 & P.caps2.PRESET_SKIPS) !== 0;
      if (canSkips && presets?.length) {
        this.progress = { label: "Reading skipped frequencies…", done: 0, total: 0 };
        const smap = await link.readMany(P.what.PRESET_SKIPS, 0, presets.length);
        for (const [i, r] of smap) {
          if (!presets[i]) continue;
          // A blank entry (erased flash: 0xFFFFFFFF, or 0) is no frequency: left out, and said so.
          const all = presetSkipsFromRecord(r) ?? [];
          presets[i].skips = all.filter((f) => f !== 0xffffffff && f !== 0);
          const blank = all.length - presets[i].skips.length;
          if (blank) this.notes = [...this.notes, `range preset ${i + 1}: ${blank} blank skipped ${blank === 1 ? "frequency" : "frequencies"} left out (Write with a list of its own clears them on the radio)`];
        }
      }
      let home: Home;
      try {
        const rec = await link.readRecord(P.what.SETTINGS, 0);
        home = rec ? settingsHome(rec) : undefined;
      } catch {
        home = undefined; // a radio without the record (the demo radio): the home channel isn't known
      }
      return { set, home, canPos, presets, canSkips };
    } finally {
      radio.busy = "";
      this.progress = null;
    }
  }

  /** Read into the table (and base). Unwritten edits are dropped: the caller asks first. A read already going is
   *  joined, not started again. */
  read(): Promise<void> {
    this.#reading ??= (async () => {
      this.error = "";
      try {
        const { set, home, canPos, presets } = await this.readRadio();
        if (!canPos) carryPositions(set, $state.snapshot(this.table) as ChannelSet);
        this.base = clone(set);
        this.table = clone(set);
        this.baseHome = this.home = home;
        this.basePresets = presets;
        this.presets = clone(presets ?? []);
        this.history = [];
        this.restored = 0;
        this.source = `Read from ${radio.label} at ${new Date().toLocaleTimeString()}`;
      } catch (e) {
        this.error = (e as Error).message;
      } finally {
        this.#reading = null;
      }
    })();
    return this.#reading;
  }

  /** A fresh read saved as a backup file: the radio as it is now. */
  async backupRadio(): Promise<ReadResult & { name: string }> {
    const { set, home, canPos, presets, canSkips } = await this.readRadio();
    const name = `${this.fileBase()}-backup.json`;
    download(name, backupFile(set, new Date().toISOString(), this.radioMeta()), "application/json");
    if (presets?.length) download(`${this.fileBase()}-presets.json`, presetsFile(presets, new Date().toISOString(), this.radioMeta()), "application/json");
    return { set, home, canPos, presets, canSkips, name };
  }

  /** The range presets as `.ferrite`'s presets.json, unwritten changes too. */
  presetsText(saved: string, radio: Record<string, string>): string {
    return presetsFile($state.snapshot(this.presets) as Preset[], saved, radio);
  }

  /** presets.json (a codeplug's part) into the table as unwritten changes: each takes the place of the radio's preset
   *  with its number (keeping that one's skipped frequencies); true when loaded, else `error` says why. */
  loadPresets(text: string, name: string): boolean {
    this.error = "";
    try {
      const r = presetsRestore(text);
      const have = this.basePresets?.length ?? 0;
      this.remember();
      this.presets = r.presets.map((p, i) => ({ ...p, number: i + 1, ...(i < have ? { origin: i + 1 } : {}) }));
      return true;
    } catch (e) {
      this.error = `${name}: ${(e as Error).message}`;
      return false;
    }
  }

  /** The table as the channels part's JSON (the backup format: `.ferrite`'s channels.json), unwritten changes too. */
  fileText(saved: string, radio: Record<string, string>): string {
    return backupFile($state.snapshot(this.table) as ChannelSet, saved, radio);
  }

  /** A backup file (or a codeplug's channels.json) into the table as unwritten changes (Write then shows the diff
   *  against the radio): true when loaded, else `error` says why. */
  loadFile(text: string, name: string): boolean {
    this.error = "";
    try {
      const r = restoreFile(text);
      this.remember();
      this.table = r.set;
      this.source = `Loaded ${name} (saved ${r.saved}${r.radio.callsign ? `, ${r.radio.callsign}` : ""})`;
      this.notes = [];
      return true;
    } catch (e) {
      this.error = `${name}: ${(e as Error).message}`;
      return false;
    }
  }

  /** Step 1 of a write: a fresh read, saved as a backup file, then the plan against it for review. */
  async startWrite() {
    this.error = "";
    this.write = { step: "backup" };
    try {
      const { set: fresh, home: freshHome, canPos, presets: freshPresets, canSkips, name } = await this.backupRadio();
      // A radio without positions: the diff's positions are against those Console kept (the table as read).
      if (!canPos) carryPositions(fresh, this.base ? (clone(this.base) as ChannelSet) : null);
      const plan = writePlan(fresh, this.table);
      // Range presets: only to a radio that gave them, and only when the table's differ from what it holds now.
      const want = $state.snapshot(this.presets) as Preset[];
      const presets = freshPresets ? presetsPlan(freshPresets, this.presetsAgainst(freshPresets, want), canSkips) : null;
      const skipsKept = !!freshPresets && !canSkips && want.some((p) => p.skips?.length);
      const drifted = (!!this.base && !sameJson(this.base, fresh)) || (!!this.basePresets && !!freshPresets && !sameJson(this.basePresets, freshPresets));
      // The home channel goes only when the table moved it (a swap or renumber here), and only where the radio's differs.
      const to = this.home ?? null;
      const home = this.homeChanged && freshHome !== undefined && freshHome !== to ? { from: freshHome, to } : null;
      this.write = {
        step: "review",
        plan,
        home,
        canPos,
        fresh,
        backupName: name,
        drifted,
        presets: presets && (presets.ops.length || presets.problems.length || presets.skips.length) ? presets : null,
        skipsKept,
      };
    } catch (e) {
      this.write = null;
      this.error = `Nothing written: the backup read failed (${(e as Error).message}).`;
    }
  }

  /** Step 2, on confirm: the write session, then a read back to check. */
  async commitWrite() {
    const w = this.write;
    const link = radio.connectedLink;
    if (!w || w.step !== "review" || !link || w.plan.problems.length) return;
    const { plan, home, canPos, presets } = w;
    this.write = { step: "writing", plan, home, canPos, done: 0, presets };
    let error = "";
    let written = writeCount(w);
    radio.busy = "Writing channels";
    try {
      if (plan.ops.length) {
        await link.writeSession(new Uint8Array(plan.begin), plan.ops, (done) => {
          this.write = { step: "writing", plan, home, canPos, done, presets };
        });
      }
      // LINK-53: positions after the records they belong to (a new channel must be there first); to a radio
      // that can't store them, nothing (the review said so).
      if (canPos && plan.positions.length) {
        const want = new Map(this.table.channels.map((c) => [c.number, c.pos]));
        const recs = plan.positions.map((n) => ({ index: n - 1, record: positionRecord(want.get(n)) }));
        try {
          await link.writePositions(recs, (done) => {
            this.write = { step: "writing", plan, home, canPos, done: plan.ops.length + done, presets };
          });
        } catch (e) {
          throw new Error(`positions: ${(e as Error).message}`);
        }
      }
      // Range presets, in a session of their own (deletions first: each kept one keeps its skipped frequencies).
      if (presets?.ops.length) {
        const before = plan.ops.length + (canPos ? plan.positions.length : 0);
        try {
          await link.writeSession(new Uint8Array(presets.begin), presets.ops, (done) => {
            this.write = { step: "writing", plan, home, canPos, done: before + done, presets };
          });
        } catch (e) {
          throw new Error(`range presets: ${(e as Error).message}`);
        }
      }
      // LINK-58: the skip lists after the presets (a list stays with the preset in its place).
      if (presets?.skips.length) {
        const before = plan.ops.length + (canPos ? plan.positions.length : 0) + presets.ops.length;
        try {
          await link.writeRecords(
            P.what.PRESET_SKIPS,
            presets.skips.map(([index, r]) => ({ index, record: new Uint8Array(r) })),
            (done) => (this.write = { step: "writing", plan, home, canPos, done: before + done, presets }),
          );
        } catch (e) {
          throw new Error(`skipped frequencies: ${(e as Error).message}`);
        }
      }
      // After the records: `home N` needs channel N on the radio.
      if (home) {
        await link.cmd(`home ${home.to ?? "none"}`);
        this.write = { step: "writing", plan, home, canPos, done: writeCount(w), presets };
      }
    } catch (e) {
      error = (e as Error).message;
      written = e instanceof WriteError ? e.done : plan.ops.length;
    } finally {
      radio.busy = "";
    }
    let verified = false;
    try {
      const { set: back, home: backHome, canPos: backPos, presets: backPresets, canSkips: backSkips } = await this.readRadio();
      if (!backPos) carryPositions(back, $state.snapshot(this.table) as ChannelSet);
      this.base = clone(back);
      this.baseHome = backHome;
      // Skip lists a radio can't take (no caps2) stay in the table: compared only where it gave them.
      const cmp = backSkips ? presetFields : presetRecord;
      const presetsSame = !backPresets || sameJson(backPresets.map(cmp), ($state.snapshot(this.presets) as Preset[]).map((p) => cmp(this.tidy(p))));
      verified = !error && sameJson(back, this.table) && (this.home === undefined || backHome === this.home) && presetsSame;
      if (backPresets) this.basePresets = backPresets;
      if (!error) {
        this.table = clone(back);
        this.home = backHome;
        if (backPresets && backSkips) this.presets = clone(backPresets);
        else if (backPresets) this.presets = backPresets.map((p, i) => ({ ...p, skips: this.presets[i]?.skips ?? [] }));
        this.history = [];
        this.restored = 0;
      }
      this.source = `Written to ${radio.label} and read back at ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      error ||= `the read back failed: ${(e as Error).message}`;
    }
    this.write = { step: "done", plan, home, canPos, verified, error, written, presets, skipsKept: w.skipsKept };
  }

  closeWrite() {
    this.write = null;
  }

  /** CHIRP CSV: parse a file for review (applied with `applyImport`). */
  importChirp(text: string, file: string) {
    this.error = "";
    try {
      this.imported = { ...chirpImport(text, this.table.zones), file };
    } catch (e) {
      this.error = `${file}: ${(e as Error).message}`;
    }
  }

  /** The import into the table: by number over what is there, or replacing every channel. */
  applyImport(replace: boolean) {
    const imp = this.imported;
    if (!imp) return;
    this.remember();
    const byNum = new Map((replace ? [] : this.table.channels).map((c) => [c.number, c]));
    for (const c of imp.channels) {
      // Merge: what CHIRP's columns can't hold stays as the table had it (an export and import changes nothing).
      const was = byNum.get(c.number);
      byNum.set(
        c.number,
        was
          ? { ...c, squelch: was.squelch, busy: was.busy, reverse: was.reverse, aprs: was.aprs, hidden: was.hidden, end_tone: was.end_tone, tail: was.tail, keep: was.keep, ...posOf(c.pos ?? was.pos) }
          : c,
      );
    }
    this.table.channels = [...byNum.values()].sort((a, b) => a.number - b.number);
    this.source = `${imp.channels.length} channels imported from ${imp.file}${replace ? " (replacing all)" : ""}`;
    this.notes = imp.notes;
    this.imported = null;
  }

  /** The import as new channels in a new zone (the core numbered them: `chirpNewZone`). */
  applyImportNewZone(nz: ChirpNewZone) {
    const imp = this.imported;
    if (!imp || !nz.zone || nz.room || nz.name_error) return;
    this.remember();
    this.table.zones = [...this.table.zones, nz.zone];
    this.table.channels = [...this.table.channels, ...nz.channels].sort((a, b) => a.number - b.number);
    this.source = `${nz.channels.length} channels imported from ${imp.file} as ${nz.numbers} in new zone "${nz.zone.name}"`;
    this.notes = imp.notes;
    this.imported = null;
  }

  /** The library's channels and new zones into the table (the core numbered and checked them). */
  addLibrary(a: LibraryAdded, what: string) {
    this.error = "";
    this.remember();
    this.table.zones = [...this.table.zones, ...a.zones];
    this.table.channels = [...this.table.channels, ...a.channels].sort((x, y) => x.number - y.number);
    const z = a.zones.length ? `, ${a.zones.length} new ${a.zones.length === 1 ? "zone" : "zones"}` : "";
    const sk = a.skipped ? `, ${a.skipped} skipped` : "";
    this.source = `${a.channels.length} channels added from ${what}${z}${sk}`;
    this.notes = a.notes;
  }

  exportChirp() {
    download(`${this.fileBase()}-chirp.csv`, chirpExport(this.table), "text/csv");
  }

  // ---- range presets (MENU 0 1 4) ----

  /** The table's presets against what the radio holds now: when the radio's changed since the read (a preset added or
   *  deleted there), the ones read keep their place only where the radio still has the same one there. */
  private presetsAgainst(fresh: Preset[], want: Preset[]): Preset[] {
    const base = this.basePresets ?? [];
    return want.map((p) => {
      if (!p.origin) return p;
      const was = base[p.origin - 1];
      const now = fresh[p.origin - 1];
      return was && now && sameJson(presetRecord(was), presetRecord(now)) ? p : { ...p, origin: undefined };
    });
  }

  /** A preset as the radio would hold it (the core's words and MHz), or as typed when the radio would refuse it. */
  private tidy(p: Preset): Preset {
    try {
      return { ...normalizePreset(p), number: p.number, ...(p.origin ? { origin: p.origin } : {}) };
    } catch {
      return p;
    }
  }

  /** Why the radio would refuse this preset, or undefined. */
  presetProblem(p: Preset): string | undefined {
    return checkPreset(p);
  }

  /** One field of a preset, normalised by the core as the radio would hold it; a value that doesn't parse stays as
   *  typed (the row says what is wrong). */
  editPreset<K extends "name" | "low" | "high" | "step" | "mode" | "resume">(number: number, k: K, v: string) {
    const i = this.presets.findIndex((p) => p.number === number);
    if (i < 0) return;
    const was = $state.snapshot(this.presets[i]) as Preset;
    const next = this.tidy({ ...was, [k]: v });
    if (sameJson(was, next)) return;
    this.remember();
    this.presets[i] = next;
  }

  /** SCAN-10: a preset's skipped frequencies (10 Hz), in order; checked as the radio checks them when written. */
  setPresetSkips(number: number, skips: number[]) {
    const i = this.presets.findIndex((p) => p.number === number);
    if (i < 0 || sameJson(this.presets[i].skips ?? [], skips)) return;
    this.remember();
    this.presets[i] = { ...($state.snapshot(this.presets[i]) as Preset), skips: [...skips] };
  }

  /** A new preset at the end (2 m's band, as the radio's own new one): its number, or null when 16 are there. */
  addPreset(max = 16): number | null {
    const n = this.presets.length + 1;
    if (n > max) return null;
    this.remember();
    this.presets = [...this.presets, newPreset(n, `Range ${n}`)];
    return n;
  }

  /** A preset out of the table (its skipped frequencies go with it on Write); the ones after it move up. */
  deletePreset(number: number) {
    this.remember();
    this.presets = this.presets.filter((p) => p.number !== number).map((p, i) => ({ ...p, number: i + 1 }));
  }

  // ---- table edits ----

  setChannel(number: number, c: Channel) {
    const i = this.table.channels.findIndex((x) => x.number === number);
    if (i < 0 || sameJson(this.table.channels[i], c)) return;
    this.remember();
    this.table.channels[i] = c;
  }

  /** One field of a channel, normalised by the core as the radio would hold it; a value that doesn't parse stays as
   *  typed (the row's marker says what is wrong). */
  edit<K extends keyof Channel>(number: number, k: K, v: Channel[K]) {
    const c = this.table.channels.find((x) => x.number === number);
    if (!c) return;
    const next = { ...($state.snapshot(c) as Channel), [k]: v };
    let out = next;
    try {
      out = normalizeChannel(next);
    } catch {
      /* kept as typed */
    }
    this.setChannel(number, out);
  }

  /** One change to several channels (the bulk bar), each through the core's normalising as a row edit is; one undo. */
  setMany(numbers: Iterable<number>, patch: Partial<Channel>) {
    const want = new Set(numbers);
    this.remember();
    this.table.channels = this.table.channels.map((c) => {
      if (!want.has(c.number)) return c;
      const next = { ...($state.snapshot(c) as Channel), ...patch };
      try {
        return normalizeChannel(next);
      } catch {
        return next; // kept as set: the row's marker says what is wrong
      }
    });
  }

  addChannel(): number | null {
    const used = new Set(this.table.channels.map((c) => c.number));
    let n = 1;
    while (used.has(n)) n++;
    if (n > 1000) return null;
    this.remember();
    this.table.channels = [...this.table.channels, newChannel(n, "146.52")].sort((a, b) => a.number - b.number);
    return n;
  }

  /** Channels out of the table (undoable): how many went. */
  deleteChannels(numbers: Iterable<number>): number {
    const gone = new Set(numbers);
    const before = this.table.channels.length;
    this.remember();
    this.table.channels = this.table.channels.filter((c) => !gone.has(c.number));
    if (this.home != null && gone.has(this.home)) this.home = null; // CHAN-18: deleting the channel clears it
    return before - this.table.channels.length;
  }

  /** A channel to another number (free ones only). */
  renumber(from: number, to: number): string {
    if (!(to >= 1 && to <= 1000)) return "Channels are 1 to 1000.";
    if (this.table.channels.some((c) => c.number === to)) return `Channel ${to} is in use.`;
    const c = this.table.channels.find((x) => x.number === from);
    if (!c) return "";
    this.remember();
    c.number = to;
    for (const z of this.table.zones) {
      if (z.pri1 === from) z.pri1 = to;
      if (z.pri2 === from) z.pri2 = to;
    }
    if (this.home === from) this.home = to; // CHAN-18: renumbering carries it
    this.table.channels.sort((a, b) => a.number - b.number);
    return "";
  }

  /** Two channels trade numbers (the zone editor's ▲ ▼: a zone's order is its channels' numbers), one undo. What
   *  names a channel by number goes with it: the zones' priority channels and the home channel. */
  swap(a: number, b: number) {
    const ca = this.table.channels.find((c) => c.number === a);
    const cb = this.table.channels.find((c) => c.number === b);
    if (!ca || !cb || a === b) return;
    this.remember();
    ca.number = b;
    cb.number = a;
    const other = (n: number | null) => (n === a ? b : n === b ? a : n);
    for (const z of this.table.zones) {
      z.pri1 = other(z.pri1);
      z.pri2 = other(z.pri2);
    }
    if (this.home != null) this.home = other(this.home);
    this.table.channels.sort((x, y) => x.number - y.number);
  }

  /** Channels into a zone (its index; null for no zone): a channel is in one zone at most, so this moves it. */
  moveToZone(numbers: Iterable<number>, zone: number | null) {
    this.setMany(numbers, { zone });
  }

  /** A new zone at the end (zones are numbered in order), named `name` (checked as the radio would): "" when added,
   *  else why not. */
  addZone(name?: string, max = 254): string {
    const n = this.table.zones.length + 1;
    if (n > max) return `At most ${max} zones.`;
    let z = newZone(n, name ?? `Zone ${n}`);
    try {
      z = normalizeZone(z);
    } catch (e) {
      return (e as Error).message;
    }
    this.remember();
    this.table.zones = [...this.table.zones, z];
    return "";
  }

  setZone(number: number, z: Zone) {
    if (sameJson(this.table.zones[number - 1], z)) return;
    this.remember();
    this.table.zones[number - 1] = z;
  }

  /** CHAN-12: a zone goes, its channels to no zone; the zones after it move up one (and their channels with them). */
  deleteZone(number: number) {
    const idx = number - 1;
    this.remember();
    this.table.zones = this.table.zones.filter((_, i) => i !== idx).map((z, i) => ({ ...z, number: i + 1 }));
    for (const c of this.table.channels) {
      if (c.zone === idx) c.zone = null;
      else if (c.zone !== null && c.zone > idx) c.zone -= 1;
    }
  }

  /** Every unwritten change dropped: back to what was read (an empty table when nothing was). Undoable. */
  revert() {
    this.remember();
    this.table = this.base ? clone(this.base) : { zones: [], channels: [] };
    this.home = this.baseHome;
    this.presets = clone(this.basePresets ?? []);
    this.restored = 0;
    this.source = this.base ? "Changes discarded: the table as read" : "";
  }

  // ---- unwritten edits kept across visits (IndexedDB: the table can be 1000 channels) ----

  /** The last visit's unwritten edits back into the table, when there were any and nothing is here yet. */
  async restore() {
    try {
      const saved = await kept.get();
      if (saved && !this.base && !this.table.channels.length && !this.table.zones.length) {
        this.base = saved.base;
        this.table = saved.table;
        this.baseHome = saved.baseHome;
        this.home = saved.home;
        this.basePresets = saved.basePresets ?? null;
        this.presets = saved.presets ?? [];
        this.source = `Restored from your last visit (${new Date(saved.at).toLocaleString()})`;
        this.restored = this.pending;
        if (!this.restored) void kept.clear().catch(() => {});
      }
    } catch {
      /* nothing kept, or storage blocked: nothing to restore */
    } finally {
      this.ready = true;
    }
  }

  /** Keeps the table while it has unwritten changes, and forgets it once it hasn't (written, read or discarded). */
  keep() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    $effect.root(() => {
      $effect(() => {
        const n = this.pending;
        if (!this.ready) return;
        const snap = n
          ? {
              base: $state.snapshot(this.base),
              table: $state.snapshot(this.table),
              baseHome: this.baseHome,
              home: this.home,
              basePresets: $state.snapshot(this.basePresets),
              presets: $state.snapshot(this.presets),
              at: Date.now(),
            }
          : null;
        clearTimeout(timer);
        timer = setTimeout(() => void (snap ? kept.put(snap as Kept) : kept.clear()).catch(() => {}), 250);
      });
    });
    // A page closed with changes not written asks first.
    window.addEventListener("beforeunload", (e) => {
      if (this.pending) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }
}

type Kept = { base: ChannelSet | null; table: ChannelSet; baseHome?: Home; home?: Home; basePresets?: Preset[] | null; presets?: Preset[]; at: number };

/** One record in IndexedDB: the working table and what it was read as. */
const kept = (() => {
  const open = () =>
    new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open("ferrite-console-channels", 1);
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
    get: () => run<Kept | undefined>("readonly", (s) => s.get("working")),
    put: (v: Kept) => run("readwrite", (s) => s.put(v, "working")),
    clear: () => run("readwrite", (s) => s.delete("working")),
  };
})();

export const channels = new Channels();
if (typeof indexedDB !== "undefined" && typeof window !== "undefined") {
  channels.keep();
  void channels.restore();
}
