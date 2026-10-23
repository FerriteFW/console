// The Install page: a stock radio to Ferrite, and back, with no command line (decision 261; BACKUP-1, BACKUP-2,
// BACKUP-7, BACKUP-8, BACKUP-9.3, INST-5, INST-10, INST-11). ferrite's tools/flash.py, ssbpatch.py and
// fw/tools/backup.py, as one flow:
//   1. Connect: the cable opened as it is (the radio may run stock, the reader or Ferrite).
//   2. Back up: the hwtest reader image through the bootloader; the whole SPI flash read with its fdump (500 kbaud,
//      a CRC per 4 KB frame), checked against the radio's own flashcrc; saved by the owner before anything else.
//   3. SSB (optional): the patch from the owner's own stock .BTF, found in the browser.
//   4. Install: the bundled release (SHA-256 checked) or a file, with the patch bundled; refused without a saved
//      backup or over a pending phone update.
//   Back to stock: the backup written into Ferrite's own ranges over the link (STOCK_RESTORE, never calibration or
//   the update area: core/src/install.rs), then the stock .BTF through the bootloader.
import { ACK, BootPort, bootRate, CMD_PROBE, sendAll } from "./bootflash";
import {
  backupCheck,
  backupName,
  bootProbe,
  firmwareCheck,
  FirmwareUpdate,
  Fdump,
  imageCheck,
  loadCore,
  nameUid,
  P,
  readerLine,
  RestorePlan,
  restoreIdCheck,
  restoreStart,
  Session,
  sha256Hex,
  ssbDescribe,
  ssbExtract,
  statusText,
  type BackupCheck,
  type FdStep,
  type FirmwareCheck,
  type ImageCheck,
  type RestoreSummary,
  type SsbFound,
} from "./core";
import { Link, TimeoutError } from "./link";
import { radio } from "./radio.svelte";
import { sleep, type Transport } from "./transport/types";

/** The reader's fdump rates, fastest first (fdump_proto.py's RATES: the radio's 8 MHz UART makes these exact). */
const READER_RATES = [500_000, 250_000, 115_200];
const NAK = 0x15;
const CAN = 0x18;
/** How long probes go out for the bootloader (flash.py's --wait is 30 s; a power cycle by hand takes longer). */
const BOOT_WAIT_MS = 60_000;
/** A Ferrite first boot formats its store before it answers. */
const FIRST_BOOT_MS = 60_000;
export const STOCK_RESTORE = 0x60;
const OP_START = 0;
const OP_FINISH = 4;

export type Step = "idle" | "running" | "done" | "failed";
export type Picked = { name: string; bytes: Uint8Array };
export type Release = { version: string; file: string; sha256: string };
type Manifest = { ferrite?: Release; reader?: Release };

class Abort extends Error {}

const enc = (s: string) => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

/** The cable's bytes as console text, unless a protocol has the port (`sink`). */
class Wire {
  text = "";
  sink: ((b: Uint8Array) => void) | null = null;
  private wake: (() => void) | null = null;

  constructor(readonly t: Transport) {
    this.attach();
  }

  /** The port back to this (after the bootloader's or the link's own reader). */
  attach() {
    this.t.onData = (b) => {
      if (this.sink) this.sink(b);
      else this.text = (this.text + latin1(b)).slice(-8192);
      this.wake?.();
    };
  }

  clear() {
    this.text = "";
  }

  /** Waits up to `ms` for anything to arrive. */
  idle(ms: number) {
    return new Promise<void>((ok) => {
      this.wake = ok;
      setTimeout(ok, ms);
    }).then(() => {
      this.wake = null;
    });
  }

  /** The first match of `re` in what arrives, or null after `ms`. */
  async waitFor(re: RegExp, ms: number, held: () => void): Promise<RegExpMatchArray | null> {
    const end = performance.now() + ms;
    for (;;) {
      held();
      const m = this.text.match(re);
      if (m) return m;
      if (performance.now() > end) return null;
      await this.idle(Math.min(200, end - performance.now()));
    }
  }

  write(s: string | Uint8Array) {
    return this.t.write(typeof s === "string" ? enc(s) : s);
  }
}

