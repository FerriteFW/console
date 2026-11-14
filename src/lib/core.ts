// The Rust core (core/ through wasm/), loaded once. Everything protocol-shaped comes from here: framing, answers,
// the UI readback's parser, key codes, the unique ID's text. Structures arrive as JSON.
import init, * as wasm from "../core-wasm/core.js";

export type Answer = { ty: number; seq: number; status: number; rest: number[]; event?: boolean };

export type Build = { byte: number; name: string; bench: boolean; dry: boolean };
/** LINK-62: the layout this firmware stores and the one the chip's data is in (they differ while it waits for
 *  Console to move the data: the radio shows D25 "Finish the update", UPD-16). */
export type Layouts = { firmware: number; chip: number };
/** HELLO's answer. A radio on another protocol than `P.protocol` (decision 385) gives only its version and build:
 *  `caps` 0, `layouts` and `lists_gen` null; Console then offers nothing but the update. */
export type Hello = {
  protocol: number;
  max_payload: number;
  may_go_on: boolean;
  firmware: string;
  build: Build | null;
  /** LINK-35.2: `P.caps` bits (compression granted, receive audio on this port, line commands). */
  caps: number;
  layouts: Layouts | null;
  /** LINK-71: the lists hash (from the stored channels, zones and range presets; the same across restarts when nothing changed). */
  lists_gen: number | null;
};
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
  /** LINK-62. */
  layouts: Layouts | null;
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
  /** LINK-19.5: the screen as drawn (texts and coloured fills, in drawing order) when asked for; none on home. */
  items?: ScreenItem[];
};
/** LINK-19.5: a text in its line box (font id, RGB565 colours; bg null on the screen's own background) or a fill. */
export type ScreenItem =
  | { k: "t"; x: number; y: number; w: number; h: number; font: number; fg: number; bg: number | null; s: string }
  | { k: "r"; x: number; y: number; w: number; h: number; c: number }
  | { k: "o"; x: number; y: number; w: number; h: number; c: number };
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
  msg: Record<"HELLO" | "INFO" | "AUTH" | "READ" | "WRITE" | "DELETE" | "BEGIN" | "END" | "SLOT" | "BAUD" | "REBOOT" | "KEY" | "CMD" | "MORE" | "UI" | "READ_MANY" | "WRITE_MANY" | "LOG_READ" | "SUBSCRIBE" | "EVENT" | "HEARD" | "MSGS" | "MSG_SEND" | "MSG_STOP" | "MSG_DELETE" | "AUDIO" | "AUDIO_DATA" | "DATA_READ" | "DATA_WRITE" | "CLOCK" | "STATE" | "TUNE" | "BEACON", number>;
  /** LINK-59: `DATA_READ`'s ops and its most bytes, and the erase unit. */
  data: { READ: number; CRC: number; READ_MAX: number; SECTOR: number };
  what: Record<"SETTINGS" | "CHANNEL" | "ZONE" | "PRESET" | "APRS" | "POSITION" | "QUICK" | "WAYPOINT" | "DTMF" | "PRESET_SKIPS" | "SAT" | "SAT_INFO" | "RADIO", number>;
  /** The link protocol this Console speaks (decision 385: 1 until Ferrite 0.9; a radio on another is only updated). */
  protocol: number;
  /** LINK-35.2: HELLO's capability bits (only what differs by build or session). */
  caps: Record<"LZ" | "AUDIO" | "LINE_CMDS", number>;
  /** What the radio holds (layout 3, decision 333): 4,000 channels, 512 zones, 256 channels a zone, 1,016 contacts,
   *  2,032 waypoints. */
  limits: { channels: number; zones: number; zoneCap: number; contacts: number; waypoints: number; sats: number };
  /** LINK-55: the index a new waypoint is written at (it becomes the newest). */
  waypointAdd: number;
  /** LINK-63: WRITE_MANY of `what::SAT` with length 0 at this index clears every satellite. */
  satAll: number;
  event: Record<"SUB_HEARD" | "SUB_MSGS" | "SUB_UI" | "SUB_LOG" | "SUB_STATE" | "STATE" | "LOG" | "HEARD" | "MSG" | "MSG_STATE" | "UI" | "QUIET_MS" | "DICT", number>;
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

