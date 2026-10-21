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

// Phase 2: channels and zones. Record layouts, the views, the write plan (dry-run through ferrite's own link
// session), backups and CHIRP CSV are all the core's (core/src/channels.rs, plan.rs, chirp.rs).

export type Channel = {
  number: number;
  name: string;
  rx: string;
  duplex: string;
  offset: string;
  mode: string;
  rx_tone: string;
  tx_tone: string;
  power: string;
  step: string;
  squelch: string;
  zone: number | null;
  busy: boolean;
  reverse: boolean;
  skip: boolean;
  aprs: boolean;
  rx_only: boolean;
  hidden: boolean;
  priority: boolean;
  end_tone: string;
  tail: string;
  keep: number;
};
export type Zone = {
  number: number;
  name: string;
  scan_all: boolean;
  shown: boolean;
  by_distance: boolean;
  resume: string;
  dwell: string;
  pri1: number | null;
  pri2: number | null;
};
export type ChannelSet = { zones: Zone[]; channels: Channel[] };
export type Choices = {
  modes: string[];
  powers: string[];
  steps: string[];
  endTones: string[];
  tails: string[];
  resumes: string[];
  duplex: string[];
  squelch: string[];
  ctcss: string[];
  dcs: string[];
  maxChannels: number;
  maxZones: number;
};
export type Field = { field: string; from: string; to: string };
export type Change = { what: "zone" | "channel"; number: number; kind: "added" | "changed" | "deleted"; name: string; fields: Field[] };
export type Problem = { what: string; number: number; error: string };
export type PlanOp = { kind: "write" | "delete"; what: "zone" | "channel" | "settings"; number: number; msg: number; payloads: number[][] };
export type Plan = { changes: Change[]; begin: number[]; ops: PlanOp[]; problems: Problem[] };
export type ChirpImport = { channels: Channel[]; notes: string[]; skipped: number };

const js = JSON.stringify;
export const channelChoices = (): Choices => JSON.parse(wasm.channel_choices());
export const decodeSet = (zones: Uint8Array[], channels: Uint8Array[]): { set: ChannelSet; bad: string[] } =>
  JSON.parse(wasm.decode_set(js(zones.map((z) => [...z])), js(channels.map((c) => [...c]))));
export const normalizeChannel = (c: Channel): Channel => JSON.parse(wasm.normalize_channel(js(c)));
export const normalizeZone = (z: Zone): Zone => JSON.parse(wasm.normalize_zone(js(z)));
export const checkChannel = (c: Channel, zones: number): string | undefined => wasm.check_channel(js(c), zones) ?? undefined;
export const newChannel = (number: number, rxMhz: string): Channel => JSON.parse(wasm.new_channel(number, rxMhz));
export const newZone = (number: number, name: string): Zone => JSON.parse(wasm.new_zone(number, name));
export const writePlan = (base: ChannelSet, want: ChannelSet): Plan => JSON.parse(wasm.write_plan(js(base), js(want)));
export const backupFile = (set: ChannelSet, saved: string, radio: Record<string, string>) => wasm.backup_file(js(set), saved, js(radio));
export const restoreFile = (text: string): { set: ChannelSet; saved: string; radio: Record<string, string> } =>
  JSON.parse(wasm.restore_file(text));
export const chirpExport = (set: ChannelSet) => wasm.chirp_export(js(set));
export const chirpImport = (text: string, zones: Zone[]): ChirpImport => JSON.parse(wasm.chirp_import(text, js(zones)));
export const recordReader = (what: number, index: number) => new wasm.RecordReader(what, index);

// The channel library ("Add channels": core/src/library.rs): entries to channels and zones through ferrite's checks,
// places, distances, airport names, TAFL groups.

export type LibraryItem = {
  name: string;
  rx: number;
  tx?: number | null;
  mode: "FM" | "NFM" | "AM";
  power?: string | null;
  rx_only?: boolean;
  zone: string;
  tone?: string | null;
};
export type LibraryAdded = { channels: Channel[]; zones: Zone[]; notes: string[]; skipped: number; made_rx_only: number };
export type Place = { lat: number; lon: number; grid: string };

export const libraryAdd = (items: LibraryItem[], table: ChannelSet): LibraryAdded => JSON.parse(wasm.library_add(js(items), js(table)));
export const libraryFixedItems = (set: unknown, picks: number[], zone: string): LibraryItem[] =>
  JSON.parse(wasm.library_fixed_items(js(set), js(picks), zone));
export const parsePlace = (text: string): Place | null => {
  const p = wasm.parse_place(text);
  return p ? JSON.parse(p) : null;
};
/** Indices of `coords` (lat, lon back to back) within `radiusKm`, nearest first, with their distances. */
export const near = (p: { lat: number; lon: number }, radiusKm: number, coords: Float64Array, limit: number): { i: number; km: number }[] => {
  const flat = wasm.near(p.lat, p.lon, radiusKm, coords, limit);
  const out: { i: number; km: number }[] = [];
  for (let k = 0; k < flat.length; k += 2) out.push({ i: flat[k], km: flat[k + 1] });
  return out;
};
export const airportType = (code: string, khz: number): string => wasm.airport_type(code, khz);
export const airportName = (icao: string, type: string, khz: number, repeat: boolean): string => wasm.airport_name(icao, type, khz, repeat);
export const taflGroups = (names: string[]): string[] => JSON.parse(wasm.tafl_groups(js(names)));

// Radio Settings: the settings record as the radio's menu shows it (core/src/settings.rs: ferrite's own App and
// link session decide the values, choices and checks).

export type SettingKind = "pick" | "level" | "text" | "readonly";
export type SettingItem = {
  id: string;
  path: string;
  name: string;
  sub: string;
  help: string;
  value: string;
  changed: boolean;
  kind: SettingKind;
  choices: string[];
  hint: string;
  note: string;
};
export type SettingsGroup = { path: string; name: string; items: SettingItem[]; note: string };
export type SettingsView = { groups: SettingsGroup[]; notes: string[] };
export type SettingChange = { id: string; path: string; group: string; name: string; from: string; to: string };
export type SettingsPlan = { changes: SettingChange[]; begin: number[]; ops: PlanOp[]; problems: Problem[] };

export const settingsView = (record: Uint8Array): SettingsView => JSON.parse(wasm.settings_view(record));
/** The record with one setting changed, or throws the radio's reason. */
export const settingsSet = (record: Uint8Array, id: string, value: string): Uint8Array => wasm.settings_set(record, id, value);
export const settingsPlan = (base: Uint8Array, want: Uint8Array): SettingsPlan => JSON.parse(wasm.settings_plan(base, want));
export const settingsLen = () => wasm.settings_len();
export const settingsBackup = (record: Uint8Array, saved: string, radio: Record<string, string>) => wasm.settings_backup(record, saved, js(radio));
export const settingsRestore = (text: string): { record: number[]; saved: string; radio: Record<string, string> } =>
  JSON.parse(wasm.settings_restore(text));
