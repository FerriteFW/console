// Satellite mode's satellites (manual chapter 28a: SAT-2, SAT-3, SAT-13, SAT-15, SAT-18, SAT-21; LINK-63 – LINK-65):
// data.ferritefw.dev's satellites/sats.json (through sitedata.ts, kept for offline use), the FM-workable list (all of
// it written), what the radio holds (READ_MANY of SAT and SAT_INFO), and the write: the clock, then the whole list
// (clear all, records 0..n-1 in order), then the info record with the WMM2025 declination at the radio's position.
// With "Keep satellites up to date" on, each connect refreshes a radio's own satellites when the file is newer
// (SAT-21: at most once a day, never a radio with none).
import { untrack } from "svelte";
import {
  P,
  clockOf,
  loadCore,
  parsePlace,
  satHeld,
  satInfoOf,
  satInfoRecord,
  satsParse,
  satsRefresh,
  satsSyncDue,
  wmmDeclination,
  type RadioClock,
  type SatInfo,
  type SatRow,
  type SatsFile,
} from "./core";
import type { Link } from "./link";
import { radio } from "./radio.svelte";
import { radioPlace } from "./radioplace";
import { library } from "./library.svelte";
import { sites } from "./sites.svelte";

const AUTO_KEY = "satsAutoSync";
const CLOCK_KEY = "clockOnConnect";

export { ISS, ageDays, ageLevel, declText } from "./satage";
import { declText } from "./satage";

function storedClock(): boolean {
  try {
    return localStorage.getItem(CLOCK_KEY) !== "off";
  } catch {
    return true;
  }
}

function storedAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "off";
  } catch {
    return true;
  }
}

const nowS = () => Math.floor(Date.now() / 1000);

class Satellites {
  /** sats.json read (the workable satellites); its text for SAT-21's refresh. */
  file = $state.raw<SatsFile | null>(null);
  private fileText = "";
  fileError = $state("");
  /** The file came from the offline copy (the server couldn't be reached). */
  fileKept = $state(false);
  loadingFile = $state(false);
  /** What the radio holds: its satellites (null: not read), the info record, its clock. */
  held = $state.raw<SatRow[] | null>(null);
  info = $state.raw<SatInfo | null>(null);
  clock = $state.raw<RadioClock | null>(null);
  /** The link the radio's list was read on. */
  private heldFor: Link | null = null;
  busy = $state("");
  error = $state("");
  /** The page's note after a write. */
  notice = $state("");
  /** SAT-21's note after a rewrite on connect (shown as a toast on any page). */
  toast = $state("");
  /** "Keep satellites up to date" (SAT-21), on to start. */
  #auto = $state(storedAuto());
  get auto() {
    return this.#auto;
  }
  set auto(v: boolean) {
    this.#auto = v;
    try {
      localStorage.setItem(AUTO_KEY, v ? "on" : "off");
    } catch {
      /* not kept */
    }
  }
  /** "Set the radio's clock on connect" (LINK-65), on to start: a radio that loses its clock at power-off (GPS-23)
   * gets this computer's time at each connect, unless its clock is already from GPS. */
  #setClock = $state(storedClock());
  get setClock() {
    return this.#setClock;
  }
  set setClock(v: boolean) {
    this.#setClock = v;
    try {
      localStorage.setItem(CLOCK_KEY, v ? "on" : "off");
    } catch {
      /* not kept */
    }
  }
  /** The link each connect's check ran for (once a connection). */
  private syncedFor: Link | null = null;

  /** A radio is connected: it takes satellites (LINK-63). */
  get supported(): boolean {
    return !!radio.connectedLink;
  }

  /** sats.json (once; again by `loadFile(true)`). */
  async loadFile(again = false): Promise<SatsFile | null> {
    if (this.file && !again) return this.file;
    this.loadingFile = true;
    this.fileError = "";
    try {
      await loadCore();
      const { text, kept } = await sites.client.sats();
      const f = satsParse(text);
      this.fileText = text;
      this.fileKept = kept;
      this.file = f;
      return f;
    } catch (e) {
      this.fileError = `The satellite list didn't load: ${(e as Error).message}`;
      return null;
    } finally {
      this.loadingFile = false;
    }
  }

  /**
   * What Write puts on the radio (Alex, Nov 14, 2026: no picking; about 19 workable satellites and 32 places): the
   * whole list in its order; past 32, the active ones first.
   */
  get toWrite(): SatRow[] {
    const all = this.file?.sats ?? [];
    const max = P?.limits?.sats ?? 32; // read before the core has loaded too (the page's first draw)
    if (all.length <= max) return all;
    // past 32 (as Pocket): active first, then voice before APRS and beacons; the file's order within each
    const rank = (s: SatRow) => (s.status === "active" ? 0 : 2) + (s.tps.some((t) => t.kind === "Voice") ? 0 : 1);
    return all
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .slice(0, max)
      .map((x) => x.s);
  }

  /** The list's records for the radio, each keeping the starting settings the radio holds for it (by NORAD number). */
  private records(rows: SatRow[]): Uint8Array[] {
    const held = new Map((this.held ?? []).map((h) => [h.id, h]));
    return rows.map((r) => {
      const h = held.get(r.id);
      return h ? satsRefresh(this.fileText, [new Uint8Array(h.record)])[0] : new Uint8Array(r.record);
    });
  }

  /** Reads once a connection is up (the page open); with Keep up to date on, the connect's own check reads instead. */
  ensure() {
    const link = radio.connectedLink;
    if (!link || this.heldFor === link || this.busy || !this.supported) return;
    if (this.auto && this.syncedFor !== link) return;
    untrack(() => void this.readRadio().catch(() => {}));
  }