/** LINK-13.4: one receive-audio block's samples (12 kHz µ-law decoded, 16-bit); empty for a keep-alive. */
export const audioDecode = (p: Uint8Array): Int16Array => wasm.audio_decode(p);
export const statusText = (s: number, rest: Uint8Array = new Uint8Array()) => wasm.status_text(s, rest);
export const helloPayload = (name: string) => wasm.hello_payload(name);
/** HELLO's payload without asking for compression (a radio on another protocol: its caps can't be read). */
export const helloPayloadPlain = (name: string) => wasm.hello_payload_lz(name, false);
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
  /** CHAN-2, LINK-53: where the channel is, [lat, lon] in degrees (1e-7 at most); absent when it has none. */
  pos?: [number, number];
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
  /** CHAN-35: the most channels a zone holds (256). */
  zoneCap: number;
};
export type Field = { field: string; from: string; to: string };
export type Change = { what: "zone" | "channel" | "preset"; number: number; kind: "added" | "changed" | "deleted"; name: string; fields: Field[] };
export type Problem = { what: string; number: number; error: string };
export type PlanOp = { kind: "write" | "delete"; what: "zone" | "channel" | "preset" | "settings" | "aprs"; number: number; msg: number; payloads: number[][] };
/** `positions`: the channels whose position changes (LINK-53), sent after the ops to a radio that can store them. */
export type Plan = { changes: Change[]; begin: number[]; ops: PlanOp[]; problems: Problem[]; positions: number[] };
export type ChirpImport = { channels: Channel[]; notes: string[]; skipped: number };

const js = JSON.stringify;
export const channelChoices = (): Choices => JSON.parse(wasm.channel_choices());
export const decodeSet = (zones: Uint8Array[], channels: Uint8Array[]): { set: ChannelSet; bad: string[] } =>
  JSON.parse(wasm.decode_set(js(zones.map((z) => [...z])), js(channels.map((c) => [...c]))));
export const normalizeChannel = (c: Channel): Channel => JSON.parse(wasm.normalize_channel(js(c)));
/** The TX frequency and the repeater shift as shown (shift "" for simplex or a TX more than 10 MHz away). */
export const channelTx = (c: Channel): { tx: string; shift: string } => JSON.parse(wasm.channel_tx(js(c)));
/** The channel with its TX typed, or its shift typed; throws why not. */
export const channelWithTx = (c: Channel, tx: string): Channel => JSON.parse(wasm.channel_with_tx(js(c), tx));
export const channelWithShift = (c: Channel, shift: string): Channel => JSON.parse(wasm.channel_with_shift(js(c), shift));
export const normalizeZone = (z: Zone): Zone => JSON.parse(wasm.normalize_zone(js(z)));
export const checkChannel = (c: Channel, zones: number): string | undefined => wasm.check_channel(js(c), zones) ?? undefined;
export const newChannel = (number: number, rxMhz: string): Channel => JSON.parse(wasm.new_channel(number, rxMhz));
export const newZone = (number: number, name: string): Zone => JSON.parse(wasm.new_zone(number, name));
/** A position as typed or stored: [lat, lon] in degrees (null for none), its text to five decimals, its grid square. */
export type PositionView = { pos: [number, number] | null; text: string; grid: string };
/** CHAN-2: a typed position ("45.4215, -75.6972", "FN25dk"; empty or "none" for none); throws with why not. */
export const parsePosition = (text: string): PositionView => JSON.parse(wasm.parse_position(text));
export const positionView = (pos: [number, number] | null | undefined): PositionView => JSON.parse(wasm.position_view(js(pos ?? null)));
/** LINK-53: `WRITE_MANY` what 7's record for a position (0 bytes clears it), and a read one back. */
export const positionRecord = (pos: [number, number] | null | undefined): Uint8Array => wasm.position_record(js(pos ?? null));
export const positionFromRecord = (rec: Uint8Array): [number, number] | null => {
  const p = wasm.position_from_record(rec);
  return p ? JSON.parse(p) : null;
};
export const writePlan = (base: ChannelSet, want: ChannelSet): Plan => JSON.parse(wasm.write_plan(js(base), js(want)));
export const backupFile = (set: ChannelSet, saved: string, radio: Record<string, string>) => wasm.backup_file(js(set), saved, js(radio));
export const restoreFile = (text: string): { set: ChannelSet; saved: string; radio: Record<string, string> } =>
  JSON.parse(wasm.restore_file(text));
