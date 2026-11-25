//! The core for the browser. Structures cross as JSON strings (the UI parses them); bytes as `Uint8Array`.

use ferrite_console_core::{
    answers, aprs, aprs_settings, channels, chirp, demo, ffw, firmware, install, keys, library, lists, liveview, log, plan,
    migrate, records, sats, session, settings, signature, timing, ui, uid, wmm, zonecap,
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

    /// LINK-50: past a stream's frames' seqs.
    pub fn skip(&mut self, n: u8) {
        self.0.skip(n)
    }

    /// LINK-51: compression on or off (from a HELLO answer); both windows start over.
    pub fn set_lz(&mut self, on: bool) {
        self.0.set_lz(on)
    }

    /// LINK-51: a frame was lost while compressed: HELLO before asking again.
    pub fn lz_broken(&self) -> bool {
        self.0.lz_broken()
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

/// LINK-13.4: one `AUDIO_DATA` block's samples (12 kHz, 16-bit), decoded by ferrite's own coder (G.711 µ-law,
/// decision 330); empty for a keep-alive or a malformed one.
#[wasm_bindgen]
pub fn audio_decode(p: &[u8]) -> Vec<i16> {
    ferrite_console_core::audio::decode(p)
}

/// The protocol numbers the UI uses, as JSON.
#[wasm_bindgen]
pub fn protocol() -> String {
    use ferrite_console_core::link::{event, key, msg, what};
    serde_json::json!({
        "msg": { "HELLO": msg::HELLO, "INFO": msg::INFO, "AUTH": msg::AUTH, "READ": msg::READ, "WRITE": msg::WRITE,
                 "DELETE": msg::DELETE, "BEGIN": msg::BEGIN, "END": msg::END, "SLOT": msg::SLOT, "BAUD": msg::BAUD,
                 "REBOOT": msg::REBOOT, "KEY": msg::KEY, "CMD": msg::CMD, "MORE": msg::MORE, "UI": msg::UI, "READ_MANY": msg::READ_MANY, "WRITE_MANY": msg::WRITE_MANY, "USED": msg::USED,
                 "LOG_READ": msg::LOG_READ, "SUBSCRIBE": msg::SUBSCRIBE, "EVENT": msg::EVENT, "HEARD": msg::HEARD, "MSGS": msg::MSGS, "MSG_SEND": msg::MSG_SEND, "MSG_STOP": msg::MSG_STOP,
                 "MSG_DELETE": msg::MSG_DELETE, "AUDIO": msg::AUDIO, "AUDIO_DATA": msg::AUDIO_DATA,
                 "DATA_READ": msg::DATA_READ, "DATA_WRITE": msg::DATA_WRITE, "CLOCK": msg::CLOCK, "STATE": msg::STATE, "TUNE": msg::TUNE, "BEACON": msg::BEACON },
        "data": { "READ": ferrite_console_core::link::data::READ, "CRC": ferrite_console_core::link::data::CRC,
                  "READ_MAX": ferrite_console_core::link::data::READ_MAX, "SECTOR": ferrite_console_core::link::data::SECTOR },
        "what": { "SETTINGS": what::SETTINGS, "CHANNEL": what::CHANNEL, "ZONE": what::ZONE, "PRESET": what::PRESET, "APRS": what::APRS, "POSITION": what::POSITION,
                  "QUICK": what::QUICK, "WAYPOINT": what::WAYPOINT, "DTMF": what::DTMF, "PRESET_SKIPS": what::PRESET_SKIPS,
                  "SAT": what::SAT, "SAT_INFO": what::SAT_INFO, "RADIO": what::RADIO },
        "limits": { "channels": channels::MAX_CHANNELS, "zones": ferrite_console_core::radioside::MAX_ZONES, "zoneCap": channels::ZONE_CAP,
                    "contacts": lists::CONTACT_MAX, "waypoints": lists::WAYPOINT_MAX, "sats": sats::MAX },
        "protocol": ferrite_console_core::link::PROTOCOL,
        "caps": { "LZ": ferrite_console_core::link::caps::LZ, "AUDIO": ferrite_console_core::link::caps::AUDIO, "LINE_CMDS": ferrite_console_core::link::caps::LINE_CMDS },
        "waypointAdd": lists::WAYPOINT_ADD,
        "satAll": ferrite_console_core::link::ADD,
        "event": { "SUB_HEARD": event::SUB_HEARD, "SUB_MSGS": event::SUB_MSGS, "SUB_UI": event::SUB_UI, "SUB_LOG": event::SUB_LOG, "SUB_STATE": event::SUB_STATE, "STATE": event::STATE, "LOG": event::LOG, "HEARD": event::HEARD,
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

/// `HELLO`'s payload asking for compression or not (a radio on another protocol is asked again without it).
#[wasm_bindgen]
pub fn hello_payload_lz(name: &str, lz: bool) -> Vec<u8> {
    answers::hello_payload_lz(name, lz)
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

/// `INFO`'s answer as JSON, or null.
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
    v.normal().map(|c| json(&c)).map_err(|e| JsError::new(&e))
}

/// A channel's TX frequency and its repeater shift as shown (`{tx, shift}`: the shift empty for simplex or a TX
/// further than 10 MHz away).
#[wasm_bindgen]
pub fn channel_tx(view: &str) -> Result<String, JsError> {
    let v: channels::ChanView = from_json(view, "channel")?;
    Ok(json(&serde_json::json!({ "tx": v.tx_text(), "shift": v.shift_text() })))
}

/// The channel with its TX frequency typed (simplex, a shift, or a split as the distance from RX says), or why not.
#[wasm_bindgen]
pub fn channel_with_tx(view: &str, tx: &str) -> Result<String, JsError> {
    let v: channels::ChanView = from_json(view, "channel")?;
    v.with_tx(tx).map(|c| json(&c)).map_err(|e| JsError::new(&e))
}

/// The channel with its shift typed ("+600k", "-0.6", "+5M"): TX follows, or why not.
#[wasm_bindgen]
pub fn channel_with_shift(view: &str, shift: &str) -> Result<String, JsError> {
    let v: channels::ChanView = from_json(view, "channel")?;
    v.with_shift(shift).map(|c| json(&c)).map_err(|e| JsError::new(&e))
}

/// CHAN-2, LINK-53: a typed position ("45.4215, -75.6972", a grid square; empty or "none" for none) as JSON
/// `{pos: [lat, lon] | null, text, grid}` (degrees; the text to five decimals), or why it isn't one.
#[wasm_bindgen]
pub fn parse_position(text: &str) -> Result<String, JsError> {
    channels::Position::parse(text).map(position_json).map_err(|e| JsError::new(&e))
}

/// A stored position (`[lat, lon]` in degrees, JSON) as `{pos, text, grid}`, for showing it.
#[wasm_bindgen]
pub fn position_view(pos: &str) -> Result<String, JsError> {
    let p: Option<channels::Position> = from_json(pos, "position")?;
    Ok(position_json(p))
}

fn position_json(p: Option<channels::Position>) -> String {
    serde_json::json!({
        "pos": p,
        "text": p.map(|p| p.text()).unwrap_or_default(),
        "grid": p.map(|p| p.grid()).unwrap_or_default(),
    })
    .to_string()
}

/// LINK-53: a `WRITE_MANY` record of `what` 7 for a position (`[lat, lon]` in degrees, JSON; `null` clears: 0
/// bytes).
#[wasm_bindgen]
pub fn position_record(pos: &str) -> Result<Vec<u8>, JsError> {
    let p: Option<channels::Position> = from_json(pos, "position")?;
    Ok(channels::position_record(p.map(|p| p.e7())))
}

/// LINK-53: a `READ_MANY` record of `what` 7 as `[lat, lon]` in degrees (JSON), or undefined if it isn't one.
#[wasm_bindgen]
pub fn position_from_record(rec: &[u8]) -> Option<String> {
    channels::position_from_record(rec).map(|(lat, lon)| json(&channels::Position { lat, lon }))
}

/// LINK-54: a `WRITE_MANY` record of `what` 8 for a quick message (`{own, text}`, JSON; `own` false puts the factory
/// text back).
#[wasm_bindgen]
pub fn quick_record(q: &str) -> Result<Vec<u8>, JsError> {
    let q: lists::QuickMessage = from_json(q, "quick message")?;
    Ok(lists::quick_record(&q))
}

/// LINK-54: a `READ_MANY` record of `what` 8 as `{own, text}` (JSON), or undefined.
#[wasm_bindgen]
pub fn quick_from_record(rec: &[u8]) -> Option<String> {
    lists::quick_from_record(rec).map(|q| json(&q))
}

/// LINK-55: a `WRITE_MANY` record of `what` 9 for a waypoint (`{name, lat, lon, source}`, JSON, the position in
/// 1e-7 degree, the source "marked", "aprs", "link" or "grid"; `null` deletes: 0 bytes). A new one goes at index
/// `protocol().waypointAdd`.
#[wasm_bindgen]
pub fn waypoint_record(w: &str) -> Result<Vec<u8>, JsError> {
    let w: Option<lists::Waypoint> = from_json(w, "waypoint")?;
    Ok(lists::waypoint_record(w.as_ref()))
}

/// LINK-55: a `READ_MANY` record of `what` 9 as `{name, lat, lon, source}` (JSON), or undefined.
#[wasm_bindgen]
pub fn waypoint_from_record(rec: &[u8]) -> Option<String> {
    lists::waypoint_from_record(rec).map(|w| json(&w))
}

/// LINK-55: the `WRITE_MANY` records (`[[index, [bytes]], ...]`, JSON, in order) that take the radio's waypoints
/// `old` to `new` (JSON lists, newest first).
#[wasm_bindgen]
pub fn waypoint_writes(old: &str, new: &str) -> Result<String, JsError> {
    let (o, n): (Vec<lists::Waypoint>, Vec<lists::Waypoint>) = (from_json(old, "old")?, from_json(new, "new")?);
    Ok(json(&lists::waypoint_writes(&o, &n)))
}

/// LINK-56: a `WRITE_MANY` record of `what` 10 for a DTMF memory (`{symbols, name}`, JSON; `null` clears it and its
/// name).
#[wasm_bindgen]
pub fn dtmf_record(m: &str) -> Result<Vec<u8>, JsError> {
    let m: Option<lists::DtmfMemory> = from_json(m, "DTMF memory")?;
    Ok(lists::dtmf_record(m.as_ref()))
}

/// LINK-56: a `READ_MANY` record of `what` 10 as `{symbols, name}` (JSON), or undefined.
#[wasm_bindgen]
pub fn dtmf_from_record(rec: &[u8]) -> Option<String> {
    lists::dtmf_from_record(rec).map(|m| json(&m))
}

/// TEXT-7: the factory quick messages (JSON list).
#[wasm_bindgen]
pub fn quick_factory() -> String {
    json(&lists::quick_factory())
}

/// LINK-54: why the radio would refuse a quick message (`{own, text}`, JSON), or undefined.
#[wasm_bindgen]
pub fn quick_check(q: &str) -> Result<Option<String>, JsError> {
    let q: lists::QuickMessage = from_json(q, "quick message")?;
    Ok(lists::check_quick(&q))
}

/// LINK-55: why the radio would refuse a waypoint (`{name, lat, lon, source}`, JSON), or undefined.
#[wasm_bindgen]
pub fn waypoint_check(w: &str) -> Result<Option<String>, JsError> {
    let w: lists::Waypoint = from_json(w, "waypoint")?;
    Ok(lists::check_waypoint(&w))
}

/// LINK-56: why the radio would refuse a DTMF memory (`{symbols, name}`, JSON), or undefined.
#[wasm_bindgen]
pub fn dtmf_check(m: &str) -> Result<Option<String>, JsError> {
    let m: lists::DtmfMemory = from_json(m, "DTMF memory")?;
    Ok(lists::check_dtmf(&m))
}

/// LINK-58: a `WRITE_MANY` record of `what` 11 for a range preset's skip list (JSON list of frequencies, 10 Hz;
/// `[]` clears it). Write it after the presets: a list stays with the preset in its place.
#[wasm_bindgen]
pub fn preset_skips_record(f: &str) -> Result<Vec<u8>, JsError> {
    let f: Vec<u32> = from_json(f, "skipped frequencies")?;
    Ok(lists::preset_skips_record(&f))
}

/// LINK-58: a `READ_MANY` record of `what` 11 as a JSON list of frequencies (10 Hz), or undefined.
#[wasm_bindgen]
pub fn preset_skips_from_record(rec: &[u8]) -> Option<String> {
    lists::preset_skips_from_record(rec).map(|f| json(&f))
}

#[wasm_bindgen]
pub fn normalize_zone(view: &str) -> Result<String, JsError> {
    let v: channels::ZoneView = from_json(view, "zone")?;
    v.zone().map(|(n, c)| json(&channels::ZoneView::of(v.number - 1, n.as_bytes(), &c))).map_err(|e| JsError::new(&e))
}

/// A channel's problem as the radio would see it (ferrite's own checks, with `zones` zones), or undefined.
#[wasm_bindgen]
pub fn check_channel(view: &str, zones: u16) -> Result<Option<String>, JsError> {
    let v: channels::ChanView = from_json(view, "channel")?;
    Ok(plan::check_channel(&v, zones))
}

#[wasm_bindgen]
pub fn new_channel(number: u16, rx_mhz: &str) -> String {
    json(&channels::ChanView::new(number, channels::parse_mhz(rx_mhz).unwrap_or(14_652_000)))
}

#[wasm_bindgen]
pub fn new_zone(number: u16, name: &str) -> String {
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

/// The set's channels as a CHIRP CSV file: `{text, channels, left_out, lost_priority, notes}` (issue #85: what
/// didn't go in is said).
#[wasm_bindgen]
pub fn chirp_export(set: &str) -> Result<String, JsError> {
    let s: plan::Set = from_json(set, "set")?;
    Ok(json(&chirp::export_report(&s.channels, &s.zones)))
}

/// A CHIRP CSV file to `{channels, notes, skipped}`; `zones` (JSON, the table's) let a Comment name a zone.
#[wasm_bindgen]
pub fn chirp_import(text: &str, zones: &str) -> Result<String, JsError> {
    let z: Vec<channels::ZoneView> = from_json(zones, "zones")?;
    chirp::import(text, &z).map(|i| json(&i)).map_err(|e| JsError::new(&e))
}

/// Imported channels (JSON) into a new zone named `name` at free numbers of the table (JSON `Set`): `{channels,
/// zone, numbers, room, name_error}` (`chirp::into_new_zone`).
#[wasm_bindgen]
pub fn chirp_new_zone(channels: &str, table: &str, name: &str) -> Result<String, JsError> {
    let c: Vec<channels::ChanView> = from_json(channels, "channels")?;
    let t: plan::Set = from_json(table, "table")?;
    Ok(json(&chirp::into_new_zone(&c, &t, name)))
}

/// A new zone's name from the file's name, unique among `zones` (JSON).
#[wasm_bindgen]
pub fn chirp_zone_name(file: &str, zones: &str) -> Result<String, JsError> {
    let z: Vec<channels::ZoneView> = from_json(zones, "zones")?;
    Ok(chirp::zone_name_for(file, &z))
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
/// `split`: a zone's 257th channel goes on in a new zone (" 2", " 3"; CHAN-35), else is skipped.
#[wasm_bindgen]
pub fn library_add(items: &str, table: &str, split: bool) -> Result<String, JsError> {
    let i: Vec<library::Item> = from_json(items, "items")?;
    let t: plan::Set = from_json(table, "table")?;
    Ok(json(&library::add(&i, &t, split)))
}

/// CHAN-35: the table's zones over 256 channels (`[{number, name, count}]`).
#[wasm_bindgen]
pub fn zone_over_cap(table: &str) -> Result<String, JsError> {
    let t: plan::Set = from_json(table, "table")?;
    Ok(json(&zonecap::over_cap(&t)))
}

/// CHAN-35: the table with every zone over 256 split over new zones (`{set, notes, made, unzoned}`).
#[wasm_bindgen]
pub fn zone_split(table: &str) -> Result<String, JsError> {
    let t: plan::Set = from_json(table, "table")?;
    Ok(json(&zonecap::split_full_zones(&t)))
}

/// CHAN-35: whether channels `numbers` (JSON, as the radio shows them) may go into zone `zone` (its index; -1 for no
/// zone): "" when they may, else the refusal.
#[wasm_bindgen]
pub fn zone_room(table: &str, numbers: &str, zone: i32) -> Result<String, JsError> {
    let t: plan::Set = from_json(table, "table")?;
    let n: Vec<u16> = from_json(numbers, "numbers")?;
    let z = u16::try_from(zone).ok();
    Ok(zonecap::room(&t, &n, z).err().unwrap_or_default())
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

/// An airport frequency's type name from OurAirports' type string (or its frequency when there's none).
#[wasm_bindgen]
pub fn airport_type(code: &str, khz: u32) -> String {
    library::airport_type(code, khz)
}

/// A channel name for an airport frequency, 16 characters.
#[wasm_bindgen]
pub fn airport_name(icao: &str, type_name: &str, khz: u32, repeat: bool) -> String {
    library::airport_name(icao, type_name, khz, repeat)
}

/// Licensees' organization groups (JSON names in, JSON group names out, one per name).
#[wasm_bindgen]
pub fn org_groups(names: &str) -> Result<String, JsError> {
    let n: Vec<String> = from_json(names, "names")?;
    Ok(json(&library::org_groups(&n, 2)))
}

// Radio Settings: the settings record (bytes) as the radio's menu shows it, changed and checked by ferrite's own
// App and link session (`ferrite_console_core::settings`).

/// The settings no record carries, from JSON `{id: value}` (`settings::Extras`; empty text for none).
fn extras(ex: &str) -> Result<settings::Extras, JsError> {
    if ex.is_empty() {
        return Ok(settings::Extras::new());
    }
    from_json(ex, "extras")
}

/// The record and the terminal-backed values (`ex`, JSON) as the menu shows them (`settings::View` as JSON).
#[wasm_bindgen]
pub fn settings_view(record: &[u8], ex: &str) -> Result<String, JsError> {
    Ok(json(&settings::view(record, &extras(ex)?)))
}

/// CHAN-17 (decision 347): the settings record with its home channel set (1-1000, or none).
#[wasm_bindgen]
pub fn settings_with_home(record: &[u8], home: Option<u16>) -> Vec<u8> {
    settings::with_home(record, home)
}

/// CHAN-17: the home channel the settings record names (1-1000), or none.
#[wasm_bindgen]
pub fn settings_home(record: &[u8]) -> Option<u16> {
    settings::home_channel(record)
}

/// One setting changed (`id`: "0 7 1", or a text field's name) to a value as the menu shows it: `{record,
/// extras}`, or the radio's reason.
#[wasm_bindgen]
pub fn settings_set(record: &[u8], ex: &str, id: &str, value: &str) -> Result<String, JsError> {
    let (r, x) = settings::set(record, &extras(ex)?, id, value).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::json!({ "record": r, "extras": x }).to_string())
}

/// The write from the radio's record and values to the edited ones (`settings::Plan` as JSON: the record's write and
/// the `set` lines), dry-run through ferrite's link session.
#[wasm_bindgen]
pub fn settings_plan(base: &[u8], base_ex: &str, want: &[u8], want_ex: &str) -> Result<String, JsError> {
    Ok(json(&settings::plan(base, &extras(base_ex)?, want, &extras(want_ex)?)))
}

/// LINK-21.1: the edits (the editor's read `base` -> `edited`) put on the radio's record as it is now (`fresh`):
/// `merge::Merged` as JSON (the record and values to write, the radio's changes since the read, the ones the edits
/// replace).
#[wasm_bindgen]
pub fn settings_merge(base: &[u8], base_ex: &str, edited: &[u8], edited_ex: &str, fresh: &[u8], fresh_ex: &str, whole: bool) -> Result<String, JsError> {
    Ok(json(&settings::merge(base, &extras(base_ex)?, edited, &extras(edited_ex)?, fresh, &extras(fresh_ex)?, whole)))
}

/// This Console's record length (the radio's INFO says its own).
#[wasm_bindgen]
pub fn settings_len() -> u32 {
    settings::record_len() as u32
}

#[wasm_bindgen]
pub fn settings_backup(record: &[u8], ex: &str, saved: &str, radio: &str) -> Result<String, JsError> {
    let r = from_json(radio, "radio")?;
    Ok(settings::backup(record, &extras(ex)?, saved, r))
}

/// The `.ferrite` codeplug's settings.json: the backup without the PIN lock.
#[wasm_bindgen]
pub fn settings_codeplug_part(record: &[u8], ex: &str, saved: &str, radio: &str) -> Result<String, JsError> {
    let r = from_json(radio, "radio")?;
    Ok(settings::codeplug_part(record, &extras(ex)?, saved, r))
}

/// `record` with the PIN lock's fields from `from` (the radio's own record).
#[wasm_bindgen]
pub fn settings_keep_pin(record: &[u8], from: &[u8]) -> Vec<u8> {
    settings::keep_pin(record, from)
}

/// A settings backup file to `{record, extras, saved, radio}`, or why not.
#[wasm_bindgen]
pub fn settings_restore(text: &str) -> Result<String, JsError> {
    let (rec, b) = settings::restore(text).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::json!({ "record": rec, "extras": b.extras, "saved": b.saved, "radio": b.radio }).to_string())
}

/// The terminal-backed values from the text of a `dump` the radio sent (`CMD`, its pages up to
/// `settings_dump_end`), as JSON.
#[wasm_bindgen]
pub fn settings_extras_from_dump(text: &str) -> String {
    json(&settings::extras_from_dump(text))
}

/// LINK-66: the terminal-backed settings from the radio record (decision 347).
#[wasm_bindgen]
pub fn settings_extras_from_radio(rec: &[u8]) -> String {
    json(&settings::extras_from_radio(rec))
}

/// Where the dump's settings end: Console stops reading the dump at a line starting with it.
#[wasm_bindgen]
pub fn settings_dump_end() -> String {
    settings::DUMP_SETTINGS_END.into()
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
    /// The restorer image (BACKUP-13), as it is.
    pub fn restorer(btf: &[u8]) -> Result<FirmwareUpdate, JsError> {
        install::restorer_update(btf).map(FirmwareUpdate).map_err(|p| JsError::new(&p.join("; ")))
    }
    /// A stock `.BTF` for the way back (BACKUP-8), padded over stock's marker sector's first page with the marker
    /// read at backup time put back when there is one (BACKUP-12).
    pub fn stock(btf: &[u8], marker: Option<Vec<u8>>, icons: Option<Vec<u8>>) -> Result<FirmwareUpdate, JsError> {
        install::stock_update(btf, marker.as_deref(), icons.as_deref()).map(FirmwareUpdate).map_err(|p| JsError::new(&p.join("; ")))
    }
    /// A Ferrite image, with the owner's SSB patch bundled when given (INST-11).
    pub fn ferrite(btf: &[u8], patch: Option<Vec<u8>>) -> Result<FirmwareUpdate, JsError> {
        install::ferrite_update(btf, patch.as_deref())
            .map(|(u, _)| FirmwareUpdate(u))
            .map_err(|p| JsError::new(&p.join("; ")))
    }
}

// The update file, `.ffw` (`ferrite_console_core::ffw`, ferrite decision 335).

/// A checked `.ffw`: its image, and the raw writes that put its SPI parts on the radio after the MCU flash.
#[wasm_bindgen]
pub struct FfwFile {
    f: ffw::Ffw,
    steps: Vec<migrate::Step>,
}

#[wasm_bindgen]
impl FfwFile {
    /// Throws every problem, one a line, when the file isn't one to install (UPD-21, UPD-24); `dev_unsigned`: the
    /// developer option that takes an unsigned file.
    #[wasm_bindgen(constructor)]
    pub fn new(b: &[u8], dev_unsigned: bool) -> Result<FfwFile, JsError> {
        let f = ffw::read(b, dev_unsigned).map_err(|p| JsError::new(&p.join("\n")))?;
        let steps = ffw::write_plan(&f.parts).map_err(|e| JsError::new(&e))?;
        Ok(FfwFile { f, steps })
    }
    /// `{version, build, kind, layout, signed, parts: [{file, addr, size}]}`.
    pub fn summary(&self) -> String {
        let m = &self.f.manifest;
        let parts: Vec<_> = self.f.parts.iter().map(|p| serde_json::json!({ "file": p.file, "addr": p.addr, "size": p.data.len() })).collect();
        json(&serde_json::json!({ "version": m.version, "build": m.build, "kind": m.kind, "layout": m.layout, "signed": self.f.signed, "parts": parts }))
    }
    /// The MCU image (`firmware.btf`), for the usual checks and the bootloader.
    pub fn btf(&self) -> Vec<u8> {
        self.f.btf.clone()
    }
    /// The parts' raw writes: their number; then each one's kind ("erase", "program", "crc", "stamp"), message,
    /// payload, a CRC's expected answer (-1 for the others) and the part it belongs to.
    pub fn len(&self) -> usize {
        self.steps.len()
    }
    pub fn is_empty(&self) -> bool {
        self.f.parts.is_empty()
    }
    pub fn kind(&self, i: usize) -> String {
        self.steps[i].kind.into()
    }
    pub fn msg(&self, i: usize) -> u8 {
        self.steps[i].msg
    }
    pub fn payload(&self, i: usize) -> Vec<u8> {
        self.steps[i].payload.clone()
    }
    pub fn expect(&self, i: usize) -> f64 {
        self.steps[i].expect.map_or(-1.0, |c| c as f64)
    }
    pub fn region(&self, i: usize) -> String {
        self.steps[i].region.clone()
    }
}

// The Install page (`ferrite_console_core::install`): the reader's backup, SSB, back to stock.

/// SHA-256 as lowercase hex.
#[wasm_bindgen]
pub fn sha256_hex(b: &[u8]) -> String {
    install::sha256_hex(b)
}

/// An image against its `.minisig` text, with Ferrite's key: `{signed, error}` (the trusted comment, or why not).
#[wasm_bindgen]
pub fn signature_check(image: &[u8], minisig: &str) -> String {
    json(&signature::check(image, minisig))
}

/// `{size, sha256, crc32, cal_crc32, pending_update, regions, problems}`.
#[wasm_bindgen]
pub fn backup_check(b: &[u8]) -> String {
    json(&install::check_backup(b))
}

/// An image check `{blocks, image_len, version, crc32, sha256, problems}` for `kind` "reader", "restorer" or "stock".
#[wasm_bindgen]
pub fn image_check(kind: &str, btf: &[u8]) -> String {
    json(&match kind {
        "reader" => install::check_reader(btf),
        "restorer" => install::check_restorer(btf),
        _ => install::check_stock(btf),
    })
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

/// INST-10.1: the stock image's window the backup reads for the patch, from the reader's `mdump`, checked line by
/// line; None when it doesn't come whole (an older reader, a lost line).
#[wasm_bindgen]
pub fn parse_mdump_ssb(text: &str) -> Option<Vec<u8>> {
    install::parse_mdump_range(text, install::SSB_MCU_ADDR, install::SSB_MCU_LEN)
}

/// INST-10.1: `{found, addr, records, sha256}` for that window ("known", "unknown" or "none"; never the bytes).
#[wasm_bindgen]
pub fn ssb_on_radio(window: &[u8]) -> String {
    json(&install::ssb_on_radio(window, install::SSB_MCU_ADDR, &install::SSB_KNOWN))
}

/// INST-10.1: the known stock patch from that window, or nothing.
#[wasm_bindgen]
pub fn ssb_from_radio(window: &[u8]) -> Option<Vec<u8>> {
    install::ssb_from_radio(window, install::SSB_MCU_ADDR, &install::SSB_KNOWN)
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
    /// `fdumpz` (the Rust reader, BACKUP-9.6): coded 16 KB chunks.
    pub fn z(addr: u32, len: u32) -> Fdump {
        Fdump(install::Fdump::new_z(addr, len))
    }
    pub fn command(&self, baud: u32) -> String {
        self.0.command(baud)
    }
    pub fn synced(&self) -> bool {
        self.0.synced()
    }
    /// `{send, nak, inflate, done, error, got}`.
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
    /// The DEFLATE bytes a step's `inflate` asks for.
    pub fn take_inflate(&mut self) -> Vec<u8> {
        self.0.take_inflate()
    }
    /// The inflated chunk (empty when it didn't inflate): a step, as `feed`'s.
    pub fn inflated(&mut self, out: &[u8]) -> String {
        json(&self.0.inflated(out))
    }
    /// How long a begun frame may still take (ms from its start; 0: none begun).
    pub fn frame_budget_ms(&self, baud: u32) -> u32 {
        self.0.frame_budget_ms(baud)
    }
    pub fn wire(&self) -> usize {
        self.0.wire
    }
    pub fn naks(&self) -> usize {
        self.0.naks
    }
    pub fn dups(&self) -> usize {
        self.0.dups
    }
}

/// Whether a reader image speaks `fdumpz` (the Rust reader; hwtest's doesn't).
#[wasm_bindgen]
pub fn reader_has_fdumpz(btf: &[u8]) -> bool {
    install::reader_has_fdumpz(btf)
}

/// The backup's file name for a radio ID and a date (decision 263), with the stock marker word when there is one
/// (BACKUP-12).
#[wasm_bindgen]
pub fn backup_name(uid: &str, date: &str, marker: Option<Vec<u8>>) -> String {
    install::backup_name(uid, date, marker.as_deref())
}

/// BACKUP-12.3: the reader's `mdump` of stock's menu icons, checked line by line; None when it doesn't add up.
#[wasm_bindgen]
pub fn parse_mdump_icons(text: &str) -> Option<Vec<u8>> {
    install::parse_mdump_range(text, install::ICONS_ADDR, install::ICONS_LEN)
}

/// BACKUP-12.3: whether bytes from the icon area are stock's tiles (not erased, not a Ferrite image's code).
#[wasm_bindgen]
pub fn icons_plausible(b: &[u8]) -> bool {
    install::icons_plausible(b)
}

/// The marker sector's 16 bytes from the reader's `mdump 0x080F0000 16` answer, or nothing (BACKUP-12.1).
#[wasm_bindgen]
pub fn parse_mdump(text: &str) -> Option<Vec<u8>> {
    install::parse_mdump(text)
}

/// The stock marker word in 16 saved bytes, or nothing (erased or not stock's).
#[wasm_bindgen]
pub fn marker_word(m: &[u8]) -> Option<String> {
    install::marker_word(m)
}

/// The marker a backup's file name carries, as 16 bytes, or nothing.
#[wasm_bindgen]
pub fn name_marker(name: &str) -> Option<Vec<u8>> {
    install::name_marker(name)
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

// ---- Finish the update: one layout's data to another (LINK-59 – LINK-62, UPD-16; `ferrite_console_core::migrate`) ----

/// The regions (`[[start, len]]`) to back up from a chip on layout `chip_layout` before moving it; null when Console
/// doesn't know that layout.
#[wasm_bindgen]
pub fn migrate_regions(chip_layout: u8) -> String {
    json(&migrate::backup_regions(chip_layout))
}

/// The CRC-32 an erased range of `len` bytes reads as (a blank sector needn't be read).
#[wasm_bindgen]
pub fn migrate_erased_crc(len: u32) -> u32 {
    migrate::erased_crc(len as usize)
}

/// CRC-32/ISO-HDLC of `b` (`DATA_READ`'s CRC).
#[wasm_bindgen]
pub fn data_crc32(b: &[u8]) -> u32 {
    migrate::crc32(b)
}

/// The PC's copy of the old layout's regions (the backup kept before anything is written).
#[wasm_bindgen]
pub struct MigrateCopy(migrate::Copy);

#[wasm_bindgen]
impl MigrateCopy {
    /// An empty copy of a chip on `layout`; `uid` the radio's 12 ID bytes when known.
    #[wasm_bindgen(constructor)]
    pub fn new(layout: u8, uid: Option<Vec<u8>>) -> MigrateCopy {
        let uid = uid.and_then(|u| <[u8; 12]>::try_from(u.as_slice()).ok());
        MigrateCopy(migrate::Copy { layout, uid, regions: Vec::new() })
    }
    /// The copy from its file (`to_file`'s bytes), or why not.
    pub fn from_file(f: &[u8]) -> Result<MigrateCopy, JsError> {
        migrate::Copy::from_file(f).map(MigrateCopy).map_err(|e| JsError::new(&e))
    }
    /// A region as read.
    pub fn add(&mut self, start: u32, bytes: &[u8]) {
        self.0.regions.push((start, bytes.to_vec()));
    }
    pub fn layout(&self) -> u8 {
        self.0.layout
    }
    /// The radio's ID bytes, when the copy has them.
    pub fn uid(&self) -> Option<Vec<u8>> {
        self.0.uid.map(|u| u.to_vec())
    }
    /// The file Console keeps (and offers to save): the regions with a CRC each.
    pub fn to_file(&self) -> Vec<u8> {
        self.0.to_file()
    }
}

/// The translation and its writes, in LINK-62's order: each region erased, programmed and read back by CRC, the
/// sector that held the old header last, then the stamp.
#[wasm_bindgen]
pub struct MigratePlan {
    t: migrate::Translated,
    steps: Vec<migrate::Step>,
}

#[wasm_bindgen]
impl MigratePlan {
    #[wasm_bindgen(constructor)]
    pub fn new(copy: &MigrateCopy) -> Result<MigratePlan, JsError> {
        let t = migrate::translate(&copy.0).map_err(|e| JsError::new(&e))?;
        let steps = migrate::write_plan(&t);
        Ok(MigratePlan { t, steps })
    }
    /// `{notes, summary, regions: [{name, start, len}], steps}`.
    pub fn summary(&self) -> String {
        let regions: Vec<_> = self
            .t
            .regions
            .iter()
            .map(|r| serde_json::json!({ "name": r.name, "start": r.start, "len": r.data.len() }))
            .collect();
        json(&serde_json::json!({ "notes": self.t.notes, "summary": self.t.summary, "regions": regions, "steps": self.steps.len() }))
    }
    pub fn len(&self) -> usize {
        self.steps.len()
    }
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
    /// "erase", "program", "crc" or "stamp".
    pub fn kind(&self, i: usize) -> String {
        self.steps[i].kind.into()
    }
    /// The message type: `DATA_WRITE`, or `DATA_READ` for a CRC.
    pub fn msg(&self, i: usize) -> u8 {
        self.steps[i].msg
    }
    pub fn payload(&self, i: usize) -> Vec<u8> {
        self.steps[i].payload.clone()
    }
    /// A CRC step's expected answer; -1 for the others.
    pub fn expect(&self, i: usize) -> f64 {
        self.steps[i].expect.map_or(-1.0, |c| c as f64)
    }
    pub fn region(&self, i: usize) -> String {
        self.steps[i].region.clone()
    }
    /// Bytes a step moves (a program's), for the time left.
    pub fn bytes(&self, i: usize) -> u32 {
        if self.steps[i].kind == "program" { self.steps[i].len } else { 0 }
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

/// LINK-67: `STATE`'s record as JSON (`RadioState`), or null when this Console can't read it.
#[wasm_bindgen]
pub fn state_parse(rec: &[u8]) -> String {
    json(&ferrite_console_core::state::parse(rec))
}

/// LINK-67.1: a state event's body (after its kind) over the record kept so far (empty: none yet); the new record,
/// or nothing when `STATE` must be asked.
#[wasm_bindgen]
pub fn state_merge(prev: &[u8], body: &[u8]) -> Option<Vec<u8>> {
    ferrite_console_core::state::merge((!prev.is_empty()).then_some(prev), body)
}

/// LINK-68: `TUNE`'s payload (op "channel", "step", "group", "zone", "scan"), or why not.
#[wasm_bindgen]
pub fn tune_payload(slot: u8, op: &str, value: i32) -> Result<Vec<u8>, JsError> {
    ferrite_console_core::state::tune_payload(slot, op, value).map_err(|e| JsError::new(&e))
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

/// LINK-52: `MSG_DELETE`'s payload for one message as `MSGS` listed it.
#[wasm_bindgen]
pub fn msg_delete_payload(inbound: bool, peer: &str, text: &str) -> Vec<u8> {
    aprs::msg_delete_payload(inbound, peer, text)
}

#[wasm_bindgen]
pub fn subscribe_payload(mask: u8, gap: u8, renew: bool, texts: bool) -> Vec<u8> {
    aprs::subscribe_payload(mask, gap, renew, texts)
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
pub fn aprs_view(settings: &[u8], record: &[u8], ex: &str) -> Result<String, JsError> {
    Ok(json(&aprs_settings::view(settings, record, &extras(ex)?)))
}

/// `{record, extras}`, or the radio's reason.
#[wasm_bindgen]
pub fn aprs_set(settings: &[u8], record: &[u8], ex: &str, id: &str, value: &str) -> Result<String, JsError> {
    let (r, x) = aprs_settings::set(settings, record, &extras(ex)?, id, value).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::json!({ "record": r, "extras": x }).to_string())
}

#[wasm_bindgen]
pub fn aprs_plan(settings: &[u8], base: &[u8], base_ex: &str, want: &[u8], want_ex: &str) -> Result<String, JsError> {
    Ok(json(&aprs_settings::plan(settings, base, &extras(base_ex)?, want, &extras(want_ex)?)))
}

/// LINK-21.1: as `settings_merge`, for the APRS record.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn aprs_merge(settings: &[u8], base: &[u8], base_ex: &str, edited: &[u8], edited_ex: &str, fresh: &[u8], fresh_ex: &str, whole: bool) -> Result<String, JsError> {
    Ok(json(&aprs_settings::merge(settings, base, &extras(base_ex)?, edited, &extras(edited_ex)?, fresh, &extras(fresh_ex)?, whole)))
}

#[wasm_bindgen]
pub fn aprs_record_len() -> u32 {
    aprs_settings::RECORD_LEN as u32
}

#[wasm_bindgen]
pub fn aprs_backup(settings: &[u8], record: &[u8], ex: &str, saved: &str, radio: &str) -> Result<String, JsError> {
    let r = from_json(radio, "radio")?;
    Ok(aprs_settings::backup(settings, record, &extras(ex)?, saved, r))
}

#[wasm_bindgen]
pub fn aprs_restore(text: &str) -> Result<String, JsError> {
    let (rec, b) = aprs_settings::restore(text).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::json!({ "record": rec, "extras": b.extras, "saved": b.saved, "radio": b.radio }).to_string())
}

// Range presets (MENU 0 1 4, LINK-21's what 4): ferrite_console_core::presets.

/// The presets editor's lists (steps, modes, resumes, the most presets, the longest name), as JSON.
#[wasm_bindgen]
pub fn preset_choices() -> String {
    ferrite_console_core::presets::choices().to_string()
}

/// Preset records as read (JSON `[[..], ..]`, index order) to `{presets, bad}`.
#[wasm_bindgen]
pub fn decode_presets(records: &str) -> Result<String, JsError> {
    let r: Vec<Vec<u8>> = from_json(records, "presets")?;
    let (presets, bad) = ferrite_console_core::presets::from_records(&r);
    Ok(serde_json::json!({ "presets": presets, "bad": bad }).to_string())
}

/// A preset as the radio would hold it, or why the radio would refuse it.
#[wasm_bindgen]
pub fn normalize_preset(view: &str) -> Result<String, JsError> {
    let v: ferrite_console_core::presets::PresetView = from_json(view, "preset")?;
    v.normal().map(|n| json(&n)).map_err(|e| JsError::new(&e))
}

/// A preset's problem as the radio would see it (ferrite's own link checks), or undefined.
#[wasm_bindgen]
pub fn check_preset(view: &str) -> Result<Option<String>, JsError> {
    let v: ferrite_console_core::presets::PresetView = from_json(view, "preset")?;
    Ok(ferrite_console_core::presets::check(&v))
}

#[wasm_bindgen]
pub fn new_preset(number: u8, name: &str) -> String {
    json(&ferrite_console_core::presets::PresetView::new(number, name))
}

/// The presets write plan from the radio's to the table's (JSON lists of presets).
#[wasm_bindgen]
pub fn presets_plan(base: &str, want: &str) -> Result<String, JsError> {
    let b: Vec<ferrite_console_core::presets::PresetView> = from_json(base, "base")?;
    let w: Vec<ferrite_console_core::presets::PresetView> = from_json(want, "table")?;
    Ok(json(&ferrite_console_core::presets::plan(&b, &w)))
}

/// SCAN-10: a skipped frequency typed in MHz, as 10 Hz, or undefined.
#[wasm_bindgen]
pub fn preset_skip_parse(text: &str) -> Option<u32> {
    ferrite_console_core::presets::parse_skip(text)
}

/// The presets as `.ferrite`'s presets.json. `radio` is JSON `{firmware, callsign, ...}`.
#[wasm_bindgen]
pub fn presets_file(list: &str, saved: &str, radio: &str) -> Result<String, JsError> {
    let l: Vec<ferrite_console_core::presets::PresetView> = from_json(list, "presets")?;
    let r = from_json(radio, "radio")?;
    ferrite_console_core::presets::backup(&l, saved, r).map_err(|p| JsError::new(&format!("preset {}: {}", p.number, p.error)))
}

/// presets.json back to `{presets, saved, radio}`, or why not.
#[wasm_bindgen]
pub fn presets_restore(text: &str) -> Result<String, JsError> {
    let (presets, b) = ferrite_console_core::presets::restore(text).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::json!({ "presets": presets, "saved": b.saved, "radio": b.radio }).to_string())
}

// Satellite mode (LINK-63 – LINK-65): core/src/sats.rs and wmm.rs.

/// APRS-23 (decision 397): a weather station's comment read as weather, metric (JSON `aprs::Wx`), or "null".
#[wasm_bindgen]
pub fn aprs_wx(comment: &str) -> String {
    json(&ferrite_console_core::aprs::wx(comment))
}

/// SAT-23: each satellite's next pass over the place, for the tables: `records` the radio records end to end
/// (`len` bytes each). JSON: an array of `satmap::Pass` or null.
#[wasm_bindgen]
pub fn sat_next_passes(records: &[u8], len: usize, now: u32, lat: f64, lon: f64) -> String {
    let recs: Vec<Vec<u8>> = records.chunks(len.max(1)).map(<[u8]>::to_vec).collect();
    json(&ferrite_console_core::satmap::next_passes(&recs, now, (lat, lon)))
}

/// SAT-23: a satellite on the map (core/src/satmap.rs): `record` the radio's satellite record, `now` UTC seconds, the
/// place (degrees) when `has_place`. JSON: `satmap::SatMap`.
#[wasm_bindgen]
pub fn sat_map(record: &[u8], now: u32, has_place: bool, lat: f64, lon: f64) -> Result<String, JsError> {
    ferrite_console_core::satmap::sat_map(record, now, has_place.then_some((lat, lon))).map(|m| json(&m)).map_err(|e| JsError::new(&e))
}

/// `sats.json` as the workable satellites with their records (JSON: `sats::Parsed`), or why it didn't read.
#[wasm_bindgen]
pub fn sats_parse(json: &str) -> Result<String, JsError> {
    sats::parse(json).map(|p| self::json(&p)).map_err(|e| JsError::new(&e))
}

/// A satellite record the radio gave back as a row (JSON), or undefined.
#[wasm_bindgen]
pub fn sat_held(rec: &[u8]) -> Option<String> {
    sats::held(rec).map(|r| json(&r))
}

/// SAT-21's rewrite: the radio's records (152 bytes each, back to back) again from the file; the same layout back.
#[wasm_bindgen]
pub fn sats_refresh(file: &str, held: &[u8]) -> Result<Vec<u8>, JsError> {
    let recs: Vec<Vec<u8>> = held.chunks(sats::RECORD_LEN).map(<[u8]>::to_vec).collect();
    sats::refresh(file, &recs).map(|v| v.concat()).map_err(|e| JsError::new(&e))
}

/// The info record (LINK-64); `decl` in 0.1 degree east positive, 0x7FFF none.
#[wasm_bindgen]
pub fn sat_info_record(decl: i32, stamp: u32, written: u32) -> Vec<u8> {
    let d = (decl != 0x7FFF).then_some(decl.clamp(-1800, 1800) as i16);
    sats::info_record(d, stamp, written)
}

/// The info record read back (JSON `{decl, stamp, written}`), or undefined.
#[wasm_bindgen]
pub fn sat_info_of(rec: &[u8]) -> Option<String> {
    sats::info_of(rec).map(|i| json(&i))
}

/// SAT-21: whether a connect writes the list; `same_set` the radio holds the list's satellites; `info` the info
/// record's JSON or "null".
#[wasm_bindgen]
pub fn sats_sync_due(built: u32, same_set: bool, info: &str, now: u32) -> bool {
    let info: Option<sats::InfoRow> = serde_json::from_str(info).unwrap_or(None);
    sats::sync_due(built, same_set, info, now)
}

/// LINK-65: `CLOCK`'s answer after the status (JSON `{now, source}`), or undefined.
#[wasm_bindgen]
pub fn clock_of(rest: &[u8]) -> Option<String> {
    sats::clock_of(rest).map(|c| json(&c))
}

/// SAT-18: the declination (WMM2025) on the ground at a place, at UTC seconds since 1970, in 0.1 degree east positive.
#[wasm_bindgen]
pub fn wmm_declination(lat: f64, lon: f64, unix: f64) -> i32 {
    wmm::declination_tenths(lat, lon, wmm::decimal_year(unix)) as i32
}

/// LINK-33 (decision 347): the library's tune as `SLOT`'s payload; an error's reason as a string.
#[wasm_bindgen]
pub fn library_slot_tune(slot: u8, hz: f64, mode: &str, tx_tone: &str, rx_tone: &str, shift_hz: f64) -> Result<Vec<u8>, String> {
    library::slot_tune(slot, hz as u64, mode, tx_tone, rx_tone, shift_hz as i64)
}
