// The Install page: a stock radio to Ferrite, and back, with no command line (decision 261; BACKUP-1, BACKUP-2,
// BACKUP-7, BACKUP-8, BACKUP-9.3, INST-5, INST-10, INST-11). ferrite's tools/flash.py, ssbpatch.py and
// fw/tools/backup.py, as one flow:
//   1. Connect: the cable opened as it is (the radio may run stock, the reader or Ferrite).
//   2. Back up: the reader image (Ferrite's read-only reader, or hwtest's) through the bootloader; the whole SPI flash read
//      with the Rust reader's fdumpz (230400 baud, coded 16 KB chunks with a CRC each, BACKUP-9.6) or hwtest's fdump
//      (500 kbaud down, 4 KB frames), checked against the radio's own flashcrc; saved by the owner before anything else.
//   3. SSB (optional): the patch from the owner's own stock .BTF, found in the browser.
//   4. Install: the bundled release (SHA-256 checked) or a file, with the patch bundled; refused without a saved
//      backup or over a pending phone update.
//   Back to stock: the backup written into Ferrite's own ranges over the link (STOCK_RESTORE, never calibration or
//   the update area: core/src/install.rs), then the stock .BTF through the bootloader, padded over stock's marker
//   sector's first page with the marker the backup read put back (BACKUP-12, ferrite decision 338).
import { debugLog } from "./debuglog";
import { saveAs } from "./download";
import { createZip, readZip } from "./zip";
import { CONSOLE_VERSION } from "./codeplug.svelte";
import { ACK, askRestart, BootPort, bootRate, CMD_PROBE, sendAll } from "./bootflash";
import {
  backupCheck,
  backupName,
  bootProbe,
  FfwFile,
  firmwareCheck,
  FirmwareUpdate,
  Fdump,
  iconsPlausible,
  ICONS_LEN,
  imageCheck,
  MDUMP_ICONS,
  parseMdumpIcons,
  loadCore,
  markerWord,
  nameMarker,
  nameUid,
  parseMdump,
  P,
  readerHasFdumpz,
  readerLine,
  RestorePlan,
  restoreIdCheck,
  restoreStart,
  sha256Hex,
  ssbDescribe,
  ssbExtract,
  statusText,
  type BackupCheck,
  type FdStep,
  type FfwSummary,
  type FirmwareCheck,
  type ImageCheck,
  type RestoreSummary,
  type SsbFound,
} from "./core";
import { signatureOf, signatureProblem, splitPicked, type Signed } from "./signature";
import { writeParts } from "./parts";
import { devOpts } from "./devopts.svelte";
import { Link, TimeoutError } from "./link";
import { installIdProblem, otherRadio, restoreProgress, stockOnlyAllowed, uidKey } from "./installGuard";
import { cablePrefs } from "./cablePrefs.svelte";
import { radio } from "./radio.svelte";
import { sleep, type Transport } from "./transport/types";
import { appFetch } from "./appfetch";

/** The reader's fdump rates, fastest first (fdump_proto.py's RATES: the radio's 8 MHz UART makes these exact). */
const READER_RATES = [500_000, 250_000, 115_200];
/** The Rust reader's fdumpz rate (BACKUP-9.6, ferrite decision 265): one fixed, safe rate for long transfers. */
const FDUMPZ_BAUD = 230_400;
const NAK = 0x15;
const CAN = 0x18;
/** How long probes go out for the bootloader (flash.py's --wait is 30 s; a power cycle by hand takes longer). */
const BOOT_WAIT_MS = 60_000;
/** BACKUP-8.1: after the restore's FINISH the radio resets into its bootloader by itself (about 300 ms, then its
 *  ~200 ms window): probes go out this long. Past it Ferrite has started (and may set up its storage over the
 *  restored data), so no one is asked to power-cycle into the bootloader here. */
const FINISH_BOOT_MS = 5_000;
/** A Ferrite first boot formats its store before it answers. */
const FIRST_BOOT_MS = 60_000;
export const STOCK_RESTORE = 0x60;
/** BACKUP-12.1: the reader's (and hwtest's) read of stock's marker sector, the MCU's 0x080F0000-0x080F000F. */
const MDUMP_MARKER = "mdump 0x080F0000 16\r";
const OP_START = 0;
const OP_FINISH = 4;

export type Step = "idle" | "running" | "done" | "failed";
export type Picked = { name: string; bytes: Uint8Array };
/** A bundled image; `minisig` is its signature's text when the release was signed (scripts/bundle-firmware.mjs). */
export type Release = { version: string; file: string; sha256: string; minisig?: string };
type Manifest = { ferrite?: Release; reader?: Release };

class Abort extends Error {}
/** Back to stock found no Ferrite on the radio: the page offers the restorer (BACKUP-13). */
class NotFerrite extends Error {}

/** The reader answered `?` to fdumpz (hwtest's): plain fdump instead. */
class NoFdumpz extends Error {}

/** One fdumpz DEFLATE chunk (raw DEFLATE, RFC 1951) inflated by the browser; empty when it doesn't inflate. */
async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
  try {
    const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  } catch {
    return new Uint8Array(0);
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
};
/** BACKUP-1.5: the backup's local date and time for its name (`YYYYMMDD-HHMMSS`): two backups a day never share one. */
const stamp = () => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};

/** The cable's bytes as console text, unless a protocol has the port (`sink`). */
/** What the radio sent last, for the debug log when a reader step fails (Nov 17, 2026: two Windows backups failed
 * with "no answer to fdump" after a 0.2 s icon read; the log couldn't tell a `?` from silence). Control characters
 * shown escaped; at most `n` characters, the end of it. */
function radioSaid(s: string, n = 300): string {
  const t = s.slice(-n);
  return JSON.stringify(t) + (s.length > n ? ` (last ${n} of ${s.length})` : "");
}

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

/** BACKUP-12.3: stock's menu icons each backup this browser took read, by its SHA-256 (IndexedDB, as the stock file;
 * best effort). They aren't in the backup file: Install also offers them as a file of their own. */