export const chirpExport = (set: ChannelSet) => wasm.chirp_export(js(set));
export const chirpImport = (text: string, zones: Zone[]): ChirpImport => JSON.parse(wasm.chirp_import(text, js(zones)));
/** Imported channels into a new zone at free numbers: `room` says why it can't (numbers, zones), `name_error` the name. */
/** `zones`: one new zone, or (more than 256 channels, CHAN-35) one per 256: "Repeaters 1", "Repeaters 2", ... */
export type ChirpNewZone = { channels: Channel[]; zones: Zone[]; numbers: string; room: string; name_error: string };
export const chirpNewZone = (channels: Channel[], table: ChannelSet, name: string): ChirpNewZone =>
  JSON.parse(wasm.chirp_new_zone(js(channels), js(table), name));
export const chirpZoneName = (file: string, zones: Zone[]): string => wasm.chirp_zone_name(file, js(zones));
export const recordReader = (what: number, index: number) => new wasm.RecordReader(what, index);

// Range presets (MENU 0 1 4, LINK-21's what 4: core/src/presets.rs). A preset's skipped frequencies (SCAN-10) aren't in
// the link's record: the radio keeps them with the preset it holds, so `origin` (the number a preset was read as)
// says which preset is which, and the plan never moves a kept one to another's place.

export type Preset = {
  number: number;
  name: string;
  low: string;
  high: string;
  step: string;
  mode: string;
  resume: string;
  /** The number it was read as; absent for one added here (or opened from a file). */
  origin?: number;
  /** SCAN-10, LINK-58: its skipped frequencies (10 Hz), in the radio's order; empty when none or not read. */
  skips: number[];
};
export type PresetChoices = { steps: string[]; modes: string[]; resumes: string[]; max: number; nameLen: number; skipsMax: number };
/** `skips`: LINK-58's skip list records `[index, bytes]`, written after the ops. */
export type PresetPlan = { changes: Change[]; begin: number[]; ops: PlanOp[]; problems: Problem[]; skips: [number, number[]][] };

export const presetChoices = (): PresetChoices => JSON.parse(wasm.preset_choices());
export const decodePresets = (records: Uint8Array[]): { presets: Preset[]; bad: string[] } =>
  JSON.parse(wasm.decode_presets(js(records.map((r) => [...r]))));
/** A preset as the radio would hold it; throws the radio's reason. */
export const normalizePreset = (p: Preset): Preset => JSON.parse(wasm.normalize_preset(js(p)));
export const checkPreset = (p: Preset): string | undefined => wasm.check_preset(js(p)) ?? undefined;
export const newPreset = (number: number, name: string): Preset => JSON.parse(wasm.new_preset(number, name));
export const presetsPlan = (base: Preset[], want: Preset[]): PresetPlan => JSON.parse(wasm.presets_plan(js(base), js(want)));
/** A skipped frequency typed in MHz, as 10 Hz; undefined if it isn't one. */
export const presetSkipParse = (text: string): number | undefined => wasm.preset_skip_parse(text) ?? undefined;
/** LINK-58: `WRITE_MANY` what 11's record for a skip list, and a read one back (10 Hz each). */
export const presetSkipsRecord = (f: number[]): Uint8Array => wasm.preset_skips_record(js(f));
export const presetSkipsFromRecord = (rec: Uint8Array): number[] | null => {
  const t = wasm.preset_skips_from_record(rec);
  return t ? JSON.parse(t) : null;
};
/** 10 Hz units as MHz text, five decimals ("146.52000"), as the radio lists them. */
export const mhzText = (f: number) => `${Math.floor(f / 100_000)}.${String(f % 100_000).padStart(5, "0")}`;

// The owner's lists (core/src/lists.rs, LINK-54 – LINK-56): quick messages, waypoints, DTMF memories. Records and
// checks are ferrite's (the checks run its own link session).

/** TEXT-7: `own` false is the factory text (`text` then the radio's). */
export type QuickMessage = { own: boolean; text: string };
/** GPS-10: lat and lon in 1e-7 degree; source "marked", "aprs", "link" or "grid". */
export type Waypoint = { name: string; lat: number; lon: number; source: string };
/** DTMF-12: symbols 0-9 A-D * #, a name of up to 10. */
export type DtmfMemory = { symbols: string; name: string };

