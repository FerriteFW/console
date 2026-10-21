// The Rust core (core/ through wasm/), loaded once. Everything protocol-shaped comes from here: framing, answers,
// the UI readback's parser, key codes, the unique ID's text. Structures arrive as JSON.
import init, * as wasm from "../core-wasm/core.js";

export type Answer = { ty: number; seq: number; status: number; rest: number[] };

export type Build = { byte: number; name: string; bench: boolean; dry: boolean };
export type Hello = { protocol: number; max_payload: number; may_go_on: boolean; firmware: string; build: Build | null };
export type Info = {
  firmware: string;
  channels: number;
  zones: number;
  presets: number;
  settings_len: number;
  region: number;
  callsign: string;
  build: Build | null;
  uid: number[] | null;
  uid_text: string | null;
};
export type TextChunk = { more: boolean; text: string; working: boolean };
export type Value = string | number;
export type Kv = Record<string, Value>;
export type Row = { num: number | null; name: string; value: string; sel: boolean; dot: boolean; grey: boolean; kv: Kv };
export type Note = { head: string; body: string };
export type UiLine = { kind: string; args: string[]; kv: Kv };
export type Ui = {
  lines: string[];
  screen: { id: string; name: string; title: string } | null;
  state: Kv;
  bar: Kv;
  toast: Note | null;
  popup: Note | null;
  qmenu: string[][];
  cards: Kv[];
  bcast: Record<string, Kv>;
  rows: Row[];
  sel: number | null;
  help: Note | null;
  hints: [string, string][];
  other: UiLine[];
};
export type Timing = {
  open_settle_ms: number;
  quiet_ms: number;
  cable_timeout_ms: number;
  ble_timeout_ms: number;
  busy_retry_ms: number;
  busy_sleep_ms: number;
  long_settle_ms: number;
  more_wait_ms: number;
  ble_chunk: number;
  ble_pace_ms: number;
  baud_switch_ms: number;
  baud_fallback_ms: number;
  cable_baud: number;
  cable_fast_rates: number[];
  hold_for_long_ms: number;
};
export type Protocol = {
  msg: Record<"HELLO" | "INFO" | "AUTH" | "READ" | "WRITE" | "DELETE" | "BEGIN" | "END" | "SLOT" | "BAUD" | "KEY" | "CMD" | "MORE" | "UI", number>;
  what: Record<"SETTINGS" | "CHANNEL" | "ZONE" | "PRESET", number>;
  knobMax: number;
  keys: string[];
  timing: Timing;
};

let ready: Promise<void> | null = null;
export let P: Protocol;

/** Loads the wasm core (once). */
export function loadCore(): Promise<void> {
  ready ??= init().then(() => {
    P = JSON.parse(wasm.protocol());
  });
  return ready;
}

export const Session = wasm.Session;
export type Session = wasm.Session;
export const DemoRadio = wasm.DemoRadio;
export type DemoRadio = wasm.DemoRadio;

export const statusText = (s: number, rest: Uint8Array = new Uint8Array()) => wasm.status_text(s, rest);
export const helloPayload = (name: string) => wasm.hello_payload(name);
export const authPayload = (pin: string) => wasm.auth_payload(pin);
export const baudPayload = (rate: number) => wasm.baud_payload(rate);
export const parseHello = (rest: Uint8Array): Hello | null => JSON.parse(wasm.parse_hello(rest));
export const parseInfo = (rest: Uint8Array): Info | null => JSON.parse(wasm.parse_info(rest));
export const parseTextChunk = (rest: Uint8Array): TextChunk | null => JSON.parse(wasm.parse_text_chunk(rest));
export const parseUi = (text: string): Ui => JSON.parse(wasm.parse_ui(text));
export const keyPayload = (name: string, action: "short" | "long" | "down" | "up") => wasm.key_payload(name, action);
export const knobPayloads = (steps: number): Uint8Array[] => {
  const flat = wasm.knob_payloads(steps);
  const out: Uint8Array[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push(flat.slice(i, i + 2));
  return out;
};
