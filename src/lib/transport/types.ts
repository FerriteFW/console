// A byte pipe to the radio. The protocol lives in the Rust core and Link; a transport only moves bytes, so the web
// build (Web Serial, Web Bluetooth), the Tauri desktop app and, later, iOS and Android (native serial and BLE behind
// Tauri commands) all plug in here.

export type TransportKind = "cable" | "bluetooth" | "demo";

export interface Transport {
  readonly kind: TransportKind;
  /** What the connection bar shows: "Cable", "Bluetooth: walkie-talkie", "Demo radio". */
  readonly label: string;
  /** Bluetooth: the radio paces its answers (LINK-36), so time-outs are longer and polling runs back to back. */
  readonly slow: boolean;
  /** Bytes received. Set by Link before anything is written. */
  onData: (bytes: Uint8Array) => void;
  /** The connection went away (cable pulled, Bluetooth dropped). */
  onClose: (why: string) => void;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** The cable only: the port's rate now. */
  baud?: number;
  /** The cable only: reopen the port at another rate (LINK-11). */
  setBaud?(rate: number): Promise<void>;
}

/** Where transports come from on this platform. */
export interface TransportProvider {
  /** Which kinds this platform can open, and why not where it can't. */
  available(): Record<TransportKind, true | string>;
  /** Asks the user to pick a device (a browser chooser, or the native picker) and opens it. */
  open(kind: TransportKind): Promise<Transport>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
