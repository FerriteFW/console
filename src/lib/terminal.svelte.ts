// The Terminal page's state: the radio's command line over the link (CMD, LINK-34), its answers as the radio sends
// them (paged with MORE by the link), and the lines typed (history). Kept here, not in the page, so the log and the
// history stay while another page is open. Console never reinterprets a command or its output; it only refuses the
// ones that could transmit.
import { RadioError, TimeoutError } from "./link";
import { radio } from "./radio.svelte";

export type Entry = { id: number; kind: "cmd" | "out" | "refused" | "error" | "note"; text: string };

const HISTORY_KEY = "ferrite-console.terminal.history";
const HISTORY_MAX = 100;
const LOG_MAX = 2000;

/**
 * Why Console won't send `line`, or null. Never a command that transmits (Console's rule, as the remote keys'):
 * `key` (the terminal's remote key, the path a remote PTT would take), `txtest` (the bench build's transmit test
 * generators, TERM-33) and `xb start` (starts the crossband repeater, which transmits, XB-20.1).
 */
export function blocked(line: string): string | null {
  const w = line.trim().toLowerCase().split(/\s+/);
  if (w[0] === "key") return "key: not from Console: remote keys are on Live View's keypad, which never transmits.";
  if (w[0] === "txtest") return "txtest: not from Console: it transmits. Use the bench tools (tools/bench.py) with Dry TX on.";
  if (w[0] === "xb" && w[1] === "start") return "xb start: not from Console: the crossband repeater transmits. Start it on the radio.";
  return null;
}

function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(-HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

class Terminal {
  log = $state<Entry[]>([]);
  history = $state<string[]>(loadHistory());
  running = $state(false);
  private nextId = 1;

  private add(kind: Entry["kind"], text: string) {
    this.log.push({ id: this.nextId++, kind, text });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  clear() {
    this.log = [];
  }

  private remember(line: string) {
    const h = this.history.filter((x) => x !== line);
    h.push(line);
    this.history = h.slice(-HISTORY_MAX);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
    } catch {
      /* no storage: history for this page only */
    }
  }

  /** Runs one command line on the radio and logs it with its answer or refusal. */
  async run(raw: string) {
    const line = raw.trim();
    if (!line) return;
    this.remember(line);
    this.add("cmd", line);
    const why = blocked(line);
    if (why) {
      this.add("note", why);
      return;
    }
    const link = radio.connectedLink;
    if (!link) {
      this.add("error", "Not connected: connect to the radio first.");
      return;
    }
    this.running = true;
    try {
      const out = await link.cmd(line);
      this.add("out", out.replace(/\n$/, "") || "(no output)");
    } catch (e) {
      if (e instanceof RadioError) this.add("refused", e.message);
      else if (e instanceof TimeoutError) this.add("error", e.message);
      else this.add("error", (e as Error)?.message ?? String(e));
    } finally {
      this.running = false;
      radio.refresh(); // a `set` or `slot` may have changed the screen
    }
  }
}

export const terminal = new Terminal();
