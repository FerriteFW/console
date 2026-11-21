// Firmware Update: a Ferrite update file (.ffw: the image and its SPI parts, ferrite decision 335) or a bare .btf
// into a radio that already runs Ferrite, over the cable, as ferrite's tools/flash.py does it: link REBOOT (LINK-24), the port back at 115200, probes until the stock bootloader answers,
// then hello, model, count, every 1 KB block and end; then the radio restarts and Console connects again.
// The frames come from the Rust core (core/src/firmware.rs), only from a file its checks passed: the bootloader
// only ever gets the image's own blocks.
import { debugLog } from "./debuglog";
import { askRestart, BootPort } from "./bootflash";
import {
  FfwFile,
  FirmwareUpdate,
  P,
  type FfwSummary,
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
import { signatureOf, signatureProblem, splitPicked, type Signed } from "./signature";
import { sleep, type Transport } from "./transport/types";
import { appFetch } from "./appfetch";
import { newerFirmware } from "./updates.svelte";
import { LAYOUT_MOVING, markFrom, migrate } from "./migrate.svelte";
import { writeParts } from "./parts";
import { devOpts } from "./devopts.svelte";

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

/** "migrating": the new firmware stores another layout than the chip's data: Finish the update runs as part of it. */
/** "parts": the .ffw's SPI parts going in over the raw writes, once the new firmware runs (UPD-21). */
export type Stage = "pick" | "ready" | "rebooting" | "probing" | "sending" | "restarting" | "migrating" | "parts" | "done" | "failed";

export const STAY_IN_BOOTLOADER = "The radio stays in the bootloader: start again (Resume).";

class Abort extends Error {}

type Firmware_ = { firmware: string; build: string };

class Firmware {
  stage = $state<Stage>("pick");
  fileName = $state("");
  check = $state<FirmwareCheck | null>(null);
  /** The image's minisig signature: Ferrite's (its trusted comment), none, or one that doesn't verify (refused). */
  signature = $state<Signed | null>(null);
  /** What the step is doing, in words. */
  #message = $state("");
  #error = $state("");
  /** What it's doing now; each change goes to the debug log (debuglog.ts), so a report has the steps. */
  get message() {
    return this.#message;
  }
  set message(v: string) {
    if (v && v !== this.#message) debugLog(`firmware: ${v}`);
    this.#message = v;
  }
  /** What went wrong; to the debug log too. */
  get error() {
    return this.#error;
  }
  set error(v: string) {
    if (v && v !== this.#error) debugLog(`firmware ERROR: ${v}`);
    this.#error = v;
  }
  done = $state(0);
  blocks = $state(0);
  /** A .ffw's contents (its parts written after the MCU flash); null for a bare .btf. */
  ffwSummary = $state<FfwSummary | null>(null);
  /** The developer option (devopts.svelte.ts): an unsigned .ffw (a local build) is taken (UPD-21). Off: only
   *  Ferrite's signed releases. */
  get devUnsigned() {
    return devOpts.allowUnsigned;
  }
  /** The picked files came from the update feed: signed, whatever the option (UPD-27). */
  private fromRelease = false;
  /** The parts written so far (the "parts" stage). */
  partsDone = $state(0);
  partsTotal = $state(0);
  /** The radio before the update (INFO), and after. */
  before = $state<Firmware_ | null>(null);
  after = $state<Firmware_ | null>(null);
  /** A failed update left the cable held and the radio (probably) in the bootloader: Resume probes again. */
  canResume = $state(false);

  private bytes: Uint8Array | null = null;
  private ffw: FfwFile | null = null;
  /** The files last picked, checked again when the developer option changes. */
  private picked: File[] = [];
  private t: Transport | null = null;
  /** The radio answered HELLO as Ferrite this session (start), not just a cable opened as it is (openAndResume). */
  private trusted = false;

  /** Steps running now: the bar's Disconnect waits. */
  get running() {
    return ["rebooting", "probing", "sending", "restarting", "migrating", "parts"].includes(this.stage);
  }

  get pct() {
    return this.blocks ? Math.floor((this.done * 100) / this.blocks) : 0;
  }

  /**
   * The release Update offers: the one bundled with Console (public/firmware/manifest.json, scripts/bundle-firmware.mjs),
   * or a newer one from the internet (UPD-25: `url` set), whichever is newer.
   */
  bundled = $state<{ version: string; file: string; sha256: string; minisig?: string; url?: string } | null>(null);
  /** UPD-25: a newer Ferrite is out that speaks another link protocol: it needs a newer Console (its version). */
  needsConsole = $state("");
  #loading: Promise<void> | null = null;

  /** The manifest, once, then the feed: what the page offers besides a file. */
  loadBundled(): Promise<void> {
    this.#loading ??= (async () => {
      try {
        const r = await appFetch("firmware/manifest.json", { cache: "no-cache" });
        if (r.ok) this.bundled = (await r.json()).ferrite ?? null;
      } catch {
        // no bundled release in this copy of Console: a file only
      }
      const n = await newerFirmware(this.bundled?.version ?? "");
      if (n && "usable" in n) this.bundled = { version: n.usable.version, file: n.usable.file, sha256: n.usable.sha256, url: n.usable.url };
      else if (n) this.needsConsole = n.needsConsole;
    })();
    return this.#loading;
  }

  /**
   * UPD-15: the bundled image (or UPD-25's download), used only when its SHA-256 is the manifest's (the feed's); then
   * checked as a picked file, with the manifest's signature when it has one (a .ffw's is inside: UPD-21).
   */
  async useBundled() {
    const r = this.bundled;
    if (this.running || !r) return;
    try {
      const res = r.url ? await fetch(r.url, { cache: "no-cache" }) : await appFetch(`firmware/${r.file}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${r.file}: ${res.status}`);
      const b = new Uint8Array(await res.arrayBuffer());
      await loadCore();
      if (sha256Hex(b) !== r.sha256.toLowerCase()) throw new Error(`${r.file} doesn't match its checksum: Console won't use it`);
      const files = [new File([b as BlobPart], r.file)];
      // A .ffw carries its signature inside; a bare .btf's comes from the manifest.
      if (r.minisig) files.push(new File([r.minisig], `${r.file}.minisig`));
      await this.pick(files, !!r.url); // UPD-27: one from the update feed is signed, developer option or not
    } catch (e) {
      this.error = `The release didn't load (${(e as Error).message}). Choose a file instead.`;
    }
  }

  /** The developer option changed: the last picked file is checked again under it. */
  async setDevUnsigned(on: boolean) {
    devOpts.allowUnsigned = on;
    if (this.picked.length && !this.running) await this.pick(this.picked, this.fromRelease);
  }

  /** The picked files (a .ffw; or a .btf, and its .minisig when there is one), checked by the core. */
  async pick(picked: FileList | File[], release = false) {
    if (this.running) return;
    const files = Array.from(picked);
    if (!files.length) return;
    this.picked = files;
    this.fromRelease = release;
    await loadCore();
    this.ffw?.free();
    this.ffw = null;
    this.ffwSummary = null;
    const ffwFile = files.find((f) => /\.ffw$/i.test(f.name));
    if (ffwFile) return this.pickFfw(ffwFile, release);
    const { btf: file, sig } = splitPicked(files);
    this.fileName = file?.name ?? files[0].name;
    this.error = "";
    this.after = null;
    this.done = 0;
    this.signature = null;
    if (!file) {
      this.check = null;
      this.bytes = null;
      this.error = `${files[0].name} is not a .ffw or .btf file. Build one with tools/mkbtf.sh.`;
      this.stage = "pick";
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const signature = signatureOf(bytes, sig ? await sig.text() : null);
    this.signature = signature;
    const c = firmwareCheck(bytes);
    // UPD-27: a signature that doesn't verify refuses the image like a failed check; none, unless allowed
    const why = signatureProblem(signature, this.devUnsigned, release);
    if (why) c.problems.push(why);
    this.check = c;
    this.bytes = c.problems.length ? null : bytes;
    this.blocks = c.blocks;
    if (this.stage !== "failed") this.stage = c.problems.length ? "pick" : "ready";
  }

  /** UPD-21, UPD-24: a .ffw checked whole by the core (its signature, every hash, each part's target); then its
   *  image as a picked .btf. */
  private async pickFfw(file: File, release = false) {
    this.fileName = file.name;
    this.error = "";
    this.after = null;
    this.done = 0;
    this.signature = null;
    let f: FfwFile;
    try {
      f = new FfwFile(new Uint8Array(await file.arrayBuffer()), this.devUnsigned && !release); // UPD-27
    } catch (e) {
      this.check = null;
      this.bytes = null;
      this.error = `Console won't install ${file.name}: ${(e as Error).message}`;
      if (this.stage !== "failed") this.stage = "pick";
      return;
    }
    const summary = JSON.parse(f.summary()) as FfwSummary;
    const btf = f.btf();
    const c = firmwareCheck(btf);
    this.signature = summary.signed !== null ? { kind: "signed", comment: summary.signed } : { kind: "unsigned" };
    this.ffw = f;
    this.ffwSummary = summary;
    this.check = c;
    this.bytes = c.problems.length ? null : btf;
    this.blocks = c.blocks;
    if (this.stage !== "failed") this.stage = c.problems.length ? "pick" : "ready";
  }

  clearFile() {
    if (this.running) return;
    this.ffw?.free();
    this.ffw = null;
    this.ffwSummary = null;
    this.picked = [];
    this.check = null;
    this.signature = null;
    this.bytes = null;
    this.fileName = "";
    if (this.stage !== "failed") this.stage = "pick";
  }

  /** The whole update, from a connected Ferrite radio on the cable (or one on another link protocol: decision 385,
   *  which knows only HELLO and REBOOT from here). */
  async start() {
    if (this.running || !this.bytes) return;
    const info = radio.info;
    const hello = radio.hello;
    const got = radio.takeForUpdate();
    if (!got) {
      this.error = "Connect the radio over the cable first.";
      return;
    }
    this.before = { firmware: info?.firmware ?? hello?.firmware ?? "?", build: info?.build?.name ?? hello?.build?.name ?? "" };
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

  /** HELLO until the new firmware answers, then the usual connection; what it says it is. A firmware that stores
   *  another layout than the chip's data (LINK-62) gets the data moved first, as part of the update (UPD-16). */
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
    if (radio.phase === "outdated") throw new Error(`The radio restarted, but ${radio.mismatch?.text ?? "it speaks another link protocol."}`);
    if (radio.phase !== "connected") throw new Error(radio.error || "Connecting again failed.");
    const l = radio.hello?.layouts;
    // An earlier update's SPI parts cut before their stamp leave the radio "half moved" (255) with nothing moved: the
    // mark says it began from this layout. Then the parts below finish it (their stamp clears the mark); no data move.
    const partsOnly =
      !!l && l.chip === LAYOUT_MOVING && !!radio.connectedLink && (await markFrom(radio.connectedLink).catch(() => null)) === l.firmware;
    if (partsOnly) debugLog("update: the radio says 255, but its mark began from this layout: only the SPI parts were cut; writing them finishes it");
    if (partsOnly && (!this.ffw || this.ffw.is_empty()))
      throw new Error("The radio's last update stopped while writing its SPI parts: install the full update file (.ffw), whose parts finish it.");
    if (l && l.firmware !== l.chip && !partsOnly) {
      // UPD-16, LINK-62: the new firmware stores another layout: the data moves now, as part of the update.
      this.stage = "migrating";
      this.message = `The new firmware keeps its data in layout ${l.firmware}: moving yours from layout ${l.chip}…`;
      await migrate.start();
      if (migrate.stage !== "done") {
        throw new Error(
          `Finishing the update: ${migrate.error} The firmware is updated and your data waits safely (the radio shows "Finish the update"): press Finish the update to try again.`,
        );
      }
      this.message = "";
    }
    if (this.ffw && !this.ffw.is_empty()) await this.parts(this.ffw);
    this.after = { firmware: radio.info?.firmware ?? radio.hello?.firmware ?? "?", build: radio.info?.build?.name ?? "" };
    this.t = null;
    this.stage = "done";
    this.message = "";
  }

  /** UPD-21: the .ffw's SPI parts over the cable's raw writes, then the radio restarts with them. A failure here
   *  leaves the new firmware running with its fallbacks (short messages, the plain terminal, no logo). */
  private async parts(ffw: FfwFile) {
    this.stage = "parts";
    this.message = "Writing the update's SPI parts (text, logo, terminal pages)…";
    const got = radio.takeForUpdate();
    if (!got) throw new Error("The radio isn't connected: its SPI parts weren't written. Connect it and install the same file again.");
    try {
      await writeParts(got.t, got.link, ffw, (m, d, n) => {
        this.message = m;
        this.partsDone = d;
        this.partsTotal = n;
      }, () => {
        if (!radio.holds(got.t)) throw new Abort("The cable went away (unplugged or disconnected) while the SPI parts were written: install the same file again.");
      });
    } catch (e) {
      throw new Error(`The firmware is updated, but its SPI parts didn't go in (${(e as Error).message}). It runs with short messages until they do: install the same file again.`);
    } finally {
      await radio.handBack(got.t);
    }
    if (radio.phase !== "connected") throw new Error(radio.error || "Connecting again failed after the SPI parts.");
  }

  /** After a failure that left the radio connected (not in its bootloader): ready to install again. The wizard
   *  reopened on the old failure with only Close, so "Install again" could never start (Nov 17, 2026). */
  again() {
    if (this.running || radio.phase === "updating") return;
    this.error = "";
    this.stage = this.check && this.check.problems.length === 0 ? "ready" : "pick";
  }

  private fail(e: unknown, resumable: boolean) {
    this.canResume = resumable && radio.phase === "updating";
    this.stage = "failed";
    this.message = "";
    this.error = (e as Error)?.message ?? String(e);
  }
}

export const firmware = new Firmware();
