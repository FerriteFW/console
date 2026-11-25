// src/lib/download.ts (LINK-21.3, console#106): a save says "saved" only when it was written (the browser's save
// dialog, the desktop app), says "saving … check your browser's downloads" when it went to a plain download the browser
// may hold back, and "not saved" when the dialog was cancelled. The dialog opens before the content is made (the
// owner's click lasts only seconds in Chrome), and a cancel makes nothing.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { saveAs, saveDownload, saveLine, type SaveResult } from "../../src/lib/download.ts";

type Win = Record<string, unknown>;
const g = globalThis as unknown as { window?: Win; document?: unknown };
let clicks: string[] = [];

beforeEach(() => {
  clicks = [];
  g.window = {};
  g.document = {
    body: { append() {} },
    createElement: () => {
      const a = { href: "", download: "", click: () => clicks.push(a.download), remove() {} };
      return a;
    },
  };
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  delete g.window;
  delete g.document;
});

/** Chrome's save dialog: picks `name` (or the suggested one), or throws `fail` (AbortError: closed). */
function picker(opts: { name?: string; fail?: string } = {}) {
  const log: string[] = [];
  const written: Blob[] = [];
  const fn = async (o: { suggestedName: string; types?: unknown }) => {
    log.push(`pick ${o.suggestedName}`);
    if (opts.fail) throw Object.assign(new Error(opts.fail), { name: opts.fail });
    return {
      name: opts.name ?? o.suggestedName,
      async createWritable() {
        return {
          async write(b: Blob) {
            written.push(b);
          },
          async close() {
            log.push("closed");
          },
        };
      },
      async remove() {
        log.push("removed");
      },
    };
  };
  g.window!.showSaveFilePicker = fn;
  return { log, written };
}

test("LINK-21.3: Chrome's dialog: saved, under the name picked, the content made after the pick", async () => {
  const p = picker({ name: "mine.ferrite" });
  const r = await saveAs("VE7GPL-settings-20261125-0141.ferrite", async () => {
    p.log.push("made");
    return new Blob(["x"]);
  });
  assert.deepEqual(r, { status: "saved", name: "mine.ferrite" });
  assert.deepEqual(p.log, ["pick VE7GPL-settings-20261125-0141.ferrite", "made", "closed"]);
  assert.equal(p.written.length, 1);
  assert.deepEqual(clicks, []); // no download as well
  assert.equal(saveLine(r, "Backed up", "settings"), "Backed up settings as mine.ferrite.");
});

test("LINK-21.3: a cancelled dialog: not saved, nothing made, no download", async () => {
  const p = picker({ fail: "AbortError" });
  let made = false;
  const r = await saveAs("a.ferrite", async () => {
    made = true;
    return new Blob(["x"]);
  });
  assert.deepEqual(r, { status: "cancelled" });
  assert.equal(made, false);
  assert.deepEqual(clicks, []);
  assert.deepEqual(p.log, ["pick a.ferrite"]);
  assert.equal(saveLine(r, "Backed up", "settings"), "Not saved: cancelled.");
});

test("LINK-21.3: the dialog refused (no gesture left): a download, worded as saving", async () => {
  picker({ fail: "SecurityError" });
  const r = await saveAs("a.ferrite", new Blob(["x"]));
  assert.deepEqual(r, { status: "started", name: "a.ferrite" });
  assert.deepEqual(clicks, ["a.ferrite"]);
});

test("LINK-21.3: no dialog (Firefox, Safari): a download, never claimed as saved", async () => {
  const r = await saveAs("VE7GPL-full-20261125-0139.ferrite", async () => new Blob(["x"]));
  assert.deepEqual(r, { status: "started", name: "VE7GPL-full-20261125-0139.ferrite" });
  assert.deepEqual(clicks, ["VE7GPL-full-20261125-0139.ferrite"]);
  const line = saveLine(r, "Backed up", "channels (2) and zones (1)");
  assert.equal(line, "Saving channels (2) and zones (1) as VE7GPL-full-20261125-0139.ferrite — check your browser's downloads.");
  assert.doesNotMatch(line, /Backed up|saved/);
});

test("LINK-21.3: dialog: false skips Chrome's dialog (a save no click asked for)", async () => {
  const p = picker();
  const r = await saveAs("layout2.bin", new Blob(["x"]), { dialog: false });
  assert.equal(r.status, "started");
  assert.deepEqual(p.log, []);
});

test("LINK-21.3: the content failing after the pick: the error, and the empty file the dialog made removed", async () => {
  const p = picker();
  await assert.rejects(
    saveAs("a.ferrite", async () => {
      throw new Error("the radio didn't answer");
    }),
    /didn't answer/,
  );
  assert.deepEqual(p.log, ["pick a.ferrite", "removed"]);
});

test("LINK-21.3: the desktop app: its own dialog decides (saved with the file's name, or cancelled); no browser paths", async () => {
  const p = picker();
  const calls: string[] = [];
  let answer: string | null = "/Users/me/Documents/mine.ferrite";
  g.window!.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      return answer;
    },
  };
  assert.deepEqual(await saveAs("a.ferrite", new Blob(["x"])), { status: "saved", name: "mine.ferrite" });
  answer = null;
  assert.deepEqual(await saveAs("a.ferrite", async () => new Blob(["x"])), { status: "cancelled" });
  assert.deepEqual(calls, ["save_file", "save_file"]);
  assert.deepEqual(p.log, []);
  assert.deepEqual(clicks, []);
});

test("LINK-21.3: saveDownload (no dialog): a browser download is started, not saved", async () => {
  const r = await saveDownload("shot.png", new Blob(["x"]));
  assert.deepEqual(r, { status: "started", name: "shot.png" });
  assert.deepEqual(clicks, ["shot.png"]);
});

test("LINK-21.3: saveLine's three wordings", () => {
  const saved: SaveResult = { status: "saved", name: "x.gpx" };
  const started: SaveResult = { status: "started", name: "x.gpx" };
  assert.equal(saveLine(saved, "Saved"), "Saved as x.gpx.");
  assert.equal(saveLine(saved, "Saved", "4 waypoints"), "Saved 4 waypoints as x.gpx.");
  assert.equal(saveLine(started, "Saved", "4 waypoints"), "Saving 4 waypoints as x.gpx — check your browser's downloads.");
  assert.equal(saveLine({ status: "cancelled" }, "Saved"), "Not saved: cancelled.");
});
