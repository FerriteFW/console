// About's "Save debug info": one text file for a bug report. What Console runs on, the connection and the radio, the
// channel table's state and the last write's result, then the log Console always keeps in memory (debuglog.ts: the
// link's requests with their answers and times, timeouts, resyncs, the write's steps and a read back's differences,
// errors and presses). No PIN, no file contents: the radio's ID, callsign and the table's counts only.
import { channels } from "./channels.svelte";
import { CONSOLE_VERSION } from "./codeplug.svelte";
import { debugLines, debugLog, debugPrevious } from "./debuglog";
import { saveAs } from "./download";
import { radio } from "./radio.svelte";
import { isTauri } from "./transport/native";

const json = (v: unknown) => {
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `${x.length} bytes` : x));
  } catch (e) {
    return `(${(e as Error).message})`;
  }
};

/** The report's text. */
export function debugText(): string {
  const c = channels;
  const w = c.write;
  const lines = [
    `Ferrite Console ${CONSOLE_VERSION} (${isTauri() ? "desktop app" : "web"}), saved ${new Date().toISOString()}`,
    `platform: ${navigator.userAgent}`,
    "",
    "== connection",
    `phase ${radio.phase}, ${radio.kind ?? "none"} ${radio.label}, baud ${radio.baud ?? "-"}, note "${radio.note}", error "${radio.error}", fails ${radio.fails}`,
    `hello: ${json(radio.hello)}`,
    `info: ${json(radio.info)}`,
    "",
    "== channels",
    `radio as read: ${c.base ? `${c.base.channels.length} channels, ${c.base.zones.length} zones` : "not read"}; table: ${c.table.channels.length} channels, ${c.table.zones.length} zones; unwritten changes ${c.pending}`,
    `source "${c.source}", error "${c.error}"`,
    `write: ${w ? json({ step: w.step, done: "done" in w ? w.done : undefined, verified: "verified" in w ? w.verified : undefined, error: "error" in w ? w.error : undefined, written: "written" in w ? w.written : undefined, ops: "plan" in w && w.plan ? w.plan.ops.length : undefined, problems: "plan" in w && w.plan ? w.plan.problems : undefined }) : "none open"}`,
    "",
    `== log (this session, the last ${debugLines().length} lines)`,
    ...debugLines(),
    "",
    `== log of the previous session (the last time Console ran: ${debugPrevious().length} lines)`,
    ...debugPrevious(),
  ];
  return lines.join("\n") + "\n";
}

/** Saves the report where the owner picks (the desktop app's save dialog; a browser download). The name, or null. */
export async function saveDebugInfo(): Promise<string | null> {
  debugLog("debug info saved");
  const d = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  const name = `ferrite-console-debug-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
  return saveAs(name, new Blob([debugText()], { type: "text/plain" }));
}