const parsed = <T>(t: string | undefined): T | null => (t ? JSON.parse(t) : null);
export const quickFactory = (): string[] => JSON.parse(wasm.quick_factory());
export const quickRecord = (q: QuickMessage): Uint8Array => wasm.quick_record(js(q));
export const quickFromRecord = (rec: Uint8Array): QuickMessage | null => parsed(wasm.quick_from_record(rec));
export const quickCheck = (q: QuickMessage): string | undefined => wasm.quick_check(js(q)) ?? undefined;
/** `null` deletes the waypoint at its index (an empty record). */
export const waypointRecord = (w: Waypoint | null): Uint8Array => wasm.waypoint_record(js(w));
export const waypointFromRecord = (rec: Uint8Array): Waypoint | null => parsed(wasm.waypoint_from_record(rec));
export const waypointCheck = (w: Waypoint): string | undefined => wasm.waypoint_check(js(w)) ?? undefined;
/** LINK-55: the writes (index, record), in order, that take the radio's waypoints `old` to `want` (newest first). */
export const waypointWrites = (old: Waypoint[], want: Waypoint[]): { index: number; record: Uint8Array }[] =>
  (JSON.parse(wasm.waypoint_writes(js(old), js(want))) as [number, number[]][]).map(([index, r]) => ({ index, record: new Uint8Array(r) }));
/** `null` clears the memory and its name. */
export const dtmfRecord = (m: DtmfMemory | null): Uint8Array => wasm.dtmf_record(js(m));
export const dtmfFromRecord = (rec: Uint8Array): DtmfMemory | null => parsed(wasm.dtmf_from_record(rec));
export const dtmfCheck = (m: DtmfMemory): string | undefined => wasm.dtmf_check(js(m)) ?? undefined;
// Satellite mode (LINK-63 – LINK-65, SAT-2, SAT-18, SAT-21): core/src/sats.rs and wmm.rs.

/** A transponder as the lists show it: Hz; tones as text ("" none); kind Voice, APRS or Beacon. */
export type SatTp = { desc: string; kind: string; up: number; down: number; tone: string; arm: string };
/** A satellite (the file's, or one the radio holds): `short` is its name on the radio; `epoch` UTC seconds; `record`
 *  the radio's 152 bytes; `dropped` the file's transmitters the radio can't use. */
export type SatRow = { id: number; name: string; short: string; status: string; epoch: number; tps: SatTp[]; dropped: number; record: number[] };
/** sats.json read: `built` UTC seconds of its build date. */
export type SatsFile = { built: number; built_text: string; licence: string; attribution: string; sats: SatRow[]; skipped: string[] };
/** LINK-64: the declination (0.1°, east positive; null none), the data's build time and when Console wrote. */
export type SatInfo = { decl: number | null; stamp: number; written: number };
/** LINK-65: the radio's UTC (0 none) and its source. */
export type RadioClock = { now: number; source: "none" | "GPS" | "set" };

export const satsParse = (json: string): SatsFile => JSON.parse(wasm.sats_parse(json));
export const satHeld = (rec: Uint8Array): SatRow | null => parsed(wasm.sat_held(rec));
/** SAT-21: the radio's records again from the file (by NORAD number, in the radio's order). */
export const satsRefresh = (file: string, held: Uint8Array[]): Uint8Array[] => {
  const flat = new Uint8Array(held.reduce((n, r) => n + r.length, 0));
  let o = 0;
  for (const r of held) {
    flat.set(r, o);
    o += r.length;
  }
  const out = wasm.sats_refresh(file, flat);
  const recs: Uint8Array[] = [];
  for (let i = 0; i + 152 <= out.length; i += 152) recs.push(out.slice(i, i + 152));
  return recs;
};
export const satInfoRecord = (decl: number | null, stamp: number, written: number): Uint8Array => wasm.sat_info_record(decl ?? 0x7fff, stamp, written);
export const satInfoOf = (rec: Uint8Array): SatInfo | null => parsed(wasm.sat_info_of(rec));
export const satsSyncDue = (built: number, held: number, info: SatInfo | null, now: number): boolean => wasm.sats_sync_due(built, held, js(info), now);
export const clockOf = (rest: Uint8Array): RadioClock | null => parsed(wasm.clock_of(rest));
/** SAT-18: the WMM2025 declination at a place and time (UTC seconds), 0.1° east positive. */
export const wmmDeclination = (lat: number, lon: number, unix: number): number => wasm.wmm_declination(lat, lon, unix);

/** `.ferrite`'s presets.json (docs/dev/codeplug-format.md). */
export const presetsFile = (list: Preset[], saved: string, radio: Record<string, string>): string => wasm.presets_file(js(list), saved, js(radio));
export const presetsRestore = (text: string): { presets: Preset[]; saved: string; radio: Record<string, string> } =>
  JSON.parse(wasm.presets_restore(text));

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
  /** The receive tone when it differs from `tone` ("off": none). */
  rx_tone?: string | null;
  /** [lat, lon] in degrees: the channel's position (airports, TAFL sites). */
  pos?: [number, number] | null;
};
export type LibraryAdded = { channels: Channel[]; zones: Zone[]; notes: string[]; skipped: number; made_rx_only: number };
export type Place = { lat: number; lon: number; grid: string };

