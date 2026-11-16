// CHIRP imports: the imported channels whose Comment names no zone of the table go into a zone called CHIRP, the
// table's own or a new one after its zones (none left: they stay in no zone). A CHIRP file has no zones, and channels
// in no zone were easy to lose track of on the radio (a user, Nov 16, 2026). Pure: `newZone` makes the zone.

type Z = { name: string };
type C = { zone: number | null };

export function intoChirpZone<Zo extends Z, Ch extends C>(zones: Zo[], channels: Ch[], maxZones: number, newZone: (n: number, name: string) => Zo): { zones: Zo[]; channels: Ch[] } {
  if (!channels.some((c) => c.zone === null)) return { zones, channels };
  let at = zones.findIndex((z) => z.name.trim().toLowerCase() === "chirp");
  if (at < 0) {
    if (zones.length >= maxZones) return { zones, channels };
    at = zones.length;
    zones = [...zones, newZone(at + 1, "CHIRP")];
  }
  return { zones, channels: channels.map((c) => (c.zone === null ? { ...c, zone: at } : c)) };
}
