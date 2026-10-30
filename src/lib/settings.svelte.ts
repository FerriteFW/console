// Radio Settings as Svelte state: the record read from the radio (`base`) with the values of the settings no record
// carries (`baseExtras`: read with the terminal's `dump`), the record and values being edited, and the view of them
// (the radio's menu: numbers, names, values, choices). Read, write (a fresh read saved as a backup file first, then
// the diff, then the write on confirm: the record's write session and the `set` lines, then a read back), backup
// files out and back in. Every value, choice, check and diff is the Rust core's (ferrite's own App and link session);
// this file moves records and lines.
import {
  dumpSettingsEnd,
  extrasFromDump,
  P,
  settingsBackup,
  settingsLen,
  settingsPlan,
  settingsRestore,
  settingsSet,
  settingsView,
  type Extras,
  type SettingsPlan,
  type SettingsView,
} from "./core";
import { download, stamp } from "./channels.svelte";
import { RadioError, WriteError, type Link } from "./link";
import { radio } from "./radio.svelte";

export type SettingsWriteStep =
  | { step: "backup" }
  | { step: "review"; plan: SettingsPlan; fresh: Uint8Array; backupName: string; drifted: boolean }
  | { step: "writing"; plan: SettingsPlan }
  | { step: "done"; plan: SettingsPlan; verified: boolean; error: string };

export const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** The settings no record carries, as the radio holds them: its `dump` (CMD, LINK-34), read up to the end of its
 * settings. A radio whose terminal won't (the demo radio) gives none: those settings then show as not read. */
export async function readExtras(link: Link): Promise<Extras> {
  const end = dumpSettingsEnd();
  try {
    const text = await link.cmd("dump", (soFar) => soFar.includes(`\n${end}`));
    return extrasFromDump(text);
  } catch (e) {
    if (e instanceof RadioError) return {};
    throw e;
  }
}

/** The plan's `set` lines, one at a time over the link: the first refusal, or "". */
export async function sendCmds(link: Link, cmds: string[]): Promise<string> {
  for (const c of cmds) {
    try {
      await link.cmd(c);
    } catch (e) {
      return `${c}: ${(e as Error).message}`;
    }
  }
  return "";
}

class RadioSettings {
  /** The record as the radio held it when last read (or written and read back). */
  base = $state.raw<Uint8Array | null>(null);
  /** The terminal-backed values read with it. */
  baseExtras = $state.raw<Extras>({});
  /** The record being edited. */
  record = $state.raw<Uint8Array | null>(null);
  /** The terminal-backed values being edited. */
  extras = $state.raw<Extras>({});
  view = $state.raw<SettingsView | null>(null);
  /** Each setting's value as read (for the changed marks). */
  baseValues = $state.raw<Record<string, string>>({});
  source = $state("");
  busy = $state("");
  error = $state("");
  /** The radio's reason a change was refused, by setting. */
  refused = $state<Record<string, string>>({});
  write = $state<SettingsWriteStep | null>(null);

  /** Settings whose value differs from what was read. */
  get dirty(): Set<string> {
    const out = new Set<string>();
    if (!this.view || !this.base) return out;
    for (const g of this.view.groups) for (const i of g.items) if (this.baseValues[i.id] !== undefined && this.baseValues[i.id] !== i.value) out.add(i.id);
    if (!out.size && !same(this.base, this.record)) out.add("other");
    return out;
  }

  private show(record: Uint8Array, extras: Extras) {
    this.record = record;
    this.extras = extras;
    this.view = settingsView(record, extras);
  }

  private values(v: SettingsView): Record<string, string> {
    return Object.fromEntries(v.groups.flatMap((g) => g.items.map((i) => [i.id, i.value])));
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
    return `ferrite-${who}-${stamp()}-settings`;
  }

  /** The settings record from the radio (READ what 1, in parts) and the terminal-backed values (its dump). */
  async readRadio(): Promise<{ record: Uint8Array; extras: Extras }> {
    const link = radio.connectedLink;
    if (!link) throw new Error("Connect to a radio first.");
    radio.busy = this.busy = "Reading settings";
    try {
      const r = await link.readRecord(P.what.SETTINGS, 0);
      if (!r) throw new Error("The radio has no settings record.");
      return { record: r, extras: await readExtras(link) };
    } finally {
      radio.busy = this.busy = "";
    }
  }

