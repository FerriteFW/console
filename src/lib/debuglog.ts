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

export function debugLog(line: string) {
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
  void enabled().then((yes) => {
    if (!yes) return;
    debugLog(`start: ${navigator.userAgent}`);
    window.addEventListener("error", (e) => debugLog(`uncaught: ${text(e.error ?? e.message)}`));
    window.addEventListener("unhandledrejection", (e) => debugLog(`unhandled rejection: ${text(e.reason)}`));
  });
}
