// The stock bootloader's side of the cable, shared by Firmware Update and the Install page: its replies matched by
// command, the probes that catch it, and a whole image sent as flash.py sends it (hello, model, count, every 1 KB
// block, end). The frames come from the Rust core (core/src/firmware.rs, core/src/install.rs).
import { BootReader, bootProbe, bootResultText, P, Session, type BootStep, type FirmwareUpdate } from "./core";
import { sleep, type Transport } from "./transport/types";

export const CMD_PROBE = 0x42;
export const ACK = 0x06;
export const BAD_FRAME = 0xe1;
/** The probe's answer once the bootloader is in update mode (06 is its power-on window). */
export const E_INSIDE = 0xe5;

/** The bootloader's replies as they arrive, matched by command. */
export class BootPort {
  private reader = new BootReader();
  private replies: [number, number][] = [];
  private wake: (() => void) | null = null;

  constructor(readonly t: Transport) {
    t.onData = (b) => {
      const flat = this.reader.feed(b);
      for (let i = 0; i + 1 < flat.length; i += 2) this.replies.push([flat[i], flat[i + 1]]);
      this.wake?.();
    };
  }

  clear() {
    this.replies = [];
    this.reader.clear();
  }

  /** The next reply to `cmd` (others are dropped), or null after `ms`. */
  async next(cmd: number, ms: number): Promise<number | null> {
    const end = performance.now() + ms;
    for (;;) {
      while (this.replies.length) {
        const [c, r] = this.replies.shift()!;
        if (c === cmd) return r;
      }
      const left = end - performance.now();
      if (left <= 0) return null;
      await new Promise<void>((ok) => {
        this.wake = ok;
        setTimeout(ok, left);
      });
      this.wake = null;
    }
  }

  free() {
    this.reader.free();
  }
}

/** Probes until the bootloader answers (06 in its power-on window, E5 inside); the answer, or null after `ms`. */
export async function probe(port: BootPort, ms: number, held: () => void = () => {}, gapMs = 15): Promise<number | null> {
  const p = bootProbe();
  const end = performance.now() + ms;
  port.clear();
  while (performance.now() < end) {
    held();
    await port.t.write(p);
    const r = await port.next(CMD_PROBE, gapMs);
    if (r !== null) {
      await sleep(100);
      port.clear();
      return r;
    }
  }
  return null;
}

/** One frame, sent again (up to 3 times) when nothing or a garbled-frame reply comes back. */
export async function command(port: BootPort, frame: Uint8Array, step: BootStep, held: () => void = () => {}): Promise<number | null> {
  for (let tries = 0; tries < 3; tries++) {
    held();
    port.clear();
    await port.t.write(frame);
    const r = await port.next(step.cmd, step.timeout_ms);
    if (r === null || r === BAD_FRAME) continue;
    return r;
  }
  return null;
}

/** Every step of `update` (after the bootloader answered a probe); throws with the step's reason. */
export async function sendAll(port: BootPort, update: FirmwareUpdate, progress: (done: number, total: number, what: string) => void, held: () => void = () => {}) {
  const blocks = update.blocks();
  for (let i = 0; i < update.steps(); i++) {
    const step: BootStep = JSON.parse(update.step(i));
    progress(step.block === null ? (i < 3 ? 0 : blocks) : step.block, blocks, step.block === null ? `Bootloader: ${step.what}` : `Sending block ${step.block + 1} of ${blocks}`);
    const r = await command(port, update.frame(i), step, held);
    if (r === ACK) continue;
    if (step.what === "end") break; // flash.py goes on: the radio restarts anyway
    const why = r === null ? "no reply" : bootResultText(r);
    throw new Error(`${step.block === null ? step.what : `Block ${step.block + 1} of ${blocks}`}: ${why}.`);
  }
  progress(blocks, blocks, "Sent");
}

/** The bootloader talks at 115200 whatever the link had raised the cable to (LINK-11). */
export async function bootRate(t: Transport) {
  if (t.setBaud && t.baud !== P.timing.cable_baud) await t.setBaud(P.timing.cable_baud);
}

/** Ferrite's REBOOT (LINK-24) and the reader's `reboot`, sent without waiting for an answer; stock ignores both. As
 * Link.open: Ctrl-C closes Ferrite's terminal if it holds the cable (TERM-2), then 0x00 takes it. Sent again while
 * probing: a radio that restarted past its bootloader's 200 ms window (the port was still changing speed) is back
 * in Ferrite and asked again. */
export async function askRestart(t: Transport) {
  const s = new Session();
  try {
    await t.write(Session.opening());
    await sleep(P.timing.open_settle_ms);
    await t.write(s.take_cable(performance.now()));
    await t.write(s.request(P.msg.REBOOT, new Uint8Array(), performance.now()));
  } finally {
    s.free();
  }
  await sleep(100);
  await t.write(new TextEncoder().encode("\r\nreboot\r\n"));
}
