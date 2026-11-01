// The connection and what the Live View shows, as Svelte state: connect (cable, Bluetooth, demo), HELLO, the PIN
// when the radio asks for it, INFO, the cable's faster rate, then the screen: the UI readback polled on the cable,
// and on Bluetooth the radio's own compact updates (LINK-47, LINK-48) through a subscription (LINK-46), which also
// carries the APRS events the APRS pages ask for.
import { LiveClient, loadCore, P, parseEvent, parseUi, type AprsEvent, type Hello, type Info, type Ui } from "./core";
import { Link, RadioError, TimeoutError } from "./link";
import { provider, type Transport, type TransportKind } from "./transport";
import { BridgeTransport } from "./transport/bridge";
import { sleep } from "./transport/types";

/** "updating": Firmware Update holds the cable (no link: the bootloader's protocol, or waiting for the restart). */
export type Phase = "idle" | "connecting" | "pin" | "connected" | "updating";

/** Cable: a readback every so often (each takes ~50-100 ms at 115200). Bluetooth: back to back (~1 s each). */
const POLL_GAP_MS = { cable: 150, bluetooth: 0, demo: 150 } as const;
/** Readbacks failing in a row before the bar says the radio isn't answering. */
const FAILS_SHOWN = 2;
/** A subscription is renewed this often (the radio drops it after 10 s without a frame: LINK-46). */
const RENEW_MS = 5000;
/** Live View by events: no update this long (the radio sends one at least every 5 s) asks for the whole state. */
const UI_SILENT_MS = 12_000;
/** The cable's readbacks failing in a row before the radio counts as gone (restarted: it speaks 115200 again). */
const LOST_AFTER = 5;
/** Reconnecting: a try this often (the first few quicker), for this long at most. */
const RETRY_MS = [1000, 2000, 2000, 3000, 5000];
const RETRY_FOR_MS = 30 * 60_000;
/** `?liveview=events` uses the updates on the cable too; `?liveview=poll` polls on Bluetooth too. */
const LIVE_MODE = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("liveview");

/** An APRS event (or `gap`: events were lost: read the lists again). */
export type EventListener = (ev: AprsEvent | null, gap: boolean) => void;

class Radio {
  phase = $state<Phase>("idle");
  kind = $state<TransportKind | null>(null);
  label = $state("");
  /** The port or radio is open and the session is starting (HELLO, INFO): set as soon as `open` returns, cleared
   *  at each connect. The welcome closes on it rather than waiting the seconds Bluetooth takes to answer. */
  opened = $state(false);
  baud = $state<number | null>(null);
  hello = $state<Hello | null>(null);
  info = $state<Info | null>(null);
  ui = $state<Ui | null>(null);
  /** How long the last readback took, ms. */
  uiMs = $state(0);
  /** Readbacks failed in a row. */
  fails = $state(0);
  error = $state("");
  /** A note for the bar ("230400 baud"). */
  note = $state("");
  /** A key's refusal, shown a few seconds. */
  keyNote = $state("");
  #live = $state(true);
  /** Live View polling on; turning it on reads the screen at once. */
  get live() {
    return this.#live;
  }
  set live(v: boolean) {
    this.#live = v;
    this.refresh();
    this.subWake?.();
  }
  pinError = $state("");
  /** The link dropped and Console is picking the same radio up again by itself: why it dropped, and the tries so
   *  far; null when not reconnecting. */
  retrying = $state<{ why: string; tries: number } | null>(null);
  /** A transfer (channels read or written) holds the link: the Live View stops polling meanwhile. */
  busy = $state("");

  /** What is subscribed now (LINK-46: 1 heard, 2 messages, 4 Live View, 8 the event log: LINK-57); 0 none. */
  subMask = $state(0);
  /** The radio answered SUBSCRIBE `unknown type`: firmware before LINK-46 (polling only, no APRS events). */
  noEvents = $state(false);
  /** Live View comes from the radio's updates now (not the polled readback). */
  get liveByEvents() {
    return (this.subMask & 4) !== 0;
  }
  /** Live View's event bytes a second (the last 10 s), and the updates and whole-state asks so far. */
  liveRate = $state(0);
  liveUpdates = $state(0);
  liveResyncs = $state(0);

