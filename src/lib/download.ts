// Files out of Console, and what the owner is told about them (console#106). Three ways a file leaves:
// - the desktop app: the shell's own save dialog (`save_file`) or its Downloads folder (`save_download`); it writes
//   the file itself, so it is saved (the app's webview drops <a download> links: CHIRP export did nothing there, and
//   the backup a write saved first never landed; Nov 16, 2026);
// - Chrome and Edge: the browser's save dialog (`showSaveFilePicker`), opened from the owner's click: the file is
//   written through it, so it is saved, and a cancel is a cancel;
// - every other browser (Firefox, Safari), or where the dialog isn't allowed: an <a download> link. The browser can
//   hold that back (Chrome's "allow multiple downloads?" prompt, Nov 25, 2026), so Console says it is saving, never
//   that it saved.
// Pure apart from `window` and `document` (tests/unit/download.test.ts stubs them).
import { SaveError } from "./backupError.ts";

/** How a save went: `saved` (written: the desktop app, or the browser's save dialog), `started` (handed to the
 *  browser's downloads, which may hold it back or ask first), or `cancelled` (the owner closed the dialog). */
export type SaveResult = { status: "saved"; name: string } | { status: "started"; name: string } | { status: "cancelled" };

/** The file's bytes, or how to make them: a function runs after the save dialog closed (Chrome's dialog must open
 *  from the click, before a radio read or anything else slow; the owner's gesture lasts only seconds). */
export type Content = Blob | (() => Promise<Blob>);

type Writable = { write(b: Blob): Promise<void>; close(): Promise<void> };
type Handle = { name: string; createWritable(): Promise<Writable>; remove?: () => Promise<void> };
type Picker = (o: { suggestedName: string; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<Handle>;

/** The desktop app (Tauri); here rather than transport/native's, which pulls in Svelte state. */
const desktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const make = (c: Content) => (typeof c === "function" ? c() : Promise.resolve(c));

/** Saves `content` as `name` where the owner picks: the desktop app's save dialog, else the browser's (Chrome, Edge;
 *  `dialog: false` skips it, for a save no click asked for), else a download. Call it straight from the click, before
 *  any await: Chrome refuses its dialog without the gesture (the download is used then). Throws when the content
 *  couldn't be made or the desktop app couldn't write it (SaveError). */
export async function saveAs(name: string, content: Content, opts: { dialog?: boolean; type?: string } = {}): Promise<SaveResult> {
  if (desktop()) {
    const blob = await make(content);
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = await invoke<string | null>("save_file", bytes, { headers: { "x-name": name } }).catch(asError);
    return path ? { status: "saved", name: path.split(/[\\/]/).pop() ?? name } : { status: "cancelled" };
  }
  const pick = opts.dialog === false ? undefined : (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  if (pick) {
    let h: Handle | null = null;
    try {
      h = await pick.call(window, { suggestedName: name, types: types(name, content, opts.type) });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return { status: "cancelled" };
      // Not allowed here (no gesture left, a sandboxed frame, a policy): the download below.
    }
    if (h) {
      let blob: Blob;
      try {
        blob = await make(content);
      } catch (e) {
        await h.remove?.().catch(() => {}); // the empty file the dialog made
        throw e;
      }
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return { status: "saved", name: h.name };
    }
  }
  anchor(name, await make(content));
  return { status: "started", name };
}

/** Saves `blob` as `name` without asking where: the desktop app's Downloads folder (its path), else a browser
 *  download (started, not confirmed). For quick files the owner isn't told about one by one (screenshots, CSVs).
 *  Throws when the desktop app couldn't write it (SaveError). */
export async function saveDownload(name: string, blob: Blob): Promise<SaveResult> {
  if (desktop()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { status: "saved", name: await invoke<string>("save_download", bytes, { headers: { "x-name": name } }).catch(asError) };
  }
  anchor(name, blob);
  return { status: "started", name };
}

/** The owner's line for a save: "<done> <what> as NAME." when it's written, "Saving <what> as NAME — check your
 *  browser's downloads." when the browser has it, "Not saved: cancelled." when the dialog was closed. `what` may be
 *  empty ("Saved as NAME."). */
export function saveLine(r: SaveResult, done: string, what = ""): string {
  const w = what ? ` ${what}` : "";
  if (r.status === "cancelled") return "Not saved: cancelled.";
  if (r.status === "saved") return `${done}${w} as ${r.name}.`;
  return `Saving${w} as ${r.name} — check your browser's downloads.`;
}

/** The dialog's file type, from the name's extension (Chrome lists it as the only choice). */
function types(name: string, content: Content, type?: string) {
  const ext = /\.[A-Za-z0-9]{1,16}$/.exec(name)?.[0];
  if (!ext) return undefined;
  const mime = type || (content instanceof Blob && /^[a-z]+\/[a-z0-9.+-]+$/i.test(content.type) ? content.type : "application/octet-stream");
  return [{ accept: { [mime]: [ext] } }];
}

function anchor(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  const t = setTimeout(() => URL.revokeObjectURL(url), 10_000) as unknown as { unref?: () => void };
  t.unref?.(); // Node (the unit tests) needn't wait for it
}

/** The desktop shell's commands reject with their message as a plain string: as a SaveError, so callers' `e.message`
 *  says what failed (a backup before a write showed "the backup read failed (undefined)", Nov 24, 2026) and a caller
 *  can tell a save that failed from a read that did (backupError.ts). */
function asError(e: unknown): never {
  throw new SaveError(e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));
}
