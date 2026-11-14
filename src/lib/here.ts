// This computer's location (decision 398): the desktop app on macOS asks Core Location (src-tauri locate.rs: wry
// passes no geolocation through to the webview there); everywhere else the browser's geolocation. Asked once a
// session (the first ask is the system's permission prompt); stays on this computer.
import { isTauri } from "./transport/native";

export type Here = { lat: number; lon: number };

const macApp = () => isTauri() && typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** Whether this computer can say where it is at all. */
export const canLocate = typeof navigator !== "undefined" && (macApp() || !!navigator.geolocation);

let asked: Promise<Here> | null = null;

/** This computer's position; rejects with why not (refused, none in time, none at all). */
export function here(): Promise<Here> {
  asked ??= (async () => {
    if (macApp()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const h = await invoke<{ lat: number; lon: number } | null>("here");
      if (h) return { lat: h.lat, lon: h.lon };
    }
    const geo = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
    if (!geo) throw new Error("This computer can't tell its location. Type a place or a grid square.");
    const p = await new Promise<GeolocationPosition>((ok, no) => geo.getCurrentPosition(ok, no, { timeout: 15_000, maximumAge: 600_000 })).catch((e) => {
      throw new Error(
        (e as GeolocationPositionError).code === 1
          ? "Location is off for Console (it was refused). Allow it in the browser's site settings, or type a place."
          : "Your location isn't available right now. Type a place or a grid square.",
      );
    });
    return { lat: p.coords.latitude, lon: p.coords.longitude };
  })();
  // a failure can be asked again (after allowing it in System Settings)
  asked.catch(() => (asked = null));
  return asked;
}