  private link: Link | null = null;
  private t: Transport | null = null;
  private wake: (() => void) | null = null;
  private generation = 0;
  /** What each part of Console wants events for (its mask). */
  private wants = new Map<string, number>();
  private listeners = new Set<EventListener>();
  private subWake: (() => void) | null = null;
  private resync = false;
  private lastEvSeq: number | null = null;
  private lastUiAt = 0;
  private live_: InstanceType<typeof LiveClient> | null = null;
  private evLog: [number, number][] = [];
  /** Disconnecting: no more subscriptions. */
  private leaving = false;
  /** How to open this session's port or radio again with no chooser (the transport's `reopen`). */
  private reopen: (() => Promise<Transport>) | null = null;
  private retryGen = 0;

  /** The link while connected (channel programming uses it directly). */
  get connectedLink(): Link | null {
    return this.phase === "connected" ? this.link : null;
  }

  available() {
    return provider.available();
  }

  async connect(kind: TransportKind) {
    this.stopRetry();
    return this.connectWith(() => provider.open(kind));
  }

  /** The development bridge (tools/bridge.py): the cable or the simulator over a local WebSocket. */
  async connectBridge(url?: string) {
    this.stopRetry();
    return this.connectWith(() => BridgeTransport.open(url));
  }

  /** Stop reconnecting (the bar's Stop, or another connection started). */
  stopRetry() {
    if (!this.retrying) return;
    this.retryGen++;
    this.retrying = null;
  }

  /**
   * The link dropped (cable pulled, the radio restarted, Bluetooth gone): open the same port or radio again in the
   * background, quietly, until it answers (no chooser, no welcome). Listen stays off (LINK-13.5); Live View and the
   * pages' event subscriptions come back by themselves (they live here, not in the link).
   */
  private lost(why: string) {
    const reopen = this.reopen;
    if (!reopen || this.leaving) {
      this.error = why;
      return;
    }
    const g = ++this.retryGen;
    this.retrying = { why, tries: 0 };
    this.error = "";
    const start = performance.now();
    void (async () => {
      for (let i = 0; ; i++) {
        await sleep(RETRY_MS[Math.min(i, RETRY_MS.length - 1)]);
        if (g !== this.retryGen) return;
        if (performance.now() - start > RETRY_FOR_MS) {
          this.retrying = null;
          this.error = `${why} Console stopped trying to reconnect after 30 minutes.`;
          return;
        }
        if (this.phase !== "idle") continue;
        this.retrying = { why, tries: i + 1 };
        let t: Transport;
        try {
          t = await reopen();
        } catch {
          continue; // not back yet
        }
        if (g !== this.retryGen || this.phase !== "idle") {
          await t.close().catch(() => {});
          return;
        }
        await this.connectWith(async () => t, true);
        if (g !== this.retryGen) return;
        if (this.phase === "connected" || this.phase === "pin") {
          this.retryGen++;
          this.retrying = null;
          return;
        }
      }
    })();
  }

  /**
   * Firmware Update takes the cable from a connected session: polling stops; the link stays usable for REBOOT. The
   * bar shows "Updating firmware" until `handBack` or `disconnect`.
   */
  takeForUpdate(): { t: Transport; link: Link } | null {
    if (this.phase !== "connected" || !this.link || !this.t || this.kind !== "cable") return null;
    const gen = ++this.generation; // the poll loop stops
    this.wake?.();
    this.phase = "updating";
    this.busy = "";
    this.note = "";
    this.ui = null;
    const t = this.t;
    t.onClose = (why) => {
      if (gen === this.generation) this.drop(why);
    };
    return { t, link: this.link };
  }

  /**
   * Firmware Update with no session: the cable (or the bridge) opened as it is, for a radio waiting in the
   * bootloader after a failed update. No HELLO: the bootloader doesn't speak the link.
   */
  async openForUpdate(how: "cable" | "bridge"): Promise<Transport> {
    this.stopRetry();
    if (this.phase !== "idle") throw new Error("Disconnect first.");
    this.error = "";
    this.note = "";
    await loadCore();
    const t = how === "bridge" ? await BridgeTransport.open() : await provider.open("cable");
    const gen = ++this.generation;
    this.t = t;
    this.kind = t.kind;
    this.label = t.label;
    this.phase = "updating";
    t.onClose = (why) => {
      if (gen === this.generation) this.drop(why);
    };
    this.reopen = t.reopen ? () => t.reopen!() : null;
    return t;
  }

