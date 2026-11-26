// Radio Settings as Svelte state: the record read from the radio (`base`) with the values of the settings it doesn't
// carry (`baseExtras`: Watch and Battery Save, read from the radio record), the record and values being edited, and
// the view of them (the radio's menu: numbers, names, values, choices). Read, write (a fresh read kept in memory as
// the backup first, LINK-21.2, then the diff, then the write on confirm: the records' write session, then a read
// back), backup files back in. Every value, choice, check and diff is the Rust core's (ferrite's own App and link session);
// this file moves records and lines.
import { backupFailed } from "./backupError";
import {
  extrasFromRadio,
  P,
  settingsCodeplugPart,
  settingsLen,
  settingsMerge,
  settingsPlan,
  settingsRestore,
  settingsKeepPin,
  settingsSet,
  settingsView,
  type Extras,
  type Merged,
  type SettingChange,
  type SettingsPlan,
  type SettingsView,
} from "./core";
import { RadioError, WriteError, type Link } from "./link";
import { prewrite, type Kept } from "./prewrite";
import { partRadio, radio } from "./radio.svelte";

export type SettingsWriteStep =
  | { step: "backup" }
  | {
      step: "review";
      plan: SettingsPlan;
      fresh: Uint8Array;
      /** LINK-21.2: the fresh read, kept in memory (Put the radio back, Save this backup…). */
      kept: Kept;
      /** LINK-21.1: what is written: the edits on the radio's record as it is now (a loaded file whole). */
      want: Uint8Array;
      wantEx: Extras;
      /** What changed on the radio since the editor's read, and which of those the write replaces. */
      radio: SettingChange[];
      overridden: SettingChange[];
      /** A loaded file (a backup, a codeplug), written whole. */
      whole: boolean;
    }
  | { step: "writing"; plan: SettingsPlan }
  | { step: "done"; plan: SettingsPlan; verified: boolean; error: string; kept: Kept };

/** LINK-21.1: the review step of a write from the merge (shared with APRS settings). */
export function reviewStep(plan: SettingsPlan, fresh: Uint8Array, kept: Kept, m: Merged, whole: boolean): SettingsWriteStep {
  return { step: "review", plan, fresh, kept, want: m.record, wantEx: m.extras, radio: m.radio, overridden: m.overridden, whole };
}

export const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** The settings the settings record doesn't carry (Watch, Battery Save), as the radio holds them: its radio record
 * (LINK-66, decision 347). A radio that refuses it gives none: those settings then show as not read. */
export async function readExtras(link: Link): Promise<Extras> {
  try {
    const rec = await link.readRecord(P.what.RADIO, 0);
    return rec ? extrasFromRadio(rec) : {};
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
  /** The record came from a codeplug, which never carries the PIN lock: the radio's own is kept (taken from the
   *  record read before the write). */
  keepPin = false;
  /** `base` is a read from the radio (not a file loaded before any read): the write merges the edits onto the radio's
   *  record as it is then (LINK-21.1). */
  baseFromRadio = false;
  /** The editor holds a loaded file (a backup, a codeplug): it is written whole. */
  whole = false;

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

  private took(r: Uint8Array, extras: Extras, source: string, fromRadio = true) {
    this.base = r;
    this.baseFromRadio = fromRadio;
    this.whole = false;
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
      this.keepPin = false;
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
    this.whole = false;
    this.refused = {};
    this.source = "Edits undone: as read";
  }

  /** LINK-21.2: a fresh read, kept in memory as the write's backup (a .ferrite's settings part); no file. */
  async backupRadio(): Promise<{ record: Uint8Array; extras: Extras; kept: Kept }> {
    const { record, extras } = await this.readRadio();
    const kept = prewrite.keep("settings", { settings: settingsCodeplugPart(record, extras, new Date().toISOString(), partRadio()) }, radio.label);
    return { record, extras, kept };
  }

  /** A backup file (or a codeplug's settings.json) into the editor as unwritten changes (Write then shows the diff to
   * the radio and restores it): true when loaded. A value the file lacks (a file from before it) stays as read. */
  loadFile(text: string, name: string, codeplug = false): boolean {
    this.error = "";
    try {
      const r = settingsRestore(text);
      let rec = new Uint8Array(r.record);
      // A codeplug has no PIN lock: the radio's own (as read) stays, and the write takes it from its fresh read.
      if (codeplug && this.base) rec = settingsKeepPin(rec, this.base);
      const extras = { ...this.extras, ...r.extras };
      if (!this.base) this.took(rec, extras, "", false);
      else this.show(rec, extras);
      this.whole = true;
      this.source = `Loaded ${name} (saved ${r.saved}${r.radio.callsign ? `, ${r.radio.callsign}` : ""})`;
      this.keepPin = codeplug;
      return true;
    } catch (e) {
      this.error = `${name}: ${(e as Error).message}`;
      return false;
    }
  }

  /** Step 1: a fresh read kept as the backup (LINK-21.2); the edits put on it (LINK-21.1: only the fields edited since the
   * read; what the radio changed meanwhile stays, and the dialog lists it); then the diff (and ferrite's dry run). */
  async startWrite() {
    if (!this.record) return;
    this.error = "";
    this.write = { step: "backup" };
    try {
      const { record: fresh, extras, kept } = await this.backupRadio();
      if (this.keepPin) this.show(settingsKeepPin(this.record, fresh), this.extras);
      const m: Merged =
        this.base && this.baseFromRadio
          ? settingsMerge(this.base, this.baseExtras, this.record!, this.extras, fresh, extras, this.whole)
          : { record: this.record!, extras: this.extras, radio: [], overridden: [] };
      const plan = settingsPlan(fresh, extras, m.record, m.extras);
      this.write = reviewStep(plan, fresh, kept, m, this.whole);
    } catch (e) {
      this.write = null;
      this.error = backupFailed(e);
    }
  }

  /** Step 2, on confirm: the write session (BEGIN, WRITE parts, END) and the `set` lines, then a read back to check. */
  async commitWrite() {
    const w = this.write;
    const link = radio.connectedLink;
    if (!w || w.step !== "review" || !link || w.plan.problems.length || !(w.plan.ops.length || w.plan.cmds.length)) return;
    const plan = w.plan;
    const want = w.want;
    const wantEx = w.wantEx;
    const kept = w.kept;
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
      // A failed write leaves `base` the editor's read: the next write merges the same edits onto the radio again.
      if (!error) this.took(back.record, back.extras, `Written to ${radio.label} and read back at ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      error ||= `the read back failed: ${(e as Error).message}`;
    }
    this.write = { step: "done", plan, verified, error, kept };
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
