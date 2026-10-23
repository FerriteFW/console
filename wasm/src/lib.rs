//! The core for the browser. Structures cross as JSON strings (the UI parses them); bytes as `Uint8Array`.

use ferrite_console_core::{
    answers, aprs, aprs_settings, channels, chirp, demo, firmware, install, keys, library, liveview, log, plan,
    records, session, settings, timing, ui, uid,
};
use wasm_bindgen::prelude::*;

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

/// A link session's framing (sans I/O): see `ferrite_console_core::session`.
#[wasm_bindgen]
pub struct Session(session::Session);

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Session {
        Session(session::Session::new())
    }

    /// Ctrl-C: the first bytes written.
    pub fn opening() -> Vec<u8> {
        session::Session::opening().to_vec()
    }

    pub fn discard(&mut self) {
        self.0.discard()
    }

    /// The 0x00 that gives the cable to the link (and resyncs).
    pub fn take_cable(&mut self, now_ms: f64) -> Vec<u8> {
        self.0.take_cable(now_ms).to_vec()
    }

    pub fn next_seq(&self) -> u8 {
        self.0.next_seq()
    }

    /// A request's wire bytes; its seq is the `next_seq()` read before.
    pub fn request(&mut self, ty: u8, payload: &[u8], now_ms: f64) -> Result<Vec<u8>, JsError> {
        self.0.request(ty, payload, now_ms).map(|r| r.wire).map_err(|_| JsError::new("payload too long"))
    }

    /// Bytes read; the answers completed, as JSON `[{ty, seq, status, rest: [..]}]`; events (LINK-46) carry
    /// `event: true`, `rest` their whole payload.
    pub fn feed(&mut self, bytes: &[u8]) -> String {
        json(&self.0.feed(bytes))
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

/// The demo radio (no hardware): bytes in, bytes out.
#[wasm_bindgen]
pub struct DemoRadio(demo::DemoRadio);

#[wasm_bindgen]
impl DemoRadio {
    #[wasm_bindgen(constructor)]
    pub fn new() -> DemoRadio {
        DemoRadio(demo::DemoRadio::new())
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.0.feed(bytes)
    }
}

impl Default for DemoRadio {
    fn default() -> Self {
        Self::new()
    }
}

/// The protocol numbers the UI uses, as JSON.
#[wasm_bindgen]
pub fn protocol() -> String {
    use ferrite_console_core::link::{event, key, msg, what};
    serde_json::json!({
        "msg": { "HELLO": msg::HELLO, "INFO": msg::INFO, "AUTH": msg::AUTH, "READ": msg::READ, "WRITE": msg::WRITE,
                 "DELETE": msg::DELETE, "BEGIN": msg::BEGIN, "END": msg::END, "SLOT": msg::SLOT, "BAUD": msg::BAUD,
                 "REBOOT": msg::REBOOT, "KEY": msg::KEY, "CMD": msg::CMD, "MORE": msg::MORE, "UI": msg::UI, "READ_MANY": msg::READ_MANY, "WRITE_MANY": msg::WRITE_MANY,
                 "LOG_READ": msg::LOG_READ, "SUBSCRIBE": msg::SUBSCRIBE, "EVENT": msg::EVENT, "HEARD": msg::HEARD, "MSGS": msg::MSGS, "MSG_SEND": msg::MSG_SEND },
        "what": { "SETTINGS": what::SETTINGS, "CHANNEL": what::CHANNEL, "ZONE": what::ZONE, "PRESET": what::PRESET, "APRS": what::APRS },
        "event": { "SUB_HEARD": event::SUB_HEARD, "SUB_MSGS": event::SUB_MSGS, "SUB_UI": event::SUB_UI, "HEARD": event::HEARD,
                   "MSG": event::MSG, "MSG_STATE": event::MSG_STATE, "UI": event::UI, "QUIET_MS": event::QUIET_MS, "DICT": liveview::DICT },
        "knobMax": key::KNOB_MAX,
        "keys": keys::NAMES,
        "timing": timing::TIMING,
    })
    .to_string()
}

#[wasm_bindgen]
pub fn status_text(status: u8, rest: &[u8]) -> String {
    answers::status_text(status, rest)
}

#[wasm_bindgen]
pub fn hello_payload(name: &str) -> Vec<u8> {
    answers::hello_payload(name)
}

#[wasm_bindgen]
pub fn auth_payload(pin: &str) -> Vec<u8> {
    answers::auth_payload(pin)
}

#[wasm_bindgen]
pub fn baud_payload(rate: u32) -> Vec<u8> {
    answers::baud_payload(rate)
}

/// `HELLO`'s answer (after the status byte) as JSON, or null.
#[wasm_bindgen]
pub fn parse_hello(rest: &[u8]) -> String {
    json(&answers::Hello::parse(rest))
}

#[wasm_bindgen]
pub fn parse_info(rest: &[u8]) -> String {
    json(&answers::Info::parse(rest))
}

#[wasm_bindgen]
pub fn parse_slot(rest: &[u8]) -> String {
    json(&answers::Slot::parse(rest))
}

/// A `UI`/`CMD`/`MORE` chunk as JSON `{more, text, working}`, or null.
#[wasm_bindgen]
pub fn parse_text_chunk(rest: &[u8]) -> String {
    json(&answers::TextChunk::parse(rest))
}

/// The UI readback's text as JSON (`ferrite_console_core::ui::Ui`).
#[wasm_bindgen]
pub fn parse_ui(text: &str) -> String {
    json(&ui::parse(text))
}

#[wasm_bindgen]
pub fn uid_text(bytes: &[u8]) -> Option<String> {
    uid::text(bytes)
}

/// `KEY`'s payload for a key name and "short", "long", "down" or "up"; an error for an unknown name (never PTT).
#[wasm_bindgen]
pub fn key_payload(name: &str, action: &str) -> Result<Vec<u8>, JsError> {
    let a = keys::Action::named(action).ok_or_else(|| JsError::new("action: short, long, down or up"))?;
    keys::payload(name, a).map(|p| p.to_vec()).ok_or_else(|| JsError::new(&format!("no key {name:?}")))
}

/// Knob steps as `KEY` payloads, two bytes each, back to back.
#[wasm_bindgen]
pub fn knob_payloads(steps: i32) -> Vec<u8> {
    keys::knob_payloads(steps).concat()
}

// Phase 2 (channel and zone programming): the record payloads, ready for the UI to use.

#[wasm_bindgen]
pub fn read_payload(what: u8, index: u16, offset: u16, len: u8) -> Vec<u8> {
    records::read_payload(what, index, offset, len)
}

/// `WRITE`'s payloads for a record, as JSON `[[..], ..]`.
#[wasm_bindgen]
pub fn write_payloads(what: u8, index: u16, record: &[u8]) -> String {
    json(&records::write_payloads(what, index, record))
}

#[wasm_bindgen]
pub fn delete_payload(what: u8, index: u16) -> Vec<u8> {
    records::delete_payload(what, index)
}

#[wasm_bindgen]
pub fn begin_payload(n: u16) -> Vec<u8> {
    records::begin_payload(n)
}

// Phase 2: channels and zones. Sets and views cross as JSON (`ferrite_console_core::plan::Set`, `channels::ChanView`,
// `channels::ZoneView`); records as byte arrays.

fn from_json<T: serde::de::DeserializeOwned>(s: &str, what: &str) -> Result<T, JsError> {
    serde_json::from_str(s).map_err(|e| JsError::new(&format!("{what}: {e}")))
}

/// What the table's selects offer (modes, powers, steps, tones ...), as JSON.
#[wasm_bindgen]
pub fn channel_choices() -> String {
    channels::choices().to_string()
}

/// Records as read (JSON `[[..], ..]` each: zones in index order, channels in any) to `{set, bad}`.
#[wasm_bindgen]
pub fn decode_set(zones: &str, channels: &str) -> Result<String, JsError> {
    let z: Vec<Vec<u8>> = from_json(zones, "zones")?;
    let c: Vec<Vec<u8>> = from_json(channels, "channels")?;
    let (set, bad) = plan::Set::from_records(&z, &c);
    Ok(serde_json::json!({ "set": set, "bad": bad }).to_string())
}

/// A channel view, normalised as the radio would hold it (frequencies to five decimals, tones as words), or the
/// first field that doesn't parse.
#[wasm_bindgen]
pub fn normalize_channel(view: &str) -> Result<String, JsError> {
    let v: channels::ChanView = from_json(view, "channel")?;
    v.channel().map(|c| json(&channels::ChanView::of(&c))).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn normalize_zone(view: &str) -> Result<String, JsError> {
    let v: channels::ZoneView = from_json(view, "zone")?;
    v.zone().map(|(n, c)| json(&channels::ZoneView::of(v.number - 1, n.as_bytes(), &c))).map_err(|e| JsError::new(&e))
}

/// A channel's problem as the radio would see it (ferrite's own checks, with `zones` zones), or undefined.
#[wasm_bindgen]
pub fn check_channel(view: &str, zones: u8) -> Result<Option<String>, JsError> {
    let v: channels::ChanView = from_json(view, "channel")?;
    Ok(plan::check_channel(&v, zones))
}

#[wasm_bindgen]
pub fn new_channel(number: u16, rx_mhz: &str) -> String {
    json(&channels::ChanView::new(number, channels::parse_mhz(rx_mhz).unwrap_or(14_652_000)))
}

#[wasm_bindgen]
pub fn new_zone(number: u8, name: &str) -> String {
    json(&channels::ZoneView::new(number, name))
}

/// The write plan from the radio's set to the table's (`plan::Plan` as JSON): the diff, `BEGIN`'s payload, the
/// requests, and the problems ferrite's own link session found running it.
#[wasm_bindgen]
pub fn write_plan(base: &str, want: &str) -> Result<String, JsError> {
    let b: plan::Set = from_json(base, "base")?;
    let w: plan::Set = from_json(want, "table")?;
    Ok(json(&plan::plan(&b, &w)))
}

/// The set as a backup file's text. `radio` is JSON `{firmware, callsign, uid, ...}`.
#[wasm_bindgen]
pub fn backup_file(set: &str, saved: &str, radio: &str) -> Result<String, JsError> {
    let s: plan::Set = from_json(set, "set")?;
    let r = from_json(radio, "radio")?;
    plan::backup(&s, saved, r).map_err(|p| JsError::new(&format!("{} {}: {}", p.what, p.number, p.error)))
}

/// A backup file back to `{set, saved, radio}`, or why not.
#[wasm_bindgen]
pub fn restore_file(text: &str) -> Result<String, JsError> {
    let (set, b) = plan::restore(text).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::json!({ "set": set, "saved": b.saved, "radio": b.radio }).to_string())
}

/// The set's channels as a CHIRP CSV file.
#[wasm_bindgen]
pub fn chirp_export(set: &str) -> Result<String, JsError> {
    let s: plan::Set = from_json(set, "set")?;
    Ok(chirp::export(&s.channels, &s.zones))
}

/// A CHIRP CSV file to `{channels, notes, skipped}`; `zones` (JSON, the table's) let a Comment name a zone.
#[wasm_bindgen]
pub fn chirp_import(text: &str, zones: &str) -> Result<String, JsError> {
    let z: Vec<channels::ZoneView> = from_json(zones, "zones")?;
    chirp::import(text, &z).map(|i| json(&i)).map_err(|e| JsError::new(&e))
}

/// Reads one record part by part (`records::Reader`): send `next_payload()` as a `READ` and `take` the answer's
/// rest until `done()`.
#[wasm_bindgen]
pub struct RecordReader(records::Reader);

#[wasm_bindgen]
impl RecordReader {
    #[wasm_bindgen(constructor)]
    pub fn new(what: u8, index: u16) -> RecordReader {
        RecordReader(records::Reader::new(what, index))
    }
    pub fn next_payload(&self) -> Vec<u8> {
        self.0.next_payload()
    }
    pub fn take(&mut self, rest: &[u8]) -> bool {
        self.0.take(rest)
    }
    pub fn done(&self) -> bool {
        self.0.done()
    }
    pub fn record(&self) -> Vec<u8> {
        self.0.record.clone()
    }
}

// The channel library (`ferrite_console_core::library`): fixed sets, airports and TAFL sites as channels.

/// Library entries (JSON `[Item]`) as channels and zones for the table (JSON `Set`): `{channels, zones, notes,
/// skipped, made_rx_only}`.
#[wasm_bindgen]
pub fn library_add(items: &str, table: &str) -> Result<String, JsError> {
    let i: Vec<library::Item> = from_json(items, "items")?;
    let t: plan::Set = from_json(table, "table")?;
    Ok(json(&library::add(&i, &t)))
}

/// A fixed set's picked channels (indices, JSON) as library entries (JSON), into the zone named `zone`.
#[wasm_bindgen]
pub fn library_fixed_items(set: &str, picks: &str, zone: &str) -> Result<String, JsError> {
    let s: library::FixedSet = from_json(set, "set")?;
    let p: Vec<usize> = from_json(picks, "picks")?;
    Ok(json(&library::fixed_items(&s, &p, zone)))
}

/// A place from typed text (lat,lon; a grid square; a GGA sentence; the terminal's answers): `{lat, lon, grid}`,
/// or undefined.
#[wasm_bindgen]
pub fn parse_place(text: &str) -> Option<String> {
    library::parse_place(text)
        .map(|p| serde_json::json!({ "lat": p.lat, "lon": p.lon, "grid": library::grid_of(p) }).to_string())
}

/// Of `coords` (lat, lon back to back), those within `radius_km` of (lat, lon), nearest first, at most `limit`:
/// indices and distances (km) back to back.
#[wasm_bindgen]
pub fn near(lat: f64, lon: f64, radius_km: f64, coords: &[f64], limit: usize) -> Vec<f64> {
    library::near(library::Place { lat, lon }, radius_km, coords, limit)
        .into_iter()
        .flat_map(|(i, d)| [i as f64, d])
        .collect()
}

/// An airport frequency's type name from its code (or its frequency when there's none).
#[wasm_bindgen]
pub fn airport_type(code: &str, khz: u32) -> String {
    library::airport_type(code, khz)
}

/// A channel name for an airport frequency, 16 characters.
#[wasm_bindgen]
pub fn airport_name(icao: &str, type_name: &str, khz: u32, repeat: bool) -> String {
    library::airport_name(icao, type_name, khz, repeat)
}

/// TAFL's name groups (JSON names in, JSON group names out, one per name).
#[wasm_bindgen]
pub fn tafl_groups(names: &str) -> Result<String, JsError> {
    let n: Vec<String> = from_json(names, "names")?;
    Ok(json(&library::tafl_groups(&n, 2)))
}

// Radio Settings: the settings record (bytes) as the radio's menu shows it, changed and checked by ferrite's own
// App and link session (`ferrite_console_core::settings`).

/// The record as the menu shows it (`settings::View` as JSON).
#[wasm_bindgen]
pub fn settings_view(record: &[u8]) -> String {
    json(&settings::view(record))
}

/// One setting changed (`id`: "0 7 1", or a text field's name) to a value as the menu shows it: the new record, or
/// the radio's reason.
#[wasm_bindgen]
pub fn settings_set(record: &[u8], id: &str, value: &str) -> Result<Vec<u8>, JsError> {
    settings::set(record, id, value).map_err(|e| JsError::new(&e))
}

/// The write from the radio's record to the edited one (`settings::Plan` as JSON), dry-run through ferrite's link
/// session.
#[wasm_bindgen]
pub fn settings_plan(base: &[u8], want: &[u8]) -> String {
    json(&settings::plan(base, want))
}

/// This Console's record length (the radio's INFO says its own).
#[wasm_bindgen]
pub fn settings_len() -> u32 {
    settings::record_len() as u32
}

#[wasm_bindgen]
pub fn settings_backup(record: &[u8], saved: &str, radio: &str) -> Result<String, JsError> {
    let r = from_json(radio, "radio")?;
    Ok(settings::backup(record, saved, r))
}

/// A settings backup file to `{record, saved, radio}`, or why not.
#[wasm_bindgen]
pub fn settings_restore(text: &str) -> Result<String, JsError> {
    let (rec, b) = settings::restore(text).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::json!({ "record": rec, "saved": b.saved, "radio": b.radio }).to_string())
}

