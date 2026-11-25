// The programming cable through Chrome's Web Serial: 115200 8N1, raised with BAUD after HELLO (LINK-11, LINK-13.3).
import type { Transport } from "./types";

/** Web Serial's read errors after which the port gives a new stream (the spec's non-fatal ones). */
const NON_FATAL = new Set(["BufferOverrunError", "FramingError", "ParityError", "BreakError"]);

// Minimal Web Serial types (not in TypeScript's DOM library).
type SerialPortLike = {
  open(o: { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  addEventListener(t: "disconnect", f: () => void): void;
};
type SerialLike = {
  requestPort(o?: { filters: { usbVendorId: number }[] }): Promise<SerialPortLike>;
  getPorts?(): Promise<SerialPortLike[]>;
};

/** USB-serial chips programming cables use: CH340 (the RT-950 Pro's cable), CP210x, FTDI, Prolific. */
const FILTERS = [0x1a86, 0x10c4, 0x0403, 0x067b].map((usbVendorId) => ({ usbVendorId }));

/** Why the browser couldn't open the cable's port, in words the owner can act on. Chrome says only "Failed to open
 *  serial port." (a NetworkError) whether another program holds it or, on Linux, the user isn't in the group that
 *  may use serial ports (the desktop app tells them apart: src-tauri/src/serial.rs). */
export function openFailed(e: unknown, linux: boolean): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.name !== "NetworkError" && !/failed to open serial port/i.test(err.message)) return err;
  const busy = "another program may have it open (another Console, CHIRP, a terminal): close it and try again";
  const why = linux
    ? `${busy}. Or your user isn't in the dialout group (uucp on Arch), which may use serial ports: run \`sudo usermod -aG dialout $USER\` in a terminal, then log out and back in`
    : busy;
  return new Error(`Couldn't open the cable's port: ${why}. (${err.message})`);
}

const onLinux = () => typeof navigator !== "undefined" && /linux/i.test(navigator.platform || navigator.userAgent) && !/android/i.test(navigator.userAgent);

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
  /** Writes one after another: a stream has one writer at a time, and the second of two windowed WRITE_MANY frames
   *  sent back to back found it locked and was never sent (issue #33: every write past 5 channels lost a frame). */
  private queue: Promise<void> = Promise.resolve();
  private port: SerialPortLike;

  private constructor(port: SerialPortLike) {
    this.port = port;
  }

  static async request(): Promise<WebSerialTransport> {
    const serial = webSerial();
    if (!serial) throw new Error("This browser has no Web Serial: use Chrome, Edge or Firefox on a desktop.");
    return WebSerialTransport.fromPort(await serial.requestPort({ filters: FILTERS }));
  }

  private static async fromPort(port: SerialPortLike): Promise<WebSerialTransport> {
    const t = new WebSerialTransport(port);
    await t.openAt(115200);
    port.addEventListener("disconnect", () => {
      if (!t.closing) t.onClose("The cable was unplugged.");
    });
    const info = port.getInfo();
    if (info.usbVendorId === 0x1a86) t.label = "Cable (CH340)";
    return t;
  }

  /**
   * The same cable again, from the ports this page was already granted (no chooser): the same port if it's back,
   * else the one port of the same USB chip. Throws while it isn't plugged in.
   */
  async reopen(): Promise<WebSerialTransport> {
    const ports = (await webSerial()?.getPorts?.()) ?? [];
    const was = this.port.getInfo();
    const same = (p: SerialPortLike) => {
      const i = p.getInfo();
      return i.usbVendorId === was.usbVendorId && i.usbProductId === was.usbProductId;
    };
    const alike = ports.filter((p) => p !== this.port && same(p));
    const tries = [...ports.filter((p) => p === this.port), ...(alike.length === 1 ? alike : [])];
    let last: unknown = new Error("The cable isn't back yet.");
    for (const p of tries) {
      try {
        return await WebSerialTransport.fromPort(p);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  private async openAt(rate: number) {
    // 64 KB: a JavaScript stall (inflating, a background tab) at 230400 overran 8 KB in about 350 ms
    await this.port.open({ baudRate: rate, dataBits: 8, stopBits: 1, parity: "none", bufferSize: 65536 }).catch((e) => {
      throw openFailed(e, onLinux());
    });
    this.baud = rate;
    const port = this.port;
    this.loop = (async () => {
      // A framing, parity, break or overrun error ends one stream only (Web Serial): the port hands out another, and
      // reading goes on (a byte garbled at a rate switch ended the whole session; the serial-comms review, Nov 17).
      let errors = 0;
      let since = 0;
      while (!this.closing) {
        const readable = port.readable;
        if (!readable) {
          if (!this.closing) this.onClose("The cable stopped: the port gives no more data.");
          return;
        }
        const reader = readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return; // cancelled (shut)
            if (value && value.length) this.onData(value);
          }
        } catch (e) {
          const name = (e as { name?: string })?.name ?? "";
          // a line held in break, or a lasting rate mismatch, errors without end: give up after 20 in a second
          const now = Date.now();
          if (now - since > 1000) [since, errors] = [now, 0];
          if (!this.closing && NON_FATAL.has(name) && ++errors <= 20) {
            void import("../debuglog").then((m) => m.debugLog(`cable: ${name} while reading: reading on`)).catch(() => {});
            continue;
          }
          if (!this.closing) this.onClose(`The cable stopped: ${(e as Error).message}`);
          return;
        } finally {
          reader.releaseLock();
        }
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

  write(bytes: Uint8Array): Promise<void> {
    const run = async () => {
      const w = this.port.writable!.getWriter();
      try {
        await w.write(bytes);
      } finally {
        w.releaseLock();
      }
    };
    const r = this.queue.then(run, run);
    this.queue = r.catch(() => {}); // a failed write still rejects for its caller; the next one still goes
    return r;
  }

  /** Closes and reopens the port at `rate` (Web Serial can't change a port's rate in place). */
  async setBaud(rate: number) {
    if (rate === this.baud) return;
    // `closing` only while the old port shuts: the new read loop stops at once while it's set, and a switch with
    // it still up left nothing reading at the new rate (High speed never came up in 0.9.4).
    this.closing = true;
    try {
      await this.shut();
    } finally {
      this.closing = false;
    }
    await this.openAt(rate);
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
