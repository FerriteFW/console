// CHIRP imports: the imported channels whose Comment names no zone of the table go into a zone called CHIRP, the
// table's own or a new one after its zones (none left: they stay in no zone). A CHIRP file has no zones, and channels
// in no zone were easy to lose track of on the radio (a user, Nov 16, 2026). Pure: `newZone` makes the zone.

type Z = { name: string };
type C = { zone: number | null; number?: number };

/** `kept` (Merge by number): the table's channels' zones by number. A channel the table already has keeps its own
 *  zone when the file names none (CHIRP's columns can't hold one), so an export and import changes nothing; only
 *  the others go in CHIRP. */
export function intoChirpZone<Zo extends Z, Ch extends C>(
  zones: Zo[],
  channels: Ch[],
  maxZones: number,
  newZone: (n: number, name: string) => Zo,
  kept?: Map<number, number | null>,
): { zones: Zo[]; channels: Ch[] } {
  const has = (c: Ch) => c.number !== undefined && kept?.has(c.number) === true;
  const own = channels.map((c) => (c.zone === null && has(c) ? { ...c, zone: kept!.get(c.number!) ?? null } : c));
  const homeless = (i: number) => channels[i].zone === null && !has(channels[i]);
  if (!channels.some((_, i) => homeless(i))) return { zones, channels: own };
  let at = zones.findIndex((z) => z.name.trim().toLowerCase() === "chirp");
  if (at < 0) {
    if (zones.length >= maxZones) return { zones, channels: own };
    at = zones.length;
    zones = [...zones, newZone(at + 1, "CHIRP")];
  }
  return { zones, channels: own.map((c, i) => (homeless(i) ? { ...c, zone: at } : c)) };
}
