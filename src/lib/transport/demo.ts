// The demo radio: the Rust core's DemoRadio (core/src/demo.rs) answering in memory, a few milliseconds late as a
// cable would. For trying Console, and its UI, with no radio.
import { DemoRadio } from "../core";
import { sleep, type Transport } from "./types";

export class DemoTransport implements Transport {
  readonly kind = "demo" as const;
  readonly label = "Demo radio";
  readonly slow = false;
  onData: (b: Uint8Array) => void = () => {};
  onClose: (why: string) => void = () => {};
  private radio = new DemoRadio();

  async write(bytes: Uint8Array) {
    const out = this.radio.feed(bytes);
    if (out.length) {
      void sleep(8).then(() => this.onData(out));
    }
  }

  async close() {
    this.radio.free();
  }
}
