// Press and hold, as the radio's keys: let go before 750 ms = a short press, held to 750 ms = a long press (sent at
// once; the radio holds it 750 ms then lets go: LINK-19). Shift makes any press long (UV Studio's convention). The
// drawn keypad and the keyboard both come through here. Never PTT: the core has no name for one.
import { P } from "./core";
import { radio } from "./radio.svelte";

class Presser {
  /** Keys shown pressed: "down" while held, "long" once the long press went. */
  shown = $state<Record<string, "down" | "long">>({});
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  down(name: string, long = false) {
    if (this.timers.has(name) || this.shown[name]) return;
    if (long) {
      this.shown[name] = "long";
      void radio.press(name, true);
      setTimeout(() => delete this.shown[name], 250);
      return;
    }
    this.shown[name] = "down";
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        this.shown[name] = "long";
        void radio.press(name, true);
      }, P?.timing.hold_for_long_ms ?? 750),
    );
  }

  up(name: string) {
    const t = this.timers.get(name);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(name);
      void radio.press(name, false);
    }
    if (this.shown[name] !== "long" || t !== undefined) delete this.shown[name];
    else setTimeout(() => delete this.shown[name], 100);
  }

  /** The pointer left the key before letting go: nothing is sent. */
  cancel(name: string) {
    const t = this.timers.get(name);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(name);
    delete this.shown[name];
  }
}

export const presser = new Presser();

/** Knob steps gathered for a moment and sent as one KEY (a fast wheel would otherwise queue dozens). */
let pending = 0;
let flushing: ReturnType<typeof setTimeout> | undefined;
export function turn(steps: number) {
  pending += steps;
  if (flushing) return;
  flushing = setTimeout(() => {
    const n = pending;
    pending = 0;
    flushing = undefined;
    void radio.knob(n);
  }, 90);
}
