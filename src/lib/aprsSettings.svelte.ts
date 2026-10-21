// APRS settings as Svelte state (LINK-43): the APRS record read from the radio (`base`) beside its settings record
// (its region decides "the region's" frequency), the record being edited, and the view of it as MENU 0 5 shows it.
// As Radio Settings: a fresh read saved as a backup file first, then the diff (with ferrite's dry run), the write on
// confirm, then a read back. Every value, choice and check is the core's (ferrite's own App and link session).
import { aprsBackup, aprsPlan, aprsRecordLen, aprsRestore, aprsSet, aprsView, P, type AprsView } from "./core";
import { download, stamp } from "./channels.svelte";
import { RadioError, WriteError } from "./link";
import { radio } from "./radio.svelte";
import type { SettingsWriteStep } from "./settings.svelte";

const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

class AprsSettings {
  /** The radio's settings record (for its region), read with the APRS record. */
  settingsRec = $state.raw<Uint8Array>(new Uint8Array());
  base = $state.raw<Uint8Array | null>(null);
  record = $state.raw<Uint8Array | null>(null);
  view = $state.raw<AprsView | null>(null);
  baseValues = $state.raw<Record<string, string>>({});
  source = $state("");
  busy = $state("");
  error = $state("");
  refused = $state<Record<string, string>>({});
  write = $state<SettingsWriteStep | null>(null);

  get dirty(): Set<string> {
    const out = new Set<string>();
    if (!this.view || !this.base) return out;
    for (const i of this.view.items) if (this.baseValues[i.id] !== undefined && this.baseValues[i.id] !== i.value) out.add(i.id);
    if (!out.size && !same(this.base, this.record)) out.add("other");
    return out;
  }

  get lengthOk() {
    return !this.base || this.base.length === aprsRecordLen();
  }

  private show(record: Uint8Array) {
    this.record = record;
    this.view = aprsView(this.settingsRec, record);
  }

  private meta(): Record<string, string> {
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
    return `ferrite-${who}-${stamp()}-aprs`;
  }

  /** The APRS record (READ what 5), and the settings record once a connection (for the region). */
  async readRadio(): Promise<Uint8Array> {
    const link = radio.connectedLink;
    if (!link) throw new Error("Connect to a radio first.");
    radio.busy = this.busy = "Reading APRS settings";
    try {
      if (!this.settingsRec.length) this.settingsRec = (await link.readRecord(P.what.SETTINGS, 0)) ?? new Uint8Array();
      let r: Uint8Array | null;
      try {
        r = await link.readRecord(P.what.APRS, 0);
      } catch (e) {
        if (e instanceof RadioError && e.status === 3) throw new Error("This radio's firmware has no APRS record over the link yet (LINK-43): update it.");
        throw e;
      }
      if (!r) throw new Error("The radio has no APRS record.");
      return r;
    } finally {
      radio.busy = this.busy = "";
    }
  }

  private took(r: Uint8Array, source: string) {
    this.base = r;
    this.show(r);
    this.baseValues = Object.fromEntries(this.view!.items.map((i) => [i.id, i.value]));
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

  change(id: string, value: string) {
    if (!this.record) return;
    const refused = { ...this.refused };
    delete refused[id];
    try {
      this.show(aprsSet(this.settingsRec, this.record, id, value));
    } catch (e) {
      refused[id] = (e as Error).message;
      this.view = aprsView(this.settingsRec, this.record);
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
    download(name, aprsBackup(this.settingsRec, record, new Date().toISOString(), this.meta()), "application/json");
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
    download(`${this.fileBase()}-edited.json`, aprsBackup(this.settingsRec, this.record, new Date().toISOString(), this.meta()), "application/json");
  }

  loadFile(text: string, name: string) {
    this.error = "";
    try {
      const r = aprsRestore(text);
      const rec = new Uint8Array(r.record);
      if (!this.base) this.took(rec, "");
      else this.show(rec);
      this.source = `Loaded ${name} (saved ${r.saved}${r.radio.callsign ? `, ${r.radio.callsign}` : ""})`;
    } catch (e) {
      this.error = `${name}: ${(e as Error).message}`;
    }
  }

  async startWrite() {
    if (!this.record) return;
    this.error = "";
    this.write = { step: "backup" };
    try {
      const { record: fresh, name } = await this.backupRadio();
      const plan = aprsPlan(this.settingsRec, fresh, this.record);
      this.write = { step: "review", plan, fresh, backupName: name, drifted: !!this.base && !same(this.base, fresh) };
    } catch (e) {
      this.write = null;
      this.error = `Nothing written: the backup read failed (${(e as Error).message}).`;
    }
  }

  async commitWrite() {
    const w = this.write;
    const link = radio.connectedLink;
    if (!w || w.step !== "review" || !link || w.plan.problems.length || !w.plan.ops.length) return;
    const plan = w.plan;
    const want = this.record!;
    this.write = { step: "writing", plan };
    let error = "";
    radio.busy = this.busy = "Writing APRS settings";
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

  /** A new connection: the settings record is read again with the next read. */
  forget() {
    this.settingsRec = new Uint8Array();
  }
}

export const aprsSettings = new AprsSettings();
