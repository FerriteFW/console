// The APRS console's state: the radio's heard list and messages (HEARD, MSGS: LINK-44), kept current by the
// subscription's events (LINK-46) while an APRS page is open, sending a message (MSG_SEND: LINK-45), and the radio's
// own position for distances (its GPS fix, else its fixed position). Ages become times when they arrive.
import { parsePlace, type AprsEvent, type Message, type Station } from "./core";
import { RadioError } from "./link";
import { radio } from "./radio.svelte";

export type HeardRow = Station & { at: number };
export type MsgRow = Message & { at: number; id: number };
export type Thread = { peer: string; last: MsgRow; unread: number; messages: MsgRow[] };
export type Place = { lat: number; lon: number; from: string };

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle km and the initial bearing (degrees) from `a` to `b`. */
export function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): { km: number; deg: number } {
  const [f1, f2, dl] = [rad(a.lat), rad(b.lat), rad(b.lon - a.lon)];
  const h = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return { km, deg: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 };
}

export const compass = (deg: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

/** "3 min ago", "2 h ago", from a time in ms. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** A local date and time, to the second. */
export const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

let nextId = 1;

class Aprs {
  stations = $state<HeardRow[]>([]);
  heardCount = $state(0);
  messages = $state<MsgRow[]>([]);
  me = $state<Place | null>(null);
  loaded = $state(false);
  busy = $state("");
  error = $state("");
  readAt = $state(0);
  /** Events arrived since the last read (for the pages' "live" mark). */
  events = $state(0);
  private users = 0;
  private release: (() => void) | null = null;
  private forLink: unknown = null;

  /** A page is open: events while any is, and a read when the lists are from another connection or none. */
  use(): () => void {
    if (this.users++ === 0) {
      const stopWant = radio.want("aprs", 1 | 2);
      const stopEvents = radio.onEvents((ev, gap) => this.onEvent(ev, gap));
      this.release = () => {
        stopWant();
        stopEvents();
      };
    }
    return () => {
      if (--this.users === 0) {
        this.release?.();
        this.release = null;
        this.forLink = null; // events stop: the next page open reads again
      }
    };
  }

  /** Reads when connected and the lists aren't this connection's (call from an effect on the connection). */
  ensure() {
    const link = radio.connectedLink;
    if (!link) return;
    if (this.forLink !== link && !this.busy) void this.refresh();
  }

  async refresh() {
    const link = radio.connectedLink;
    if (!link) return;
    this.forLink = link;
    this.error = "";
    this.busy = "Reading the heard list and messages";
    try {
      const now = Date.now();
      const h = await link.heard();
      this.heardCount = h.count;
      this.stations = h.stations.map((s) => ({ ...s, at: now - s.ago_s * 1000 }));
      const m = await link.msgs();
      this.messages = m.messages.map((x) => ({ ...x, at: now - x.ago_s * 1000, id: nextId++ }));
      this.loaded = true;
      this.readAt = now;
      this.events = 0;
      if (!this.me) await this.position();
    } catch (e) {
      this.error = e instanceof RadioError && e.status === 2 ? "This radio's firmware has no APRS over the link yet (LINK-44): update it." : (e as Error).message;
      this.forLink = null;
    } finally {
      this.busy = "";
    }
  }

  /** The radio's place: its GPS fix, else APRS's fixed position, else the radio's (MENU 0 5 4 5, 0 6 9). */
  async position() {
    const link = radio.connectedLink;
    if (!link) return;
    for (const [cmd, from] of [
      ["gps", "GPS"],
      ["get 0 5 4 5", "APRS fixed position"],
      ["get 0 6 9", "fixed position"],
    ] as const) {
      try {
        const p = parsePlace(await link.cmd(cmd));
        if (p) {
          this.me = { lat: p.lat, lon: p.lon, from };
          return;
        }
      } catch {
        /* the next */
      }
    }
  }

  private onEvent(ev: AprsEvent | null, gap: boolean) {
    if (gap) {
      void this.refresh(); // some were lost: read the lists again
      return;
    }
    if (!ev || !this.loaded) return;
    const now = Date.now();
    if (ev.kind === "heard") {
      const s: HeardRow = { ...ev.station, at: now - ev.station.ago_s * 1000 };
      this.stations = [s, ...this.stations.filter((x) => x.call !== s.call)];
      this.heardCount = ev.count;
      this.events++;
    } else if (ev.kind === "message") {
      this.messages = [{ ...ev.message, at: now - ev.message.ago_s * 1000, id: nextId++ }, ...this.messages];
      this.events++;
    } else if (ev.kind === "message_state") {
      const m = ev.message;
      const i = this.messages.findIndex((x) => x.inbound === m.inbound && x.peer === m.peer && x.text === m.text);
      if (i >= 0) {
        const next = [...this.messages];
        next[i] = { ...next[i], state: m.state, state_n: m.state_n, tries: m.tries };
        this.messages = next;
      }
      this.events++;
    }
  }

  /** Conversations by station, the newest first; each one's messages oldest first. */
  get threads(): Thread[] {
    const by = new Map<string, MsgRow[]>();
    for (const m of this.messages) {
      const k = m.peer.toUpperCase();
      if (!by.has(k)) by.set(k, []);
      by.get(k)!.push(m);
    }
    return [...by.entries()]
      .map(([peer, ms]) => {
        const sorted = [...ms].sort((a, b) => a.at - b.at || b.id - a.id);
        return { peer, last: sorted[sorted.length - 1], unread: ms.filter((m) => m.inbound && m.state === "unread").length, messages: sorted };
      })
      .sort((a, b) => b.last.at - a.last.at);
  }

  /**
   * LINK-45: a message queued on the radio, which sends it by its own rules. What happens next, in words. Without
   * events (older firmware) the list is read again.
   */
  async send(to: string, text: string): Promise<string> {
    const link = radio.connectedLink;
    if (!link) throw new Error("Connect to a radio first.");
    const now = await link.msgSend(to, text);
    if (!(radio.subMask & 2)) await this.refresh();
    return now ? "Queued: it goes at the radio's next APRS turn." : "Queued: it waits until APRS mode is on (MENU 0 5 3).";
  }

  /** The heard station named `call`, if any. */
  station(call: string) {
    return this.stations.find((s) => s.call.toUpperCase() === call.toUpperCase());
  }
}

export const aprs = new Aprs();
