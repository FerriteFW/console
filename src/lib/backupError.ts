// Why a write stopped at its backup step, in words the owner can act on: the radio didn't read, or the backup file
// didn't save. Both used to say "the backup read failed", even when the read was fine and the desktop app couldn't
// write the file (Linux, Console run as root, Nov 24, 2026).

/** A file the desktop app couldn't save (download.ts); its message names the path and the system's reason. */
export class SaveError extends Error {
  override name = "SaveError";
}

/** The line a write shows when its backup step failed: nothing went to the radio either way. */
export function backupFailed(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  return e instanceof SaveError
    ? `Nothing written: the backup file couldn't be saved. ${msg}`
    : `Nothing written: the backup read failed (${msg}).`;
}
