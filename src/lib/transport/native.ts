// Native transports for the Tauri apps (desktop now; iOS and Android later). The desktop webviews (WKWebView on
// macOS, WebKitGTK on Linux) have no Web Serial or Web Bluetooth, so the shell will move the bytes: serial through
// the `serialport` crate, BLE through `btleplug` (FFE0/FFE1 only, never FF31), behind the commands below, with
// received bytes coming back as `transport://data` events.
//
// TODO(phase 1.5): implement `transport_open`, `transport_write`, `transport_close` in src-tauri/src/lib.rs. Until
// then they answer "not implemented yet" and the desktop app offers the demo radio only (on Windows the WebView2
// webview has Web Serial and Web Bluetooth of its own, so the web transports may work there as they are).
import type { Transport, TransportKind } from "./types";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class NativeTransport implements Transport {
  readonly slow: boolean;
  label: string;
  onData: (b: Uint8Array) => void = () => {};
  onClose: (why: string) => void = () => {};

  private constructor(readonly kind: TransportKind) {
    this.slow = kind === "bluetooth";
    this.label = kind === "bluetooth" ? "Bluetooth (native)" : "Cable (native)";
  }

  static async open(kind: TransportKind): Promise<NativeTransport> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("transport_open", { kind }); // rejects with "not implemented yet" for now
    return new NativeTransport(kind);
  }

  async write(bytes: Uint8Array) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("transport_write", { bytes: Array.from(bytes) });
  }

  async close() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("transport_close");
  }
}
