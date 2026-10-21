//! The core for the browser. Structures cross as JSON strings (the UI parses them); bytes as `Uint8Array`.

use ferrite_console_core::{answers, channels, chirp, demo, keys, library, plan, records, session, timing, ui, uid};
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

    /// Bytes read; the answers completed, as JSON `[{ty, seq, status, rest: [..]}]`.
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
    use ferrite_console_core::link::{key, msg, what};
    serde_json::json!({
        "msg": { "HELLO": msg::HELLO, "INFO": msg::INFO, "AUTH": msg::AUTH, "READ": msg::READ, "WRITE": msg::WRITE,
                 "DELETE": msg::DELETE, "BEGIN": msg::BEGIN, "END": msg::END, "SLOT": msg::SLOT, "BAUD": msg::BAUD,
                 "KEY": msg::KEY, "CMD": msg::CMD, "MORE": msg::MORE, "UI": msg::UI },
        "what": { "SETTINGS": what::SETTINGS, "CHANNEL": what::CHANNEL, "ZONE": what::ZONE, "PRESET": what::PRESET },
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
