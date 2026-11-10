// The desktop app's own device picker (the webview has no browser chooser): a list of ports or radios in a
// popover under the connection bar. NativeTransport.open asks `picker.pick(kind)` and waits for a click.
import { debugLog } from "./debuglog";
import type { TransportKind } from "./transport/types";

export type PickItem = { id: string; name: string; detail: string; likely: boolean };
type Source = { list(): Promise<PickItem[]>; start?(): Promise<void>; stop?(): Promise<void>; every?: number };

const LAST = "ferrite-console.native-pick.";

/** The device picked last time, per kind, so it sits first and highlighted. */
export function lastPick(kind: TransportKind): string {
  try {
    return localStorage.getItem(LAST + kind) ?? "";
  } catch {
    return "";
  }
}

class Picker {
  kind = $state<TransportKind | null>(null);
  items = $state<PickItem[]>([]);
  error = $state("");
  /** Bluetooth keeps scanning while the picker is open; the cable lists once (Refresh lists again). */
  scanning = $state(false);
  private source: Source | null = null;
  private done: ((id: string) => void) | null = null;
  private cancel: ((e: Error) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Opens the picker; the chosen ID, or a NotFoundError (as a browser chooser's) when it is closed. */
  pick(kind: TransportKind, source: Source): Promise<string> {
    debugLog(`picker open ${kind}: drawn ${!!document.querySelector(".pick")}`);
    setTimeout(() => debugLog(`picker ${kind} after 1 s: drawn ${!!document.querySelector(".pick")}, ${this.items.length} items, error "${this.error}"`), 1000);
    this.close(false);
    this.kind = kind;
    this.items = [];
    this.error = "";
    this.source = source;
    const p = new Promise<string>((ok, fail) => {
      this.done = ok;
      this.cancel = fail;
    });
    void this.start();
    return p;
  }

  private async start() {
    const s = this.source!;
    try {
      if (s.start) {
        await s.start();
        this.scanning = true;
      }
      await this.refresh();
      if (s.every) this.timer = setInterval(() => void this.refresh(), s.every);
    } catch (e) {
      this.error = (e as Error)?.message ?? String(e);
    }
  }

  async refresh() {
    const s = this.source;
    if (!s) return;
    try {
      const last = this.kind ? lastPick(this.kind) : "";
      const got = await s.list();
      if (s !== this.source) return;
      // The last pick first, then the order the shell gave (cable chips first, strongest radio first).
      this.items = [...got.filter((i) => i.id === last), ...got.filter((i) => i.id !== last)];
      this.error = "";
    } catch (e) {
      this.error = (e as Error)?.message ?? String(e);
    }
  }

  choose(id: string) {
    try {
      if (this.kind) localStorage.setItem(LAST + this.kind, id);
    } catch {
      /* not kept */
    }
    const ok = this.done;
    this.done = null;
    this.close(false);
    ok?.(id);
  }

  /** Closes the picker; `cancelled` rejects the waiting open as a closed chooser does. */
  close(cancelled = true) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.scanning) void this.source?.stop?.().catch(() => {});
    this.scanning = false;
    this.source = null;
    this.kind = null;
    const fail = this.cancel;
    this.cancel = null;
    if (cancelled && this.done) {
      const e = new Error("No device selected (the picker was cancelled).");
      e.name = "NotFoundError";
      fail?.(e);
    }
    this.done = null;
  }
}

export const picker = new Picker();
