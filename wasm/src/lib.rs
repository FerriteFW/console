//! The core for the browser. Structures cross as JSON strings (the UI parses them); bytes as `Uint8Array`.

use ferrite_console_core::{answers, demo, keys, records, session, timing, ui, uid};
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
