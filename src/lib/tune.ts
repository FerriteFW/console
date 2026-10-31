// Live View's "Tune from map": a frequency picked on Near me's map, set on the radio's active slot as a VFO
// frequency (no channel saved). It goes as one terminal `slot` line over the link's CMD (TERM-35, LINK-33, LINK-34):
// the keypad's own paths and checks, refused whole with the radio's reason. Pure, so the unit tests reach it.

/** What a map row tunes: the frequency, its mode, a repeater's shift and tones (Ferrite's words, TERM-35.2). */
export type Tune = {
  name: string;
  /** RX frequency in Hz. */
  hz: number;
  mode: "NFM" | "FM" | "AM";
  /** A repeater's shift in Hz (TX minus RX); 0 or absent: simplex. */
  shiftHz?: number;
  /** Tone sent and tone squelch ("100.0", "D023N"); absent: off. */
  txTone?: string;
  rxTone?: string;
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

/** What the confirmation says: "Slot A: 146.94 FM −600 kHz, T 100.0". */
export function tuneSummary(slot: string, t: Tune): string {
  const f = mhz5(t.hz).replace(/0+$/, "").replace(/\.$/, "");
  const s = t.shiftHz ? Math.round(t.shiftHz) : 0;
  const shift = s ? ` ${s > 0 ? "+" : "−"}${Math.abs(s) >= 1e6 ? `${+(Math.abs(s) / 1e6).toFixed(4)} MHz` : `${Math.abs(s) / 1000} kHz`}` : "";
  const tones = [t.txTone ? `T ${t.txTone}` : "", t.rxTone ? `R ${t.rxTone}` : ""].filter(Boolean).join(" · ");
  return `Slot ${slot}: ${f} ${t.mode}${shift}${tones ? `, ${tones}` : ""}`;
}