const iconStore = {
  get: (sha: string) => keep.run<Uint8Array | undefined>("readonly", (s) => s.get(`icons-${sha}`)).then((v) => v ?? null),
  put: (sha: string, b: Uint8Array) => keep.run("readwrite", (s) => s.put(b, `icons-${sha}`)),
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

/** BACKUP-12: stock's marker sector bytes each backup this browser took read (its SHA-256 -> 32 hex digits). The file
 * name carries a stock word too; this covers a renamed file. Best effort, as `ids`. */
const markers = {
  key: "ferrite-console-backup-markers",
  all(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(markers.key) ?? "{}") ?? {};
    } catch {
      return {};
    }
  },
  get(sha: string): Uint8Array | null {
    const h = markers.all()[sha];
    return h && /^[0-9a-f]{32}$/.test(h) ? Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))) : null;
  },
  put(sha: string, m: Uint8Array) {
    try {
      localStorage.setItem(markers.key, JSON.stringify({ ...markers.all(), [sha]: Array.from(m, (x) => x.toString(16).padStart(2, "0")).join("") }));
    } catch {
      /* not kept: the file name still carries a stock word */
    }
  },
};

// ---- the backup file (.fbin, decision 407): one zip with everything the way back needs ----

/** BACKUP-2.1: the backup file's manifest. `spi.bin` is the whole SPI flash as the reader read it (what a `.bin`
 *  backup held before 0.9.3); `icons.bin` stock's menu tiles from MCU 0x08080000 when they were stock's
 *  (BACKUP-12.3); the marker the 16 bytes at 0x080F0000 in hex (BACKUP-12.1). */
type FbinManifest = {
  format: "ferrite-backup";
  version: 1;
  radio_id: string;
  saved: string;
  console: string;
  chip: string;
  spi: { file: "spi.bin"; bytes: number; sha256: string; crc32: string };
  marker: string | null;
  icons: { file: "icons.bin"; bytes: number; sha256: string } | null;
};

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The `.fbin` bytes for a backup. */
async function fbin(spi: Uint8Array, crc32: string, sha: string, uid: string, chip: string, marker: Uint8Array | null, icons: Uint8Array | null): Promise<Uint8Array> {
  const m: FbinManifest = {
    format: "ferrite-backup",
    version: 1,
    radio_id: uid,
    saved: new Date().toISOString(),
    console: CONSOLE_VERSION,
    chip,
    spi: { file: "spi.bin", bytes: spi.length, sha256: sha, crc32 },
    marker: marker ? hexOf(marker) : null,
    icons: icons ? { file: "icons.bin", bytes: icons.length, sha256: sha256Hex(icons) } : null,
  };
  const entries = [
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(m, null, 1) + "\n") },
    { name: "spi.bin", data: spi },
    ...(icons ? [{ name: "icons.bin", data: icons }] : []),
  ];
  return new Uint8Array(await (await createZip(entries)).arrayBuffer());
}

/** A `.fbin` opened: its parts, each checked against the manifest; or the reason it isn't one. */
export async function openFbin(b: Uint8Array): Promise<{ spi: Uint8Array; manifest: FbinManifest; marker: Uint8Array | null; icons: Uint8Array | null }> {
  const z = await readZip(b).catch(() => {
    throw new Error("not a Ferrite backup (.fbin): the zip doesn't read");
  });
  const mf = z.get("manifest.json");
  const spi = z.get("spi.bin");
  if (!mf || !spi) throw new Error("not a Ferrite backup (.fbin): no manifest.json or spi.bin");
  const manifest = JSON.parse(new TextDecoder().decode(mf)) as FbinManifest;
  if (manifest.format !== "ferrite-backup") throw new Error("not a Ferrite backup (.fbin)");
  if (sha256Hex(spi) !== manifest.spi.sha256) throw new Error("its spi.bin doesn't match its manifest (a damaged file)");
  const icons = z.get("icons.bin") ?? null;
  if (icons && (!manifest.icons || sha256Hex(icons) !== manifest.icons.sha256)) throw new Error("its icons.bin doesn't match its manifest (a damaged file)");
  const marker = manifest.marker && /^[0-9a-f]{32}$/.test(manifest.marker) ? Uint8Array.from(manifest.marker.match(/../g)!.map((x) => parseInt(x, 16))) : null;
  return { spi, manifest, marker, icons };
}