// Firmware Update (`ferrite_console_core::firmware`): the .btf checks and the bootloader's frames.

/// A picked .btf, checked: `{file_len, blocks, image_len, ferrite, version, crc32, describe, problems}`.
#[wasm_bindgen]
pub fn firmware_check(btf: &[u8]) -> String {
    json(&firmware::check_file(btf))
}

/// The bootloader's probe frame.
#[wasm_bindgen]
pub fn boot_probe() -> Vec<u8> {
    firmware::probe()
}

/// flash.py's results table: a reply's result byte as words.
#[wasm_bindgen]
pub fn boot_result_text(r: u8) -> String {
    firmware::result_text(r).into()
}

/// A checked file's update: `steps()` frames in order (hello, model, count, the blocks, end), nothing else.
#[wasm_bindgen]
pub struct FirmwareUpdate(firmware::Update);

#[wasm_bindgen]
impl FirmwareUpdate {
    /// Throws the check's problems when the file can't be flashed.
    #[wasm_bindgen(constructor)]
    pub fn new(btf: &[u8]) -> Result<FirmwareUpdate, JsError> {
        firmware::Update::new(btf).map(FirmwareUpdate).map_err(|p| JsError::new(&p.join("; ")))
    }
    pub fn blocks(&self) -> usize {
        self.0.blocks()
    }
    pub fn steps(&self) -> usize {
        self.0.steps()
    }
    /// `{cmd, what, block, timeout_ms}`.
    pub fn step(&self, i: usize) -> String {
        json(&self.0.step(i))
    }
    pub fn frame(&self, i: usize) -> Vec<u8> {
        self.0.frame(i)
    }
}