/** The owner's stock .BTF, kept in this browser only when they say so (IndexedDB; best effort). */
const keep = {
  db(): Promise<IDBDatabase> {
    return new Promise((ok, fail) => {
      const r = indexedDB.open("ferrite-console-install", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
  },
  async run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    try {
      const db = await this.db();
      return await new Promise<T>((ok, fail) => {
        const r = f(db.transaction("files", mode).objectStore("files"));
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
    } catch {
      return undefined;
    }
  },
  get: () => keep.run<Picked | undefined>("readonly", (s) => s.get("stock")).then((v) => v ?? null),
  put: (p: Picked) => keep.run("readwrite", (s) => s.put(p, "stock")),
  drop: () => keep.run("readwrite", (s) => s.delete("stock")),
};

/** Which radio each backup this browser took is from: its SHA-256 -> the radio ID (decision 263). The file name
 * carries the ID too; this covers a renamed file. Best effort: a private window or cleared storage forgets it. */
const ids = {
  key: "ferrite-console-backup-ids",
  all(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(ids.key) ?? "{}") ?? {};
    } catch {
      return {};
    }
  },
  get: (sha: string): string | null => ids.all()[sha] ?? null,
  put(sha: string, uid: string) {
    if (!uid) return;
    try {
      localStorage.setItem(ids.key, JSON.stringify({ ...ids.all(), [sha]: uid }));
    } catch {
      /* not kept: the file name still says */
    }
  },
};

type SaveHandle = { name: string; createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>; getFile(): Promise<File> };
type SavePicker = (o: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle>;

function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

class Install {
  // 1. Connect
  private linked = $state(false);
  /** The cable is held for this page (Console's connection is in its `updating` phase). */
  get connected() {
    return this.linked && radio.phase === "updating";
  }
  label = $state("");
  // 2. Back up
  backupStep = $state<Step>("idle");
  /** What runs now, in words. */
  message = $state("");
  error = $state("");
  /** Which card the error belongs to. */
  errorAt = $state<"connect" | "backup" | "install" | "restore" | "">("");
  done = $state(0);
  total = $state(0);
  uid = $state("");
  chip = $state("");
  check = $state<BackupCheck | null>(null);
  backupName = $state("");
  /** The owner saved the backup and said so (or the desktop app saved it and read it back). */
  saved = $state(false);
  savedWhere = $state("");
  /** The browser's download started; the owner still confirms. */
  downloaded = $state(false);
  saveError = $state("");
  // 3. SSB
  stock = $state<Picked | null>(null);
  stockCheck = $state<ImageCheck | null>(null);
  ssb = $state<SsbFound | null>(null);
  ssbError = $state("");
  keepStock = $state(false);
  // 4. Install
  release = $state<Release | null>(null);
  releaseError = $state("");
  ferrite = $state<Picked | null>(null);
  ferriteCheck = $state<FirmwareCheck | null>(null);
  ferriteSource = $state<"bundled" | "file" | "">("");
  readerFile = $state<Picked | null>(null);
  readerCheck = $state<ImageCheck | null>(null);
  readerSource = $state<"bundled" | "file" | "">("");
  installStep = $state<Step>("idle");
  installed = $state("");
  // Back to stock
  restoreBackup = $state<Picked | null>(null);
  restoreBackupCheck = $state<BackupCheck | null>(null);
  /** The radio the backup is from, when Console knows it (its file name, or this browser's record). */
  restoreBackupUid = $state<string | null>(null);
  /** Console doesn't know the backup's radio: the owner types this radio's ID (this one) to go on. */
  restoreConfirmUid = $state<string | null>(null);
  restoreTyped = $state("");
  restoreStep = $state<Step>("idle");
  restoreSummary = $state<RestoreSummary | null>(null);
  /** A failure after the restore wrote: the radio must not start Ferrite again before stock is flashed. */
  restoreWrote = $state(false);

  private t: Transport | null = null;
  private wire: Wire | null = null;
  private backup: Uint8Array | null = null;
  private patch: Uint8Array | null = null;
  private loaded = false;

  get running() {
    return this.backupStep === "running" || this.installStep === "running" || this.restoreStep === "running";
  }
  get pct() {
    return this.total ? Math.floor((this.done * 100) / this.total) : 0;
  }
  /** BACKUP-2: nothing writes until the backup is verified and saved. */
  get backupReady() {
    return this.backupStep === "done" && !!this.check && this.check.problems.filter((p) => !p.startsWith("a stock phone")).length === 0;
  }
  get unlocked() {
    return this.backupReady && this.saved;
  }

  /** The bundled release and the reader (public/firmware/manifest.json, made by scripts/bundle-firmware.mjs). */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    await loadCore();
    const kept = await keep.get();
    if (kept) {
      this.keepStock = true;
      this.pickStock(kept);
    }
    let m: Manifest;
    try {
      const r = await fetch("firmware/manifest.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(String(r.status));
      m = await r.json();
    } catch {
      this.releaseError = "This copy of Console has no bundled release. Use a file (Advanced).";
      return;
    }
    if (m.ferrite) {
      const b = await this.fetchChecked(m.ferrite);
      if (b) {
        this.release = m.ferrite;
        this.setFerrite({ name: m.ferrite.file, bytes: b }, "bundled");
      }
    }
    if (m.reader) {
      const b = await this.fetchChecked(m.reader);
      if (b) this.setReader({ name: m.reader.file, bytes: b }, "bundled");
    }
  }

  /** UPD-15: a bundled file is used only when its SHA-256 is the manifest's. */
  private async fetchChecked(r: Release): Promise<Uint8Array | null> {
    try {
      const res = await fetch(`firmware/${r.file}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${r.file}: ${res.status}`);
      const b = new Uint8Array(await res.arrayBuffer());
      if (sha256Hex(b) !== r.sha256.toLowerCase()) {
        this.releaseError = `${r.file} doesn't match its checksum: Console won't use it. Use a file (Advanced).`;
        return null;
      }
      return b;
    } catch (e) {
      this.releaseError = `The bundled ${r.file} didn't load (${(e as Error).message}). Use a file (Advanced).`;
      return null;
    }
  }

  setFerrite(p: Picked, source: "bundled" | "file") {
    this.ferrite = p;
    this.ferriteCheck = firmwareCheck(p.bytes);
    this.ferriteSource = source;
  }

  setReader(p: Picked, source: "bundled" | "file") {
    this.readerFile = p;
    this.readerCheck = imageCheck("reader", p.bytes);
    this.readerSource = source;
  }

  async pickFile(kind: "ferrite" | "reader" | "stock" | "backup", f: File) {
    await loadCore();
    const p = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    if (kind === "ferrite") this.setFerrite(p, "file");
    else if (kind === "reader") this.setReader(p, "file");
    else if (kind === "stock") {
      this.pickStock(p);
      if (this.keepStock) await keep.put(p);
    } else {
      this.restoreBackup = p;
      this.restoreBackupCheck = backupCheck(p.bytes);
      this.restoreBackupUid = ids.get(this.restoreBackupCheck.sha256) ?? nameUid(p.name);
      this.restoreConfirmUid = null;
      this.restoreTyped = "";
      this.restoreSummary = null;
    }
  }

  /** INST-10: the owner's stock file; the patch found here, never sent anywhere. Kept for the way back. */
  private pickStock(p: Picked) {
    this.stock = p;
    this.stockCheck = imageCheck("stock", p.bytes);
    this.ssbError = "";
    this.patch = null;
    this.ssb = null;
    if (this.stockCheck.problems.length) {
      this.ssbError = this.stockCheck.problems.join(" ");
      return;
    }
    const patch = ssbExtract(p.bytes);
    if (!patch) {
      this.ssbError = "No SSB patch in this file. Ferrite installs without it: USB, LSB and CW stay hidden.";
      return;
    }
    this.patch = patch;
    this.ssb = ssbDescribe(patch);
  }

  async setKeepStock(on: boolean) {
    this.keepStock = on;
    if (on && this.stock) await keep.put($state.snapshot(this.stock) as Picked);
    if (!on) await keep.drop();
  }

  clearStock() {
    this.stock = null;
    this.stockCheck = null;
    this.ssb = null;
    this.patch = null;
    this.ssbError = "";
    void keep.drop();
    this.keepStock = false;
  }

  // ---- 1. Connect ----

  async connect(how: "cable" | "bridge") {
    if (this.running) return;
    this.error = "";
    this.errorAt = "";
    try {
      this.t = await radio.openForUpdate(how);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/cancel|no port selected/i.test(msg)) {
        this.error = msg;
        this.errorAt = "connect";
      }
      return;
    }
    this.wire = new Wire(this.t);
    this.linked = true;
    this.label = this.t.label || (how === "bridge" ? "Bridge" : "Cable");
  }

  async disconnect() {
    if (this.running) return;
    this.linked = false;
    this.t = null;
    this.wire = null;
    await radio.disconnect();
  }

  private held = () => {
    if (radio.phase !== "updating" || !this.t) {
      this.linked = false;
      throw new Abort("The cable went away (unplugged or disconnected). Connect again and start this step again.");
    }
  };

  // ---- the bootloader ----

  /** flash.py's enter_bootloader: Ferrite's REBOOT, the reader's `reboot`, the stock nudge; probes until it answers. */
  private async enterBootloader(ask = true): Promise<BootPort> {
    const t = this.t!;
    await bootRate(t);
    if (ask) await this.askRestart(t);
    const port = new BootPort(t);
    const probe = bootProbe();
    const t0 = performance.now();
    let nudged = false;
    let asked = 1;
    port.clear();
    while (performance.now() - t0 < BOOT_WAIT_MS) {
      this.held();
      const left = performance.now() - t0;
      if (left > 5000)
        this.message = "Waiting for the bootloader. Turn the radio off, then hold the two lower side keys and turn it on.";
      // A radio still starting (its boot screen) misses the first REBOOT: asked again a few times.
      if (ask && asked < 4 && left > asked * 3000) {
        asked++;
        await this.askRestart(t);
      }
      if (ask && !nudged && left > 1500) {
        // Still stock firmware? Its own updater's sequence restarts it into the bootloader.
        nudged = true;
        const inner = t.onData;
        let acked = false;
        t.onData = (b) => {
          if (b.includes(ACK)) acked = true;
          inner(b);
        };
        await t.write(enc("PROGRAMBT9000U"));
        await sleep(300);
        t.onData = inner;
        if (acked) await t.write(enc("UPDATE"));
      }
      await t.write(probe);
      if ((await port.next(CMD_PROBE, 15)) !== null) {
        await sleep(100);
        port.clear();
        return port;
      }
    }
    port.free();
    throw new Error("No answer from the bootloader. Turn the radio off, hold the two lower side keys, turn it on, then start this step again.");
  }

  /** Ferrite's REBOOT (LINK-24) and the reader's `reboot`; stock ignores both. */
  private async askRestart(t: Transport) {
    const s = new Session();
    try {
      // As Link.open: Ctrl-C closes Ferrite's terminal if it holds the cable (TERM-2), then 0x00 takes it.
      await t.write(Session.opening());
      await sleep(P.timing.open_settle_ms);
      await t.write(s.take_cable(performance.now()));
      await t.write(s.request(P.msg.REBOOT, new Uint8Array(), performance.now()));
    } finally {
      s.free();
    }
    await sleep(100);
    await t.write(enc("\r\nreboot\r\n"));
  }

  /** `ask`: restart the radio first (false: it is restarting by itself, as after the restore's FINISH). */
  private async flash(update: InstanceType<typeof FirmwareUpdate>, what: string, ask = true) {
    this.message = `Restarting the radio into its bootloader for ${what}…`;
    const port = await this.enterBootloader(ask);
    try {
      await sendAll(
        port,
        update,
        (done, total, msg) => {
          this.done = done;
          this.total = total;
          this.message = `${what}: ${msg.toLowerCase()}`;
        },
        this.held,
      );
    } finally {
      port.free();
      update.free();
      this.wire?.attach();
    }
  }

  // ---- 2. Back up ----

  async backUp() {
    if (this.running || !this.t || !this.wire) return;
    if (!this.readerFile || this.readerCheck?.problems.length) {
      this.error = "No reader image: Console can't take the backup. Pick one under Advanced.";
      this.errorAt = "backup";
      return;
    }
    this.backupStep = "running";
    this.error = "";
    this.errorAt = "";
    this.saved = false;
    this.downloaded = false;
    this.savedWhere = "";
    this.check = null;
    this.backup = null;
    const w = this.wire;
    try {
      await this.flash(FirmwareUpdate.reader(this.readerFile.bytes), "the reader");
      this.message = "Waiting for the reader to start…";
      await this.readerPrompt();
      // The radio's screen says "Backing up your radio" instead of hwtest's diagnostics pages (an older reader
      // doesn't know `reader`: its pages stay, nothing else changes).
      w.clear();
      await w.write("reader\r");
      await w.waitFor(/reader screen on/, 1500, this.held);
      w.clear();
      await w.write("sys\r");
      const sys = await w.waitFor(/[^\r\n]* uid [0-9A-F]{24}[^\r\n]*/, 4000, this.held);
      this.uid = (sys && readerLine<{ uid: string }>("sys", sys[0])?.uid) || "";
      w.clear();
      await w.write("flash\r");
      const fl = await w.waitFor(/flash id [0-9A-F]{6} \([^)]*\)[^\r\n]*/, 5000, this.held);
      const chip = fl && readerLine<{ id: string; vendor: string; size: number }>("flash", fl[0]);
      if (!chip) throw new Error("The reader didn't report the radio's SPI flash.");
      this.chip = `${chip.vendor} ${chip.id}, ${chip.size / 1024} KB`;
      const data = await this.readChip(chip.size);
      this.message = "Checking: the radio's own CRC of the whole chip (about a minute)…";
      w.clear();
      await w.write("flashcrc\r");
      const crc = await w.waitFor(/flash crc32 [0-9A-F]{8} over \d+ KB/, 240_000, this.held);
      const radioCrc = crc && readerLine<{ crc: number; size: number }>("flashcrc", crc[0]);
      if (!radioCrc) throw new Error("The radio didn't answer flashcrc. Start the backup again.");
      const c = backupCheck(data);
      const mine = parseInt(c.crc32, 16);
      if (radioCrc.crc !== mine || radioCrc.size !== data.length)
        throw new Error(
          `The radio says CRC ${radioCrc.crc.toString(16).toUpperCase().padStart(8, "0")} over ${radioCrc.size / 1024} KB; the read is ${c.crc32}. Start the backup again.`,
        );
      this.backup = data;
      this.check = c;
      this.backupName = backupName(this.uid, today());
      ids.put(c.sha256, this.uid);
      this.message = "";
      this.backupStep = c.problems.some((p) => !p.startsWith("a stock phone")) ? "failed" : "done";
      if (this.backupStep === "failed") {
        this.error = c.problems.join(" ");
        this.errorAt = "backup";
      }
    } catch (e) {
      this.fail("backup", e);
    }
  }

  /** Enter until the reader's `>` prompt answers. */
  private async readerPrompt() {
    const w = this.wire!;
    await sleep(1500);
    const end = performance.now() + 20_000;
    while (performance.now() < end) {
      this.held();
      w.clear();
      await w.write("\r");
      await w.idle(300);
      if (w.text.trimEnd().endsWith(">")) return;
    }
    throw new Error("The reader didn't start. Turn the radio off and on, then start the backup again.");
  }

  /** The whole chip with fdump, from the fastest rate down (flashdump.py's read_range). */
  private async readChip(size: number): Promise<Uint8Array> {
    let last: Error | null = null;
    for (const rate of this.t!.setBaud ? READER_RATES : [READER_RATES[READER_RATES.length - 1]]) {
      try {
        return await this.fdump(size, rate);
      } catch (e) {
        if (e instanceof Abort) throw e;
        last = e as Error;
        if (/no answer to fdump|outside/.test(last.message)) break;
        await this.wire!.write("\r");
        await sleep(500);
      }
    }
    throw new Error(`Reading the flash failed: ${last?.message ?? "?"}. Start the backup again.`);
  }

  private async fdump(len: number, rate: number): Promise<Uint8Array> {
    const t = this.t!;
    const w = this.wire!;
    const fd = new Fdump(0, len);
    const queue: FdStep[] = [];
    this.done = 0;
    this.total = len;
    this.message = `Reading the flash at ${rate / 1000} kbaud…`;
    try {
      w.clear();
      await w.write(fd.command(rate));
      const ready = await w.waitFor(/fdump(?:: [^\r\n]*|[ ][0-9A-F]{6} [0-9A-F]+ \d+ ready[^\r\n]*)/, 5000, this.held);
      if (!ready) throw new Error("no answer to fdump");
      if (ready[0].startsWith("fdump: ")) throw new Error(ready[0]);
      if (t.setBaud) await t.setBaud(rate);
      await sleep(50);
      w.sink = (b) => queue.push(JSON.parse(fd.feed(b)));
      const syncEnd = performance.now() + 3000;
      while (!fd.synced()) {
        this.held();
        if (performance.now() > syncEnd) throw new Error(`no sync at ${rate} baud`);
        await w.write("FDS1");
        await w.idle(100);
      }
      let last = performance.now();
      for (;;) {
        this.held();
        let st = queue.shift();
        if (!st) {
          if (performance.now() - last < 3500) {
            await w.idle(100);
            continue;
          }
          st = JSON.parse(fd.timeout()) as FdStep;
        }
        last = performance.now();
        if (st.error) throw new Error(st.error);
        if (st.send.length) await t.write(new Uint8Array(st.send));
        if (st.nak) {
          await sleep(20);
          fd.resume();
          queue.length = 0;
          await t.write(new Uint8Array([NAK]));
        }
        this.done = st.got;
        if (st.done) break;
      }
      return fd.take_data();
    } catch (e) {
      await t.write(new Uint8Array([CAN, CAN, CAN, CAN])).catch(() => {});
      throw e;
    } finally {
      w.sink = null;
      fd.free();
      await sleep(50);
      if (t.setBaud) await t.setBaud(P.timing.cable_baud).catch(() => {});
      await sleep(50);
      await w.waitFor(/fdump (end|stopped)[^\r\n]*/, 3000, () => {});
    }
  }

  /** BACKUP-2: the desktop app's save dialog (the file read back), Chrome's save dialog (read back too), or the
   * browser's download the owner confirms. Once: a download already started isn't started again by this. */
  async save() {
    if (!this.backup || this.saving) return;
    this.saveError = "";
    if (isTauri()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const path = await invoke<string | null>("save_file", this.backup, { headers: { "x-name": this.backupName } });
        if (path) {
          this.savedWhere = path;
          this.saved = true;
        }
      } catch (e) {
        this.saveError = String((e as Error)?.message ?? e);
      }
      return;
    }
    const blob = new Blob([this.backup as BlobPart], { type: "application/octet-stream" });
    const pick = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (pick) {
      this.saving = true;
      try {
        const h = await pick({ suggestedName: this.backupName, types: [{ description: "Radio backup", accept: { "application/octet-stream": [".bin"] } }] });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        const back = new Uint8Array(await (await h.getFile()).arrayBuffer());
        if (back.length === this.backup.length && sha256Hex(back) === this.check?.sha256) {
          this.savedWhere = h.name;
          this.saved = true;
        } else this.saveError = `${h.name} didn't read back as this backup. Save it again.`;
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return; // the owner closed the dialog
        // Not allowed here (a sandboxed frame, a policy): the download below.
      } finally {
        this.saving = false;
      }
    }
    if (this.downloaded) return; // once: "Download again" says so itself
    this.download(blob);
  }

  /** The browser's download, again, when the owner asks for it. */
  downloadAgain() {
    if (this.backup) this.download(new Blob([this.backup as BlobPart], { type: "application/octet-stream" }));
  }

  private saving = false;

  private download(blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.backupName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    this.downloaded = true;
  }

  /** The owner confirms the download landed. */
  confirmSaved() {
    if (this.downloaded) {
      this.saved = true;
      this.savedWhere = `${this.backupName} (your downloads)`;
    }
  }

  /** Or proves it: the saved file picked again must be the backup. */
  async checkSaved(f: File) {
    const b = new Uint8Array(await f.arrayBuffer());
    if (this.backup && b.length === this.backup.length && sha256Hex(b) === this.check?.sha256) {
      this.saved = true;
      this.savedWhere = f.name;
      this.saveError = "";
    } else this.saveError = `${f.name} isn't this backup.`;
  }

  // ---- 4. Install ----

  /** Why Install can't run yet, or "". */
  get installBlock(): string {
    if (!this.unlocked) return "Take the backup and save it first.";
    if (this.check?.pending_update)
      return "A stock phone or Bluetooth update is waiting in this radio (0xA55A at 0x300000): the bootloader would flash it over Ferrite. Let stock finish or clear that update, then take a new backup.";
    if (!this.ferrite || !this.ferriteCheck) return "No Ferrite image: pick one under Advanced.";
    if (this.ferriteCheck.problems.length) return this.ferriteCheck.problems.join(" ");
    if (!this.connected) return "Connect the radio.";
    return "";
  }

  async install() {
    if (this.running || this.installBlock) return;
    this.installStep = "running";
    this.error = "";
    this.errorAt = "";
    try {
      const update = FirmwareUpdate.ferrite(this.ferrite!.bytes, this.patch ?? undefined);
      await this.flash(update, "Ferrite");
      this.message = "Sent. Ferrite starts, sets up its storage and opens its first-run setup…";
      this.installed = (await this.hello(FIRST_BOOT_MS)) ?? "";
      this.installStep = "done";
      this.resetRestore();
      this.message = "";
    } catch (e) {
      this.fail("install", e);
    }
  }

  /** HELLO until Ferrite answers: its version, or null when it doesn't in `ms` (not an error: first boot). */
  private async hello(ms: number): Promise<string | null> {
    const t = this.t!;
    await sleep(1500);
    const end = performance.now() + ms;
    while (performance.now() < end) {
      this.held();
      const link = new Link(t);
      try {
        await link.open();
        const h = await link.hello();
        return h.firmware;
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
      } finally {
        link.close();
        this.wire?.attach();
      }
    }
    return null;
  }

  // ---- Back to stock ----

  /** A finished Back to stock is history once Ferrite is installed again. */
  private resetRestore() {
    this.restoreStep = "idle";
    this.restoreSummary = null;
    this.restoreWrote = false;
    this.restoreConfirmUid = null;
    this.restoreTyped = "";
  }

  /** The radio runs stock again: the install card starts over (the backup stays: it is still this radio's). */
  private backOnStock() {
    this.restoreWrote = false;
    this.restoreStep = "done";
    this.restoreConfirmUid = null;
    this.restoreTyped = "";
    this.installStep = "idle";
    this.installed = "";
    this.message = "";
  }

  get restoreBlock(): string {
    const b = this.restoreBackupCheck;
    if (!this.restoreBackup || !b) return "Drop in your backup.";
    const bad = b.problems.filter((p) => !p.startsWith("a stock phone"));
    if (bad.length) return bad.join(" ");
    if (!this.stock || !this.stockCheck) return "Drop in your stock .BTF.";
    if (this.stockCheck.problems.length) return this.stockCheck.problems.join(" ");
    if (!this.connected) return "Connect the radio.";
    return "";
  }

  /** BACKUP-7, BACKUP-8: the backup into Ferrite's ranges over the link, then the stock .BTF. */
  async restore() {
    if (this.running || this.restoreBlock) return;
    this.restoreStep = "running";
    this.restoreWrote = false;
    this.error = "";
    this.errorAt = "";
    const t = this.t!;
    const link = new Link(t);
    let plan: InstanceType<typeof RestorePlan> | null = null;
    try {
      this.message = "Asking the radio (it must run Ferrite)…";
      await link.open();
      await link.hello().catch(() => {
        throw new Error("The radio doesn't answer as Ferrite. Back to stock needs Ferrite running; check the cable and that the radio is on.");
      });
      // Decision 263, before anything stops: the backup must be this radio's by its MCU ID (INFO's; calibration can
      // be the same on two radios). The START answer's ID is checked again by the plan.
      const here = (await link.info().catch(() => null))?.uid_text ?? null;
      if (here) {
        const pre = restoreIdCheck(here, this.restoreBackupUid, this.restoreTyped);
        this.restoreConfirmUid = pre.confirm_uid;
        if (pre.problems.length) throw new Error(`${pre.problems.join(" ")} Nothing was written.`);
      }
      const { status, rest } = await link.ask(STOCK_RESTORE, new Uint8Array([OP_START]), 10_000);
      if (status === 2) throw new Error("This Ferrite is older than the way back: update it first (Firmware Update), then try again.");
      if (status !== 0) throw new Error(`The radio refused: ${statusText(status, rest)}.`);
      const start = restoreStart(rest);
      if (!start) throw new Error("The radio's answer didn't parse. Turn it off and on, then try again.");
      // Decision 263: the backup must be this radio's by its MCU ID (calibration can match on two radios).
      plan = new RestorePlan(this.restoreBackup!.bytes, JSON.stringify(start), this.restoreBackupUid ?? undefined, this.restoreTyped || undefined);
      const sum: RestoreSummary = JSON.parse(plan.summary());
      this.restoreSummary = sum;
      this.restoreConfirmUid = sum.confirm_uid;
      if (sum.problems.length) {
        // Nothing written: the radio resets and starts Ferrite again.
        await link.ask(STOCK_RESTORE, new Uint8Array([OP_FINISH]), 3000).catch(() => {});
        throw new Error(`${sum.problems.join(" ")} Nothing was written; the radio restarts.`);
      }
      this.total = plan.len();
      for (let i = 0; i < plan.len(); i++) {
        this.held();
        this.done = i;
        this.message = `Writing your stock data back: ${Math.floor((i * 100) / plan.len())}%`;
        const payload = plan.payload(i);
        let answer: { status: number; rest: Uint8Array } | null = null;
        for (let tries = 0; tries < 3 && !answer; tries++) {
          try {
            answer = await link.ask(STOCK_RESTORE, payload, 4000);
          } catch (e) {
            if (!(e instanceof TimeoutError)) throw e;
          }
        }
        if (!answer) throw new Error("The radio stopped answering during the restore.");
        if (answer.status !== 0) throw new Error(`The radio refused a ${plan.kind(i)}: ${statusText(answer.status, answer.rest)}.`);
        this.restoreWrote = true;
        const want = plan.expect(i);
        if (want >= 0) {
          const got = new DataView(answer.rest.buffer, answer.rest.byteOffset).getUint32(0, true);
          if (got !== want) throw new Error("A range read back differently from the backup. Start Back to stock again.");
        }
      }
      this.done = plan.len();
      if (start.uid) {
        this.restoreBackupUid = start.uid;
        ids.put(this.restoreBackupCheck!.sha256, start.uid); // known from now on
      }
      this.message = "Restored and read back. Restarting into the bootloader…";
      const fin = await link.ask(STOCK_RESTORE, new Uint8Array([OP_FINISH]), 3000);
      if (fin.status !== 0) throw new Error(`The radio refused to finish: ${statusText(fin.status)}.`);
      link.close();
      this.wire!.attach();
      await this.flash(FirmwareUpdate.stock(this.stock!.bytes), "stock firmware", false);
      this.backOnStock();
    } catch (e) {
      link.close();
      this.wire?.attach();
      this.fail("restore", e);
    } finally {
      plan?.free();
    }
  }

  /** After a cut restore: the radio waits in the bootloader (side keys held at power-on); only the stock file goes. */
  async flashStockOnly() {
    if (this.running || !this.stock || this.stockCheck?.problems.length || !this.connected) return;
    this.restoreStep = "running";
    this.error = "";
    this.errorAt = "";
    try {
      await this.flash(FirmwareUpdate.stock(this.stock.bytes), "stock firmware");
      this.backOnStock();
    } catch (e) {
      this.fail("restore", e);
    }
  }

  private fail(which: "backup" | "install" | "restore", e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (which === "backup") this.backupStep = "failed";
    else if (which === "install") this.installStep = "failed";
    else this.restoreStep = "failed";
    this.message = "";
    this.error = msg;
    this.errorAt = which;
    if (radio.phase !== "updating") this.linked = false;
  }
}

export const install = new Install();
