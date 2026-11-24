// Live View's "Tune from map": a frequency picked on Near me's map, set on the radio's active slot as a VFO
// frequency (no channel saved). It goes as one terminal `slot` line over the link's CMD (TERM-35, LINK-33, LINK-34):
// the keypad's own paths and checks, refused whole with the radio's reason. Pure, so the unit tests reach it.

/** What a map row tunes: the frequency, its mode, a repeater's shift and tones (Ferrite's words, TERM-35.2). */
export type Tune = {
  name: string;
  /** RX frequency in Hz. */
  hz: number;
  mode: "NFM" | "FM" | "AM" | "NAM";
  /** A repeater's shift in Hz (TX minus RX); 0 or absent: simplex. */
  shiftHz?: number;
  /** Tone sent and tone squelch ("100.0", "D023N"); absent: off. */
  txTone?: string;
  rxTone?: string;
  /** Where it came from on the map (a licensed site, an airport, a repeater) and its position, for Add as channel. */
  kind?: "lic" | "air" | "rpt";
  pos?: [number, number];
};

/** The data's tone as Ferrite's word (TERM-35.2): DCS gets its N ("D023" is "D023N"). */
export const toneWord = (t: string) => (/^D\d{3}$/.test(t) ? `${t}N` : t);

const mhz5 = (hz: number) => (Math.round(hz / 10) / 1e5).toFixed(5);

/** The active slot's letter from the terminal's `slot` list ("A* vfo 146.52000 ..."), or null. */
export function activeSlot(list: string): string | null {
  return /^([ABC])\*/m.exec(list)?.[1] ?? null;
}

/** The `slot` line that tunes `slot` to `t` as a VFO: frequency, mode, both tones and the shift, every time, so
 * nothing of the slot's last frequency lingers (a tone squelch, a shift). */
export function slotLine(slot: string, t: Tune): string {
  const s = t.shiftHz ? Math.round(t.shiftHz) : 0;
  const offset = s ? `${s > 0 ? "+" : "-"}${mhz5(Math.abs(s))}` : "off";
  return `slot ${slot} vfo ${mhz5(t.hz)} ${t.mode.toLowerCase()} txtone ${t.txTone || "off"} rxtone ${t.rxTone || "off"} offset ${offset}`;
}

/** Two tunes are the same when the radio would end up the same: frequency, mode, shift and tones. */
const sameTune = (a: Tune, b: Tune) =>
  a.hz === b.hz && a.mode === b.mode && (a.shiftHz || 0) === (b.shiftHz || 0) && (a.txTone || "") === (b.txTone || "") && (a.rxTone || "") === (b.rxTone || "");

/** The recent tunes with `t` first (once), at most `max`. */
export function remember(list: Tune[], t: Tune, max = 10): Tune[] {
  return [t, ...list.filter((x) => !sameTune(x, t))].slice(0, max);
}

/** Recent tunes from storage: what parses and looks like a tune; anything else is dropped. */
export function readRecent(text: string | null): Tune[] {
  try {
    const v = JSON.parse(text ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((t) => t && typeof t.name === "string" && Number.isFinite(t.hz) && t.hz > 0 && ["NFM", "FM", "AM", "NAM"].includes(t.mode)).slice(0, 10);
  } catch {
    return [];
  }
}

/** The list's second line: "FM · −600 kHz · T 100.0". */
export function tuneDetail(t: Tune): string {
  const s = t.shiftHz ? Math.round(t.shiftHz) : 0;
  const shift = s ? `${s > 0 ? "+" : "−"}${Math.abs(s) >= 1e6 ? `${+(Math.abs(s) / 1e6).toFixed(4)} MHz` : `${Math.abs(s) / 1000} kHz`}` : "";
  return [t.mode, shift, t.txTone ? `T ${t.txTone}` : "", t.rxTone ? `R ${t.rxTone}` : ""].filter(Boolean).join(" · ");
}

/** "146.94" from the Hz. */
export const tuneMhz = (t: Tune) => mhz5(t.hz).replace(/0+$/, "").replace(/\.$/, "");

/**
 * A tune as Add channels' entry (the core's `library_add` makes the channel): a repeater with its input and tones in
 * "Repeaters", an airport's NAM (narrow AM) receive-only in "Airband" (Ferrite never transmits there), anything else in "Near me";
 * low power, as Add channels does.
 */
export function tuneItem(t: Tune) {
  const s = t.shiftHz ? Math.round(t.shiftHz) : 0;
  const rpt = t.kind === "rpt" || s !== 0;
  const air = t.kind === "air" || t.mode === "AM" || t.mode === "NAM";
  return {
    name: t.name,
    rx: t.hz / 1e6,
    tx: s ? (t.hz + s) / 1e6 : null,
    mode: t.mode,
    power: "Low",
    rx_only: air,
    zone: rpt ? "Repeaters" : air ? "Airband" : "Near me",
    tone: t.txTone || null,
    rx_tone: rpt ? t.rxTone || "off" : t.rxTone || null,
    pos: t.pos ?? null,
  };
}

/** What the confirmation says: "Slot A: 146.94 FM −600 kHz, T 100.0". */
export function tuneSummary(slot: string, t: Tune): string {
  const f = mhz5(t.hz).replace(/0+$/, "").replace(/\.$/, "");
  const s = t.shiftHz ? Math.round(t.shiftHz) : 0;
  const shift = s ? ` ${s > 0 ? "+" : "−"}${Math.abs(s) >= 1e6 ? `${+(Math.abs(s) / 1e6).toFixed(4)} MHz` : `${Math.abs(s) / 1000} kHz`}` : "";
  const tones = [t.txTone ? `T ${t.txTone}` : "", t.rxTone ? `R ${t.rxTone}` : ""].filter(Boolean).join(" · ");
  return `Slot ${slot}: ${f} ${t.mode}${shift}${tones ? `, ${tones}` : ""}`;
}
