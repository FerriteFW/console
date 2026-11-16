// SSTV pictures on the radio (ferrite manual chapter 27a, SSTV-4, decisions 403 and 404): four slots in the SPI flash,
// past the stock bootloader's fonts (0x0E0000-0x15CFFF, never written), each a 64-byte header and 320 x 256 pixels in
// RGB565. Slot 0 holds the picture to send (Console writes it), 1 to 3 the three newest received. Pure: the slots' addresses, the header both ways, the pixels both ways, the cover crop, and
// the raw writes (`DATA_WRITE` ERASE and PROGRAM, LINK-60) that put a picture in a slot.

export const BASE = 0x15d000;
export const SLOT_SIZE = 0x29000;
export const SLOTS = 4;
/** Slot 0: the picture to send; 1 to 3: received. */
export const SEND_SLOTS = [0];
export const RECEIVED_SLOTS = [1, 2, 3];
export const SECTOR = 4096;
export const SECTORS = SLOT_SIZE / SECTOR; // 41
export const PIXELS_AT = 0x1000;
export const W = 320;
export const H = 256;
export const ROW = W * 2;
export const HEADER_LEN = 64;
/** `lines` while a picture is still being received. */
export const RECEIVING = 0xffff;
export const KIND_RECEIVED = 1;
export const KIND_SEND = 2;
const PAGE = 256;
/** The most bytes one PROGRAM carries (ferrite-core `link::data::PROGRAM_MAX`). */
const PROGRAM_MAX = 64;

/** The first Ferrite with the picture slots: before it any `DATA_WRITE` starts an update (LINK-61), so Console
 *  writes pictures only to this or newer (reading is safe on any). */
export const PICTURES_FROM = "0.9.1";

export const slotAddr = (k: number) => BASE + k * SLOT_SIZE;
export const pixelsAddr = (k: number) => slotAddr(k) + PIXELS_AT;

/** SSTV-2: the modes by their VIS code. */
export const MODES: Record<number, string> = { 8: "Robot 36", 44: "Martin M1", 60: "Scottie S1", 99: "PD90", 95: "PD120" };
export const modeName = (vis: number) => (vis === 0 ? "" : (MODES[vis] ?? `VIS ${vis}`));

export type Header = {
  kind: number;
  vis: number;
  flags: number;
  width: number;
  lines: number;
  /** UTC seconds, 0 unknown. */
  time: number;
  /** 10 Hz units, 0 none. */
  freq: number;
  name: string;
  seq: number;
};

/** Bit 0 of flags clear: the picture is complete. */
export const complete = (h: Header) => (h.flags & 1) === 0;

/** SSTV-4.3: the header from a slot's first bytes; null for an empty slot (no magic) or another format. */
export function decodeHeader(b: Uint8Array): Header | null {
  if (b.length < 40 || b[0] !== 0x53 || b[1] !== 0x53 || b[2] !== 0x54 || b[3] !== 0x56 || b[4] !== 1) return null;
  const d = new DataView(b.buffer, b.byteOffset, b.length);
  let name = "";
  for (let i = 20; i < 36 && b[i]; i++) name += String.fromCharCode(b[i]);
  return {
    kind: b[5],
    vis: b[6],
    flags: b[7],
    width: d.getUint16(8, true),
    lines: d.getUint16(10, true),
    time: d.getUint32(12, true),
    freq: d.getUint32(16, true),
    name,
    seq: d.getUint32(36, true),
  };
}

/** SSTV-4.3: 64 bytes, the rest 0xFF. */
export function encodeHeader(h: Header): Uint8Array {
  const b = new Uint8Array(HEADER_LEN).fill(0xff);
  const d = new DataView(b.buffer);
  b.set([0x53, 0x53, 0x54, 0x56, 1, h.kind, h.vis, h.flags]);
  d.setUint16(8, h.width, true);
  d.setUint16(10, h.lines, true);
  d.setUint32(12, h.time, true);
  d.setUint32(16, h.freq, true);
  b.fill(0, 20, 36);
  const n = asciiName(h.name);
  for (let i = 0; i < n.length; i++) b[20 + i] = n.charCodeAt(i);
  d.setUint32(36, h.seq, true);
  return b;
}

