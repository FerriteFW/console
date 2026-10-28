// Firmware Update: a Ferrite image into a radio that already runs Ferrite, over the cable, as ferrite's
// tools/flash.py does it: link REBOOT (LINK-24), the port back at 115200, probes until the stock bootloader answers,
// then hello, model, count, every 1 KB block and end; then the radio restarts and Console connects again.
// The frames come from the Rust core (core/src/firmware.rs), only from a file its checks passed: the bootloader
// only ever gets the image's own blocks.
import { askRestart, BootPort } from "./bootflash";
import {
  FirmwareUpdate,
  P,
  bootProbe,
  bootResultText,
  firmwareCheck,
  loadCore,
  sha256Hex,
  statusText,
  type BootStep,
  type FirmwareCheck,
} from "./core";
import { Link, TimeoutError } from "./link";
import { radio } from "./radio.svelte";
import { sleep, type Transport } from "./transport/types";

const CMD_PROBE = 0x42;
const ACK = 0x06;
const BAD_FRAME = 0xe1;
/** The probe's answer once the bootloader is in update mode (06 is its power-on window). */
const E_INSIDE = 0xe5;
/** Recovery without a session: a radio already waiting answers the first probes. */
const RECOVER_WAIT_MS = 3000;
/** flash.py's --wait: how long probes go out before giving up. */
const BOOT_WAIT_MS = 30_000;
/** How long one probe waits for its answer before the next goes. */
const PROBE_GAP_MS = 15;
/** After END: the bootloader resets, starts the new image; Console asks for HELLO until this runs out. */
const RESTART_WAIT_MS = 40_000;

export type Stage = "pick" | "ready" | "rebooting" | "probing" | "sending" | "restarting" | "done" | "failed";

export const STAY_IN_BOOTLOADER = "The radio stays in the bootloader: start again (Resume).";

class Abort extends Error {}

type Firmware_ = { firmware: string; build: string };

class Firmware {
  stage = $state<Stage>("pick");
  fileName = $state("");
  check = $state<FirmwareCheck | null>(null);
  /** What the step is doing, in words. */
  message = $state("");
  error = $state("");
  done = $state(0);
  blocks = $state(0);
  /** The radio before the update (INFO), and after. */
  before = $state<Firmware_ | null>(null);
  after = $state<Firmware_ | null>(null);
  /** A failed update left the cable held and the radio (probably) in the bootloader: Resume probes again. */
  canResume = $state(false);

  private bytes: Uint8Array | null = null;
  private t: Transport | null = null;
  /** The radio answered HELLO as Ferrite this session (start), not just a cable opened as it is (openAndResume). */
  private trusted = false;

  /** Steps running now: the bar's Disconnect waits. */
  get running() {
    return ["rebooting", "probing", "sending", "restarting"].includes(this.stage);
  }

  get pct() {
    return this.blocks ? Math.floor((this.done * 100) / this.blocks) : 0;
  }

  /** The Ferrite release bundled with Console (public/firmware/manifest.json, scripts/bundle-firmware.mjs). */
  bundled = $state<{ version: string; file: string; sha256: string } | null>(null);

  /** The manifest, once: what the page offers besides a file (Ferrite to the next Ferrite from the browser). */
  async loadBundled() {
    if (this.bundled) return;
    try {
      const r = await fetch("firmware/manifest.json", { cache: "no-cache" });
      if (r.ok) this.bundled = (await r.json()).ferrite ?? null;
    } catch {
      // no bundled release in this copy of Console: a file only
    }
  }

  /** UPD-15: the bundled image, used only when its SHA-256 is the manifest's; then checked as a picked file. */
  async useBundled() {
    const r = this.bundled;
    if (this.running || !r) return;
    try {
      const res = await fetch(`firmware/${r.file}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${r.file}: ${res.status}`);
      const b = new Uint8Array(await res.arrayBuffer());
      await loadCore();
      if (sha256Hex(b) !== r.sha256.toLowerCase()) throw new Error(`${r.file} doesn't match its checksum: Console won't use it`);
      await this.pick(new File([b as BlobPart], r.file));
    } catch (e) {
      this.error = `The bundled release didn't load (${(e as Error).message}). Choose a file instead.`;
    }
  }