/** A zip's first bytes. */
const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** What the marker bytes say, for the backup's facts. */
export function markerText(m: Uint8Array | null, read: boolean): string {
  if (!read) return "not read by this reader: assumed blank (stock shows its default model name after Back to stock)";
  if (!m) return "not read";
  const w = markerWord(m);
  if (w) return `${w} (stock's model marker; put back by Back to stock)`;
  return m.every((x) => x === 0xff) ? "blank" : "not stock's (left erased by Back to stock)";
}

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
  #message = $state("");
  #error = $state("");
  /** What it's doing now; each change goes to the debug log (debuglog.ts), so a report has the steps. */
  get message() {
    return this.#message;
  }
  set message(v: string) {
    if (v && v !== this.#message) debugLog(`install: ${v}`);
    this.#message = v;
  }
  /** What went wrong; to the debug log too. */
  get error() {
    return this.#error;
  }
  set error(v: string) {
    if (v && v !== this.#error) debugLog(`install ERROR: ${v}`);
    this.#error = v;
  }
  /** Which card the error belongs to. */
  errorAt = $state<"connect" | "backup" | "install" | "restore" | "">("");
  done = $state(0);
  total = $state(0);
  uid = $state("");
  chip = $state("");
  /** BACKUP-12.1: stock's marker sector's first 16 bytes as the reader read them (null: not read). */
  marker = $state<Uint8Array | null>(null);
  markerRead = $state(false);
  /** BACKUP-12.3: stock's menu icons as the reader read them (null: not read), and whether they are stock's tiles
   *  (not a Ferrite image's code left over them by an earlier install). */
  icons = $state<Uint8Array | null>(null);
  iconsStock = $state(false);
  check = $state<BackupCheck | null>(null);
  backupName = $state("");
  /** The `.fbin` as saved (decision 407): built once the backup is checked; what Save writes and reads back. */
  backupFile = $state<Uint8Array | null>(null);
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
  /** The images' minisig signatures (signature.ts): a bad one is also a problem in the image's check. */
  ferriteSignature = $state<Signed | null>(null);
  /** A .ffw's contents (ferrite decision 335): its SPI parts go in once Ferrite runs. Null for a bare .btf. */
  ferriteFfw = $state<FfwSummary | null>(null);
  /** The Ferrite file as picked or bundled (a .ffw is checked again when the developer option changes). */
  private ferriteOrig: { p: Picked; source: "bundled" | "file"; minisig: string | null } | null = null;
  private readerOrig: { p: Picked; source: "bundled" | "file"; minisig: string | null } | null = null;
  private ffw: FfwFile | null = null;
  /** BACKUP-13: the restorer image (bundled, signed by Ferrite's CI) for Back to stock when Ferrite isn't running. */
  restorerFile = $state<Picked | null>(null);
  restorerProblem = $state("");
  readerFile = $state<Picked | null>(null);
  readerCheck = $state<ImageCheck | null>(null);
  readerSource = $state<"bundled" | "file" | "">("");
  readerSignature = $state<Signed | null>(null);
  installStep = $state<Step>("idle");
  installed = $state("");
  // Back to stock
  restoreBackup = $state<Picked | null>(null);
  restoreBackupCheck = $state<BackupCheck | null>(null);
  /** The radio the backup is from, when Console knows it (its file name, or this browser's record). */
  restoreBackupUid = $state<string | null>(null);
  /** BACKUP-12: the marker sector bytes the backup read (this browser's record, or the file name's word), or null. */
  restoreMarker = $state<Uint8Array | null>(null);
  /** BACKUP-12.3: the menu icons Back to stock puts back (this browser's record of the backup's, or a file), and from where. */
  restoreIcons = $state<Uint8Array | null>(null);
  restoreIconsFrom = $state<"" | "backup" | "file">("");
  restoreIconsError = $state("");
  /** BACKUP-13: the last Back to stock found no Ferrite answering: the page offers the restorer. */
  restoreNoFerrite = $state(false);
  /** A backup file that didn't open (a damaged .fbin). */
  restoreFileError = $state("");
  /** Console doesn't know the backup's radio: the owner types this radio's ID (this one) to go on. */
  restoreConfirmUid = $state<string | null>(null);
  restoreTyped = $state("");
  restoreStep = $state<Step>("idle");
  restoreSummary = $state<RestoreSummary | null>(null);
  /** A failure after the restore wrote: Back to stock must run again (or, BACKUP-8.1, stock alone may finish it). */
  restoreWrote = $state(false);
  /** BACKUP-8.1: every range was written and read back, and stock started going in: the stock firmware alone may
   *  finish the way back. */
  restoreStockOnly = $state(false);

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
      const r = await appFetch("firmware/manifest.json", { cache: "no-cache" });
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
        this.setFerrite({ name: m.ferrite.file, bytes: b }, "bundled", m.ferrite.minisig ?? null);
      }
    }
    if (m.reader) {
      const b = await this.fetchChecked(m.reader);
      if (b) this.setReader({ name: m.reader.file, bytes: b }, "bundled", m.reader.minisig ?? null);
    }
    if (m.restorer) {
      const b = await this.fetchChecked(m.restorer);
      if (b) {
        const c = imageCheck("restorer", b);
        const sig = signatureOf(b, m.restorer.minisig ?? null);
        const why = signatureProblem(sig, devOpts.allowUnsigned); // UPD-27
        if (why) c.problems.push(why);
        this.restorerFile = c.problems.length ? null : { name: m.restorer.file, bytes: b };
        this.restorerProblem = c.problems.join(" ");
      }
    }
  }

  /** UPD-15: a bundled file is used only when its SHA-256 is the manifest's. */
  private async fetchChecked(r: Release): Promise<Uint8Array | null> {
    try {
      const res = await appFetch(`firmware/${r.file}`, { cache: "no-cache" });
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

  /** A signature that doesn't verify refuses the image like a failed check. A .ffw (UPD-21, UPD-24) is checked
   *  whole by the core first (its signature, every hash, each part's target); its image then as a .btf. */
  setFerrite(p: Picked, source: "bundled" | "file", minisig: string | null) {
    this.ferriteOrig = { p, source, minisig };
    this.ffw?.free();
    this.ffw = null;
    this.ferriteFfw = null;
    if (/\.ffw$/i.test(p.name)) {
      let f: FfwFile;
      try {
        f = new FfwFile(p.bytes, devOpts.allowUnsigned);
      } catch (e) {
        const c = firmwareCheck(new Uint8Array(0));
        c.problems = (e as Error).message.split("\n");
        this.ferrite = p;
        this.ferriteCheck = c;
        this.ferriteSignature = null;
        this.ferriteSource = source;
        return;
      }
      const summary = JSON.parse(f.summary()) as FfwSummary;
      this.ffw = f;
      this.ferriteFfw = summary;
      this.ferrite = { name: p.name, bytes: f.btf() };
      this.ferriteCheck = firmwareCheck(this.ferrite.bytes);
      this.ferriteSignature = summary.signed !== null ? { kind: "signed", comment: summary.signed } : { kind: "unsigned" };
      this.ferriteSource = source;
      return;
    }
    const sig = signatureOf(p.bytes, minisig);
    const c = firmwareCheck(p.bytes);
    const why = signatureProblem(sig, devOpts.allowUnsigned); // UPD-27
    if (why) c.problems.push(why);
    this.ferrite = p;
    this.ferriteCheck = c;
    this.ferriteSignature = sig;
    this.ferriteSource = source;
  }

  setReader(p: Picked, source: "bundled" | "file", minisig: string | null) {
    const sig = signatureOf(p.bytes, minisig);
    const c = imageCheck("reader", p.bytes);
    const why = signatureProblem(sig, devOpts.allowUnsigned); // UPD-27
    if (why) c.problems.push(why);
    this.readerOrig = { p, source, minisig };
    this.readerFile = p;
    this.readerCheck = c;
    this.readerSignature = sig;
    this.readerSource = source;
  }

  /** The developer option changed: the Ferrite file is checked again under it. */
  recheckFerrite() {
    const o = this.ferriteOrig;
    if (o && !this.running) this.setFerrite(o.p, o.source, o.minisig);
    const r = this.readerOrig; // the reader too (UPD-27)
    if (r && !this.running) this.setReader(r.p, r.source, r.minisig);
  }

  /** Ferrite takes a .ffw, or a .btf with its .minisig (signature.ts), as the reader does; stock and backup the
   *  first file. */
  async pickFile(kind: "ferrite" | "reader" | "stock" | "backup" | "icons", files: File[]) {
    await loadCore();
    const ffwFile = kind === "ferrite" ? files.find((f) => /\.ffw$/i.test(f.name)) : undefined;
    if (ffwFile) {
      this.setFerrite({ name: ffwFile.name, bytes: new Uint8Array(await ffwFile.arrayBuffer()) }, "file", null);
      return;
    }
    if (kind === "ferrite" || kind === "reader") {
      const { btf, sig } = splitPicked(files);
      // No .btf among them: the image's own check refuses whatever came first, as before.
      const f = btf ?? files[0];
      const p = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
      const minisig = btf && sig ? await sig.text() : null;
      if (kind === "ferrite") this.setFerrite(p, "file", minisig);
      else this.setReader(p, "file", minisig);
      return;
    }
    const f = files[0];
    const p = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    if (kind === "icons") {
      // BACKUP-12.3: a menu-icons file (Install's "Save the menu icons", this radio's or another's).
      const ok = p.bytes.length === ICONS_LEN && iconsPlausible(p.bytes);
      this.restoreIconsError = ok ? "" : `${p.name} isn't stock's menu icons (${ICONS_LEN} bytes of tiles expected).`;
      if (ok) [this.restoreIcons, this.restoreIconsFrom] = [p.bytes, "file"];
      return;
    }
    if (kind === "stock") {
      this.pickStock(p);
      if (this.keepStock) await keep.put(p);
    } else {
      // A .fbin (decision 407): the SPI flash, the radio's ID, the marker and the menu icons in one file.
      let fromFbin: Awaited<ReturnType<typeof openFbin>> | null = null;
      if (isZip(p.bytes)) {
        try {
          fromFbin = await openFbin(p.bytes);
        } catch (e) {
          this.restoreBackup = null;
          this.restoreBackupCheck = null;
          this.restoreFileError = `${p.name}: ${(e as Error).message}.`;
          return;
        }
        p.bytes = fromFbin.spi;
      }
      this.restoreFileError = "";
      this.restoreBackup = p;
      this.restoreBackupCheck = backupCheck(p.bytes);
      this.restoreBackupUid = ids.get(this.restoreBackupCheck.sha256) ?? nameUid(p.name);
      this.restoreMarker = markers.get(this.restoreBackupCheck.sha256) ?? nameMarker(p.name);
      if (fromFbin) {
        this.restoreBackupUid = fromFbin.manifest.radio_id || this.restoreBackupUid;
        this.restoreMarker = fromFbin.marker ?? this.restoreMarker;
      }
      // The icons: an icons file picked stays; else the .fbin's, else this browser's record of the backup's.
      if (this.restoreIconsFrom !== "file") {
        const mine = fromFbin?.icons && iconsPlausible(fromFbin.icons) ? fromFbin.icons : await iconStore.get(this.restoreBackupCheck.sha256);
        this.restoreIcons = mine;
        this.restoreIconsFrom = mine ? "backup" : "";
      }
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
    debugLog(`install connect ${how}: running ${this.running}, radio phase ${radio.phase}`);
    if (this.running) return;
    this.error = "";
    this.errorAt = "";
    try {
      this.t = await radio.openForUpdate(how);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      debugLog(`install connect failed: ${msg}`);
      if (!/cancel|no port selected/i.test(msg)) {
        this.error = msg;
        this.errorAt = "connect";
      }
      return;
    }
    debugLog(`install connect: opened ${this.t.label}`);
    this.wire = new Wire(this.t);
    this.linked = true;
    this.label = this.t.label || (how === "bridge" ? "Bridge" : "Cable");
  }

  async disconnect() {
    if (this.running) return;
    // BACKUP-2.1: the next radio connected may be another one: its own backup first. A cut Back to stock is
    // started again (its ranges are checked again) rather than finished with stock alone.
    this.forgetBackup();
    this.restoreStockOnly = false;
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
  private async enterBootloader(ask = true, waitMs = BOOT_WAIT_MS): Promise<BootPort> {
    const t = this.t!;
    await bootRate(t);
    if (ask) await this.askRestart(t);
    const port = new BootPort(t);
    const probe = bootProbe();
    const t0 = performance.now();
    let nudged = false;
    let asked = 1;
    port.clear();
    while (performance.now() - t0 < waitMs) {
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

  /** Ferrite's REBOOT (LINK-24) and the reader's `reboot` (bootflash.ts); stock ignores both. */
  private async askRestart(t: Transport) {
    await askRestart(t);
  }

  /** `ask`: restart the radio first (false: it is restarting by itself, as after the restore's FINISH). `waitMs`: how
   *  long the bootloader may take to answer; `sent`: the blocks it has accepted so far. */
  private async flash(
    update: InstanceType<typeof FirmwareUpdate>,
    what: string,
    ask = true,
    o: { waitMs?: number; sent?: (blocks: number) => void } = {},
  ) {
    this.message = `Restarting the radio into its bootloader for ${what}…`;
    let port: BootPort;
    try {
      port = await this.enterBootloader(ask, o.waitMs);
    } catch (e) {
      update.free();
      throw e;
    }
    try {
      await sendAll(
        port,
        update,
        (done, total, msg) => {
          o.sent?.(done);
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
      // The radio's screen says "Backing up your radio" (BACKUP-9.4; an older hwtest reader doesn't know `reader`:
      // its diagnostics pages stay, nothing else changes).
      w.clear();
      await w.write("reader\r");
      await w.waitFor(/reader screen on/, 1500, this.held);
      w.clear();
      await w.write("sys\r");
      const sys = await w.waitFor(/[^\r\n]* uid [0-9A-F]{24}[^\r\n]*/, 4000, this.held);
      this.uid = (sys && readerLine<{ uid: string }>("sys", sys[0])?.uid) || "";
      debugLog(`backup: reader ${sys ? radioSaid(sys[0]) : `said no sys line; heard ${radioSaid(w.text)}`}`);
      w.clear();
      await w.write("flash\r");
      const fl = await w.waitFor(/flash id [0-9A-F]{6} \([^)]*\)[^\r\n]*/, 5000, this.held);
      const chip = fl && readerLine<{ id: string; vendor: string; size: number }>("flash", fl[0]);
      if (!chip) {
        debugLog(`backup: no flash line; heard ${radioSaid(w.text)}`);
        throw new Error("The reader didn't report the radio's SPI flash.");
      }
      this.chip = `${chip.vendor} ${chip.id}, ${chip.size / 1024} KB`;
      // BACKUP-12.1: stock's marker sector (0x080F0000), before any Ferrite image that reaches it is flashed. A reader
      // without `mdump` (an older one) answers `?`: assumed blank, and said.
      w.clear();
      await w.write(MDUMP_MARKER);
      // To its `dump: end`: on some hosts that comes in a later read, and it then ended the icon read below at once
      // (two Windows logs and a Linux one, Nov 17, 2026).
      const md = await w.waitFor(/80F0000:[0-9A-F]{32}\*[0-9A-F]{2}(?=[\s\S]*?dump: end)|\?  \(help\)|mdump: [^\r\n]*/, 3000, this.held);
      this.marker = md ? parseMdump(md[0]) : null;
      if (!md) debugLog(`backup: no answer to the marker's mdump; heard ${radioSaid(w.text)}`);
      this.markerRead = !!this.marker;
      // BACKUP-12.3: stock's menu icons (MCU 0x08080000, 161 KB), which every Ferrite image writes over: read only,
      // about 35 s. Taken whole through the sink (the text keeps 8 KB).
      this.message = "Reading stock's menu icons (about 35 s)…";
      this.icons = await this.readIcons(w);
      this.iconsStock = !!this.icons && iconsPlausible(this.icons);
      debugLog(`backup: menu icons ${this.icons ? `read, ${this.iconsStock ? "stock's tiles" : "not stock's (Ferrite's code or blank)"}` : "not read"}`);
      let data = await this.readChip(chip.size);
      this.message = "Checking: the radio's own CRC of the whole chip (about a minute)…";
      w.clear();
      await w.write("flashcrc\r");
      const crc = await w.waitFor(/flash crc32 [0-9A-F]{8} over \d+ KB/, 240_000, this.held);
      const radioCrc = crc && readerLine<{ crc: number; size: number }>("flashcrc", crc[0]);
      if (!radioCrc) throw new Error("The radio didn't answer flashcrc. Start the backup again.");
      let c = backupCheck(data);
      const theirs = radioCrc.crc.toString(16).toUpperCase().padStart(8, "0");
      const same = () => radioCrc.crc === parseInt(c.crc32, 16) && radioCrc.size === data.length;
      debugLog(`backup: chip ${this.chip}; read ${data.length} B, CRC ${c.crc32}; the radio's ${theirs} over ${radioCrc.size} B`);
      if (!same()) {
        // A read that doesn't match the chip (an Intel Mac's report, Nov 16, 2026): once more at 115200, the slowest
        // and safest rate, before giving up. The radio's CRC stays as it was (the chip doesn't change under the reader).
        this.message = "The copy didn't match the radio's: reading the chip again, more slowly…";
        data = await this.readChip(chip.size, true);
        c = backupCheck(data);
        debugLog(`backup: read again at 115200: ${data.length} B, CRC ${c.crc32}`);
      }
      if (!same())
        throw new Error(
          `The radio says CRC ${theirs} over ${radioCrc.size / 1024} KB; the read is ${c.crc32} over ${data.length / 1024} KB, read twice. Start the backup again.`,
        );
      this.backup = data;
      this.check = c;
      this.backupName = backupName(this.uid, stamp(), this.marker).replace(/\.bin$/, ".fbin");
      this.backupFile = await fbin(data, c.crc32, c.sha256, this.uid, this.chip, this.marker, this.iconsStock ? this.icons : null);
      ids.put(c.sha256, this.uid);
      if (this.marker) markers.put(c.sha256, this.marker);
      if (this.icons && this.iconsStock) await iconStore.put(c.sha256, this.icons);
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
    debugLog(`backup: no reader prompt; heard ${radioSaid(w.text)}`);
    throw new Error("The reader didn't start. Turn the radio off and on, then start the backup again.");
  }

  /** BACKUP-12.3: the menu icons this backup read, as a file of their own (for Back to stock on another computer, or
   *  for another radio whose icons an earlier Ferrite install wrote over). The name it went as, or null. */
  async saveIcons(): Promise<string | null> {
    if (!this.icons || !this.iconsStock) return null;
    const uid = (this.uid || "radio").replace(/\s+/g, "");
    return saveAs(`rt950pro-menu-icons-${uid}.bin`, new Blob([this.icons as BlobPart], { type: "application/octet-stream" }));
  }

  /** BACKUP-12.3: the reader's `mdump` of the icon area, checked line by line; null when it doesn't come whole (an
   *  older reader, a lost line: the backup goes on without them). */
  private async readIcons(w: Wire): Promise<Uint8Array | null> {
    let text = "";
    let done = false;
    let started = false; // a `dump: end` before the first icon line is someone else's
    w.sink = (b) => {
      text += latin1(b);
      const tail = text.slice(-200);
      started ||= text.includes("8080000:");
      done ||= (started && /dump: end/.test(tail)) || /mdump: [^\r\n]*only|\?  \(help\)/.test(tail);
    };
    try {
      await w.write(MDUMP_ICONS);
      const end = performance.now() + 90_000;
      while (!done && performance.now() < end) {
        this.held();
        await sleep(200);
      }
    } finally {
      w.sink = null;
      w.clear();
    }
    const icons = done ? parseMdumpIcons(text) : null;
    if (!icons) debugLog(`backup: icons reply ${done ? "ended" : "never ended"}, ${text.length} chars: first ${JSON.stringify(text.slice(0, 120))}, last ${radioSaid(text, 200)}`);
    return icons;
  }

  /** The whole chip: the Rust reader's fdumpz at 230400 with High speed on, else 115200 (BACKUP-9.6, ferrite decision 265) when the reader image
   * has it, else (hwtest's reader, or a reader that answers `?`) fdump from the fastest rate down (flashdump.py's
   * read_range). */
  private async readChip(size: number, slow = false): Promise<Uint8Array> {
    let last: Error | null = null;
    const fast = !!this.t!.setBaud && cablePrefs.highSpeed && !slow; // decision 408: 230400 only with High speed on
    debugLog(`backup: reading ${size} B, ${fast ? "fast" : "at 115200"}`);
    if (this.readerFile && readerHasFdumpz(this.readerFile.bytes)) {
      const rate = fast ? FDUMPZ_BAUD : READER_RATES[READER_RATES.length - 1];
      for (let tries = 0; tries < 2; tries++) {
        try {
          return await this.fdump(size, rate, true);
        } catch (e) {
          if (e instanceof Abort) throw e;
          last = e as Error;
          if (e instanceof NoFdumpz) break;
          if (/no answer to fdump|outside/.test(last.message)) throw this.readFailed(last);
          await this.wire!.write("\r");
          await sleep(500);
        }
      }
      if (!(last instanceof NoFdumpz)) throw this.readFailed(last);
    }
    for (const rate of fast ? READER_RATES : [READER_RATES[READER_RATES.length - 1]]) {
      try {
        return await this.fdump(size, rate, false);
      } catch (e) {
        if (e instanceof Abort) throw e;
        last = e as Error;
        if (/no answer to fdump|outside/.test(last.message)) break;
        await this.wire!.write("\r");
        await sleep(500);
      }
    }
    throw this.readFailed(last);
  }

  private readFailed(last: Error | null) {
    return new Error(`Reading the flash failed: ${last?.message ?? "?"}. Start the backup again.`);
  }

  /** One fdump, or fdumpz (`z`: coded 16 KB chunks, DEFLATE ones inflated by the browser). A frame short of
   * bytes is asked again once its own time is up (fdump_proto.py's quick re-ask), not after the radio's 2 s. */
  private async fdump(len: number, rate: number, z: boolean): Promise<Uint8Array> {
    const t = this.t!;
    const w = this.wire!;
    const fd = z ? Fdump.z(0, len) : new Fdump(0, len);
    const queue: FdStep[] = [];
    let started = false;
    this.done = 0;
    this.total = len;
    this.message = `Reading the flash at ${rate / 1000} kbaud…`;
    try {
      w.clear();
      await w.write(fd.command(rate));
      const ready = await w.waitFor(
        /fdump(?:: [^\r\n]*|[ ][0-9A-F]{6} [0-9A-F]+ \d+ ready[^\r\n]*)|\?  \(help\)|fdumpz: \?/,
        5000,
        this.held,
      );
      if (!ready) {
        debugLog(`backup: ${z ? "fdumpz" : "fdump"} at ${rate}: no answer; heard ${radioSaid(w.text)}`);
        throw new Error("no answer to fdump");
      }
      if (ready[0].startsWith("fdump: ")) throw new Error(ready[0]);
      if (!ready[0].startsWith("fdump ")) throw new NoFdumpz("the reader has no fdumpz");
      started = true;
      if (t.setBaud) await t.setBaud(rate);
      await sleep(50);
      let heard = performance.now();
      w.sink = (b) => {
        heard = performance.now();
        const st = JSON.parse(fd.feed(b)) as FdStep;
        if (st.send.length || st.nak || st.inflate || st.done || st.error) queue.push(st);
      };
      const syncEnd = performance.now() + 3000;
      while (!fd.synced()) {
        this.held();
        if (performance.now() > syncEnd) throw new Error(`no sync at ${rate} baud`);
        await w.write("FDS1");
        await w.idle(100);
      }
      let last = performance.now();
      let begun = 0; // when the frame now coming in began (0: none)
      for (;;) {
        this.held();
        let st = queue.shift();
        if (!st) {
          const now = performance.now();
          const budget = fd.frame_budget_ms(rate);
          if (!budget) begun = 0;
          else if (!begun) begun = now;
          const late = budget > 0 && now - begun > budget;
          if (!late && now - Math.max(last, heard) < 3500) {
            await w.idle(budget ? 50 : 100);
            continue;
          }
          st = JSON.parse(fd.timeout()) as FdStep;
        }
        begun = 0;
        last = performance.now();
        if (st.inflate) st = JSON.parse(fd.inflated(await inflateRaw(fd.take_inflate()))) as FdStep;
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
      if (started) await t.write(new Uint8Array([CAN, CAN, CAN, CAN])).catch(() => {});
      throw e;
    } finally {
      w.sink = null;
      fd.free();
      if (started) {
        await sleep(50);
        if (t.setBaud) await t.setBaud(P.timing.cable_baud).catch(() => {});
        await sleep(50);
        await w.waitFor(/fdump (end|stopped)[^\r\n]*/, 3000, () => {});
      }
    }
  }

  /** BACKUP-2: the desktop app's save dialog (the file read back), Chrome's save dialog (read back too), or the
   * browser's download the owner confirms. Once: a download already started isn't started again by this. */
  async save() {
    if (!this.backup || !this.backupFile || this.saving) return;
    this.saveError = "";
    if (isTauri()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const path = await invoke<string | null>("save_file", this.backupFile, { headers: { "x-name": this.backupName } });
        if (path) {
          this.savedWhere = path;
          this.saved = true;
        }
      } catch (e) {
        this.saveError = String((e as Error)?.message ?? e);
      }
      return;
    }
    const blob = new Blob([this.backupFile as BlobPart], { type: "application/zip" });
    const pick = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (pick) {
      this.saving = true;
      try {
        const h = await pick({ suggestedName: this.backupName, types: [{ description: "Radio backup", accept: { "application/zip": [".fbin"] } }] });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        const back = new Uint8Array(await (await h.getFile()).arrayBuffer());
        if (back.length === this.backupFile.length && sha256Hex(back) === sha256Hex(this.backupFile)) {
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
    if (this.backupFile) this.download(new Blob([this.backupFile as BlobPart], { type: "application/zip" }));
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
    await loadCore();
    // The .fbin as saved, or (opened) one whose spi.bin is this backup.
    const spi = isZip(b) ? await openFbin(b).then((f) => f.spi).catch(() => null) : b;
    if (this.backup && spi && spi.length === this.backup.length && sha256Hex(spi) === this.check?.sha256) {
      this.saved = true;
      this.savedWhere = f.name;
      this.saveError = "";
    } else this.saveError = `${f.name} isn't this backup.`;
  }

  // ---- 4. Install ----

  /** Why Install can't run yet, or "". */
  get installBlock(): string {
    if (!this.unlocked) return "Take the backup and save it first.";
    if (!uidKey(this.uid)) return installIdProblem(this.uid, null); // BACKUP-2.1
    if (this.check?.pending_update)
      return "A stock phone or Bluetooth update is waiting in this radio (0xA55A at 0x300000): the bootloader would flash it over Ferrite. Let stock finish or clear that update, then take a new backup.";
    if (!this.ferrite || !this.ferriteCheck) return "No Ferrite image: pick one under Advanced.";
    if (this.ferriteCheck.problems.length) return this.ferriteCheck.problems.join(" ");
    if (!this.connected) return "Connect the radio.";
    return "";
  }

  /** BACKUP-2.1: the backup as if never taken (another radio, or the cable let go): the next install needs its own. */
  private forgetBackup() {
    this.backupStep = "idle";
    this.saved = false;
    this.savedWhere = "";
    this.downloaded = false;
    this.saveError = "";
    this.check = null;
    this.backup = null;
    this.backupFile = null;
    this.backupName = "";
    this.uid = "";
    this.chip = "";
    this.marker = null;
    this.markerRead = false;
    this.icons = null;
    this.iconsStock = false;
    if (this.errorAt === "backup") {
      this.error = "";
      this.errorAt = "";
    }
  }

  /** BACKUP-2.1: the connected radio's ID as the reader (still running from the backup step) answers `sys`, or null
   *  when nothing answers as the reader (stock, nicFW, Ferrite, a radio that is off). */
  private async radioUid(): Promise<string | null> {
    const w = this.wire;
    if (!w) return null;
    for (let tries = 0; tries < 2; tries++) {
      w.clear();
      await w.write("\r");
      await w.idle(300);
      w.clear();
      await w.write("sys\r");
      const sys = await w.waitFor(/[^\r\n]* uid [0-9A-F]{24}[^\r\n]*/, 3000, this.held);
      const uid = sys && readerLine<{ uid: string }>("sys", sys[0])?.uid;
      if (uid) return uid;
    }
    debugLog(`install: no reader sys line; heard ${radioSaid(w.text)}`);
    return null;
  }

  async install() {
    if (this.running || this.installBlock) return;
    this.installStep = "running";
    this.error = "";
    this.errorAt = "";
    try {
      // BACKUP-2.1 (decision 263's check, as Back to stock makes it): Ferrite goes only into the radio the backup is
      // from, by its MCU ID, read again now (radios swapped on the cable since the backup: the second one would get
      // Ferrite with no backup).
      this.message = "Checking that this is the radio you backed up…";
      const here = await this.radioUid();
      const why = installIdProblem(this.uid, here);
      debugLog(`install: backup's radio ${this.uid || "unknown"}, this radio ${here ?? "didn't say"}`);
      if (why) {
        if (otherRadio(this.uid, here)) {
          this.forgetBackup();
          this.installStep = "idle";
          this.fail("backup", new Error(why));
          return;
        }
        throw new Error(why);
      }
      const update = FirmwareUpdate.ferrite(this.ferrite!.bytes, this.patch ?? undefined);
      await this.flash(update, "Ferrite");
      this.message = "Sent. Ferrite starts, sets up its storage and opens its first-run setup…";
      this.installed = (await this.hello(FIRST_BOOT_MS)) ?? "";
      if (this.ffw && !this.ffw.is_empty()) await this.parts(this.ffw);
      this.installStep = "done";
      this.resetRestore();
      this.message = "";
      // Done updating: the same cable becomes Console's usual connection (Live view, channels), not held here.
      const t = this.t;
      this.linked = false;
      this.t = null;
      this.wire = null;
      if (t) await radio.handBack(t).catch(() => {});
    } catch (e) {
      this.fail("install", e);
    }
  }

  /** UPD-21: the .ffw's SPI parts over the cable once Ferrite runs (the text pack, the logo, the terminal's pages);
   *  then the radio restarts with them. Without them Ferrite runs with its fallbacks. */
  private async parts(f: FfwFile) {
    const t = this.t!;
    this.message = "Writing Ferrite's SPI parts (text, logo, terminal pages)…";
    const link = new Link(t);
    try {
      await link.open();
      await link.hello();
      await writeParts(t, link, f, (m) => (this.message = m), () => this.held());
    } catch (e) {
      throw new Error(`Ferrite is installed, but its SPI parts didn't go in (${(e as Error).message}). It runs with short messages until they do: install the same file again from Update.`);
    } finally {
      link.close();
      this.wire?.attach();
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
    this.restoreStockOnly = false;
    this.restoreConfirmUid = null;
    this.restoreTyped = "";
  }

  /** The radio runs stock again: the install card starts over (the backup stays: it is still this radio's). */
  private backOnStock() {
    this.restoreWrote = false;
    this.restoreStockOnly = false;
    this.restoreStep = "done";
    this.restoreConfirmUid = null;
    this.restoreTyped = "";
    this.installStep = "idle";
    this.installed = "";
    this.message = "";
  }

  get restoreBlock(): string {
    const b = this.restoreBackupCheck;
    if (this.restoreFileError) return this.restoreFileError;
    if (!this.restoreBackup || !b) return "Drop in your backup.";
    const bad = b.problems.filter((p) => !p.startsWith("a stock phone"));
    if (bad.length) return bad.join(" ");
    if (!this.stock || !this.stockCheck) return "Drop in your stock .BTF.";
    if (this.stockCheck.problems.length) return this.stockCheck.problems.join(" ");
    if (!this.connected) return "Connect the radio.";
    return "";
  }

  /** BACKUP-7, BACKUP-8: the backup into Ferrite's ranges over the link, then the stock .BTF. */
  /** BACKUP-13: the restorer's `START` answer, asked until `ms` runs out (it answers once it has started); null if
   *  nothing answers. Plain frames: the link never says HELLO to it. */
  private async restorerStart(link: Link, ms: number): Promise<{ status: number; rest: Uint8Array } | null> {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      this.held();
      try {
        const a = await link.ask(STOCK_RESTORE, new Uint8Array([OP_START]), 1500);
        if (a.status === 0) return a;
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
      }
    }
    return null;
  }

  /**
   * BACKUP-7, BACKUP-8: Back to stock. `viaRestorer` (BACKUP-13): the radio isn't running Ferrite (stock, nicFW, a
   * Ferrite that won't start): the restorer image goes on through the bootloader first (unless it is already
   * running), and the same restore follows from its `START`.
   */
  async restore(viaRestorer = false) {
    if (this.running || this.restoreBlock) return;
    if (viaRestorer && !this.restorerFile) {
      this.fail("restore", new Error(`This copy of Console has no restorer image${this.restorerProblem ? ` (${this.restorerProblem})` : ""}.`));
      return;
    }
    this.restoreStep = "running";
    this.restoreWrote = false;
    this.restoreStockOnly = false;
    const prog = restoreProgress();
    this.error = "";
    this.errorAt = "";
    const t = this.t!;
    let link = new Link(t);
    let plan: InstanceType<typeof RestorePlan> | null = null;
    try {
      let started: { status: number; rest: Uint8Array } | null = null;
      if (viaRestorer) {
        this.message = "Is the restorer running already?";
        await link.open();
        started = await this.restorerStart(link, 2500);
        if (!started) {
          link.close();
          this.wire!.attach();
          await this.flash(FirmwareUpdate.restorer(this.restorerFile!.bytes), "the restorer");
          this.message = "Waiting for the restorer to start…";
          link = new Link(t);
          await link.open();
          started = await this.restorerStart(link, 15_000);
          if (!started) throw new Error("The restorer didn't answer. Turn the radio off and on, then start Back to stock again.");
        }
      }
      if (!started) {
      this.message = "Asking the radio (it must run Ferrite)…";
      await link.open();
      // Plain frames: the radio's restore loop reads no compressed ones (it stopped after one block, Nov 16, 2026).
      await link.helloPlain().catch(() => {
        throw new NotFerrite("The radio doesn't answer as Ferrite: check the cable and that it is on. If it runs stock, nicFW, or a Ferrite that won't start, use “Start from the bootloader”.");
      });
      // Decision 263, before anything stops: the backup must be this radio's by its MCU ID (INFO's; calibration can
      // be the same on two radios). The START answer's ID is checked again by the plan.
      const here = (await link.info().catch(() => null))?.uid_text ?? null;
      if (here) {
        const pre = restoreIdCheck(here, this.restoreBackupUid, this.restoreTyped);
        this.restoreConfirmUid = pre.confirm_uid;
        if (pre.problems.length) throw new Error(`${pre.problems.join(" ")} Nothing was written.`);
      }
      started = await link.ask(STOCK_RESTORE, new Uint8Array([OP_START]), 10_000);
      }
      const { status, rest } = started;
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
      for (let i = 0; i < plan.len(); i++) if (plan.expect(i) >= 0) prog.ranges++;
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
          prog.verified++;
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
      prog.finished = true;
      link.close();
      this.wire!.attach();
      // BACKUP-8.1: only the bootloader's own window right after FINISH. Missed, the radio starts Ferrite (or the
      // restorer) again, and Ferrite may set up its storage over the restored data: never stock over that.
      try {
        await this.flash(
          FirmwareUpdate.stock(this.stock!.bytes, this.restoreMarker ?? undefined, this.restoreIcons ?? undefined),
          "stock firmware",
          false,
          { waitMs: FINISH_BOOT_MS, sent: (n) => (prog.stockBlocks = Math.max(prog.stockBlocks, n)) },
        );
      } catch (e) {
        if (prog.stockBlocks > 0) throw e;
        debugLog(`restore: stock didn't start going in after FINISH (${(e as Error)?.message ?? e})`);
        throw new Error(
          "The radio didn't restart into its bootloader in time, so it may have started Ferrite again, which sets up its storage over the restored data. Your backup is safe: start Back to stock again (it writes and checks everything again).",
        );
      }
      this.backOnStock();
    } catch (e) {
      link.close();
      this.wire?.attach();
      this.restoreStockOnly = stockOnlyAllowed(prog);
      this.fail("restore", e);
    } finally {
      plan?.free();
    }
  }

  /** After a cut restore: the radio waits in the bootloader (side keys held at power-on); only the stock file goes.
   *  BACKUP-8.1: only when every range was written and read back and stock had started going in. */
  async flashStockOnly() {
    if (this.running || !this.restoreStockOnly || !this.stock || this.stockCheck?.problems.length || !this.connected) return;
    this.restoreStep = "running";
    this.error = "";
    this.errorAt = "";
    try {
      await this.flash(FirmwareUpdate.stock(this.stock.bytes, this.restoreMarker ?? undefined, this.restoreIcons ?? undefined), "stock firmware");
      this.backOnStock();
    } catch (e) {
      this.fail("restore", e);
    }
  }

  private fail(which: "backup" | "install" | "restore", e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (which === "restore") this.restoreNoFerrite = e instanceof NotFerrite;
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
