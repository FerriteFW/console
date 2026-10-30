// Picks the transports this platform has: the browser's own (Web Serial, Web Bluetooth) where they exist, the Tauri
// shell's native ones where they don't, and the demo radio everywhere.
import { DemoTransport } from "./demo";
import { isTauri, NativeTransport } from "./native";
import type { Transport, TransportKind, TransportProvider } from "./types";
import { WebBluetoothTransport, webBluetooth } from "./webbluetooth";
import { WebSerialTransport, webSerial } from "./webserial";

export type { Transport, TransportKind } from "./types";

export const provider: TransportProvider = {
  available() {
    // Web Serial: Chrome, Edge and Firefox (151 and later) on a desktop; Web Bluetooth: Chrome and Edge.
    const why = (web: boolean, what: string, browsers: string): true | string =>
      web || isTauri() ? true : `This browser has no ${what}: use ${browsers} on a desktop, from https or localhost.`;
    return {
      cable: why(!!webSerial(), "Web Serial", "Chrome, Edge or Firefox"),
      bluetooth: why(!!webBluetooth(), "Web Bluetooth", "Chrome or Edge"),
      demo: true,
    };
  },
  async open(kind: TransportKind): Promise<Transport> {
    if (kind === "demo") return new DemoTransport();
    if (kind === "cable" && webSerial()) return WebSerialTransport.request();
    if (kind === "bluetooth" && webBluetooth()) return WebBluetoothTransport.request();
    if (isTauri()) return NativeTransport.open(kind);
    throw new Error(String(this.available()[kind]));
  },
};