/** `split`: past a zone's 256 channels (CHAN-35) the rest go on in new zones (" 2", " 3"), else they're skipped. */
export const libraryAdd = (items: LibraryItem[], table: ChannelSet, split = true): LibraryAdded => JSON.parse(wasm.library_add(js(items), js(table), split));

// CHAN-35: a zone holds 256 channels at most (core/src/zonecap.rs).
export type ZoneOver = { number: number; name: string; count: number };
export type ZoneSplit = { set: ChannelSet; notes: string[]; made: number; unzoned: number };
/** The table's zones over 256 channels. */
export const zoneOverCap = (t: ChannelSet): ZoneOver[] => JSON.parse(wasm.zone_over_cap(js(t)));
/** The table with each zone over 256 split over new zones (" 2", " 3"), as the radio's own update splits one. */
export const zoneSplit = (t: ChannelSet): ZoneSplit => JSON.parse(wasm.zone_split(js(t)));
/** Why channels `numbers` can't all go into zone `zone` (its index; null no zone), or "" when they can. */
export const zoneRoom = (t: ChannelSet, numbers: number[], zone: number | null): string => wasm.zone_room(js(t), js(numbers), zone ?? -1);
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
export const orgGroups = (names: string[]): string[] => JSON.parse(wasm.org_groups(js(names)));

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
/** The record's write (`ops`) and the terminal's `set` lines for the settings no record carries (`cmds`, sent after). */
export type SettingsPlan = { changes: SettingChange[]; begin: number[]; ops: PlanOp[]; cmds: string[]; problems: Problem[] };
/** The settings no record carries (Watch, Battery Save, MENU 0 5's symbol, comment, telemetry ...), by menu number, as
 * the radio's `dump` writes them: read with `dump` and written with `set` over the link (CMD). */
export type Extras = Record<string, string>;
export type Edited = { record: Uint8Array; extras: Extras };
const edited = (s: string): Edited => {
  const r = JSON.parse(s);
  return { record: new Uint8Array(r.record), extras: r.extras };
};
export type Restored = { record: number[]; extras: Extras; saved: string; radio: Record<string, string> };

/** CHAN-17: the home channel the settings record names (1-1000), or null. */
export const settingsHome = (record: Uint8Array): number | null => wasm.settings_home(record) ?? null;
/** CHAN-17 (decision 347): `record` with its home channel set (1-1000, or null for none). */
export const settingsWithHome = (record: Uint8Array, home: number | null): Uint8Array => wasm.settings_with_home(record, home ?? undefined);
export const settingsView = (record: Uint8Array, extras: Extras): SettingsView => JSON.parse(wasm.settings_view(record, js(extras)));
/** The record and values with one setting changed, or throws the radio's reason. */
export const settingsSet = (record: Uint8Array, extras: Extras, id: string, value: string): Edited =>
  edited(wasm.settings_set(record, js(extras), id, value));
export const settingsPlan = (base: Uint8Array, baseEx: Extras, want: Uint8Array, wantEx: Extras): SettingsPlan =>
  JSON.parse(wasm.settings_plan(base, js(baseEx), want, js(wantEx)));
export const settingsLen = () => wasm.settings_len();
export const settingsBackup = (record: Uint8Array, extras: Extras, saved: string, radio: Record<string, string>) =>
  wasm.settings_backup(record, js(extras), saved, js(radio));
/** The .ferrite codeplug's settings.json: the backup without the PIN lock (docs/dev/codeplug-format.md). */
export const settingsCodeplugPart = (record: Uint8Array, extras: Extras, saved: string, radio: Record<string, string>) =>
  wasm.settings_codeplug_part(record, js(extras), saved, js(radio));
/** `record` with the PIN lock's fields from `from` (the radio's own record). */
export const settingsKeepPin = (record: Uint8Array, from: Uint8Array): Uint8Array => wasm.settings_keep_pin(record, from);
export const settingsRestore = (text: string): Restored => JSON.parse(wasm.settings_restore(text));
/** The terminal-backed values from a `dump`'s text. */
export const extrasFromDump = (text: string): Extras => JSON.parse(wasm.settings_extras_from_dump(text));
/** LINK-66 (decision 347): Watch and Battery Save from the radio record. */
export const extrasFromRadio = (rec: Uint8Array): Extras => JSON.parse(wasm.settings_extras_from_radio(rec));
/** LINK-33 (decision 347): the library's tune as `SLOT`'s payload; throws the reason when it can't be one. */
export const slotTune = (slot: number, hz: number, mode: string, txTone: string, rxTone: string, shiftHz: number): Uint8Array =>
  wasm.library_slot_tune(slot, hz, mode, txTone, rxTone, shiftHz);