  /** The radio's satellites, info record and clock. Holds the link (the Live View pauses). */
  async readRadio(): Promise<void> {
    const link = radio.connectedLink;
    if (!link) throw new Error("Connect to a radio first.");
    if (!this.supported) throw new Error("This radio's firmware has no satellites over the link: update Ferrite.");
    this.heldFor = link;
    this.error = "";
    radio.busy = this.busy = "Reading satellites";
    try {
      await this.readOn(link);
    } catch (e) {
      this.error = (e as Error).message;
      throw e;
    } finally {
      radio.busy = this.busy = "";
    }
  }

  private async readOn(link: Link) {
    const recs = await link.readMany(P.what.SAT, 0, P.limits.sats);
    const held: SatRow[] = [];
    for (const [i, r] of [...recs].sort((a, b) => a[0] - b[0])) {
      const s = r.length ? satHeld(r) : null;
      if (s && i < P.limits.sats) held.push(s);
    }
    const info = (await link.readMany(P.what.SAT_INFO, 0, 1)).get(0);
    const c = await link.ok(P.msg.CLOCK);
    this.held = held;
    this.info = info?.length ? satInfoOf(info) : null;
    this.clock = clockOf(c);
  }

  /**
   * The radio's position for the declination (SAT-18): its GPS fix, else its fixed position (MENU 0 6 9), else the
   * place set in Near me. Null when none.
   */
  private async position(link: Link): Promise<{ lat: number; lon: number; from: string } | null> {
    try {
      const r = await radioPlace(link);
      if (r) return { lat: r.place.lat, lon: r.place.lon, from: r.gps ? "the radio's GPS" : "the radio's fixed position" };
    } catch {
      /* Near me's */
    }
    const p = library.place;
    return p ? { lat: p.lat, lon: p.lon, from: "the place set in Near me" } : null;
  }

  /**
   * SAT-3, LINK-63 – LINK-65: the clock, the list (clear all, then records 0..n-1 in order) and the info record with
   * the declination and the file's build time. Returns where the declination came from (or that there was none).
   */
  private async writeOn(link: Link, records: Uint8Array[], stamp: number): Promise<string> {
    const clock = new Uint8Array(4);
    new DataView(clock.buffer).setUint32(0, nowS(), true);
    await link.ok(P.msg.CLOCK, clock);
    const pos = await this.position(link);
    const decl = pos ? wmmDeclination(pos.lat, pos.lon, nowS()) : null;
    await link.writeRecords(P.what.SAT, [{ index: P.satAll, record: new Uint8Array() }, ...records.map((record, index) => ({ index, record }))]);
    await link.writeRecords(P.what.SAT_INFO, [{ index: 0, record: satInfoRecord(decl, stamp, nowS()) }]);
    await this.readOn(link);
    return pos ? `declination ${declText(decl)} at ${pos.from}` : "no declination (the radio has no position: set one in Near me, or MENU 0 6 9)";
  }

  /** Writes the list to the radio (the page's Write). */
  async write(): Promise<void> {
    const link = radio.connectedLink;
    const f = this.file;
    if (!link || !f || !this.supported) return;
    const rows = this.toWrite;
    this.error = "";
    this.notice = "";
    radio.busy = this.busy = `Writing ${rows.length} satellites`;
    try {
      const how = await this.writeOn(link, this.records(rows), f.built);
      this.heldFor = link;
      this.notice = `Wrote ${rows.length} ${rows.length === 1 ? "satellite" : "satellites"} and set the radio's clock; ${how}.`;
    } catch (e) {
      this.error = `The satellites didn't write: ${(e as Error).message}`;
    } finally {
      radio.busy = this.busy = "";
    }
  }

  /**
   * SAT-21, on each connect: the whole list goes on the radio (with the declination and clock) when the radio's set
   * isn't the list's (a radio holding none too) or the list is newer than its data, and Console last wrote them more
   * than a day ago; each keeps the starting settings the radio held for it. No prompt; a toast says so. Quiet when
   * anything fails (the page shows errors when opened).
   */
  async connected(link: Link) {
    if (this.syncedFor === link) return;
    this.syncedFor = link;
    let busy = false;
    try {
      await loadCore();
      if (this.supported && this.setClock) {
        try {
          const c = clockOf(await link.ok(P.msg.CLOCK));
          if (c?.source !== "GPS") {
            const t = new Uint8Array(4);
            new DataView(t.buffer).setUint32(0, nowS(), true);
            await link.ok(P.msg.CLOCK, t);
          }
        } catch {
          /* the radio keeps its own clock */
        }
      }
      if (!this.supported || !this.auto) return;
      busy = true;
      radio.busy = this.busy = "Checking the radio's satellites";
      await this.readOn(link);
      this.heldFor = link;
      const held = this.held ?? [];
      const f = await this.loadFile(true);
      if (!f || radio.connectedLink !== link) return;
      const rows = this.toWrite;
      const ids = (l: { id: number }[]) => l.map((s) => s.id).sort((a, b) => a - b).join(",");
      const same = ids(held) === ids(rows);
      if (!rows.length || !satsSyncDue(f.built, same, this.info, nowS())) return;
      radio.busy = this.busy = "Updating the radio's satellites";
      await this.writeOn(link, this.records(rows), f.built);
      this.toast = same
        ? `Updated the radio's ${rows.length} satellites with fresh elements (data of ${f.built_text}).`
        : `Put the ${rows.length} satellites of the list on the radio (data of ${f.built_text}).`;
    } catch {
      /* the page shows what's wrong when opened */
    } finally {
      if (busy) radio.busy = this.busy = "";
    }
  }
}

export const satellites = new Satellites();
