/// <reference types="vite/client" />
// The development bridge (tools/bridge.py): the link's bytes over a local WebSocket to a serial port or the
// simulator's TCP cable, so scripts can drive Console without the browser's port chooser. Development only: the
// Bridge button shows in `npm run dev` or with `?bridge` in the URL (`?bridge=ws://127.0.0.1:PORT` for another port).
//
// Binary frames are the bytes; text frames are JSON. The bridge says {"bridge":1,"target":"serial"|"tcp","name",
// "baud"} first; {"baud":N} asks it to set the serial port's rate (LINK-11) and it answers {"baud":N,"ok":...}.
import type { Transport } from "./types";

export const BRIDGE_URL = "ws://127.0.0.1:8765";

/** Whether this page offers the bridge: the dev server, or `?bridge` in the URL. */
export function bridgeEnabled(): boolean {
  return import.meta.env.DEV || new URLSearchParams(location.search).has("bridge");
}

/** The bridge's address: `?bridge=ws://...` or the default. */
export function bridgeUrl(): string {
  const v = new URLSearchParams(location.search).get("bridge");
  return v && /^wss?:\/\//.test(v) ? v : BRIDGE_URL;
}

type Hello = { bridge: number; target: "serial" | "tcp"; name: string; baud: number };
type Control = { baud?: number; ok?: boolean; error?: string; closed?: string } & Partial<Hello>;

export class BridgeTransport implements Transport {
  // Timing as on the cable (time-outs 2 s, polling with a gap): it is the cable, or the simulator's.
  readonly kind = "cable" as const;
  readonly slow = false;
  label = "Bridge";
  baud = 115200;
  target: "serial" | "tcp" = "tcp";
  onData: (b: Uint8Array) => void = () => {};
  onClose: (why: string) => void = () => {};
  private closing = false;
  private waitBaud: ((m: Control) => void) | null = null;

  private constructor(private ws: WebSocket) {}

  static async open(url = bridgeUrl()): Promise<BridgeTransport> {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const t = new BridgeTransport(ws);
    const hello = await new Promise<Hello>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`The bridge at ${url} didn't answer.`)), 4000);
      ws.onerror = () => {
        clearTimeout(timer);
        fail(new Error(`No bridge at ${url}: start tools/bridge.py (--tcp for the simulator, --serial for the radio).`));
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        fail(new Error(`The bridge closed (${e.code}${e.reason ? `: ${e.reason}` : ""}).`));
      };
      ws.onmessage = (m) => {
        if (typeof m.data !== "string") return;
        const msg = JSON.parse(m.data) as Control;
        clearTimeout(timer);
        if (msg.bridge) ok(msg as Hello);
        else fail(new Error(`Bridge: ${msg.error ?? m.data}`));
      };
    });
    t.target = hello.target;
    t.baud = hello.baud;
    t.label = hello.target === "tcp" ? `Bridge (simulator ${hello.name})` : `Bridge (cable ${hello.name})`;
    ws.onerror = null;
    ws.onmessage = (m) => {
      if (typeof m.data === "string") t.control(JSON.parse(m.data) as Control);
      else t.onData(new Uint8Array(m.data as ArrayBuffer));
    };
    ws.onclose = (e) => {
      if (!t.closing) t.onClose(`The bridge closed${e.reason ? `: ${e.reason}` : ""}.`);
    };
    return t;
  }

  private control(m: Control) {
    if (m.closed) {
      this.closing = true;
      this.onClose(`Bridge: ${m.closed}`);
    } else if (m.baud !== undefined && this.waitBaud) {
      this.waitBaud(m);
    }
  }

  async write(bytes: Uint8Array) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("The bridge is closed.");
    this.ws.send(bytes);
  }

  /** The serial port at `rate` (the bridge applies it after the bytes before; the simulator's TCP ignores it). */
  async setBaud(rate: number) {
    if (rate === this.baud) return;
    const ans = await new Promise<Control>((ok, fail) => {
      const timer = setTimeout(() => {
        this.waitBaud = null;
        fail(new Error("the bridge didn't set the rate"));
      }, 2000);
      this.waitBaud = (m) => {
        clearTimeout(timer);
        this.waitBaud = null;
        ok(m);
      };
      this.ws.send(JSON.stringify({ baud: rate }));
    });
    if (!ans.ok) throw new Error(`the bridge couldn't set ${rate}: ${ans.error ?? "refused"}`);
    this.baud = rate;
  }

  async close() {
    this.closing = true;
    this.ws.close();
  }
}