  /** Firmware Update or Finish the update still holds this transport (the cable wasn't pulled or let go). */
  holds(t: Transport): boolean {
    return this.phase === "updating" && this.t === t;
  }

  /** The update is done: the same cable, connected again as usual (HELLO, INFO, the faster rate). */
  async handBack(t: Transport) {
    if (this.phase !== "updating" || this.t !== t) return;
    this.link?.close();
    this.link = null;
    this.phase = "idle";
    await this.connectWith(async () => t);
    // The radio not answering yet after its update (still starting): keep trying by itself.
    if (this.phase === "idle" && this.reopen) this.lost(this.error || "The radio didn't answer after the update.");
  }

  /** `quiet`: a reconnect's try: a failure leaves no error behind (the next try comes). */
  private async connectWith(open: () => Promise<Transport>, quiet = false) {
    if (this.phase !== "idle") return;
    this.leaving = false;
    this.error = "";
    this.note = "";
    this.phase = "connecting";
    this.opened = false;
    const gen = ++this.generation;
    try {
      await loadCore();
      const t = await open();
      this.opened = true;
      this.t = t;
      this.kind = t.kind;
      this.label = t.label;
      this.reopen = t.reopen ? () => t.reopen!() : null;
      const link = new Link(t);
      this.link = link;
      t.onClose = (why) => {
        if (gen === this.generation) this.drop(why);
      };
      await link.open();
      const hello = await link.hello();
      this.hello = hello;
      if (!hello.may_go_on) {
        this.phase = "pin";
        return;
      }
      await this.afterAuth(gen);
    } catch (e) {
      if (gen === this.generation) await this.fail(e, quiet);
    }
  }

  /** LINK-30: the PIN the radio asked for. Wrong: say so and ask again; locked out: say so. */
  async submitPin(pin: string) {
    const link = this.link;
    if (!link || this.phase !== "pin") return;
    this.pinError = "";
    try {
      await link.auth(pin);
      this.phase = "connecting";
      await this.afterAuth(this.generation);
    } catch (e) {
      if (e instanceof RadioError && e.status === 4) this.pinError = "Wrong PIN (wrong tries count toward the radio's lockout).";
      else if (e instanceof RadioError && e.status === 7) this.pinError = "The radio is locked out after wrong PINs: wait, then try again.";
      else await this.fail(e);
    }
  }

  private async afterAuth(gen: number) {
    const link = this.link!;
    this.info = await link.info();
    if (this.t?.unlock) {
      // LINK-15.1: Bluetooth at 115200 when the radio and its module take it (ferrite decision 285)
      const rate = await link.bleFast().catch(() => 0);
      if (rate) this.note = rate > 9600 ? "Bluetooth at 115200" : "Bluetooth at 9600";
    }
    if (this.t?.setBaud) {
      // LINK-13.3: the cable at 230400, else 115200 (ferrite decision 266).
      try {
        const rate = await link.raiseBaud();
        this.baud = rate;
        this.note = rate > 115200 ? `${rate} baud` : "115200 baud (the radio kept its rate)";
      } catch (e) {
        this.baud = this.t.baud ?? null;
        this.note = `115200 baud (${(e as Error).message})`;
      }
    }
    if (gen !== this.generation) return;
    this.phase = "connected";
    this.lastEvSeq = null;
    this.live_?.free();
    this.live_ = new LiveClient();
    link.onEvent = (seq, p) => {
      if (gen === this.generation) this.event(seq, p);
    };
    void this.poll(gen);
    void this.subscriptions(gen);
  }

  /** Live View by the radio's updates: Bluetooth (unless `?liveview=poll`), or anywhere with `?liveview=events`. */
  private get eventsForLive() {
    if (this.noEvents || this.kind === "demo") return false;
    return LIVE_MODE === "events" || (this.kind === "bluetooth" && LIVE_MODE !== "poll");
  }