/** Where the dump's settings end (a line starting with it). */
export const dumpSettingsEnd = (): string => wasm.settings_dump_end();

// Firmware Update (core/src/firmware.rs): the .btf checks (tools/btf.py) and the stock bootloader's frames
// (tools/flash.py). The core only ever makes hello, model, count, the image's blocks and end.

export type FirmwareCheck = {
  file_len: number;
  blocks: number;
  image_len: number;
  ferrite: boolean;
  version: string | null;
  crc32: string;
  describe: string;
  problems: string[];
};
export type BootStep = { cmd: number; what: string; block: number | null; timeout_ms: number };

export const firmwareCheck = (btf: Uint8Array): FirmwareCheck => JSON.parse(wasm.firmware_check(btf));
export const bootProbe = () => wasm.boot_probe();
export const bootResultText = (r: number) => wasm.boot_result_text(r);
export const FirmwareUpdate = wasm.FirmwareUpdate;
export type FirmwareUpdate = wasm.FirmwareUpdate;
export const BootReader = wasm.BootReader;
export type BootReader = wasm.BootReader;

// The Install page (core/src/install.rs): the reader's backup (fdump), the SSB patch, back to stock (STOCK_RESTORE).

export type Region = { name: string; start: number; end: number; crc32: string };
export type BackupCheck = {
  size: number;
  sha256: string;
  crc32: string;
  cal_crc32: string;
  pending_update: boolean;
  regions: Region[];
  problems: string[];
};
export type ImageCheck = { blocks: number; image_len: number; version: string | null; crc32: string; sha256: string; problems: string[] };
export type SsbFound = { len: number; records: number; sha256: string; known: boolean };
export type FdStep = { send: number[]; nak: boolean; inflate: boolean; done: boolean; error: string | null; got: number };
export type RestoreStart = { chip: number; cal_crc32: number; ranges: [number, number][]; uid: string | null };
export type RestoreSummary = { ranges: [number, number][]; bytes: number; problems: string[]; ops: number; confirm_uid: string | null };

export const sha256Hex = (b: Uint8Array): string => wasm.sha256_hex(b);
/** A release signature (core/src/signature.rs): `signed` is its trusted comment; `error` says why it doesn't verify. */
export type SignatureCheck = { signed: string | null; error: string | null };
export const signatureCheck = (image: Uint8Array, minisig: string): SignatureCheck => JSON.parse(wasm.signature_check(image, minisig));
export const backupCheck = (b: Uint8Array): BackupCheck => JSON.parse(wasm.backup_check(b));
/** The Rust reader speaks fdumpz (BACKUP-9.6); hwtest's reader doesn't. */
export const readerHasFdumpz = (btf: Uint8Array): boolean => wasm.reader_has_fdumpz(btf);
export const imageCheck = (kind: "reader" | "stock", btf: Uint8Array): ImageCheck => JSON.parse(wasm.image_check(kind, btf));
export const readerLine = <T>(kind: "flash" | "sys" | "flashcrc", line: string): T | null => JSON.parse(wasm.reader_line(kind, line));
export const ssbExtract = (btf: Uint8Array): Uint8Array | undefined => wasm.ssb_extract(btf);
export const ssbDescribe = (patch: Uint8Array): SsbFound => JSON.parse(wasm.ssb_describe(patch));
export const restoreStart = (rest: Uint8Array): RestoreStart | null => JSON.parse(wasm.restore_start(rest));
/** The backup's file name, carrying the radio's ID (decision 263). */
export const backupName = (uid: string, date: string, marker: Uint8Array | null = null): string => wasm.backup_name(uid, date, marker ?? undefined);
/** BACKUP-12: stock's marker sector (0x080F0000) as the reader's `mdump 0x080F0000 16` answers it, or null. */
export const parseMdump = (text: string): Uint8Array | null => wasm.parse_mdump(text) ?? null;
/** The stock marker word (UV85 or BJ90, as read) in the 16 saved bytes, or null (erased or not stock's). */
export const markerWord = (m: Uint8Array): string | null => wasm.marker_word(m) ?? null;
/** The stock marker a backup's file name carries, as its 16 bytes, or null. */
export const nameMarker = (name: string): Uint8Array | null => wasm.name_marker(name) ?? null;
/** Whether a backup may go into the radio `radioUid` by its ID (decision 263). */
export const restoreIdCheck = (radioUid: string | null, backupUid: string | null, typed: string): { problems: string[]; confirm_uid: string | null } =>
  JSON.parse(wasm.restore_id_check(radioUid ?? undefined, backupUid ?? undefined, typed || undefined));