#[wasm_bindgen]
impl FirmwareUpdate {
    /// The Install page's reader image (ferrite's reader, or hwtest's), as it is.
    pub fn reader(btf: &[u8]) -> Result<FirmwareUpdate, JsError> {
        install::reader_update(btf).map(FirmwareUpdate).map_err(|p| JsError::new(&p.join("; ")))
    }
    /// A stock `.BTF` for the way back (BACKUP-8), as it is.
    pub fn stock(btf: &[u8]) -> Result<FirmwareUpdate, JsError> {
        install::stock_update(btf).map(FirmwareUpdate).map_err(|p| JsError::new(&p.join("; ")))
    }
    /// A Ferrite image, with the owner's SSB patch bundled when given (INST-11).
    pub fn ferrite(btf: &[u8], patch: Option<Vec<u8>>) -> Result<FirmwareUpdate, JsError> {
        install::ferrite_update(btf, patch.as_deref())
            .map(|(u, _)| FirmwareUpdate(u))
            .map_err(|p| JsError::new(&p.join("; ")))
    }
}

// The Install page (`ferrite_console_core::install`): the reader's backup, SSB, back to stock.

/// SHA-256 as lowercase hex.
#[wasm_bindgen]
pub fn sha256_hex(b: &[u8]) -> String {
    install::sha256_hex(b)
}

