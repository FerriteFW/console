import { P, parsePlace, type Place } from "./core";
import type { Link } from "./link";

/**
 * LINK-66 (decision 347): the radio's place from its radio record: its GPS fix, else its fixed position (MENU 0 6 9)
 * when that is on. Null when it has neither.
 */
export async function radioPlace(link: Link): Promise<{ place: Place; gps: boolean } | null> {
  const r = await link.readRecord(P.what.RADIO, 0);
  if (!r || r.length < 12) return null;
  const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
  const lat = v.getInt32(4, true) / 1e7;
  const lon = v.getInt32(8, true) / 1e7;
  if (r[2] === 0 && lat === 0 && lon === 0) return null;
  const place = parsePlace(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  return place ? { place, gps: r[2] !== 0 } : null;
}

/** The active slot's letter, from the UI status line (`act=A`, LINK-19). */
export async function activeSlotOf(link: Link): Promise<string | null> {
  return /\bact=([ABC])\b/.exec(await link.uiText(2))?.[1] ?? null;
}
