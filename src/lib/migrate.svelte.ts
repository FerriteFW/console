// Finish the update (LINK-59 – LINK-62, UPD-16, decision 333): a radio whose firmware stores another layout than
// its chip's data (HELLO and INFO end with the two, e.g. 3 and 2; the radio shows D25 "Finish the update") gets its
// data moved by Console, in LINK-62's order, so an interruption at any point loses nothing:
//   1. the layouts say what to do;
//   2. the old layout's regions read raw (DATA_READ, a blank sector told by its CRC; each region checked by CRC),
//      kept in Console's own data (IndexedDB) and offered as a file, before anything is written;
//   3. translated on the PC (the Rust core: core/src/migrate.rs);
//   4. written region by region (DATA_WRITE: erase, program, read back by CRC), the sector that holds the old header
//      last; before the first write the radio puts down a migration mark and the new header itself (decision 339),
//      so a restart at any point waits for Console (HELLO says the chip is 255, half moved), never formats;
//   5. the header stamped (the radio takes it once everything before it is written, `busy` until then, and only
//      clears the mark): the radio restarts on the new layout, and Console connects again and checks it says so.
// Started again after an interruption, it begins at 3 from the kept copy (never reading the half-written chip).
// Firmware Update runs it as part of an update whose new firmware stores another layout (firmware.svelte.ts).
import { debugLog } from "./debuglog";
import { saveBlob } from "./codeplug.svelte";
import { erasedCrc, dataCrc32, loadCore, MigrateCopy, MigratePlan, migrateRegions, P, type MigrateSummary } from "./core";
import { Eta } from "./eta";
import { Link, TimeoutError } from "./link";
import { radio } from "./radio.svelte";
import { isTauri } from "./transport/native";
import { sleep, type Transport } from "./transport/types";

export type MigrateStage = "idle" | "reading" | "writing" | "restarting" | "done" | "failed";

/** What Console keeps of a radio's old data (IndexedDB "ferrite-console-migrate", by the radio's ID). */
type Kept = {
  /** The radio's ID as About shows it ("" when it gave none). */
  uid: string;
  /** The chip's layout the copy is of, and the firmware's it goes to. */
  from: number;
  to: number;
  /** `MigrateCopy.to_file()`'s bytes. */
  file: Uint8Array;
  saved: string;
  /** "copied": read, nothing written yet; "writing": writes began (the chip is half written: use only the copy);
   *  "done": stamped and the radio came back on the new layout (kept as the backup). */
  state: "copied" | "writing" | "done";
};

/** LINK-62 (decision 339): the chip's layout while its data is half moved (a raw write this power-on, or a move cut
 *  before its stamp): only a copy of the old data can finish it. */
export const LAYOUT_MOVING = 255;

/** After the stamp: the radio restarts and mounts the new layout; Console asks for HELLO until this runs out. */
const RESTART_WAIT_MS = 40_000;

