// Radio Settings as Svelte state: the record read from the radio (`base`), the record being edited (`record`), and
// the view of it (the radio's menu: numbers, names, values, choices). Read, write (a fresh read saved as a backup
// file first, then the diff, then the write on confirm, then a read back), backup files out and back in. Every
// value, choice, check and diff is the Rust core's (ferrite's own App and link session); this file moves records.
import {
  P,
  settingsBackup,
  settingsLen,
  settingsPlan,
  settingsRestore,
  settingsSet,
  settingsView,
  type SettingsPlan,
  type SettingsView,
} from "./core";
import { download, stamp } from "./channels.svelte";
import { WriteError } from "./link";
import { radio } from "./radio.svelte";

export type SettingsWriteStep =
  | { step: "backup" }
  | { step: "review"; plan: SettingsPlan; fresh: Uint8Array; backupName: string; drifted: boolean }
  | { step: "writing"; plan: SettingsPlan }
  | { step: "done"; plan: SettingsPlan; verified: boolean; error: string };

const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

class RadioSettings {
  /** The record as the radio held it when last read (or written and read back). */
  base = $state.raw<Uint8Array | null>(null);
  /** The record being edited. */
  record = $state.raw<Uint8Array | null>(null);
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

  private show(record: Uint8Array) {
    this.record = record;
    this.view = settingsView(record);
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

  /** The settings record from the radio (READ what 1, in parts). */
  async readRadio(): Promise<Uint8Array> {
    const link = radio.connectedLink;
    if (!link) throw new Error("Connect to a radio first.");
    radio.busy = this.busy = "Reading settings";
    try {
      const r = await link.readRecord(P.what.SETTINGS, 0);
      if (!r) throw new Error("The radio has no settings record.");
      return r;
    } finally {
      radio.busy = this.busy = "";
    }
  }

  private took(r: Uint8Array, source: string) {
    this.base = r;
    this.show(r);
    this.baseValues = this.values(this.view!);
    this.refused = {};
    this.source = source;
  }

  async read() {
    this.error = "";
    try {
      this.took(await this.readRadio(), `Read from ${radio.label} at ${new Date().toLocaleTimeString()}`);
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
      this.show(settingsSet(this.record, id, value));
    } catch (e) {
      refused[id] = (e as Error).message;
      this.view = settingsView(this.record); // the control back to what the record holds
    }
    this.refused = refused;
  }

  revert() {
    if (!this.base) return;
    this.show(this.base);
    this.refused = {};
    this.source = "Edits undone: as read";
  }

  async backupRadio(): Promise<{ record: Uint8Array; name: string }> {
    const record = await this.readRadio();
    const name = `${this.fileBase()}-backup.json`;
    download(name, settingsBackup(record, new Date().toISOString(), this.radioMeta()), "application/json");
    return { record, name };
  }

  async backupOnly() {
    this.error = "";
    try {
      const { name } = await this.backupRadio();
      this.source = `Backup saved: ${name} (your downloads).`;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  saveEdited() {
    if (!this.record) return;
    download(`${this.fileBase()}-edited.json`, settingsBackup(this.record, new Date().toISOString(), this.radioMeta()), "application/json");
  }

  /** A backup file into the editor (Write then shows the diff to the radio and restores it). */
  loadFile(text: string, name: string) {
    this.error = "";
    try {
      const r = settingsRestore(text);
      const rec = new Uint8Array(r.record);
      if (!this.base) this.took(rec, "");
      else this.show(rec);
      this.source = `Loaded ${name} (saved ${r.saved}${r.radio.callsign ? `, ${r.radio.callsign}` : ""})`;
    } catch (e) {
      this.error = `${name}: ${(e as Error).message}`;
    }
  }

  /** Step 1: a fresh read saved as a backup file, then the diff (and ferrite's dry run) against it. */
  async startWrite() {
    if (!this.record) return;
    this.error = "";
    this.write = { step: "backup" };
    try {
      const { record: fresh, name } = await this.backupRadio();
      const plan = settingsPlan(fresh, this.record);
      this.write = { step: "review", plan, fresh, backupName: name, drifted: !!this.base && !same(this.base, fresh) };
    } catch (e) {
      this.write = null;
      this.error = `Nothing written: the backup read failed (${(e as Error).message}).`;
    }
  }

  /** Step 2, on confirm: the write session (BEGIN, WRITE parts, END), then a read back to check. */
  async commitWrite() {
    const w = this.write;
    const link = radio.connectedLink;
    if (!w || w.step !== "review" || !link || w.plan.problems.length || !w.plan.ops.length) return;
    const plan = w.plan;
    const want = this.record!;
    this.write = { step: "writing", plan };
    let error = "";
    radio.busy = this.busy = "Writing settings";
    try {
      await link.writeSession(new Uint8Array(plan.begin), plan.ops, () => {});
    } catch (e) {
      error = e instanceof WriteError ? e.reason.message : (e as Error).message;
    } finally {
      radio.busy = this.busy = "";
    }
    let verified = false;
    try {
      const back = await this.readRadio();
      verified = !error && same(back, want);
      if (!error) this.took(back, `Written to ${radio.label} and read back at ${new Date().toLocaleTimeString()}`);
      else this.base = back;
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
