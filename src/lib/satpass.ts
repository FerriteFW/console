// SAT-23: a satellite pass as the Satellites page says it (local time): "Up now until 14:32 (47°)", "Today 14:32,
// 47°", "Sat 09:10, 12°". Pure.
import type { SatPass } from "./core";

export const hm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function dayOf(t: number, now: number): string {
  const d = new Date(t * 1000);
  const today = new Date(now * 1000);
  const tomorrow = new Date((now + 86_400) * 1000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "short" });
}

/** One pass, short: for a table cell. */
export function passShort(p: SatPass | null, now: number): string {
  if (!p) return "none in 2 days";
  const el = `${Math.round(p.max_el)}°`;
  return p.aos <= now ? `Up now until ${hm(p.los)}, ${el}` : `${dayOf(p.aos, now)} ${hm(p.aos)}, ${el}`;
}

/** One pass, whole: when it rises and sets, how high, how long. */
export function passLong(p: SatPass, now: number): string {
  const min = Math.round((p.los - p.aos) / 60);
  const el = `highest ${Math.round(p.max_el)}°`;
  return p.aos <= now ? `up now until ${hm(p.los)} (${el})` : `${dayOf(p.aos, now).toLowerCase()} ${hm(p.aos)}–${hm(p.los)} (${el}, ${min} min)`;
}