/// `{size, sha256, crc32, cal_crc32, pending_update, regions, problems}`.
#[wasm_bindgen]
pub fn backup_check(b: &[u8]) -> String {
    json(&install::check_backup(b))
}

/// An image check `{blocks, image_len, version, crc32, sha256, problems}` for `kind` "reader" or "stock".
#[wasm_bindgen]
pub fn image_check(kind: &str, btf: &[u8]) -> String {
    json(&if kind == "reader" { install::check_reader(btf) } else { install::check_stock(btf) })
}

/// The reader console's lines: `flash` -> `{id, vendor, size}`, `sys` -> `{uid}`, `flashcrc` -> `{crc, size}`; null
/// when the line isn't one.
#[wasm_bindgen]
pub fn reader_line(kind: &str, line: &str) -> String {
    match kind {
        "flash" => json(
            &install::parse_flash(line)
                .map(|(id, vendor, size)| serde_json::json!({"id": id, "vendor": vendor, "size": size})),
        ),
        "sys" => json(&install::parse_uid(line).map(|w| serde_json::json!({"uid": install::uid_text(w)}))),
        _ => json(&install::parse_flashcrc(line).map(|(crc, size)| serde_json::json!({"crc": crc, "size": size}))),
    }
}

/// The SSB patch in a stock `.BTF` (INST-10), or nothing.
#[wasm_bindgen]
pub fn ssb_extract(btf: &[u8]) -> Option<Vec<u8>> {
    install::ssb_extract(btf, true)
}