  /** The mask wanted now. */
  private wanted() {
    let m = 0;
    for (const w of this.wants.values()) m |= w;
    if (this.live && !this.busy && this.eventsForLive) m |= 4;
    // LINK-57: the event log's events only from a radio that has them (HELLO caps 128).
    if (!this.link || !(this.link.caps & P.caps.LISTS)) m &= ~8;
    return this.noEvents || this.leaving ? 0 : m;
  }

  /**
   * Events for `who` (`mask`: 1 heard, 2 messages, 8 the event log): subscribed while any part wants them. The returned function
   * stops wanting them.
   */
  want(who: string, mask: number): () => void {
    this.wants.set(who, mask);
    this.subWake?.();
    return () => {
      this.wants.delete(who);
      this.subWake?.();
    };
  }

  /** APRS events as they come (and `gap` when some were lost). The returned function stops listening. */
  onEvents(f: EventListener): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private event(seq: number, p: Uint8Array) {
    const gap = this.lastEvSeq !== null && seq !== ((this.lastEvSeq + 1) & 0xff);
    this.lastEvSeq = seq;
    if (p[0] === P.event.UI) {
      if (!(this.subMask & 4) || !this.live_) return;
      const now = performance.now();
      this.evLog.push([now, p.length + 6]);
      while (this.evLog.length && now - this.evLog[0][0] > 10_000) this.evLog.shift();
      const r = this.live_.apply(p.subarray(1));
      this.liveUpdates = this.live_.updates();
      this.liveResyncs = this.live_.resyncs();
      if (r === 0) {
        this.ui = parseUi(this.live_.text());
        this.lastUiAt = now;
        this.fails = 0;
        const span = Math.max(1000, now - this.evLog[0][0]);
        this.liveRate = Math.round((this.evLog.reduce((n, e) => n + e[1], 0) * 1000) / span);
      } else if (r === 2) {
        this.resync = true;
        this.subWake?.();
      }
      return;
    }
    const ev = parseEvent(p);
    for (const f of this.listeners) f(ev, gap);
  }

  /**
   * The subscription (LINK-46): SUBSCRIBE when the mask wanted changes or the Live View must start over, renewed
   * every 5 s; mask 0 ends it.
   */
  private async subscriptions(gen: number) {
    let renewAt = 0;
    while (gen === this.generation && this.phase === "connected") {
      const link = this.link;
      const want = this.wanted();
      const now = performance.now();
      if (want & 4 && this.subMask & 4 && now - this.lastUiAt > UI_SILENT_MS) this.resync = true;
      try {
        if (link && (want !== this.subMask || this.resync)) {
          this.resync = false;
          if (want & 4) {
            this.live_?.reset();
            this.lastUiAt = now;
          }
          const dict = await link.subscribe(want);
          if (gen !== this.generation) return;
          if (want & 4 && dict !== P.event.DICT) {
            this.noEvents = true; // a dictionary this Console doesn't know: poll instead
            await link.subscribe(0);
            this.subMask = 0;
          } else this.subMask = want;
          renewAt = performance.now() + RENEW_MS;
          this.wake?.(); // the poll loop starts or stops reading the screen
        } else if (link && want && now >= renewAt) {
          await link.subscribe(want, true);
          renewAt = performance.now() + RENEW_MS;
        }
      } catch (e) {
        if (gen !== this.generation) return;
        if (e instanceof RadioError && e.status === 2) {
          this.noEvents = true; // firmware before LINK-46
          this.subMask = 0;
          this.wake?.();
        }
      }
      await new Promise<void>((r) => {
        this.subWake = r;
        setTimeout(r, 1000);
      });
      this.subWake = null;
    }
  }

