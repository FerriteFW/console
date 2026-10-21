// A typed key sequence ("MENU 0 7 1", "MENU:long DOWN DOWN"): checked whole before anything is sent, then pressed
// in order, each one answered by the radio before the next (as radio.press does), a short gap between. Names are the
// keypad's (the core's: MENU/OK, BACK/EXIT, UP, DOWN, LEFT, RIGHT, SLOT/ABC, VM, 0-9, STAR/*, HASH/#, SIDE1/PF1,
// SIDE2/PF2); ":long" makes a press long. Never PTT: the core has no name for one, so it is refused like any unknown.
import { keyPayload } from "./core";
import { radio, sleep } from "./radio.svelte";

export type Step = { name: string; long: boolean };

/** Gap after each answered press, so the radio draws before the next. */
const GAP_MS = 150;
const RECENT_KEY = "keySequences";
const RECENT_MAX = 6;

/** The steps, or the names the core doesn't know. */
export function parseSequence(text: string): { steps: Step[]; unknown: string[] } {
  const steps: Step[] = [];
  const unknown: string[] = [];
  for (const tok of text.trim().split(/[\s,]+/).filter(Boolean)) {
    const m = /^(.+?)(?::(long|short))?$/i.exec(tok)!;
    const name = m[1].toUpperCase();
    let ok = false;
    try {
      keyPayload(name, "short");
      ok = true;
    } catch {
      /* unknown */
    }
    if (ok) steps.push({ name, long: m[2]?.toLowerCase() === "long" });
    else unknown.push(tok);
  }
  return { steps, unknown };
}

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

class Sequencer {
  running = $state(false);
  /** Which step is being pressed (0-based) and how many there are. */
  at = $state(0);
  total = $state(0);
  error = $state("");
  recent = $state<string[]>(loadRecent());
  private stopped = false;

  remember(text: string) {
    const t = text.trim().replace(/\s+/g, " ");
    this.recent = [t, ...this.recent.filter((r) => r !== t)].slice(0, RECENT_MAX);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    } catch {
      /* not kept */
    }
  }

  /** Checks and runs `text`; false if refused (the reason in `error`). */
  async run(text: string): Promise<boolean> {
    if (this.running) return false;
    this.error = "";
    if (radio.phase !== "connected") {
      this.error = "Not connected";
      return false;
    }
    const { steps, unknown } = parseSequence(text);
    if (unknown.length) {
      this.error = `Unknown key${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`;
      return false;
    }
    if (!steps.length) return false;
    this.remember(text);
    this.running = true;
    this.stopped = false;
    this.total = steps.length;
    // A disconnect (or a new connection meanwhile) ends the run.
    const link = radio.connectedLink;
    try {
      for (let i = 0; i < steps.length; i++) {
        if (this.stopped || !link || radio.connectedLink !== link) break;
        this.at = i;
        if (!(await radio.press(steps[i].name, steps[i].long))) {
          if (radio.connectedLink === link) this.error = `Stopped at ${steps[i].name} (step ${i + 1})`;
          break;
        }
        if (i < steps.length - 1) await sleep(GAP_MS);
      }
    } finally {
      this.running = false;
    }
    return true;
  }

  /** Stops before the next press (the one being sent finishes). */
  stop() {
    this.stopped = true;
  }
}

export const sequencer = new Sequencer();