/** A name the header holds: printable ASCII, at most 16. */
export const asciiName = (s: string) => s.replace(/[^\x20-\x7e]/g, "").slice(0, 16);

/** A file's base name, for a picture to send: no folder, no extension, printable ASCII, at most 16. */
export const nameOf = (file: string) => asciiName((file.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, ""));

/** RGBA (a canvas's ImageData) to RGB565 little-endian, 2 bytes a pixel. */
export function toRgb565(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const n = rgba.length >> 2;
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = ((rgba[i * 4] >> 3) << 11) | ((rgba[i * 4 + 1] >> 2) << 5) | (rgba[i * 4 + 2] >> 3);
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = v >> 8;
  }
  return out;
}

/** RGB565 little-endian to RGBA (opaque), each channel's top bits repeated into its low ones. */
export function fromRgb565(px: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const n = px.length >> 1;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = px[i * 2] | (px[i * 2 + 1] << 8);
    const r = v >> 11, g = (v >> 5) & 63, b = v & 31;
    out[i * 4] = (r << 3) | (r >> 2);
    out[i * 4 + 1] = (g << 2) | (g >> 4);
    out[i * 4 + 2] = (b << 3) | (b >> 2);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * The part of a `w` x `h` picture that fills 320 x 256 (cover: scaled to fill, the overflow cut evenly from both
 * sides, never stretched): the source rectangle to draw.
 */
export function coverRect(w: number, h: number): { sx: number; sy: number; sw: number; sh: number } {
  if (w * H > h * W) {
    const sw = (h * W) / H;
    return { sx: (w - sw) / 2, sy: 0, sw, sh: h };
  }
  const sh = (w * H) / W;
  return { sx: 0, sy: (h - sh) / 2, sw: w, sh };
}

/** One raw write: its `DATA_WRITE` payload, and what it is (for progress). */
export type Op = { what: "erase" | "program"; addr: number; payload: Uint8Array };

const erase = (addr: number): Op => {
  const p = new Uint8Array(5);
  new DataView(p.buffer).setUint32(1, addr, true);
  return { what: "erase", addr, payload: p };
};

const program = (addr: number, bytes: Uint8Array): Op => {
  const p = new Uint8Array(5 + bytes.length);
  p[0] = 1;
  new DataView(p.buffer).setUint32(1, addr, true);
  p.set(bytes, 5);
  return { what: "program", addr, payload: p };
};

/** PROGRAMs for `bytes` at `addr`, aligned chunks of 64 inside one page; chunks all 0xFF skipped (erased already). */
function programs(addr: number, bytes: Uint8Array): Op[] {
  const out: Op[] = [];
  for (let o = 0; o < bytes.length; ) {
    const a = addr + o;
    const n = Math.min(PROGRAM_MAX - (a % PROGRAM_MAX), PAGE - (a % PAGE), bytes.length - o);
    const piece = bytes.subarray(o, o + n);
    if (piece.some((x) => x !== 0xff)) out.push(program(a, piece));
    o += n;
  }
  return out;
}

/**
 * SSTV-4.5: a picture to send into slot `k` (0): the slot's 41 sectors erased, the pixels programmed, the header
 * last (so a cut write leaves an empty slot, never a header over half a picture).
 */
export function writePlan(k: number, px: Uint8Array, h: Header): { body: Op[]; header: Op[] } {
  if (!SEND_SLOTS.includes(k)) throw new Error(`Slot ${k} isn't a slot to send from.`);
  if (px.length !== W * H * 2) throw new Error(`A picture is ${W * H * 2} bytes, not ${px.length}.`);
  const body: Op[] = [];
  for (let s = 0; s < SECTORS; s++) body.push(erase(slotAddr(k) + s * SECTOR));
  body.push(...programs(pixelsAddr(k), px));
  return { body, header: programs(slotAddr(k), encodeHeader(h)) };
}

/** The header of a picture to send (SSTV-4.5): complete, 320 x 256, the time now. */
export const sendHeader = (name: string, now = Date.now()): Header => ({
  kind: KIND_SEND,
  vis: 0,
  flags: 0xfe,
  width: W,
  lines: H,
  time: Math.floor(now / 1000),
  freq: 0,
  name: nameOf(name),
  seq: 0,
});
