// SSTV pictures (ferrite manual chapter 27a, SSTV-4): the radio's six picture slots read raw (`DATA_READ`, LINK-59,
// either link) and a picture to send written into slot 0 or 1 (`DATA_WRITE`, LINK-60: the cable only), each checked
// by its CRC. The slots' format and the write's order: sstv.ts.
import { P } from "./core";
import type { Link } from "./link";
import { radio } from "./radio.svelte";
import { atLeast } from "./version";
import { crc32 } from "./zip";
import { decodeHeader, H, HEADER_LEN, pixelsAddr, RECEIVING, ROW, SLOTS, slotAddr, writePlan, sendHeader, PICTURES_FROM, type Header } from "./sstv";

export type Slot = { k: number; header: Header | null; px: Uint8Array | null; rows: number };

/** The rows a slot's pixels hold: its lines (all 256 while it's being received; the rest reads as erased). */
const rowsOf = (h: Header) => (h.lines === RECEIVING ? H : Math.min(h.lines, H));

/** Whether the connected radio's firmware takes picture writes (an older one would start an update: LINK-61). */
export const canWrite = () => atLeast(radio.hello?.firmware ?? "", PICTURES_FROM);

class Pictures {
  slots = $state.raw<Slot[] | null>(null);
  busy = $state("");
  error = $state("");
  notice = $state("");
  /** Done and all, for the progress bar. */
  done = $state(0);
  total = $state(0);
  /** The pictures read, by slot, with the header bytes they were read under: unchanged ones aren't read again. */
  private kept = new Map<number, { key: string; px: Uint8Array }>();
  private keptFor: Link | null = null;

  async read(): Promise<void> {
    const link = radio.connectedLink;
    if (!link) return;
    if (this.keptFor !== link) this.kept.clear();
    this.keptFor = link;
    this.error = this.notice = "";
    radio.busy = this.busy = "Reading pictures";
    try {
      const heads: { k: number; raw: Uint8Array; header: Header | null }[] = [];
      for (let k = 0; k < SLOTS; k++) {
        const raw = await link.dataRead(slotAddr(k), HEADER_LEN);
        heads.push({ k, raw, header: decodeHeader(raw) });
      }
      this.total = heads.reduce((n, s) => n + (s.header ? rowsOf(s.header) * ROW : 0), 0);
      this.done = 0;
      const slots: Slot[] = [];
      for (const { k, raw, header } of heads) {
        if (!header) {
          slots.push({ k, header, px: null, rows: 0 });
          continue;
        }
        const rows = rowsOf(header);
        const key = hex(raw);
        const kept = this.kept.get(k);
        let px: Uint8Array;
        if (kept && kept.key === key && header.lines !== RECEIVING) {
          px = kept.px;
          this.done += rows * ROW;
        } else {
          px = await this.readPixels(link, k, rows * ROW);
          this.kept.set(k, { key, px });
        }
        slots.push({ k, header, px, rows });
      }
      this.slots = slots;
    } catch (e) {
      this.error = `The pictures didn't read: ${(e as Error).message}`;
    } finally {
      radio.busy = this.busy = "";
    }
  }

  private async readPixels(link: Link, k: number, len: number): Promise<Uint8Array> {
    const px = new Uint8Array(len);
    for (let o = 0; o < len; o += P.data.READ_MAX) {
      const n = Math.min(P.data.READ_MAX, len - o);
      px.set(await link.dataRead(pixelsAddr(k) + o, n), o);
      this.done += n;
    }
    // a picture being received changes as it's read: its CRC wouldn't match
    if ((await link.dataCrc(pixelsAddr(k), len)) !== crc32(px)) {
      const h = decodeHeader(await link.dataRead(slotAddr(k), HEADER_LEN));
      if (!h || h.lines !== RECEIVING) throw new Error(`slot ${k} read back differently: read again`);
    }
    return px;
  }

  /** SSTV-4.5: `px` (320 x 256 RGB565) into slot `k` (0 or 1) as a picture to send named after `file`. */
  async write(k: number, px: Uint8Array, file: string): Promise<void> {
    const link = radio.connectedLink;
    if (!link) return;
    this.error = this.notice = "";
    if (!canWrite()) {
      this.error = `Writing pictures needs Ferrite ${PICTURES_FROM} or newer.`;
      return;
    }
    if (radio.kind !== "cable") {
      this.error = "Pictures are written over the cable only: connect the radio by its cable.";
      return;
    }
    const h = sendHeader(file);
    const { body, header } = writePlan(k, px, h);
    radio.busy = this.busy = `Writing picture ${k + 1}`;
    this.total = body.length + header.length;
    this.done = 0;
    try {
      for (const op of body) {
        await link.data(P.msg.DATA_WRITE, op.payload);
        this.done++;
      }
      // the pixels checked before the header goes on: a picture that didn't write stays an empty slot
      if ((await link.dataCrc(pixelsAddr(k), px.length)) !== crc32(px)) throw new Error("the picture read back differently: write it again");
      for (const op of header) {
        await link.data(P.msg.DATA_WRITE, op.payload);
        this.done++;
      }
      if (decodeHeader(await link.dataRead(slotAddr(k), HEADER_LEN))?.name !== h.name) throw new Error("its header read back differently: write it again");
      this.kept.set(k, { key: "", px });
      const slots = (this.slots ?? Array.from({ length: SLOTS }, (_, i): Slot => ({ k: i, header: null, px: null, rows: 0 }))).slice();
      slots[k] = { k, header: h, px, rows: H };
      this.slots = slots;
      this.notice = `Wrote "${h.name}" as picture ${k + 1} to send.`;
    } catch (e) {
      this.error = `The picture didn't write: ${(e as Error).message}`;
    } finally {
      radio.busy = this.busy = "";
    }
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const pictures = new Pictures();