  private async poll(gen: number) {
    while (gen === this.generation && this.phase === "connected") {
      if (this.live && this.link && !this.busy && !this.liveByEvents) {
        const t0 = performance.now();
        try {
          const text = await this.link.uiText();
          if (gen !== this.generation) return;
          this.ui = parseUi(text);
          this.uiMs = Math.round(performance.now() - t0);
          this.fails = 0;
        } catch (e) {
          if (gen !== this.generation) return;
          this.fails++;
          if (!(e instanceof TimeoutError) && !(e instanceof RadioError)) {
            this.drop((e as Error)?.message ?? String(e));
            return;
          }
          // The cable's radio silent this long: restarted (back at 115200) or switched off: start over.
          if (this.kind === "cable" && this.fails >= LOST_AFTER && this.reopen) {
            this.drop("The radio stopped answering.");
            return;
          }
        }
      }
      const gap = this.live && !this.liveByEvents ? POLL_GAP_MS[this.kind ?? "cable"] : 60_000;
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, Math.max(gap, 20));
      });
      this.wake = null;
    }
  }

  /** Test hook (e2e): the bridge's link drops as a pulled cable would. */
  bridgeDrop(): boolean {
    if (!(this.t instanceof BridgeTransport)) return false;
    this.t.dropForTest();
    return true;
  }

  /** The development bridge's simulator test hooks (tools/bridge.py): false when not on a bridge. */
  bridgeControl(msg: object): boolean {
    if (!(this.t instanceof BridgeTransport)) return false;
    this.t.sendControl(msg);
    return true;
  }

  /** The page is closing: the cable's rate back to 115200, best effort (no waiting). */
  releaseNow() {
    if (this.phase === "connected") this.link?.releaseNow();
  }

  /** Read the screen again now (after a key). */
  refresh() {
    this.wake?.();
  }

  get notAnswering() {
    return this.fails >= FAILS_SHOWN;
  }

  /** A key: "short" or "long" (never PTT). True once the radio answered it. */
  async press(name: string, long = false): Promise<boolean> {
    if (!this.link || this.phase !== "connected") return false;
    try {
      await this.link.key(name, long ? "long" : "short");
      this.refresh();
      return true;
    } catch (e) {
      this.flash(e);
      return false;
    }
  }

  async knob(steps: number) {
    if (!this.link || this.phase !== "connected" || !steps) return;
    try {
      await this.link.knob(steps);
      this.refresh();
    } catch (e) {
      this.flash(e);
    }
  }

  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** A key's refusal, shown a few seconds in the bar. */
  private flash(e: unknown) {
    this.keyNote = `Key: ${(e as Error).message}`;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => (this.keyNote = ""), 4000);
  }

  private async fail(e: unknown, quiet = false) {
    const msg = (e as Error)?.message ?? String(e);
    // The chooser closed without a pick: not an error worth a banner.
    const cancelled = (e as Error)?.name === "NotFoundError" && /cancel|no port selected|chooser/i.test(msg);
    await this.teardown();
    this.error = cancelled || quiet ? "" : msg;
  }

  /** The link went away: a connected session reconnects by itself; anything else (an update) just says why. */
  private drop(why: string) {
    const was = this.phase === "connected";
    void this.teardown().then(() => (was ? this.lost(why) : (this.error = why)));
  }

  private async teardown() {
    this.generation++;
    this.wake?.();
    const t = this.t;
    this.link?.close();
    this.link = null;
    this.t = null;
    this.phase = "idle";
    this.ui = null;
    this.hello = null;
    this.info = null;
    this.baud = null;
    this.kind = null;
    this.fails = 0;
    this.pinError = "";
    this.busy = "";
    this.subMask = 0;
    this.noEvents = false;
    this.resync = false;
    this.live_?.free();
    this.live_ = null;
    this.liveRate = 0;
    this.subWake?.();
    if (t) {
      try {
        await t.close();
      } catch {
        /* gone */
      }
    }
  }

  async disconnect() {
    // LINK-11: the cable back at 115200 first, so tools/flash.py and the terminal find the radio there.
    this.stopRetry();
    this.reopen = null;
    const link = this.link;
    this.leaving = true;
    if (link && this.phase === "connected" && this.subMask) {
      // LINK-46: events stop now, not 10 s later on a cable the next program may already hold.
      this.subMask = 0;
      try {
        await Promise.race([link.subscribe(0), sleep(1500)]);
      } catch {
        /* the session ends anyway */
      }
    }
    if (link && this.phase === "connected") {
      this.busy = "Restoring the cable's rate";
      try {
        await Promise.race([link.lowerBaud(), sleep(2500)]);
      } catch {
        /* best effort */
      }
    }
    await this.teardown();
    this.error = "";
    this.note = "";
  }
}

export const radio = new Radio();
export { sleep };