  /** A picked file, checked by the core. */
  async pick(file: File) {
    if (this.running) return;
    await loadCore();
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.fileName = file.name;
    this.error = "";
    this.after = null;
    this.done = 0;
    if (!/\.btf$/i.test(file.name)) {
      this.check = null;
      this.bytes = null;
      this.error = `${file.name} is not a .btf file. Build one with tools/mkbtf.sh.`;
      this.stage = "pick";
      return;
    }
    const c = firmwareCheck(bytes);
    this.check = c;
    this.bytes = c.problems.length ? null : bytes;
    this.blocks = c.blocks;
    if (this.stage !== "failed") this.stage = c.problems.length ? "pick" : "ready";
  }

  clearFile() {
    if (this.running) return;
    this.check = null;
    this.bytes = null;
    this.fileName = "";
    if (this.stage !== "failed") this.stage = "pick";
  }

  /** The whole update, from a connected Ferrite radio on the cable. */
  async start() {
    if (this.running || !this.bytes) return;
    const info = radio.info;
    const got = radio.takeForUpdate();
    if (!got) {
      this.error = "Connect the radio over the cable first.";
      return;
    }
    this.before = { firmware: info?.firmware ?? "?", build: info?.build?.name ?? "" };
    this.after = null;
    this.error = "";
    this.canResume = false;
    this.t = got.t;
    this.trusted = true;
    this.stage = "rebooting";
    this.message = "Asking the radio to restart into the bootloader (REBOOT)…";
    let status: number;
    try {
      ({ status } = await got.link.ask(P.msg.REBOOT));
    } catch (e) {
      if (!(e instanceof TimeoutError)) return this.fail(e, false);
      status = 0; // it may have restarted before its answer got out: the probes tell
    }
    if (status === 7) {
      this.stage = "ready";
      this.error = "The radio is transmitting: it refused REBOOT (busy). Wait until it stops, then try again.";
      await radio.handBack(got.t);
      return;
    }
    if (status !== 0) {
      this.stage = "ready";
      this.error = `The radio refused REBOOT: ${statusText(status)}.`;
      await radio.handBack(got.t);
      return;
    }
    got.link.close();
    await this.flash(true);
  }

  /** After a failure: the radio waits in the bootloader, so probe again (no REBOOT) and send everything again. */
  async resume() {
    if (this.running || !this.bytes || !this.t || radio.phase !== "updating") return;
    this.error = "";
    await this.flash(false);
  }