/// `{len, records, sha256, known}`.
#[wasm_bindgen]
pub fn ssb_describe(patch: &[u8]) -> String {
    json(&install::ssb_describe(patch))
}

/// hwtest's binary dump, the host's side: see `install::Fdump`.
#[wasm_bindgen]
pub struct Fdump(install::Fdump);

#[wasm_bindgen]
impl Fdump {
    #[wasm_bindgen(constructor)]
    pub fn new(addr: u32, len: u32) -> Fdump {
        Fdump(install::Fdump::new(addr, len))
    }
    pub fn command(&self, baud: u32) -> String {
        self.0.command(baud)
    }
    pub fn synced(&self) -> bool {
        self.0.synced()
    }
    /// `{send, nak, done, error, got}`.
    pub fn feed(&mut self, bytes: &[u8]) -> String {
        json(&self.0.feed(bytes))
    }
    pub fn timeout(&mut self) -> String {
        json(&self.0.timeout())
    }
    pub fn resume(&mut self) {
        self.0.resume()
    }
    pub fn take_data(&mut self) -> Vec<u8> {
        self.0.take_data()
    }
    pub fn naks(&self) -> usize {
        self.0.naks
    }
    pub fn dups(&self) -> usize {
        self.0.dups
    }
}

/// The backup's file name for a radio ID and a date (decision 263).
#[wasm_bindgen]
pub fn backup_name(uid: &str, date: &str) -> String {
    install::backup_name(uid, date)
}