/** The radio ID a backup's file name carries, or null (a renamed file). */
export const nameUid = (name: string): string | null => wasm.name_uid(name) ?? null;
export const Fdump = wasm.Fdump;
export type Fdump = wasm.Fdump;
export const RestorePlan = wasm.RestorePlan;
export type RestorePlan = wasm.RestorePlan;

// APRS (core/src/aprs.rs, LINK-44 – LINK-46): the heard list, messages, events.

export type Station = {
  call: string;
  symbol: number;
  symbol_name: string;
  ago_s: number;
  times: number;
  lat: number | null;
  lon: number | null;
  course: number | null;
  speed: number | null;
  alt_m: number | null;
  path: string;
  comment: string;
};
/** APRS-23 (decision 397): a weather station's report, metric; null when the comment isn't one. */
export type Wx = { dir: number | null; wind_kmh: number | null; gust_kmh: number | null; temp_c: number | null; rain_mm: number | null; hum: number | null; hpa: number | null };
export const aprsWx = (comment: string): Wx | null => JSON.parse(wasm.aprs_wx(comment));
export type MsgState = "unread" | "read" | "pending" | "acked" | "retrying" | "failed" | "rejected" | "cancelled";
export type Message = { inbound: boolean; state: MsgState; state_n: number; tries: number; ago_s: number; peer: string; text: string };
export type AprsEvent =
  | { kind: "heard"; count: number; station: Station }
  | { kind: "message" | "message_state"; count: number; message: Message }
  | { kind: "ui" }
  /** LINK-57: an event logged on the radio (kind 5), as LOG_READ gives it. */
  | { kind: "log"; record: LogRecord }
  | { kind: "unknown"; code: number };

export const parseHeard = (rest: Uint8Array): { count: number; stations: Station[] } | null => JSON.parse(wasm.parse_heard(rest));
export const parseMsgs = (rest: Uint8Array): { count: number; messages: Message[] } | null => JSON.parse(wasm.parse_msgs(rest));
export const parseEvent = (payload: Uint8Array): AprsEvent | null => JSON.parse(wasm.parse_event(payload));

/** LINK-67: the radio state, as the core decodes `STATE`'s record. */
export type SlotNow = {
  slot: "A" | "B" | "C";
  on_channel: boolean;
  scanning: boolean;
  open: boolean;
  transmitting: boolean;
  aprs: boolean;
  broadcast: boolean;
  muted: boolean;
  off: boolean;
  /** As the radio shows it (1-based); null on the VFO. */
  channel: number | null;
  /** 0-based; -1 Local; null on a VFO. */
  zone: number | null;
  hz: number;
  mode: "FM" | "NFM" | "AM" | "WFM" | "";
  power: "Low" | "Mid" | "High" | "";
  /** dBm while the squelch is open. */
  dbm: number | null;
  name: string;
};
export type RadioNow = {
  active: number;
  transmitting: boolean;
  dry_tx: boolean;
  locked: boolean;
  battery_pct: number;
  battery_mv: number;
  battery_low: boolean;
  gps: "off" | "searching" | "fix";
  sats: number;
  pos: [number, number] | null;
  slots: SlotNow[];
};
export const stateParse = (rec: Uint8Array): RadioNow | null => JSON.parse(wasm.state_parse(rec));
/** A state event's body over the record kept (empty: none); undefined: ask `STATE` again. */
export const stateMerge = (prev: Uint8Array, body: Uint8Array): Uint8Array | undefined => wasm.state_merge(prev, body);
/** LINK-68: `TUNE`'s payload; throws with the reason when it can't be one. */
export type TuneOp = "channel" | "step" | "group" | "zone" | "scan";
export const tunePayload = (slot: number, op: TuneOp, value: number): Uint8Array => wasm.tune_payload(slot, op, value);
/** MSG_SEND's payload; throws Console's copy of the radio's rules (the radio checks again). */
export const msgSendPayload = (to: string, text: string): Uint8Array => wasm.msg_send_payload(to, text);
/** LINK-52: MSG_DELETE's payload for one message as MSGS listed it (its direction, station and text). */
export const msgDeletePayload = (inbound: boolean, peer: string, text: string): Uint8Array => wasm.msg_delete_payload(inbound, peer, text);
export const subscribePayload = (mask: number, gap: number, renew: boolean, texts = false): Uint8Array =>
  wasm.subscribe_payload(mask, gap, renew, texts);