class Migrate {
  stage = $state<MigrateStage>("idle");
  #message = $state("");
  #error = $state("");
  /** What it's doing now; each change goes to the debug log (debuglog.ts), so a report has the steps. */
  get message() {
    return this.#message;
  }
  set message(v: string) {
    if (v && v !== this.#message) debugLog(`data move: ${v}`);
    this.#message = v;
  }
  /** What went wrong; to the debug log too. */
  get error() {
    return this.#error;
  }
  set error(v: string) {
    if (v && v !== this.#error) debugLog(`data move ERROR: ${v}`);
    this.#error = v;
  }
  /** Progress of the step running: bytes read, or steps written. */
  done = $state(0);
  total = $state(0);
  /** Seconds left, or null. */
  left = $state<number | null>(null);
  /** The translation's notes and counts, once made. */
  summary = $state<MigrateSummary | null>(null);
  /** The backup file as saved ("" when only Console's own copy was kept). */
  savedAs = $state("");
  /** Console holds a copy of this radio's old data from an earlier try (its date), so a new try starts from it. */
  keptFrom = $state("");
  /** Save the backup to a file too (Console keeps its own copy either way). */
  saveFile = $state(true);
  /** A copy chosen from a file (Use a saved backup…): a try starts from it instead of reading the radio. */
  picked = $state<{ name: string; bytes: Uint8Array } | null>(null);

  private eta = new Eta();

  get running() {
    return this.stage === "reading" || this.stage === "writing" || this.stage === "restarting";
  }

  get pct() {
    return this.total ? Math.floor((this.done * 100) / this.total) : 0;
  }

  /** The connected radio waits for its data to be moved (the layouts differ: 2, or 255 while half moved), or a try of
   *  ours was cut with writes made this session. */
  get needed(): boolean {
    const l = radio.hello?.layouts;
    if (!l) return false;
    return l.firmware !== l.chip || this.cutOff;
  }

  /** A try was cut after writes began, this power-on (the radio says the layouts are the same until it restarts). */
  cutOff = $state(false);

  /** Console's kept copy for the connected radio, from a try cut after writing: its date for the card ("" when none).
   *  A radio whose layouts agree got as far as the stamp (decision 339: until it, the radio says 255, half moved), so
   *  that try is done and the copy is only the backup. */
  async lookKept() {
    const uid = radio.info?.uid_text ?? "";
    const k = await kept.get(uid).catch(() => undefined);
    const l = radio.hello?.layouts;
    let writing = k?.state === "writing";
    if (writing && l && l.firmware === l.chip) {
      await kept.state(uid, "done").catch(() => {});
      writing = false;
    }
    this.keptFrom = writing ? k!.saved : "";
    this.cutOff = false;
  }

  /** A backup file chosen to start from (another computer's, or Console's own data cleared). */
  async pick(file: File) {
    await loadCore();
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      MigrateCopy.from_file(bytes).free();
      this.picked = { name: file.name, bytes };
      this.error = "";
    } catch (e) {
      this.picked = null;
      this.error = `${file.name}: ${(e as Error).message}`;
    }
  }

  /** From the banner: Console takes the connected cable, moves the data, then connects again. */
  async start() {
    if (this.running) return;
    if (radio.kind !== "cable") {
      this.error = "Finishing the update needs the cable (the radio takes raw writes only from it): disconnect, then connect with the cable.";
      this.stage = "failed";
      return;
    }
    const got = radio.takeForUpdate();
    if (!got) {
      this.error = "Connect the radio over the cable first.";
      this.stage = "failed";
      return;
    }
    try {
      await this.run(got.t, got.link);
    } finally {
      await radio.handBack(got.t);
      if (this.stage === "done" && radio.phase === "connected" && radio.hello?.layouts && radio.hello.layouts.firmware !== radio.hello.layouts.chip) {
        this.fail(new Error("The radio came back still waiting for the update. Try again."));
      }
    }
  }

  /**
   * The whole move over `link` (the cable, connected as usual: HELLO answered with the layouts, the faster rate), the
   * transport `t` taken from the connection (`start`). Returns when the radio answers on the new layout, or
   * after a failure (`stage` "failed", `error` why). The caller hands the cable back to the connection.
   */
  async run(t: Transport, link: Link): Promise<void> {
    await loadCore();
    this.error = "";
    this.summary = null;
    this.savedAs = "";
    this.done = this.total = 0;
    this.left = null;
    let copy: InstanceType<typeof MigrateCopy> | null = null;
    let plan: InstanceType<typeof MigratePlan> | null = null;
    let wrote = false;
    try {
      const l = link.layouts;
      const info = await link.info();
      const uid = info.uid_text ?? "";
      const k = await kept.get(uid).catch(() => undefined);
      const pending = !!l && l.firmware !== l.chip;
      // A try of ours cut after writing (the radio says 255, half moved, until the stamp): only the copy counts.
      const resume = k && k.state === "writing" && (!uid || k.uid === uid) ? k : undefined;
      if (!pending && !resume && !this.picked) throw new Error("The radio's data is already in its firmware's layout: nothing to finish.");
      const fromFile = () => {
        const c = MigrateCopy.from_file(this.picked!.bytes);
        const v = c.layout();
        c.free();
        return v;
      };
      if (l?.chip === LAYOUT_MOVING && !resume && !this.picked) {
        throw new Error(
          "The radio's data was cut part way through a move, and this computer holds no copy of it. Choose Use a saved backup… (the file saved when the update began, or from the computer that started it) to finish it.",
        );
      }
      const from = resume ? resume.from : this.picked ? fromFile() : l!.chip;
      const to = l?.firmware ?? 3;
      if (!migrateRegions(from)) throw new Error(`Console doesn't know layout ${from}: update Ferrite Console.`);

      if (this.picked) {
        copy = MigrateCopy.from_file(this.picked.bytes);
        this.message = `Starting from ${this.picked.name}.`;
        await kept.put({ uid, from: copy.layout(), to, file: copy.to_file(), saved: new Date().toISOString(), state: "copied" }).catch(() => {});
      } else if (resume) {
        // Step 3 again from Console's copy: a try cut after writing (the chip is half written: never read again).
        if (!pending) {
          await kept.state(uid, "done").catch(() => {});
          throw new Error("That update got as far as the stamp: the radio's data is in its new layout already.");
        }
        copy = MigrateCopy.from_file(resume.file);
        this.message = `Starting from Console's copy of ${new Date(resume.saved).toLocaleString()}.`;
      } else {
        copy = await this.read(link, from, info.uid ?? null);
        const file = copy.to_file();
        await kept.put({ uid, from, to, file, saved: new Date().toISOString(), state: "copied" });
        if (this.saveFile) {
          const who = (info.callsign || uid.replace(/\s/g, "").slice(0, 10) || "radio").replace(/[^A-Za-z0-9-]/g, "");
          const name = `ferrite-${who}-layout${from}-backup-${stamp()}.bin`;
          try {
            const as = await saveBlob(name, new Blob([file as BlobPart], { type: "application/octet-stream" }));
            this.savedAs = as ? `${as}${isTauri() ? "" : " (your downloads)"}` : "";
          } catch {
            this.savedAs = ""; // Console's own copy is kept regardless
          }
        }
      }

      // 3. Translate.
      plan = new MigratePlan(copy);
      this.summary = JSON.parse(plan.summary());

      // 4. Write, region by region; 5. stamp.
      this.stage = "writing";
      const n = plan.len();
      this.total = n;
      this.done = 0;
      await kept.state(uid, "writing").catch(() => {});
      for (let i = 0; i < n; i++) {
        this.held(t);
        this.done = i;
        this.left = this.eta.left(i, n);
        const kind = plan.kind(i);
        this.message = kind === "stamp" ? "Stamping the new layout: the radio restarts…" : `Writing ${plan.region(i)}`;
        if (kind === "stamp") {
          // Taken once the radio has written everything before it (`busy` until then, asked again); the restart
          // waits for it to be written. Its answer may not get out before the restart; HELLO afterwards says.
          try {
            await link.data(P.msg.DATA_WRITE, plan.payload(i), 3000);
          } catch (e) {
            if (!(e instanceof TimeoutError)) throw e;
          }
          break;
        }
        const rest = await link.data(plan.msg(i), plan.payload(i));
        wrote = true;
        this.cutOff = true;
        const want = plan.expect(i);
        if (want >= 0) {
          const got = new DataView(rest.buffer, rest.byteOffset).getUint32(0, true);
          if (got !== want >>> 0) throw new Error(`${plan.region(i)} read back differently. Nothing is lost (Console has the backup): try again.`);
        }
      }
      this.done = n;
      link.close();

      // The radio restarts on the new layout: HELLO until it answers saying so.
      this.stage = "restarting";
      this.message = "The radio restarts on the new layout; connecting again…";
      await this.backOnline(t, to);
      await kept.state(uid, "done").catch(() => {});
      this.cutOff = false;
      this.keptFrom = "";
      this.picked = null;
      this.stage = "done";
      this.message = "";
    } catch (e) {
      link.close();
      this.fail(e, wrote);
    } finally {
      copy?.free();
      plan?.free();
    }
  }

  /** Step 2: the old layout's regions, a blank sector told by its CRC, each region checked by CRC at the end. */
  private async read(link: Link, layout: number, uid: number[] | null): Promise<InstanceType<typeof MigrateCopy>> {
    const regions = migrateRegions(layout)!;
    const S = P.data.SECTOR;
    const blank = erasedCrc(S);
    this.stage = "reading";
    this.total = regions.reduce((n, [, len]) => n + len, 0);
    this.done = 0;
    const copy = new MigrateCopy(layout, uid ? new Uint8Array(uid) : undefined);
    try {
      for (const [start, len] of regions) {
        const buf = new Uint8Array(len).fill(0xff);
        for (let s = 0; s < len; s += S) {
          this.held(link.t);
          this.message = `Backing up the old layout: ${Math.floor((this.done * 100) / this.total)}%`;
          if ((await link.dataCrc(start + s, S)) !== blank) {
            for (let o = 0; o < S; o += P.data.READ_MAX) {
              const k = Math.min(P.data.READ_MAX, S - o);
              buf.set(await link.dataRead(start + s + o, k), s + o);
            }
          }
          this.done += S;
          this.left = this.eta.left(this.done, this.total);
        }
        if ((await link.dataCrc(start, len)) !== dataCrc32(buf) >>> 0) {
          throw new Error("The backup didn't read back the same (the radio's CRC differs). Nothing was written: try again.");
        }
        copy.add(start, buf);
      }
      return copy;
    } catch (e) {
      copy.free();
      throw e;
    }
  }

  /** HELLO until the radio answers on layout `to` (its data in it), at the radio's starting rate. */
  private async backOnline(t: Transport, to: number) {
    await sleep(1000);
    if (t.setBaud) await t.setBaud(P.timing.cable_baud);
    const end = performance.now() + RESTART_WAIT_MS;
    for (;;) {
      this.held(t);
      const probe = new Link(t);
      try {
        await probe.open();
        const h = await probe.hello();
        probe.close();
        if (h.layouts && h.layouts.chip === to) return;
        if (h.layouts?.chip === LAYOUT_MOVING) throw new Error("The radio restarted before its stamp was written (it waits for the update again). Try again: Console has the backup.");
        throw new Error(`The radio restarted still on layout ${h.layouts?.chip ?? "?"}. Try again: Console has the backup.`);
      } catch (e) {
        probe.close();
        if (!(e instanceof TimeoutError)) throw e;
        if (performance.now() > end) throw new Error(`The radio didn't answer in ${RESTART_WAIT_MS / 1000} s after its restart. Check its screen; connect again by hand.`);
      }
    }
  }

  private held(t: Transport) {
    if (!radio.holds(t)) throw new Error("The cable went away (unplugged or disconnected). Nothing is lost: Console has the backup.");
  }

  private fail(e: unknown, wrote = false) {
    this.stage = "failed";
    this.message = "";
    const msg = (e as Error)?.message ?? String(e);
    this.error = wrote && !/Console has the backup/.test(msg) ? `${msg} Nothing is lost: Console has the backup, and Try again starts from it.` : msg;
  }

  /** The card closed after a finished or failed try. */
  reset() {
    if (this.running) return;
    this.stage = "idle";
    this.error = "";
    this.message = "";
    this.summary = null;
  }
}

/** "20261101-1412", local time. */
function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Console's own copies, by radio ID (IndexedDB; a browser without it keeps none, and a file is the only copy). */
const kept = (() => {
  const open = () =>
    new Promise<IDBDatabase>((ok, fail) => {
      if (typeof indexedDB === "undefined") return fail(new Error("no IndexedDB"));
      const r = indexedDB.open("ferrite-console-migrate", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("copies");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((ok, fail) => {
        const q = f(db.transaction("copies", mode).objectStore("copies"));
        q.onsuccess = () => ok(q.result);
        q.onerror = () => fail(q.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (uid: string) => run<Kept | undefined>("readonly", (s) => s.get(uid || "unknown")),
    put: (k: Kept) => run("readwrite", (s) => s.put(k, k.uid || "unknown")),
    async state(uid: string, state: Kept["state"]) {
      const k = await this.get(uid);
      if (k) await this.put({ ...k, state });
    },
  };
})();

export const migrate = new Migrate();
