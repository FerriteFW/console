// APRS settings as Svelte state: MENU 0 5 as the link changes it. The APRS record (LINK-43) read from the radio
// (`base`) with the values of MENU 0 5's settings no record carries (`baseExtras`: the symbol, comment, ambiguity,
// Mic-E, telemetry, TX delay and level, read with the terminal's `dump`), beside its settings record (its region
// decides "the region's" frequency); the record and values being edited, and the view of them as MENU 0 5 shows
// them. As Radio Settings: a fresh read saved as a backup file first, then the diff (with ferrite's dry run), the
// write on confirm (the record's session, then the `set` lines), then a read back. Every value, choice and check is
// the core's (ferrite's own App and link session).
import { aprsBackup, aprsMerge, aprsPlan, aprsRecordLen, aprsRestore, aprsSet, aprsView, P, type AprsView, type Extras, type Merged } from "./core";
import { backupFailed } from "./backupError";
import { download, stamp } from "./channels.svelte";
import { RadioError, WriteError } from "./link";
import { radio } from "./radio.svelte";
import { readExtras, reviewStep, same, sendCmds, type SettingsWriteStep } from "./settings.svelte";

class AprsSettings {
  /** The radio's settings record (for its region), read with the APRS record. */
  settingsRec = $state.raw<Uint8Array>(new Uint8Array());
  base = $state.raw<Uint8Array | null>(null);
  baseExtras = $state.raw<Extras>({});
  record = $state.raw<Uint8Array | null>(null);
  extras = $state.raw<Extras>({});
  view = $state.raw<AprsView | null>(null);
  baseValues = $state.raw<Record<string, string>>({});
  source = $state("");
  busy = $state("");
  error = $state("");
  refused = $state<Record<string, string>>({});
  write = $state<SettingsWriteStep | null>(null);
  /** `base` is a read from the radio: the write merges the edits onto the radio's record then (LINK-21.1). */
  baseFromRadio = false;
  /** The editor holds a loaded file: it is written whole. */
  whole = false;

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

  private show(record: Uint8Array, extras: Extras) {
    this.record = record;
    this.extras = extras;
    this.view = aprsView(this.settingsRec, record, extras);
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

  /** The APRS record (READ what 5) and the terminal-backed values (the dump), and the settings record once a
   * connection (for the region). */
  async readRadio(): Promise<{ record: Uint8Array; extras: Extras }> {
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
    this.baseValues = Object.fromEntries(this.view!.items.map((i) => [i.id, i.value]));
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

  change(id: string, value: string) {
    if (!this.record) return;
    const refused = { ...this.refused };
    delete refused[id];
    try {
      const e = aprsSet(this.settingsRec, this.record, this.extras, id, value);
      this.show(e.record, e.extras);
    } catch (e) {
      refused[id] = (e as Error).message;
      this.view = aprsView(this.settingsRec, this.record, this.extras);
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

  async backupRadio(): Promise<{ record: Uint8Array; extras: Extras; name: string }> {
    const { record, extras } = await this.readRadio();
    const name = `${this.fileBase()}-backup.json`;
    await download(name, aprsBackup(this.settingsRec, record, extras, new Date().toISOString(), this.meta()), "application/json");
    return { record, extras, name };
  }

  /** A backup file (or a codeplug's aprs.json) into the editor as unwritten changes (true when loaded); a value the
   * file lacks (a file from before it) stays as read. */
  loadFile(text: string, name: string): boolean {
    this.error = "";
    try {
      const r = aprsRestore(text);
      const rec = new Uint8Array(r.record);
      const extras = { ...this.extras, ...r.extras };
      if (!this.base) this.took(rec, extras, "", false);
      else this.show(rec, extras);
      this.whole = true;
      this.source = `Loaded ${name} (saved ${r.saved}${r.radio.callsign ? `, ${r.radio.callsign}` : ""})`;
      return true;
    } catch (e) {
      this.error = `${name}: ${(e as Error).message}`;
      return false;
    }
  }

  async startWrite() {
    if (!this.record) return;
    this.error = "";
    this.write = { step: "backup" };
    try {
      const { record: fresh, extras, name } = await this.backupRadio();
      // LINK-21.1: the edits on the radio's record as it is now; what the radio changed since the read stays.
      const m: Merged =
        this.base && this.baseFromRadio
          ? aprsMerge(this.settingsRec, this.base, this.baseExtras, this.record, this.extras, fresh, extras, this.whole)
          : { record: this.record, extras: this.extras, radio: [], overridden: [] };
      const plan = aprsPlan(this.settingsRec, fresh, extras, m.record, m.extras);
      this.write = reviewStep(plan, fresh, name, m, this.whole);
    } catch (e) {
      this.write = null;
      this.error = backupFailed(e);
    }
  }

  async commitWrite() {
    const w = this.write;
    const link = radio.connectedLink;
    if (!w || w.step !== "review" || !link || w.plan.problems.length || !(w.plan.ops.length || w.plan.cmds.length)) return;
    const plan = w.plan;
    const want = w.want;
    const wantEx = w.wantEx;
    this.write = { step: "writing", plan };
    let error = "";
    radio.busy = this.busy = "Writing APRS settings";
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
      verified = !error && same(back.record, want) && !aprsPlan(this.settingsRec, back.record, back.extras, want, wantEx).changes.length;
      // A failed write leaves `base` the editor's read: the next write merges the same edits onto the radio again.
      if (!error) this.took(back.record, back.extras, `Written to ${radio.label} and read back at ${new Date().toLocaleTimeString()}`);
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
