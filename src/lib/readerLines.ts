// The reader's console lines the backup waits for (ferrite's crates/ferrite-core/src/reader.rs), matched only once
// they are whole: the text grows a read at a time, and a line cut short by a read once lost its reason (a refusal's
// "outside" read as no refusal: FerriteFW/console#95, item 4).

/** The end of a line: what a match must reach before it counts. */
const EOL = "(?=[\\r\\n])";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The answer to an `fdump`/`fdumpz` command (`command` as sent, with its `\r`): `fdump ... ready ...`, `fdump: why`
 * (a refusal), or `?  (help)` / `fdumpz: ?` from a reader without the command. The `?` counts only right after the
 * command's own echo (FerriteFW/console#88): a late one from an earlier line isn't this command's answer. */
export function fdumpReadyRe(command: string): RegExp {
  const echo = escape(command.replace(/[\r\n]+$/, ""));
  return new RegExp(`fdump(?:: [^\\r\\n]*|[ ][0-9A-F]{6} [0-9A-F]+ \\d+ ready[^\\r\\n]*)${EOL}|${echo}[\\r\\n]+\\?  \\(help\\)|fdumpz: \\?`);
}

/** The line the reader prints back at 115200 after a dump: `fdump end ...` or `fdump stopped at ...`. */
export const FDUMP_RESULT_RE = new RegExp(`fdump (?:end|stopped)[^\\r\\n]*${EOL}`);

/** The marker sector's `mdump` answer: the line before `dump: end`, `?  (help)` (no mdump), or a whole refusal. */
export const MDUMP_MARKER_RE = new RegExp(`80F0000:[0-9A-F]{32}\\*[0-9A-F]{2}(?=[\\s\\S]*?dump: end)|\\?  \\(help\\)|mdump: [^\\r\\n]*${EOL}`);

/** The reader's `> ` prompt at the very end of what came: it is waiting for a command. */
export const PROMPT_RE = /(?:^|\n)> $/;

/** A result line, short for an error message: what comes before its "; back to 115200 baud". */
export function resultReason(line: string): string {
  return line.replace(/;[^;]*$/, "").trim();
}

/** BACKUP-9.8: how long Console sends `FDS1` after the "ready" line, under the reader's 3 s (reader.rs's
 * `SYNC_MS`, which starts as the line goes out): Console gives up first, so no sync byte of its reaches a reader
 * already back at 115200 (FerriteFW/console#88). */
export const SYNC_WINDOW_MS = 2500;

/** After a NAK's cause, how long the line must be quiet before what came is dropped and the NAK sent: the rest of
 * a frame cut short (FerriteFW/console#90). */
export const NAK_QUIET_MS = 30;

/** Waits until nothing has arrived for `quietMs` (`heard()`: when the last byte came), at most `maxMs`; true when
 * the line went quiet. */
export async function quiet(heard: () => number, quietMs: number, maxMs: number, now: () => number = () => performance.now()): Promise<boolean> {
  const end = now() + maxMs;
  for (;;) {
    const left = heard() + quietMs - now();
    if (left <= 0) return true;
    if (now() >= end) return false;
    await new Promise((ok) => setTimeout(ok, Math.min(left, end - now(), 10)));
  }
}
