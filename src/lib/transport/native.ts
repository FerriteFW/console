// Native transports for the Tauri apps. The desktop webviews (WKWebView on macOS, WebKitGTK on Linux) have no Web
// Serial or Web Bluetooth, so the shell (src-tauri/src) moves the bytes: the cable through the `serialport` crate,
// Bluetooth through `btleplug` (FFE0/FFE1; FF31 only for the speed unlock, LINK-15.1, which the shell checks). The user picks a port or a radio in the app's own
// picker (picker.svelte.ts); received bytes and the close reason come back on a Tauri channel.
import { picker, type PickItem } from "../picker.svelte";
import type { Transport, TransportKind } from "./types";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const api = () => import("@tauri-apps/api/core");

type PortRow = { name: string; detail: string; cable: boolean };
type BleRow = { id: string; name: string; rssi: number | null };
type Opened = { label: string; baud: number | null };

const sources = {
  cable: {
    async list(): Promise<PickItem[]> {
      const { invoke } = await api();
      const rows = await invoke<PortRow[]>("serial_ports");
      return rows.map((r) => ({ id: r.name, name: r.name.replace(/^\/dev\/cu\./, ""), detail: r.detail, likely: r.cable }));
    },
  },
  bluetooth: {
    every: 800,
    async start() {
      const { invoke } = await api();
      await invoke("ble_scan_start");
    },
    async stop() {
      const { invoke } = await api();
      await invoke("ble_scan_stop");
    },
    async list(): Promise<PickItem[]> {
      const { invoke } = await api();
      const rows = await invoke<BleRow[]>("ble_devices");
      // By ID, never by name: every radio advertises "walkie-talkie".
      return rows.map((r) => ({ id: r.id, name: r.name, detail: `${r.id}${r.rssi != null ? ` · ${r.rssi} dBm` : ""}`, likely: true }));
    },
  },
};

export class NativeTransport implements Transport {
  readonly slow: boolean;
  label = "";
  baud?: number;
  setBaud?: (rate: number) => Promise<void>;
  unlock?: () => Promise<boolean>;
  onData: (b: Uint8Array) => void = () => {};
  onClose: (why: string) => void = () => {};
  private closing = false;

  private constructor(readonly kind: TransportKind) {
    this.slow = kind === "bluetooth";
    if (kind === "cable") {
      // LINK-11: the shell changes the port's rate in place.
      this.setBaud = async (rate: number) => {
        const { invoke } = await api();
        await invoke("transport_set_baud", { rate });
        this.baud = rate;
      };
    } else {
      // LINK-15.1: the module's speed unlock (the shell writes only this shape to FF31)
      this.unlock = async () => {
        const token = new Uint8Array(20);
        token.set([0x3f, 0x3f, 0x3f, 0x3f, 0x02]);
        crypto.getRandomValues(token.subarray(5));
        try {
          const { invoke } = await api();
          await invoke("transport_unlock", { token: Array.from(token) });
          return true;
        } catch {
          return false;
        }
      };
    }
  }

  static async open(kind: TransportKind): Promise<NativeTransport> {
    if (kind !== "cable" && kind !== "bluetooth") throw new Error(`No native transport for ${kind}.`);
    const id = await picker.pick(kind, sources[kind]);
    const { invoke, Channel } = await api();
    const t = new NativeTransport(kind);
    const events = new Channel<ArrayBuffer | string>();
    events.onmessage = (m) => {
      if (typeof m === "string") {
        if (!t.closing) t.onClose(m);
      } else t.onData(new Uint8Array(m));
    };
    const opened = await invoke<Opened>("transport_open", { kind, id, events });
    t.label = opened.label;
    if (opened.baud != null) t.baud = opened.baud;
    return t;
  }

  async write(bytes: Uint8Array) {
    const { invoke } = await api();
    await invoke("transport_write", { bytes: Array.from(bytes) });
  }

  async close() {
    this.closing = true;
    const { invoke } = await api();
    await invoke("transport_close");
  }
}