/// The radio ID a backup's file name carries, or nothing.
#[wasm_bindgen]
pub fn name_uid(name: &str) -> Option<String> {
    install::name_uid(name)
}

/// Whether the backup may go into the radio `radio_uid` by its ID: `{problems, confirm_uid}` (decision 263).
#[wasm_bindgen]
pub fn restore_id_check(radio_uid: Option<String>, backup_uid: Option<String>, confirmed: Option<String>) -> String {
    let (problems, confirm_uid) =
        install::check_id(radio_uid.as_deref(), &install::BackupId { uid: backup_uid, confirmed });
    json(&serde_json::json!({"problems": problems, "confirm_uid": confirm_uid}))
}

/// `STOCK_RESTORE`'s START answer: `{chip, cal_crc32, ranges, uid}` or null.
#[wasm_bindgen]
pub fn restore_start(rest: &[u8]) -> String {
    json(&install::parse_start(rest))
}

/// The way back's requests (BACKUP-7): never calibration or the update area.
#[wasm_bindgen]
pub struct RestorePlan(install::RestorePlan);

#[wasm_bindgen]
impl RestorePlan {
    /// `start` is `restore_start`'s JSON; `backup_uid` the backup's radio ID when Console knows it, `confirmed` the
    /// ID the owner typed when it doesn't (decision 263).
    #[wasm_bindgen(constructor)]
    pub fn new(
        backup: &[u8],
        start: &str,
        backup_uid: Option<String>,
        confirmed: Option<String>,
    ) -> Result<RestorePlan, JsError> {
        let v: serde_json::Value = serde_json::from_str(start).map_err(|e| JsError::new(&e.to_string()))?;
        let ranges = v["ranges"]
            .as_array()
            .map(|a| a.iter().filter_map(|r| Some((r[0].as_u64()? as u32, r[1].as_u64()? as u32))).collect());
        let s = install::RestoreStart {
            chip: v["chip"].as_u64().unwrap_or(0) as u32,
            cal_crc32: v["cal_crc32"].as_u64().unwrap_or(0) as u32,
            ranges: ranges.unwrap_or_default(),
            uid: v["uid"].as_str().map(String::from),
        };
        let id = install::BackupId { uid: backup_uid, confirmed };
        Ok(RestorePlan(install::restore_plan(backup, &s, &id)))
    }
    /// `{ranges, bytes, problems, ops, confirm_uid}` (the op count; the radio's ID to type, when asked).
    pub fn summary(&self) -> String {
        json(&serde_json::json!({
            "ranges": self.0.ranges, "bytes": self.0.bytes, "problems": self.0.problems, "ops": self.0.ops.len(),
            "confirm_uid": self.0.confirm_uid,
        }))
    }
    pub fn len(&self) -> usize {
        self.0.ops.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.ops.is_empty()
    }
    pub fn kind(&self, i: usize) -> String {
        self.0.ops[i].kind.into()
    }
    pub fn payload(&self, i: usize) -> Vec<u8> {
        self.0.ops[i].payload.clone()
    }
    /// A `crc` op's expected answer; -1 for the others.
    pub fn expect(&self, i: usize) -> f64 {
        self.0.ops[i].expect.map_or(-1.0, |c| c as f64)
    }
}

/// The bootloader's replies in what the cable reads: `feed` gives them as flat pairs (cmd, result, cmd, ...).
#[wasm_bindgen]
#[derive(Default)]
pub struct BootReader(firmware::BootReader);

#[wasm_bindgen]
impl BootReader {
    #[wasm_bindgen(constructor)]
    pub fn new() -> BootReader {
        BootReader(firmware::BootReader::new())
    }
    pub fn clear(&mut self) {
        self.0.clear()
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.0.feed(bytes).into_iter().flat_map(|(c, r)| [c, r]).collect()
    }
}

