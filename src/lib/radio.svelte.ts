// The connection and what the Live View shows, as Svelte state: connect (cable, Bluetooth, demo), HELLO, the PIN
// when the radio asks for it, INFO, the cable's faster rate, then the UI readback polled while connected.
import { loadCore, parseUi, type Hello, type Info, type Ui } from "./core";
import { Link, RadioError, TimeoutError } from "./link";
import { provider, type Transport, type TransportKind } from "./transport";
import { sleep } from "./transport/types";

export type Phase = "idle" | "connecting" | "pin" | "connected";

/** Cable: a readback every so often (each takes ~50-100 ms at 115200). Bluetooth: back to back (~1 s each). */
const POLL_GAP_MS = { cable: 150, bluetooth: 0, demo: 150 } as const;
/** Readbacks failing in a row before the bar says the radio isn't answering. */
const FAILS_SHOWN = 2;

class Radio {
  phase = $state<Phase>("idle");
  kind = $state<TransportKind | null>(null);
  label = $state("");
  baud = $state<number | null>(null);
  hello = $state<Hello | null>(null);
  info = $state<Info | null>(null);
  ui = $state<Ui | null>(null);
  /** How long the last readback took, ms. */
  uiMs = $state(0);
  /** Readbacks failed in a row. */
  fails = $state(0);
  error = $state("");
  /** A note for the bar ("rate 460800"). */
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
  }
  pinError = $state("");

  private link: Link | null = null;
  private t: Transport | null = null;
  private wake: (() => void) | null = null;
  private generation = 0;

  available() {
    return provider.available();
  }

  async connect(kind: TransportKind) {
    if (this.phase !== "idle") return;
    this.error = "";
    this.note = "";
    this.phase = "connecting";
    const gen = ++this.generation;
    try {
      await loadCore();
      const t = await provider.open(kind);
      this.t = t;
      this.kind = kind;
      this.label = t.label;
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
      if (gen === this.generation) await this.fail(e);
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
    if (this.t?.setBaud) {
      // LINK-13.3: the cable at 460800, else 230400, else 115200.
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
    void this.poll(gen);
  }

  private async poll(gen: number) {
    while (gen === this.generation && this.phase === "connected") {
      if (this.live && this.link) {
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
            await this.fail(e);
            return;
          }
        }
      }
      const gap = this.live ? POLL_GAP_MS[this.kind ?? "cable"] : 60_000;
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, Math.max(gap, 20));
      });
      this.wake = null;
    }
  }

  /** Read the screen again now (after a key). */
  refresh() {
    this.wake?.();
  }

  get notAnswering() {
    return this.fails >= FAILS_SHOWN;
  }

  /** A key: "short" or "long" (never PTT). */
  async press(name: string, long = false) {
    if (!this.link || this.phase !== "connected") return;
    try {
      await this.link.key(name, long ? "long" : "short");
      this.refresh();
    } catch (e) {
      this.flash(e);
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

  private async fail(e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    // The chooser closed without a pick: not an error worth a banner.
    const cancelled = (e as Error)?.name === "NotFoundError" && /cancel|no port selected|chooser/i.test(msg);
    await this.teardown();
    this.error = cancelled ? "" : msg;
  }

  private drop(why: string) {
    void this.teardown().then(() => (this.error = why));
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
    if (t) {
      try {
        await t.close();
      } catch {
        /* gone */
      }
    }
  }

  async disconnect() {
    await this.teardown();
    this.error = "";
    this.note = "";
  }
}

export const radio = new Radio();
export { sleep };