// The event log (core/src/log.rs, LINK-42).

export type LogRecord = {
  seq: number;
  ago_s: number;
  source: string;
  slot: number;
  slot_name: string;
  unread: boolean;
  freq: number;
  mhz: string;
  id: number;
  x: number;
  y: number;
  lat: number | null;
  lon: number | null;
  name: string;
  text: string;
  detail: string;
};
export const logReadPayload = (before: number, max = 0): Uint8Array => wasm.log_read_payload(before, max);
export const parseLogPage = (rest: Uint8Array): { next: number; held: number; records: LogRecord[] } | null => JSON.parse(wasm.parse_log_page(rest));
export const logCsv = (records: LogRecord[], times: string[]): string => wasm.log_csv(js(records), js(times));

// Live View from the radio's UI events (core/src/liveview.rs, LINK-47, LINK-48).
export const LiveClient = wasm.LiveClient;
export type LiveClient = wasm.LiveClient;

// APRS settings (core/src/aprs_settings.rs, LINK-43): the APRS record as MENU 0 5 shows it, beside the radio's
// settings record (its region; empty for the defaults).

/** `elsewhere`: MENU 0 5's settings in the settings record, shown in Radio Settings ("0 5 3 APRS mode"). */
export type AprsView = { items: SettingItem[]; notes: string[]; elsewhere: string[] };
export const aprsView = (settings: Uint8Array, record: Uint8Array, extras: Extras): AprsView =>
  JSON.parse(wasm.aprs_view(settings, record, js(extras)));
export const aprsSet = (settings: Uint8Array, record: Uint8Array, extras: Extras, id: string, value: string): Edited =>
  edited(wasm.aprs_set(settings, record, js(extras), id, value));
export const aprsPlan = (settings: Uint8Array, base: Uint8Array, baseEx: Extras, want: Uint8Array, wantEx: Extras): SettingsPlan =>
  JSON.parse(wasm.aprs_plan(settings, base, js(baseEx), want, js(wantEx)));
export const aprsRecordLen = () => wasm.aprs_record_len();
export const aprsBackup = (settings: Uint8Array, record: Uint8Array, extras: Extras, saved: string, radio: Record<string, string>) =>
  wasm.aprs_backup(settings, record, js(extras), saved, js(radio));
export const aprsRestore = (text: string): Restored => JSON.parse(wasm.aprs_restore(text));

// Finish the update (LINK-59 – LINK-62, UPD-16): one layout's data to another; the translation, its writes and the
// PC's copy are the core's (core/src/migrate.rs).
export const MigrateCopy = wasm.MigrateCopy;
export type MigrateCopy = wasm.MigrateCopy;
export const MigratePlan = wasm.MigratePlan;
export type MigratePlan = wasm.MigratePlan;
/** A checked update file, `.ffw` (core/src/ffw.rs; ferrite decision 335): its image and its SPI parts' writes. */
export const FfwFile = wasm.FfwFile;
export type FfwFile = wasm.FfwFile;
export type FfwSummary = {
  version: string;
  build: string;
  kind: string;
  layout: number;
  /** The release's trusted comment; null for an unsigned file (the developer option). */
  signed: string | null;
  parts: { file: string; addr: number; size: number }[];
};
export type MigrateSummary = {
  notes: string[];
  summary: {
    channels: number;
    zones: number;
    zones_split: [string, number][];
    channels_unzoned_by_split: number;
    heard: number;
    messages: number;
    events: number;
    waypoints: number;
    contacts: number;
    scratch_applied: number;
  };
  regions: { name: string; start: number; len: number }[];
  steps: number;
};
/** The regions (`[start, len]`) to back up from a chip on `layout`, or null when Console doesn't know it. */
export const migrateRegions = (layout: number): [number, number][] | null => JSON.parse(wasm.migrate_regions(layout));
/** The CRC-32 an erased range of `len` bytes reads as. */
export const erasedCrc = (len: number): number => wasm.migrate_erased_crc(len);
/** CRC-32/ISO-HDLC, as DATA_READ's CRC. */
export const dataCrc32 = (b: Uint8Array): number => wasm.data_crc32(b);