  /** No session (the page was reloaded, or the radio sits in the bootloader): open the cable as it is, then resume. */
  async openAndResume(how: "cable" | "bridge") {
    if (this.running || !this.bytes) return;
    this.error = "";
    try {
      this.t = await radio.openForUpdate(how);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/cancel|no port selected/i.test(msg)) this.error = msg;
      return;
    }
    this.before = null;
    this.trusted = false;
    await this.flash(false);
  }

  /** Give up: the cable goes back (the radio stays wherever it is). */
  async release() {
    if (this.running) return;
    this.canResume = false;
    this.t = null;
    this.error = "";
    await radio.disconnect();
    this.stage = this.bytes ? "ready" : "pick";
  }

  private held() {
    if (radio.phase !== "updating") throw new Abort("The cable went away (unplugged or disconnected).");
  }

  private async flash(rebooted: boolean) {
    const t = this.t!;
    const update = new FirmwareUpdate(this.bytes!);
    const port = new BootPort(t);
    try {
      this.blocks = update.blocks();
      this.done = 0;
      // The bootloader talks at 115200 whatever the link had raised the cable to (LINK-11).
      if (t.setBaud) await t.setBaud(P.timing.cable_baud);
      this.stage = "probing";
      if (this.trusted) {
        this.message = rebooted
          ? "Waiting for the bootloader…"
          : "Waiting for the bootloader… (if nothing comes, turn the radio off and on while Console waits)";
        if ((await this.probe(port, BOOT_WAIT_MS, rebooted)) === null) {
          this.canResume = true;
          throw new Error(
            `No answer from the bootloader in ${BOOT_WAIT_MS / 1000} s. Turn the radio off, press Resume, then turn it on while Console waits.`,
          );
        }
      } else {
        // No session: Console can't tell this radio runs Ferrite, so only one already waiting in the bootloader (E5)
        // goes on. A radio in its power-on window (06) might be on stock, which needs flash.py and the backup.
        this.message = "Looking for a radio waiting in the bootloader…";
        const r = await this.probe(port, RECOVER_WAIT_MS);
        if (r === null) throw new Error("No radio is waiting in the bootloader. Connect it as usual, or use tools/flash.py.");
        if (r !== E_INSIDE)
          throw new Error(
            "The radio was just turned on, not waiting after a failed update, so Console can't tell it runs Ferrite. Turn it off and on, connect as usual, or use tools/flash.py.",
          );
      }
      this.stage = "sending";
      const t0 = performance.now();
      for (let i = 0; i < update.steps(); i++) {
        this.held();
        const step: BootStep = JSON.parse(update.step(i));
        this.message = step.block === null ? `Bootloader: ${step.what}` : `Sending block ${step.block + 1} of ${this.blocks}`;
        const r = await this.command(port, update.frame(i), step);
        if (r === ACK) {
          if (step.block !== null) this.done = step.block + 1;
          continue;
        }
        if (step.what === "end") break; // flash.py goes on: the radio restarts anyway
        this.canResume = true;
        const why = r === null ? "no reply" : bootResultText(r);
        throw new Error(`${step.block === null ? step.what : `Block ${step.block + 1} of ${this.blocks}`}: ${why}. ${STAY_IN_BOOTLOADER}`);
      }
      this.canResume = false;
      const secs = Math.round((performance.now() - t0) / 1000);
      this.stage = "restarting";
      this.message = `Sent in ${secs} s. The radio restarts into the new firmware; connecting again…`;
      await this.reconnect(t);
    } catch (e) {
      this.fail(e, this.canResume);
    } finally {
      port.free();
      update.free();
    }
  }

  /**
   * flash.py's enter_bootloader without the stock nudge: probes until one is answered, 06 in the power-on window or
   * E5 once inside update mode. The answer, or null.
   */
  private async probe(port: BootPort, ms: number, reask = false): Promise<number | null> {
    const probe = bootProbe();
    const t0 = performance.now();
    const end = t0 + ms;
    let asked = 1;
    port.clear();
    while (performance.now() < end) {
      this.held();
      // As Install: the first REBOOT often restarts the radio while the port still changes speed, past the
      // bootloader's 200 ms window, so Ferrite is back; asked again (at the bootloader's rate) a few times.
      if (reask && asked < 4 && performance.now() - t0 > asked * 3000) {
        asked++;
        await askRestart(port.t);
        port.clear();
      }
      await port.t.write(probe);
      const r = await port.next(CMD_PROBE, PROBE_GAP_MS);
      if (r !== null) {
        await sleep(100);
        port.clear();
        return r;
      }
    }
    return null;
  }

  /** One frame, sent again (up to 3 times) when nothing or a garbled-frame reply comes back. */
  private async command(port: BootPort, frame: Uint8Array, step: BootStep): Promise<number | null> {
    for (let tries = 0; tries < 3; tries++) {
      this.held();
      port.clear();
      await port.t.write(frame);
      const r = await port.next(step.cmd, step.timeout_ms);
      if (r === null || r === BAD_FRAME) continue;
      return r;
    }
    return null;
  }

  /** HELLO until the new firmware answers, then the usual connection; what it says it is. */
  private async reconnect(t: Transport) {
    await sleep(1500);
    const end = performance.now() + RESTART_WAIT_MS;
    for (;;) {
      this.held();
      const probe = new Link(t);
      try {
        await probe.open();
        await probe.hello();
        probe.close();
        break;
      } catch (e) {
        probe.close();
        if (!(e instanceof TimeoutError) || performance.now() > end) {
          throw new Error(
            `The new firmware didn't answer in ${RESTART_WAIT_MS / 1000} s. Check the radio's screen; connect again by hand.`,
          );
        }
      }
    }
    await radio.handBack(t);
    if (radio.phase !== "connected") throw new Error(radio.error || "Connecting again failed.");
    this.after = { firmware: radio.info?.firmware ?? radio.hello?.firmware ?? "?", build: radio.info?.build?.name ?? "" };
    this.t = null;
    this.stage = "done";
    this.message = "";
  }

  private fail(e: unknown, resumable: boolean) {
    this.canResume = resumable && radio.phase === "updating";
    this.stage = "failed";
    this.message = "";
    this.error = (e as Error)?.message ?? String(e);
  }
}

export const firmware = new Firmware();
