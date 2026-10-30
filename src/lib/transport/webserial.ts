// The programming cable through Chrome's Web Serial: 115200 8N1, raised with BAUD after HELLO (LINK-11, LINK-13.3).
import type { Transport } from "./types";

// Minimal Web Serial types (not in TypeScript's DOM library).
type SerialPortLike = {
  open(o: { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  addEventListener(t: "disconnect", f: () => void): void;
};
type SerialLike = { requestPort(o?: { filters: { usbVendorId: number }[] }): Promise<SerialPortLike> };

/** USB-serial chips programming cables use: CH340 (the RT-950 Pro's cable), CP210x, FTDI, Prolific. */
const FILTERS = [0x1a86, 0x10c4, 0x0403, 0x067b].map((usbVendorId) => ({ usbVendorId }));

export const webSerial = (): SerialLike | undefined => (navigator as unknown as { serial?: SerialLike }).serial;

export class WebSerialTransport implements Transport {
  readonly kind = "cable" as const;
  readonly slow = false;
  label = "Cable";
  baud = 115200;
  onData: (b: Uint8Array) => void = () => {};
  onClose: (why: string) => void = () => {};
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private loop: Promise<void> = Promise.resolve();
  private closing = false;

  private constructor(private port: SerialPortLike) {}

  static async request(): Promise<WebSerialTransport> {
    const serial = webSerial();
    if (!serial) throw new Error("This browser has no Web Serial: use Chrome, Edge or Firefox on a desktop.");
    const port = await serial.requestPort({ filters: FILTERS });
    const t = new WebSerialTransport(port);
    await t.openAt(115200);
    port.addEventListener("disconnect", () => {
      if (!t.closing) t.onClose("The cable was unplugged.");
    });
    const info = port.getInfo();
    if (info.usbVendorId === 0x1a86) t.label = "Cable (CH340)";
    return t;
  }

  private async openAt(rate: number) {
    await this.port.open({ baudRate: rate, dataBits: 8, stopBits: 1, parity: "none", bufferSize: 8192 });
    this.baud = rate;
    this.reader = this.port.readable!.getReader();
    const reader = this.reader;
    this.loop = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) this.onData(value);
        }
      } catch (e) {
        if (!this.closing) this.onClose(`The cable stopped: ${(e as Error).message}`);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private async shut() {
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    await this.loop;
    await this.port.close();
  }

  async write(bytes: Uint8Array) {
    const w = this.port.writable!.getWriter();
    try {
      await w.write(bytes);
    } finally {
      w.releaseLock();
    }
  }

  /** Closes and reopens the port at `rate` (Web Serial can't change a port's rate in place). */
  async setBaud(rate: number) {
    if (rate === this.baud) return;
    this.closing = true;
    try {
      await this.shut();
      await this.openAt(rate);
    } finally {
      this.closing = false;
    }
  }

  async close() {
    this.closing = true;
    try {
      await this.shut();
    } catch {
      /* unplugged */
    }
  }
}
