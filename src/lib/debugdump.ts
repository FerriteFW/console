// About's "Save debug info": one text file for a bug report. What Console runs on, the connection and the radio, the
// channel table's state and the last write's result, then the log Console always keeps in memory (debuglog.ts: the
// link's requests with their answers and times, timeouts, resyncs, the write's steps and a read back's differences,
// errors and presses). No PIN, no file contents: the radio's ID, callsign and the table's counts only. Connected, it
// also asks the radio about itself (LINK-19.6: the flash chip, the store's mount, calibration, the chips, the counts)
// and for its readback (LINK-19), so a report says what the radio was doing as well as what Console saw.
import { channels } from "./channels.svelte";
import { CONSOLE_VERSION } from "./codeplug.svelte";
import { debugLines, debugLog, debugPrevious } from "./debuglog";
import { saveAs } from "./download";
import { RadioError } from "./link";
import { radio } from "./radio.svelte";
import { isTauri } from "./transport/native";

const json = (v: unknown) => {
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `${x.length} bytes` : x));
  } catch (e) {
    return `(${(e as Error).message})`;
  }
};

/** How long Save debug info waits for each of the radio's answers (a readback over Bluetooth takes seconds). */
const ASK_MS = 8000;

/** The radio's report on itself and its readback, when connected: the lines for the report's "== radio" part. */
export async function radioReport(): Promise<string[]> {
  const link = radio.connectedLink;
  if (!link) return [`not connected (phase ${radio.phase})`];
  const ask = async (what: number, label: string): Promise<string[]> => {
    try {
      const t = await Promise.race([
        link.uiText(what),
        new Promise<never>((_r, no) => setTimeout(() => no(new Error(`no answer in ${ASK_MS / 1000} s`)), ASK_MS)),
      ]);
      return [`-- ${label}`, ...t.split("\n").filter((l) => l.trim() !== "")];
    } catch (e) {
      // A radio before 0.9.5 doesn't know what=4: bad_arg (3).
      const old = what === 4 && e instanceof RadioError && e.status === 3;
      return [`-- ${label}: ${old ? "not in this firmware (0.9.5 and later)" : (e as Error).message}`];
    }
  };
  return [...(await ask(4, "the radio on itself (ui radio)")), ...(await ask(0, "the readback (ui)"))];
}

/** The report's text; `report` is [`radioReport`]'s lines (left out: not asked). */
export function debugText(report?: string[]): string {
  const c = channels;
  const w = c.write;
  const lines = [
    `Ferrite Console ${CONSOLE_VERSION} (${isTauri() ? "desktop app" : "web"}), saved ${new Date().toISOString()}`,
    `platform: ${navigator.userAgent}`,
    "",
    "== connection",
    `phase ${radio.phase}, ${radio.kind ?? "none"} ${radio.label}, baud ${radio.baud ?? "-"}, note "${radio.note}", error "${radio.error}", fails ${radio.fails}`,
    // SELF-5.1: said plainly, so a report from unofficial firmware is seen at once
    `firmware: ${radio.info?.firmware ?? radio.hello?.firmware ?? "not connected"}${(radio.info?.build ?? radio.hello?.build)?.unofficial ? ", Unofficial firmware" : ""}`,
    `hello: ${json(radio.hello)}`,
    `info: ${json(radio.info)}`,
    `radio crash (SAFE-8.2): ${radio.crash ? json(radio.crash) : "none seen this session"}`,
    `readback restart line: ${radio.ui?.lines.find((l) => l.startsWith("restart ")) ?? "none"}`,
    "",
    ...(report ? ["== radio", ...report, ""] : []),
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
  const report = await radioReport();
  debugLog("debug info saved");
  const d = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  const name = `ferrite-console-debug-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
  return saveAs(name, new Blob([debugText(report)], { type: "text/plain" }));
}