  private took(r: Uint8Array, extras: Extras, source: string) {
    this.base = r;
    this.baseExtras = extras;
    this.show(r, extras);
    this.baseValues = this.values(this.view!);
    this.refused = {};
    this.source = source;
  }

  async read() {
    this.error = "";
    try {
      const { record, extras } = await this.readRadio();
      this.took(record, extras, `Read from ${radio.label} at ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** One setting changed (as the radio's menu would); a refusal is kept beside the setting. */
  change(id: string, value: string) {
    if (!this.record) return;
    const refused = { ...this.refused };
    delete refused[id];
    try {
      const e = settingsSet(this.record, this.extras, id, value);
      this.show(e.record, e.extras);
    } catch (e) {
      refused[id] = (e as Error).message;
      this.view = settingsView(this.record, this.extras); // the control back to what the record holds
    }
    this.refused = refused;
  }

  revert() {
    if (!this.base) return;
    this.show(this.base, this.baseExtras);
    this.refused = {};
    this.source = "Edits undone: as read";
  }

  async backupRadio(): Promise<{ record: Uint8Array; extras: Extras; name: string }> {
    const { record, extras } = await this.readRadio();
    const name = `${this.fileBase()}-backup.json`;
    download(name, settingsBackup(record, extras, new Date().toISOString(), this.radioMeta()), "application/json");
    return { record, extras, name };
  }

  /** A backup file (or a codeplug's settings.json) into the editor as unwritten changes (Write then shows the diff to
   * the radio and restores it): true when loaded. A value the file lacks (a file from before it) stays as read. */
  loadFile(text: string, name: string): boolean {
    this.error = "";
    try {
      const r = settingsRestore(text);
      const rec = new Uint8Array(r.record);
      const extras = { ...this.extras, ...r.extras };
      if (!this.base) this.took(rec, extras, "");
      else this.show(rec, extras);
      this.source = `Loaded ${name} (saved ${r.saved}${r.radio.callsign ? `, ${r.radio.callsign}` : ""})`;
      return true;
    } catch (e) {
      this.error = `${name}: ${(e as Error).message}`;
      return false;
    }
  }

  /** Step 1: a fresh read saved as a backup file, then the diff (and ferrite's dry run) against it. */
  async startWrite() {
    if (!this.record) return;
    this.error = "";
    this.write = { step: "backup" };
    try {
      const { record: fresh, extras, name } = await this.backupRadio();
      const plan = settingsPlan(fresh, extras, this.record, this.extras);
      const drifted = !!this.base && (!same(this.base, fresh) || JSON.stringify(this.baseExtras) !== JSON.stringify(extras));
      this.write = { step: "review", plan, fresh, backupName: name, drifted };
    } catch (e) {
      this.write = null;
      this.error = `Nothing written: the backup read failed (${(e as Error).message}).`;
    }
  }

  /** Step 2, on confirm: the write session (BEGIN, WRITE parts, END) and the `set` lines, then a read back to check. */
  async commitWrite() {
    const w = this.write;
    const link = radio.connectedLink;
    if (!w || w.step !== "review" || !link || w.plan.problems.length || !(w.plan.ops.length || w.plan.cmds.length)) return;
    const plan = w.plan;
    const want = this.record!;
    const wantEx = this.extras;
    this.write = { step: "writing", plan };
    let error = "";
    radio.busy = this.busy = "Writing settings";
    try {
      if (plan.ops.length) await link.writeSession(new Uint8Array(plan.begin), plan.ops, () => {});
      error = await sendCmds(link, plan.cmds);
    } catch (e) {
      error = e instanceof WriteError ? e.reason.message : (e as Error).message;
    } finally {
      radio.busy = this.busy = "";
    }
    let verified = false;
    try {
      const back = await this.readRadio();
      verified = !error && same(back.record, want) && !settingsPlan(back.record, back.extras, want, wantEx).changes.length;
      if (!error) this.took(back.record, back.extras, `Written to ${radio.label} and read back at ${new Date().toLocaleTimeString()}`);
      else {
        this.base = back.record;
        this.baseExtras = back.extras;
      }
    } catch (e) {
      error ||= `the read back failed: ${(e as Error).message}`;
    }
    this.write = { step: "done", plan, verified, error };
  }

  closeWrite() {
    this.write = null;
  }

  /** The radio's record length is this Console's (else the record isn't written: LINK-21). */
  get lengthOk() {
    return !this.base || this.base.length === settingsLen();
  }
}

export const settings = new RadioSettings();
