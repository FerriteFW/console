// The Install page's guards over the owner's stock data that don't need the radio (install.svelte.ts runs them):
// - BACKUP-2.1: Ferrite goes only into the radio the backup was taken from, by its MCU ID (decision 263's check, as
//   Back to stock does it).
// - BACKUP-8.1: "Send the stock firmware only" after a cut Back to stock only when every range was written and read
//   back, and stock had started going in (Ferrite can't start again and set up its storage over the restored data).

/** ferrite's base32 digits (core's `uid_key`): what an ID is written in. */
const DIGITS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** An ID as typed or shown ("n0eq8 0r081 ...") as its 20 digits, upper case, or "" when it isn't one. */
export function uidKey(s: string | null | undefined): string {
  const k = (s ?? "").replace(/[\s-]/g, "").toUpperCase();
  return k.length === 20 && [...k].every((c) => DIGITS.includes(c)) ? k : "";
}

/** The ID grouped as About shows it. */
const grouped = (k: string) => k.match(/.{5}/g)!.join(" ");

/**
 * BACKUP-2.1: why Ferrite can't go into the radio connected now, or "". `backupUid`: the ID the backup's reader gave;
 * `radioUid`: the one the radio answers now (null: it didn't answer as the reader).
 */
export function installIdProblem(backupUid: string, radioUid: string | null): string {
  const b = uidKey(backupUid);
  if (!b)
    return "The backup doesn't say which radio it is from (the reader didn't give the radio's ID), so Console can't check that this is the same radio. Take the backup again.";
  if (radioUid === null)
    return "Console couldn't read this radio's ID: it isn't answering as the reader from the backup step. Check that it is on and that it is the radio you backed up, then try again. Nothing was written.";
  const here = uidKey(radioUid);
  if (here !== b)
    return `This is a different radio (ID ${here ? grouped(here) : "unknown"}) from the one you backed up (ID ${grouped(b)}). Installing would leave it with no backup of its stock data. Take a backup of this radio first. Nothing was written.`;
  return "";
}

/** BACKUP-2.1: the radio answered with an ID that isn't the backup's (the backup is then forgotten). */
export function otherRadio(backupUid: string, radioUid: string | null): boolean {
  return radioUid !== null && !!uidKey(backupUid) && uidKey(radioUid) !== uidKey(backupUid);
}

/** How far a Back to stock got (BACKUP-8.1). */
export type RestoreProgress = {
  /** The ranges the plan writes (each ends with a read-back CRC). */
  ranges: number;
  /** The ranges whose CRC read back as the backup's. */
  verified: number;
  /** The radio accepted FINISH (it restarts into its bootloader). */
  finished: boolean;
  /** The stock image's blocks the bootloader accepted after that (the first one replaces Ferrite's start). */
  stockBlocks: number;
};

export const restoreProgress = (): RestoreProgress => ({ ranges: 0, verified: 0, finished: false, stockBlocks: 0 });

/**
 * BACKUP-8.1: the stock firmware alone may finish a cut Back to stock only when every range was written and read
 * back as the backup's, the radio accepted FINISH, and the bootloader took stock's first block right after it: then
 * Ferrite can't start again over the restored data. Anything less (a cut during the writes, a missed bootloader
 * window, which lets Ferrite start and set up its storage) needs Back to stock again.
 */
export function stockOnlyAllowed(p: RestoreProgress): boolean {
  return p.ranges > 0 && p.verified === p.ranges && p.finished && p.stockBlocks > 0;
}
