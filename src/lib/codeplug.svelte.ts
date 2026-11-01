// The .ferrite codeplug, Console's one file kind (docs/dev/codeplug-format.md): Save as… gathers every part the
// pages hold (channels and zones, range presets with their skip lists; Radio Settings, APRS settings, contacts, quick
// messages, waypoints and DTMF memories when read or opened this session) into
// one file; Open… loads each part a file holds into its page as unwritten changes (Write to radio, per page, puts
// it on the radio). The older per-page `-backup.json` files still open, each into its own page. In the desktop app
// the file goes through the native save dialog (the shell's `save_file`); in a browser it downloads.
import { aprsBackup, backupFile, loadCore, presetsFile, presetsRestore, settingsCodeplugPart } from "./core";
import { aprsSettings } from "./aprsSettings.svelte";
import { channels, type ChannelsFile } from "./channels.svelte";
import { buildCodeplug, codeplugName, contactsJson, fingerprint, isZip, manifest, readCodeplug, readContacts, readDtmf, readQuick, readWaypoints, type Part, type Parts, type RadioMeta } from "./codeplug.ts";
import { lists, type ListKey } from "./lists.svelte";
import { contacts } from "./contacts.svelte";
import { radio } from "./radio.svelte";
import { settings } from "./settings.svelte";
import { isTauri } from "./transport/native";

declare const __CONSOLE_VERSION__: string;
const CONSOLE_VERSION = typeof __CONSOLE_VERSION__ === "string" ? __CONSOLE_VERSION__ : "dev";

/** What the radio said about itself (INFO), for the manifest and the file's name. */
function radioMeta(): RadioMeta {
  const i = radio.info;
  if (!i) return {};
  return { callsign: i.callsign || undefined, firmware: i.firmware || undefined, build: i.build?.name || undefined };
}

/** The parts' own `radio` block, as their single-part saves write it but without the unique ID (codeplugs get
 *  shared; the manifest's fingerprint stands for it). */
function partRadio(): Record<string, string> {
  const i = radio.info;
  const m: Record<string, string> = { connection: radio.label };
  if (i) {
    m.firmware = i.firmware;
    m.callsign = i.callsign;
  }
  return m;
}

/** Every part the pages hold now: the edited tables and records, unwritten changes included. */
export function gather(saved: string): Parts {
  const r = partRadio();
  const parts: Parts = {};
  const t = channels.table;
  if (t.channels.length || t.zones.length) parts.channels = channels.fileText(saved, r);
  // Range presets: when read (even none: the file then says the radio has none) or added.
  if (channels.basePresets !== null || channels.presets.length) parts.presets = channels.presetsText(saved, r);
  // Never the PIN lock: settings.json leaves it out, and opening keeps the radio's own.
  if (settings.record) parts.settings = settingsCodeplugPart(settings.record, settings.extras, saved, r);
  if (aprsSettings.record) parts.aprs = aprsBackup(aprsSettings.settingsRec, aprsSettings.record, aprsSettings.extras, saved, r);
  // The radio's contacts with the opened ones not written yet over them (what the radio would hold after Write).
  if (contacts.loaded || contacts.pending) {
    const byCall = new Map((contacts.loaded ? contacts.list : []).map((c) => [c.call, c]));
    for (const c of contacts.pending?.list ?? []) byCall.set(c.call, c);
    parts.contacts = contactsJson([...byCall.values()].sort((a, b) => a.call.localeCompare(b.call)), saved, r);
  }
  // The owner's lists (LINK-54 – LINK-56): when read or opened, with their unwritten changes.
  for (const k of ["quick", "waypoints", "dtmf"] as const) if (lists[k].any) parts[k] = lists[k].text(saved, r);
  return parts;
}

/** The file to disk: the desktop app's save dialog (null when cancelled) or a browser download. The name it went as. */
export async function saveBlob(name: string, blob: Blob): Promise<string | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = await invoke<string | null>("save_file", bytes, { headers: { "x-name": name } });
    return path ? (path.split(/[\\/]/).pop() ?? name) : null;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/** Parts as a .ferrite file, saved: the notice's text ("" when the save dialog was cancelled). */
export async function saveParts(parts: Parts, what = "Saved"): Promise<string> {
  const meta = radioMeta();
  const uid = radio.info?.uid;
  const m = manifest(parts, meta, CONSOLE_VERSION, new Date(), uid ? await fingerprint(new Uint8Array(uid)) : undefined);
  if (!m.parts.length) throw new Error("Nothing to save yet: read the radio or open a file first.");
  const name = await saveBlob(codeplugName(meta.callsign), await buildCodeplug(parts, m));
  return name ? `${what} ${list(m.parts, parts)} as ${name}${isTauri() ? "" : " (your downloads)"}.` : "";
}

/** Save as…: everything Console holds, as one .ferrite. */
export const saveCodeplug = () => saveParts(gather(new Date().toISOString()));

/** Back up radio…: a fresh read of one page's part (the table and editors are left alone), as a .ferrite holding
 *  only that part. The notice's text ("" when the save dialog was cancelled). */
export async function backUp(part: "channels" | "settings" | "aprs" | ListKey): Promise<string> {
  const saved = new Date().toISOString();
  const r = partRadio();
  let text: string;
  if (part === "channels") {
    const { set, presets } = await channels.readRadio();
    text = backupFile(set, saved, r);
    // The range presets are read with the channels, so they go with them.
    if (presets) return saveParts({ channels: text, presets: presetsFile(presets, saved, r) }, "Backed up");
  } else if (part === "settings") {
    const { record, extras } = await settings.readRadio();
    text = settingsCodeplugPart(record, extras, saved, r);
  } else if (part === "quick" || part === "waypoints" || part === "dtmf") {
    const l = lists[part];
    text = l.fileText(await l.readRadio(), saved, r);
  } else {
    const { record, extras } = await aprsSettings.readRadio();
    text = aprsBackup(aprsSettings.settingsRec, record, extras, saved, r);
  }
  return saveParts({ [part]: text }, "Backed up");
}

