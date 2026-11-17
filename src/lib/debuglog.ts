// The desktop app's debug switch (src-tauri/src/debug.rs): started with FERRITE_DEBUG=1 or --debug, the shell logs
// its commands to the terminal and a file; this sends the webview's side there too: uncaught errors, failed promises
// and the connect steps. Off (and in the browser), every call here does nothing.
import { isTauri } from "./transport/native";

let on: Promise<boolean> | null = null;

function enabled(): Promise<boolean> {
  if (!on) {
    on = isTauri()
      ? import("@tauri-apps/api/core")
          .then(({ invoke }) => invoke<string | null>("debug_state"))
          .then((path) => path != null)
          .catch(() => false)
      : Promise.resolve(false);
  }
  return on;
}

/** The last lines logged, always kept in memory (About's "Save debug info", debugdump.ts): the debug switch only adds
 *  the terminal and the file. */
const RING = 3000;
const ring: string[] = [];
const t0 = typeof performance === "undefined" ? 0 : performance.now();

/** The lines kept, oldest first, each with its time (wall clock and seconds since start). */
export function debugLines(): string[] {
  return ring.slice();
}

// The log outlives the app (an Intel Mac's report, Nov 16, 2026: the backup failed, Console was restarted, and the
// debug info saved after had nothing of it): this session's lines go to localStorage at most every 2 s and when the
// page goes; at the next start they become the previous session's, which the debug info includes. Per computer, never
// sent anywhere; a blocked or full storage just keeps the log in memory.
const NOW_KEY = "ferrite-debug-log";
const PREV_KEY = "ferrite-debug-log-previous";
let previous: string[] = [];
try {
  const was = localStorage.getItem(NOW_KEY);
  if (was) localStorage.setItem(PREV_KEY, was);
  previous = JSON.parse(localStorage.getItem(PREV_KEY) ?? "[]");
  localStorage.removeItem(NOW_KEY);
} catch {
  previous = [];
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  saveTimer = null;
  try {
    localStorage.setItem(NOW_KEY, JSON.stringify(ring));
  } catch {
    /* memory only */
  }
}
function persistSoon() {
  if (!saveTimer) saveTimer = setTimeout(persist, 2000);
}

/** The previous session's lines (the last time Console ran), oldest first. */
export function debugPrevious(): string[] {
  return previous.slice();
}

export function debugLog(line: string) {
  const now = new Date();
  const since = typeof performance === "undefined" ? 0 : (performance.now() - t0) / 1000;
  ring.push(`${now.toISOString().slice(11, 23)} +${since.toFixed(3)} ${line}`);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  persistSoon();
  void enabled().then(async (yes) => {
    if (!yes) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("debug_log", { line }).catch(() => {});
  });
}

function text(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ""}`;
  return typeof e === "string" ? e : JSON.stringify(e);
}

/** Uncaught errors and failed promises into the log (called once at start-up). */
export function debugWatch() {
  if (typeof window === "undefined") return;
  debugLog(`start: ${navigator.userAgent}`);
  window.addEventListener("pagehide", persist);
  window.addEventListener("beforeunload", persist);
  window.addEventListener("error", (e) => debugLog(`uncaught: ${text(e.error ?? e.message)}`));
  window.addEventListener("unhandledrejection", (e) => debugLog(`unhandled rejection: ${text(e.reason)}`));
  // Every press, with what it landed on: a disabled button gets no click, but it does get the pointer.
  document.addEventListener(
    "pointerdown",
    (e) => {
      const el = e.target as HTMLElement | null;
      const b = el?.closest("button, a, input, [role=button]") as HTMLButtonElement | null;
      const what = b ?? el;
      const label = (what?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
      debugLog(`press: <${what?.tagName.toLowerCase()}> "${label}"${b?.disabled ? " DISABLED" : ""} at ${location.hash || "/"}`);
    },
    true,
  );
}
