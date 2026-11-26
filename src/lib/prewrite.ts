// The radio as it was just before a write (LINK-21.2, console#43): every Write reads the radio first and Console keeps
// that read here, in memory, until it closes; never a file by itself (each write used to download a backup, and the
// downloads filled with near-identical copies). The write dialog offers it back: "Put the radio back" loads it into
// its page and writes it (the usual diff and confirm), "Save this backup…" saves it as a .ferrite (codeplug.svelte.ts).
// The newest few per kind, as codeplug parts (the .ferrite's JSON, so Open… and the save read them as any other).
// Pure: no Svelte state (tests/unit/prewrite.test.ts); the write dialogs show it through their write step.
import type { Parts } from "./codeplug.ts";

/** What a write puts on the radio, and so what its kept read holds: the page's part (channels carry the presets). */
export type PrewriteKind = "channels" | "settings" | "aprs" | "quick" | "waypoints" | "dtmf";

/** One read kept: when, from which radio (its label), and the parts as a .ferrite holds them. */
export type Kept = { id: number; kind: PrewriteKind; at: Date; radio: string; parts: Parts };

/** Reads kept per kind: this write's, and a couple before it (a put-back is itself a write, and keeps its own). */
export const KEEP = 3;

export class Prewrite {
  #kept: Kept[] = [];
  #next = 1;

  /** The read a write just made, kept; the oldest of its kind past KEEP dropped. */
  keep(kind: PrewriteKind, parts: Parts, radio: string, at = new Date()): Kept {
    const k: Kept = { id: this.#next++, kind, at, radio, parts };
    const mine = this.#kept.filter((x) => x.kind === kind);
    const drop = new Set(mine.slice(0, Math.max(0, mine.length + 1 - KEEP)).map((x) => x.id));
    this.#kept = [...this.#kept.filter((x) => !drop.has(x.id)), k];
    return k;
  }

  /** The newest kept read of a kind, or null. */
  newest(kind: PrewriteKind): Kept | null {
    return this.#kept.findLast((x) => x.kind === kind) ?? null;
  }

  /** Every kept read, oldest first. */
  all(): readonly Kept[] {
    return this.#kept;
  }

  get(id: number): Kept | null {
    return this.#kept.find((x) => x.id === id) ?? null;
  }
}

/** The session's kept reads (one Console window: kept until it closes). */
export const prewrite = new Prewrite();
