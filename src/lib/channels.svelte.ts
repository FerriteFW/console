// Channels & Zones as Svelte state: the set read from the radio (`base`), the table being edited (`table`), and the
// flows around them: read (READ records over the link, part by part), write (a fresh read saved as a backup file
// first, then the diff, then the write session on confirm), CHIRP CSV in and out, backup files out and back in.
// Every record layout, check, diff and conversion is the Rust core's; this file only moves them and the files.
import {
  P,
  backupFile,
  chirpExport,
  chirpImport,
  decodeSet,
  newChannel,
  newZone,
  restoreFile,
  writePlan,
  type Channel,
  type ChannelSet,
  type ChirpImport,
  type Plan,
  type Zone,
} from "./core";
import { WriteError } from "./link";
import { radio } from "./radio.svelte";

export type Progress = { label: string; done: number; total: number };
/** The write dialog's steps. */
export type WriteStep =
  | { step: "backup" }
  | { step: "review"; plan: Plan; fresh: ChannelSet; backupName: string; drifted: boolean }
  | { step: "writing"; plan: Plan; done: number }
  | { step: "done"; plan: Plan; verified: boolean; error: string; written: number };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** JSON with keys sorted: the core's objects come with keys in either struct or sorted order. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  );
const sameJson = (a: unknown, b: unknown) => canon(a) === canon(b);

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

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class Channels {
  /** What the radio held when last read (or written and read back); null before a read. */
  base = $state<ChannelSet | null>(null);
  /** The table: the set being edited. */
  table = $state<ChannelSet>({ zones: [], channels: [] });
  /** Where the table came from, for the status line. */
  source = $state("");
  progress = $state<Progress | null>(null);
  error = $state("");
  /** Notes from the last read or import. */
  notes = $state<string[]>([]);
  write = $state<WriteStep | null>(null);
  imported = $state<(ChirpImport & { file: string }) | null>(null);

  /** Rows (by number) that differ from what was read: changed, added; and how many were deleted. */
  get dirty() {
    const base = this.base ?? { zones: [], channels: [] };
    const bc = new Map(base.channels.map((c) => [c.number, c]));
    const tc = new Set(this.table.channels.map((c) => c.number));
    const changed = new Set<number>();
    for (const c of this.table.channels) if (!sameJson(bc.get(c.number), c)) changed.add(c.number);
    const deleted = base.channels.filter((c) => !tc.has(c.number)).length;
    const zones = new Set<number>();
    for (const z of this.table.zones) if (!sameJson(base.zones[z.number - 1], z)) zones.add(z.number);
    const zonesDeleted = Math.max(0, base.zones.length - this.table.zones.length);
    return { changed, deleted, zones, zonesDeleted, any: changed.size + deleted + zones.size + zonesDeleted > 0 };
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

  /** Every zone and channel on the radio, read record by record. Holds the link (the Live View pauses). */
  async readRadio(): Promise<ChannelSet> {
    const link = radio.connectedLink;
    if (!link) throw new Error("Connect to a radio first.");
    const { ZONE, CHANNEL } = P.what;
    radio.busy = "Reading channels";
    try {
      const info = await link.info();
      const zones: Uint8Array[] = [];
      for (let i = 0; i < info.zones; i++) {
        this.progress = { label: `Reading zone ${i + 1} of ${info.zones}`, done: i, total: info.zones + info.channels };
        const r = await link.readRecord(ZONE, i);
        if (!r) throw new Error(`Zone ${i + 1} wasn't there (the radio said ${info.zones} zones).`);
        zones.push(r);
      }
      const chans: Uint8Array[] = [];
      for (let n = 0; n < 1000 && chans.length < info.channels; n++) {
        this.progress = {
          label: `Reading channels: ${chans.length} of ${info.channels} found, at ${n + 1}`,
          done: info.zones + chans.length,
          total: info.zones + info.channels,
        };
        const r = await link.readRecord(CHANNEL, n);
        if (r) chans.push(r);
      }
      const { set, bad } = decodeSet(zones, chans);
      this.notes = bad;
      return set;
    } finally {
      radio.busy = "";
      this.progress = null;
    }
  }

  /** Read into the table (and base). Unwritten edits are dropped: the caller asks first. */
  async read() {
    this.error = "";
    try {
      const set = await this.readRadio();
      this.base = clone(set);
      this.table = clone(set);
      this.source = `Read from ${radio.label} at ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** A fresh read saved as a backup file: the radio as it is now. */
  async backupRadio(): Promise<{ set: ChannelSet; name: string }> {
    const set = await this.readRadio();
    const name = `${this.fileBase()}-backup.json`;
    download(name, backupFile(set, new Date().toISOString(), this.radioMeta()), "application/json");
    return { set, name };
  }

  /** The Back up button: a fresh read to a file; the table is left alone. */
  async backupOnly() {
    this.error = "";
    try {
      const { name } = await this.backupRadio();
      this.notes = [`Backup saved: ${name} (your downloads).`];
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** The table to a file, in the backup format (works offline). */
  saveTable() {
    this.error = "";
    try {
      download(`${this.fileBase()}-table.json`, backupFile(this.table, new Date().toISOString(), this.radioMeta()), "application/json");
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** A backup file into the table (Write then shows the diff against the radio). */
  loadFile(text: string, name: string) {
    this.error = "";
    try {
      const r = restoreFile(text);
      this.table = r.set;
      this.source = `Loaded ${name} (saved ${r.saved}${r.radio.callsign ? `, ${r.radio.callsign}` : ""})`;
      this.notes = [];
    } catch (e) {
      this.error = `${name}: ${(e as Error).message}`;
    }
  }

  /** Step 1 of a write: a fresh read, saved as a backup file, then the plan against it for review. */
  async startWrite() {
    this.error = "";
    this.write = { step: "backup" };
    try {
      const { set: fresh, name } = await this.backupRadio();
      const plan = writePlan(fresh, this.table);
      const drifted = !!this.base && !sameJson(this.base, fresh);
      this.write = { step: "review", plan, fresh, backupName: name, drifted };
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
    const plan = w.plan;
    this.write = { step: "writing", plan, done: 0 };
    let error = "";
    let written = plan.ops.length;
    radio.busy = "Writing channels";
    try {
      await link.writeSession(new Uint8Array(plan.begin), plan.ops, (done) => {
        this.write = { step: "writing", plan, done };
      });
    } catch (e) {
      error = (e as Error).message;
      if (e instanceof WriteError) written = e.done;
    } finally {
      radio.busy = "";
    }
    let verified = false;
    try {
      const back = await this.readRadio();
      this.base = clone(back);
      verified = !error && sameJson(back, this.table);
      if (!error) this.table = clone(back);
      this.source = `Written to ${radio.label} and read back at ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      error ||= `the read back failed: ${(e as Error).message}`;
    }
    this.write = { step: "done", plan, verified, error, written };
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
    const byNum = new Map((replace ? [] : this.table.channels).map((c) => [c.number, c]));
    for (const c of imp.channels) byNum.set(c.number, c);
    this.table.channels = [...byNum.values()].sort((a, b) => a.number - b.number);
    this.source = `${imp.channels.length} channels imported from ${imp.file}${replace ? " (replacing all)" : ""}`;
    this.notes = imp.notes;
    this.imported = null;
  }

  exportChirp() {
    download(`${this.fileBase()}-chirp.csv`, chirpExport(this.table), "text/csv");
  }

  // ---- table edits ----

  setChannel(number: number, c: Channel) {
    const i = this.table.channels.findIndex((x) => x.number === number);
    if (i >= 0) this.table.channels[i] = c;
  }

  addChannel(): number | null {
    const used = new Set(this.table.channels.map((c) => c.number));
    let n = 1;
    while (used.has(n)) n++;
    if (n > 1000) return null;
    this.table.channels = [...this.table.channels, newChannel(n, "146.52")].sort((a, b) => a.number - b.number);
    return n;
  }

  deleteChannel(number: number) {
    this.table.channels = this.table.channels.filter((c) => c.number !== number);
  }

  /** A channel to another number (free ones only). */
  renumber(from: number, to: number): string {
    if (!(to >= 1 && to <= 1000)) return "Channels are 1 to 1000.";
    if (this.table.channels.some((c) => c.number === to)) return `Channel ${to} is in use.`;
    const c = this.table.channels.find((x) => x.number === from);
    if (!c) return "";
    c.number = to;
    for (const z of this.table.zones) {
      if (z.pri1 === from) z.pri1 = to;
      if (z.pri2 === from) z.pri2 = to;
    }
    this.table.channels.sort((a, b) => a.number - b.number);
    return "";
  }

  addZone() {
    const n = this.table.zones.length + 1;
    if (n > 254) return;
    this.table.zones = [...this.table.zones, newZone(n, `Zone ${n}`)];
  }

  setZone(number: number, z: Zone) {
    this.table.zones[number - 1] = z;
  }

  /** CHAN-12: a zone goes, its channels to no zone; the zones after it move up one (and their channels with them). */
  deleteZone(number: number) {
    const idx = number - 1;
    this.table.zones = this.table.zones.filter((_, i) => i !== idx).map((z, i) => ({ ...z, number: i + 1 }));
    for (const c of this.table.channels) {
      if (c.zone === idx) c.zone = null;
      else if (c.zone !== null && c.zone > idx) c.zone -= 1;
    }
  }

  /** Back to what was read. */
  revert() {
    if (this.base) this.table = clone(this.base);
    this.source = this.base ? "Edits undone: as read" : "";
  }
}

export const channels = new Channels();
