// The Rust core (core/ through wasm/), loaded once. Everything protocol-shaped comes from here: framing, answers,
// the UI readback's parser, key codes, the unique ID's text. Structures arrive as JSON.
import init, * as wasm from "../core-wasm/core.js";

export type Answer = { ty: number; seq: number; status: number; rest: number[]; event?: boolean };

export type Build = { byte: number; name: string; bench: boolean; dry: boolean };
export type Hello = { protocol: number; max_payload: number; may_go_on: boolean; firmware: string; build: Build | null; caps: number };
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
  msg: Record<"HELLO" | "INFO" | "AUTH" | "READ" | "WRITE" | "DELETE" | "BEGIN" | "END" | "SLOT" | "BAUD" | "REBOOT" | "KEY" | "CMD" | "MORE" | "UI" | "READ_MANY" | "WRITE_MANY" | "LOG_READ" | "SUBSCRIBE" | "EVENT" | "HEARD" | "MSGS" | "MSG_SEND" | "MSG_STOP" | "AUDIO" | "AUDIO_DATA", number>;
  what: Record<"SETTINGS" | "CHANNEL" | "ZONE" | "PRESET" | "APRS", number>;
  event: Record<"SUB_HEARD" | "SUB_MSGS" | "SUB_UI" | "HEARD" | "MSG" | "MSG_STATE" | "UI" | "QUIET_MS" | "DICT", number>;
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

/** LINK-13.4: one receive-audio block's samples (8 kHz, 16-bit); empty for a keep-alive. */
export const audioDecode = (p: Uint8Array): Int16Array => wasm.audio_decode(p);
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
export type PlanOp = { kind: "write" | "delete"; what: "zone" | "channel" | "settings" | "aprs"; number: number; msg: number; payloads: number[][] };
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
/** Imported channels into a new zone at free numbers: `room` says why it can't (numbers, zones), `name_error` the name. */
export type ChirpNewZone = { channels: Channel[]; zone: Zone | null; numbers: string; room: string; name_error: string };
export const chirpNewZone = (channels: Channel[], table: ChannelSet, name: string): ChirpNewZone =>
  JSON.parse(wasm.chirp_new_zone(js(channels), js(table), name));
export const chirpZoneName = (file: string, zones: Zone[]): string => wasm.chirp_zone_name(file, js(zones));
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
export const backupName = (uid: string, date: string): string => wasm.backup_name(uid, date);
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
export type MsgState = "unread" | "read" | "pending" | "acked" | "retrying" | "failed" | "rejected" | "cancelled";
export type Message = { inbound: boolean; state: MsgState; state_n: number; tries: number; ago_s: number; peer: string; text: string };
export type AprsEvent =
  | { kind: "heard"; count: number; station: Station }
  | { kind: "message" | "message_state"; count: number; message: Message }
  | { kind: "ui" }
  | { kind: "unknown"; code: number };

export const parseHeard = (rest: Uint8Array): { count: number; stations: Station[] } | null => JSON.parse(wasm.parse_heard(rest));
export const parseMsgs = (rest: Uint8Array): { count: number; messages: Message[] } | null => JSON.parse(wasm.parse_msgs(rest));
export const parseEvent = (payload: Uint8Array): AprsEvent | null => JSON.parse(wasm.parse_event(payload));
/** MSG_SEND's payload; throws Console's copy of the radio's rules (the radio checks again). */
export const msgSendPayload = (to: string, text: string): Uint8Array => wasm.msg_send_payload(to, text);
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
