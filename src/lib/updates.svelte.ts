// UPD-25, UPD-26 (ferrite decision 394): newer releases from the internet, so a new Ferrite needs no new Console and
// Console can update itself. On since 0.9.0, the first public release (written Nov 13, 2026, and off until then).
// With UPDATES_ON false nothing is fetched and nothing shows.
import { P } from "./core";
import { isTauri } from "./transport/native";
import { olderThan } from "./version";
import { isFeed, newerIn, type Feed } from "./feed";
import { CONSOLE_VERSION } from "./codeplug.svelte";

export const UPDATES_ON = true;

/** UPD-25: the feed naming the latest Ferrite (and Console), served with CORS so the web build can read it too. */
export const FEED = "https://ferritefw.dev/releases/latest.json";
/** Where a Console that can't update itself (the web build, Windows' portable .exe) sends you. */
export const CONSOLE_DOWNLOADS = "https://github.com/FerriteFW/console/releases/latest";

export type { Feed } from "./feed";

let fetched: Promise<Feed | null> | null = null;

/** The feed, once a session; null when updates are off, offline, or the feed isn't one. */
export function feed(): Promise<Feed | null> {
  if (!UPDATES_ON) return Promise.resolve(null);
  fetched ??= (async () => {
    try {
      const r = await fetch(FEED, { cache: "no-cache" });
      if (!r.ok) return null;
      const j: unknown = await r.json();
      return isFeed(j) ? j : null;
    } catch {
      return null;
    }
  })();
  return fetched;
}

/** UPD-25: the latest Ferrite from the feed when it is newer than `than` (the bundled release's version, or ""). */
export async function newerFirmware(than: string) {
  return newerIn(await feed(), than, P.protocol);
}

type Pending = { version: string; downloadAndInstall: () => Promise<void> };

/** UPD-26: Console's own update: the desktop app installs it and restarts; elsewhere a link to the download. */
class AppUpdate {
  /** The newer Console's version, or "" (none, or updates off). */
  version = $state("");
  /** The desktop app can install it itself (macOS, the Linux AppImage); else `CONSOLE_DOWNLOADS`. */
  installable = $state(false);
  busy = $state(false);
  error = $state("");
  #pending: Pending | null = null;
  #checked = false;

  async check() {
    if (!UPDATES_ON || this.#checked) return;
    this.#checked = true;
    if (isTauri()) {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check();
        if (u) {
          this.#pending = u;
          this.version = u.version;
          this.installable = true;
          return;
        }
      } catch {
        // no update for this platform in the release (Windows' portable .exe), or offline: the feed below
      }
    }
    const f = await feed();
    if (f && olderThan(CONSOLE_VERSION, f.console.version)) this.version = f.console.version;
  }

  /** Download, install, restart. */
  async install() {
    if (!this.#pending || this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await this.#pending.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      this.error = `The update didn't install (${(e as Error).message}). Download it instead.`;
      this.installable = false;
    } finally {
      this.busy = false;
    }
  }
}

export const appUpdate = new AppUpdate();