// APRS (`ferrite_console_core::aprs`, LINK-44 – LINK-46): the heard list, messages, events.

/// `HEARD`'s answer as JSON `{count, stations}`, or null.
#[wasm_bindgen]
pub fn parse_heard(rest: &[u8]) -> String {
    json(&aprs::parse_heard(rest))
}

/// `MSGS`'s answer as JSON `{count, messages}`, or null.
#[wasm_bindgen]
pub fn parse_msgs(rest: &[u8]) -> String {
    json(&aprs::parse_msgs(rest))
}

/// An event's payload as JSON `{kind: "heard" | "message" | "message_state" | "ui" | "unknown", ...}`, or null.
#[wasm_bindgen]
pub fn parse_event(payload: &[u8]) -> String {
    json(&aprs::parse_event(payload))
}

/// `MSG_SEND`'s payload, or why not (the radio checks again).
#[wasm_bindgen]
pub fn msg_send_payload(to: &str, text: &str) -> Result<Vec<u8>, JsError> {
    aprs::msg_send_payload(to, text).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn subscribe_payload(mask: u8, gap: u8, renew: bool) -> Vec<u8> {
    aprs::subscribe_payload(mask, gap, renew)
}

// The event log (`ferrite_console_core::log`, LINK-42).

#[wasm_bindgen]
pub fn log_read_payload(before: u32, max: u8) -> Vec<u8> {
    log::read_payload(before, max)
}

/// `LOG_READ`'s answer as JSON `{next, held, records}`, or null.
#[wasm_bindgen]
pub fn parse_log_page(rest: &[u8]) -> String {
    json(&log::parse_page(rest))
}

/// Records (JSON, as `parse_log_page` gave them) as CSV, each dated by `times` (JSON strings).
#[wasm_bindgen]
pub fn log_csv(records: &str, times: &str) -> Result<String, JsError> {
    let r: Vec<log::Record> = from_json(records, "records")?;
    let t: Vec<String> = from_json(times, "times")?;
    Ok(log::csv(&r, &t))
}

/// Live View from the radio's UI events (LINK-47, LINK-48).
#[wasm_bindgen]
#[derive(Default)]
pub struct LiveClient(liveview::Client);

#[wasm_bindgen]
impl LiveClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> LiveClient {
        LiveClient(liveview::Client::new())
    }
    pub fn reset(&mut self) {
        self.0.reset()
    }
    /// A UI event's payload after its kind byte: 0 shown (whole and checked), 1 partial, 2 ask for the whole state.
    pub fn apply(&mut self, ev: &[u8]) -> u8 {
        match self.0.apply(ev) {
            liveview::Applied::Shown => 0,
            liveview::Applied::Partial => 1,
            liveview::Applied::Resync => 2,
        }
    }
    pub fn text(&self) -> String {
        self.0.text()
    }
    pub fn updates(&self) -> u32 {
        self.0.updates
    }
    pub fn resyncs(&self) -> u32 {
        self.0.resyncs
    }
}

// APRS settings (`ferrite_console_core::aprs_settings`, LINK-43): the APRS record as MENU 0 5 shows it. `settings` is
// the radio's settings record (its region), or empty for the defaults.

#[wasm_bindgen]
pub fn aprs_view(settings: &[u8], record: &[u8]) -> String {
    json(&aprs_settings::view(settings, record))
}

#[wasm_bindgen]
pub fn aprs_set(settings: &[u8], record: &[u8], id: &str, value: &str) -> Result<Vec<u8>, JsError> {
    aprs_settings::set(settings, record, id, value).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn aprs_plan(settings: &[u8], base: &[u8], want: &[u8]) -> String {
    json(&aprs_settings::plan(settings, base, want))
}

#[wasm_bindgen]
pub fn aprs_record_len() -> u32 {
    aprs_settings::RECORD_LEN as u32
}

#[wasm_bindgen]
pub fn aprs_backup(settings: &[u8], record: &[u8], saved: &str, radio: &str) -> Result<String, JsError> {
    let r = from_json(radio, "radio")?;
    Ok(aprs_settings::backup(settings, record, saved, r))
}

#[wasm_bindgen]
pub fn aprs_restore(text: &str) -> Result<String, JsError> {
    let (rec, b) = aprs_settings::restore(text).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::json!({ "record": rec, "saved": b.saved, "radio": b.radio }).to_string())
}