const PART_NAME: Record<Part, string> = {
  channels: "channels",
  presets: "range presets",
  settings: "settings",
  aprs: "APRS settings",
  contacts: "contacts",
  quick: "quick messages",
  waypoints: "waypoints",
  dtmf: "DTMF memories",
};

function list(order: readonly Part[], parts: Parts): string {
  return order
    .map((p) => {
      if (p === "channels") {
        try {
          const f = JSON.parse(parts.channels!) as ChannelsFile;
          return `channels (${f.channels.length}) and zones (${f.zones.length})`;
        } catch {
          return "channels and zones";
        }
      }
      if (p === "presets") {
        try {
          return `range presets (${presetsRestore(parts.presets!).presets.length})`;
        } catch {
          return "range presets";
        }
      }
      if (p === "contacts") {
        try {
          return `contacts (${readContacts(parts.contacts!).contacts.length})`;
        } catch {
          return "contacts";
        }
      }
      try {
        if (p === "quick") return `quick messages (${readQuick(parts.quick!).messages.filter((q) => q.own).length} your own)`;
        if (p === "waypoints") return `waypoints (${readWaypoints(parts.waypoints!).waypoints.length})`;
        if (p === "dtmf") return `DTMF memories (${readDtmf(parts.dtmf!).memories.length})`;
      } catch {
        /* the name alone */
      }
      return PART_NAME[p];
    })
    .join(", ");
}

/** One part into its page as unwritten changes: "" when loaded, else why not. */
function loadPart(p: Part, text: string, from: string): string {
  switch (p) {
    case "channels":
      return channels.loadFile(text, from) ? "" : channels.error;
    case "presets":
      return channels.loadPresets(text, from) ? "" : channels.error;
    case "settings":
      return settings.loadFile(text, from, true) ? "" : settings.error;
    case "aprs":
      return aprsSettings.loadFile(text, from) ? "" : aprsSettings.error;
    case "contacts":
      try {
        contacts.offer(readContacts(text).contacts, from);
        return "";
      } catch (e) {
        return `${from}: ${(e as Error).message}`;
      }
    case "quick":
    case "waypoints":
    case "dtmf":
      return lists[p].loadFile(text, from) ? "" : lists[p].error;
  }
}

/** Which part an old single-part backup (`-backup.json`, `-edited.json`, `-table.json`) is, by its format. */
function partOf(text: string): Part | null {
  try {
    const f = JSON.parse(text)?.format;
    return f === "ferrite-console-channels"
      ? "channels"
      : f === "ferrite-console-settings"
        ? "settings"
        : f === "ferrite-console-aprs"
          ? "aprs"
          : f === "ferrite-console-contacts"
            ? "contacts"
            : f === "ferrite-console-presets"
              ? "presets"
              : f === "ferrite-console-quick"
                ? "quick"
                : f === "ferrite-console-waypoints"
                  ? "waypoints"
                  : f === "ferrite-console-dtmf"
                    ? "dtmf"
                    : null;
  } catch {
    return null;
  }
}

export type Opened = { notice: string; parts: Part[]; failed: string[] };

/** Open…: a .ferrite (every part it holds) or an older single-part JSON backup, into the pages. Throws (a reason to
 *  show) when the file is none of those, damaged, or newer than this Console reads. */
export async function openFile(file: { name: string; bytes: Uint8Array }): Promise<Opened> {
  await loadCore(); // a file opened as the page loads: the parts' readers are the core's
  let parts: Parts;
  let order: Part[];
  if (isZip(file.bytes)) {
    const c = await readCodeplug(file.bytes);
    parts = c.parts;
    order = c.manifest.parts.filter((p): p is Part => p in parts);
  } else {
    const text = new TextDecoder().decode(file.bytes);
    const p = partOf(text);
    if (!p) throw new Error(`${file.name}: not a Ferrite codeplug (.ferrite) or a Console backup (.json).`);
    parts = { [p]: text };
    order = [p];
  }
  const loaded: Part[] = [];
  const failed: string[] = [];
  for (const p of order) {
    const why = loadPart(p, parts[p]!, file.name);
    if (why) failed.push(`couldn't load ${PART_NAME[p]}: ${why}`);
    else loaded.push(p);
  }
  let notice = loaded.length ? `Loaded ${list(loaded, parts)} from ${file.name}` : `Nothing loaded from ${file.name}`;
  if (failed.length) notice = `${notice}; ${failed.join("; ")}`;
  // CHAN-35: zones over 256 channels (a file from before layout 3) were split as they loaded: said here.
  if (loaded.includes("channels") && channels.notes.length) notice = `${notice}. ${channels.notes.join(". ")}.`;
  return { notice, parts: loaded, failed };
}

/** An <input type=file>'s file, read, once the core has loaded (what reads it next is the core's: a file picked as
 *  the page opens must not race its loading). */
export async function picked(e: Event): Promise<{ name: string; bytes: Uint8Array } | null> {
  const el = e.currentTarget as HTMLInputElement;
  const f = el.files?.[0];
  el.value = "";
  if (!f) return null;
  const bytes = new Uint8Array(await f.arrayBuffer());
  await loadCore();
  return { name: f.name, bytes };
}

/** What Open… accepts (".json" first: the old backups, and the e2e tests' selectors). */
export const OPEN_ACCEPT = ".json,.ferrite,application/json,application/zip";
