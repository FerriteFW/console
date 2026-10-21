//! APRS over the link (manual chapter 29, LINK-44 – LINK-46; Appendix G "APRS records" and "Events"): the heard
//! list (`HEARD`), the messages (`MSGS`), sending one (`MSG_SEND`), and the events a subscription brings
//! (`SUBSCRIBE`, `EVENT`). The record layouts are ferrite-app's `link/sub.rs` (`station`, `message`), read here.

use ferrite_core::link::event as ev;
use serde::Serialize;

/// Little-endian fields off the front of a slice.
pub(crate) struct Rd<'a>(pub &'a [u8]);

impl<'a> Rd<'a> {
    pub fn u8(&mut self) -> Option<u8> {
        let (&b, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(b)
    }
    pub fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let b = self.0.get(..n)?;
        self.0 = &self.0[n..];
        Some(b)
    }
    pub fn u16(&mut self) -> Option<u16> {
        self.bytes(2).map(|b| u16::from_le_bytes([b[0], b[1]]))
    }
    pub fn u32(&mut self) -> Option<u32> {
        self.bytes(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub fn i32(&mut self) -> Option<i32> {
        self.u32().map(|v| v as i32)
    }
    /// A length byte, then that much text.
    pub fn text(&mut self) -> Option<String> {
        let n = self.u8()? as usize;
        self.bytes(n).map(|b| String::from_utf8_lossy(b).into_owned())
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The symbols a station record names (LINK-44).
pub const SYMBOLS: [&str; 8] = ["Car", "Home", "Digi", "Weather", "Handheld", "iGate", "Truck", "Boat"];
/// A message's states (LINK-44).
pub const STATES: [&str; 6] = ["unread", "read", "pending", "acked", "retrying", "failed"];

/// A station heard (LINK-44).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Station {
    pub call: String,
    pub symbol: u8,
    pub symbol_name: String,
    /// Seconds since it was last heard, at the answer.
    pub ago_s: u32,
    pub times: u16,
    /// Degrees.
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Degrees and km/h.
    pub course: Option<u16>,
    pub speed: Option<u16>,
    /// Metres.
    pub alt_m: Option<i32>,
    /// The digipeaters it came by, the used one marked `*`; empty when heard direct.
    pub path: String,
    pub comment: String,
}

fn station(r: &mut Rd) -> Option<Station> {
    let flags = r.u8()?;
    let call = r.text()?;
    let symbol = r.u8()?;
    let ago_s = r.u32()?;
    let times = r.u16()?;
    let (mut lat, mut lon, mut course, mut speed, mut alt_m) = (None, None, None, None, None);
    if flags & 1 != 0 {
        lat = Some(r.i32()? as f64 / 1e7);
        lon = Some(r.i32()? as f64 / 1e7);
    }
    if flags & 2 != 0 {
        course = Some(r.u16()?);
        speed = Some(r.u16()?);
    }
    if flags & 4 != 0 {
        alt_m = Some(r.i32()?);
    }
    let path = r.text()?;
    let comment = r.text()?;
    let symbol_name = SYMBOLS.get(symbol as usize).map_or_else(|| format!("symbol {symbol}"), |s| s.to_string());
    Some(Station { call, symbol, symbol_name, ago_s, times, lat, lon, course, speed, alt_m, path, comment })
}

/// A message in or out (LINK-44).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Message {
    /// To us (else ours).
    pub inbound: bool,
    pub state: String,
    pub state_n: u8,
    /// Tries so far while retrying.
    pub tries: u8,
    pub ago_s: u32,
    /// From (in), or to (ours).
    pub peer: String,
    pub text: String,
}

fn message(r: &mut Rd) -> Option<Message> {
    let inbound = r.u8()? & 1 != 0;
    let state_n = r.u8()?;
    let tries = r.u8()?;
    let ago_s = r.u32()?;
    let peer = r.text()?;
    let text = r.text()?;
    let state = STATES.get(state_n as usize).map_or_else(|| format!("state {state_n}"), |s| s.to_string());
    Some(Message { inbound, state, state_n, tries, ago_s, peer, text })
}

/// `HEARD`'s answer: the list's count and the stations from the asked index.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Heard {
    pub count: u16,
    pub stations: Vec<Station>,
}

pub fn parse_heard(rest: &[u8]) -> Option<Heard> {
    let mut r = Rd(rest);
    let count = r.u8()? as u16;
    let mut stations = Vec::new();
    while !r.is_empty() {
        stations.push(station(&mut r)?);
    }
    Some(Heard { count, stations })
}

/// `MSGS`'s answer: the count and the messages from the asked index, newest first.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Msgs {
    pub count: u16,
    pub messages: Vec<Message>,
}

pub fn parse_msgs(rest: &[u8]) -> Option<Msgs> {
    let mut r = Rd(rest);
    let count = r.u16()?;
    let mut messages = Vec::new();
    while !r.is_empty() {
        messages.push(message(&mut r)?);
    }
    Some(Msgs { count, messages })
}

/// An event's payload (LINK-46) as the UI takes it. Live View's (kind 4) stays bytes: [`crate::liveview`] applies it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Heard { count: u16, station: Station },
    Message { count: u16, message: Message },
    MessageState { count: u16, message: Message },
    Ui,
    Unknown { code: u8 },
}

pub fn parse_event(payload: &[u8]) -> Option<Event> {
    let (&kind, body) = payload.split_first()?;
    let mut r = Rd(body);
    Some(match kind {
        ev::HEARD => Event::Heard { count: r.u8()? as u16, station: station(&mut r)? },
        ev::MSG => Event::Message { count: r.u16()?, message: message(&mut r)? },
        ev::MSG_STATE => Event::MessageState { count: r.u16()?, message: message(&mut r)? },
        ev::UI => Event::Ui,
        k => Event::Unknown { code: k },
    })
}

/// `MSG_SEND`'s payload, or why not (the radio's own rules, LINK-45: it checks them again).
pub fn msg_send_payload(to: &str, text: &str) -> Result<Vec<u8>, String> {
    let to = to.trim().to_ascii_uppercase();
    if to.is_empty() || to.len() > 9 || !to.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-') {
        return Err("To: 1-9 capitals, digits and -".into());
    }
    if text.is_empty() || text.len() > 67 || !text.bytes().all(|c| (0x20..0x7F).contains(&c) && !b"|~{".contains(&c)) {
        return Err("Message: 1-67 printable characters, no | ~ {".into());
    }
    let mut p = vec![to.len() as u8];
    p.extend_from_slice(to.as_bytes());
    p.push(text.len() as u8);
    p.extend_from_slice(text.as_bytes());
    Ok(p)
}

/// `SUBSCRIBE`'s payload (LINK-46): the mask, the UI's least gap (100 ms units; 0 the radio's default), and the
/// renew flag (a keepalive, changing nothing).
pub fn subscribe_payload(mask: u8, gap: u8, renew: bool) -> Vec<u8> {
    vec![mask, gap, if renew { ev::RENEW } else { 0 }]
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ferrite_app::link::Session as RadioSession;
    use ferrite_app::sample::Sample;
    use ferrite_app::settings::Settings;
    use ferrite_app::App;
    use ferrite_core::link::{self, msg, MAX_WIRE};
    use ferrite_core::msg::{Device, LiveAll};

    struct Out(Vec<u8>);
    impl ferrite_app::term::Sink for Out {
        fn room(&self) -> usize {
            4096
        }
        fn put(&mut self, b: &[u8]) {
            self.0.extend_from_slice(b);
        }
    }

    /// A request to ferrite's own link session over the sample store (the simulator's heard list and messages):
    /// its status and the rest.
    pub(crate) fn ask_sample(ty: u8, payload: &[u8]) -> (u8, Vec<u8>) {
        let set = Box::leak(Box::new(Settings::DEFAULT));
        let alert = Box::leak(Box::new(ferrite_app::screens::alert::AlertInfo::NONE));
        let mut app = App::new(set, alert);
        let store = Sample::new();
        let mut s = RadioSession::new(true);
        let dev = Device { tx_built: true, ..Device::default() };
        let mut w = [0u8; MAX_WIRE];
        let n = link::build(ty, 1, payload, &mut w).unwrap();
        let mut out = Out(Vec::new());
        let mut now = 1000;
        for &b in &w[..n] {
            while !s.ready() {
                now += 5;
                s.poll(&mut app, &store, &dev, &LiveAll::default(), now, &mut out);
            }
            s.feed(b, now);
        }
        for _ in 0..20 {
            now += 5;
            s.poll(&mut app, &store, &dev, &LiveAll::default(), now, &mut out);
        }
        let k = out.0.iter().position(|&b| b == 0).unwrap();
        let f = link::parse(&mut out.0[..k]).unwrap();
        (f.payload[0], f.payload[1..].to_vec())
    }

    /// LINK-44: the sample store's heard list and messages, as ferrite's link session answers them, parse whole.
    #[test]
    fn heard_and_msgs_from_ferrites_session() {
        let (s, rest) = ask_sample(msg::HEARD, &[0]);
        assert_eq!(s, 0);
        let h = parse_heard(&rest).unwrap();
        assert!(h.count as usize >= h.stations.len() && !h.stations.is_empty());
        let first = &h.stations[0];
        assert!(!first.call.is_empty() && first.lat.is_some());
        assert!(h.stations.iter().any(|s| !s.path.is_empty()));
        let (s, rest) = ask_sample(msg::MSGS, &[0, 0]);
        assert_eq!(s, 0);
        let m = parse_msgs(&rest).unwrap();
        assert!(!m.messages.is_empty());
        assert!(m.messages.iter().any(|m| m.inbound) && m.messages.iter().any(|m| !m.inbound));
    }

    /// LINK-45: Console refuses what the radio would, before sending.
    #[test]
    fn msg_send_checks() {
        assert_eq!(msg_send_payload("va3rtx", "hi").unwrap(), b"\x06VA3RTX\x02hi");
        assert!(msg_send_payload("TOOLONGCALL", "hi").is_err());
        assert!(msg_send_payload("VA3RTX", "a{b").is_err());
        assert!(msg_send_payload("VA3RTX", "").is_err());
        assert!(msg_send_payload("VA3RTX", &"x".repeat(68)).is_err());
    }

    #[test]
    fn events_parse() {
        // a station event: kind, count, then the station record as HEARD carries it
        let (_, rest) = ask_sample(msg::HEARD, &[0]);
        let h = parse_heard(&rest).unwrap();
        let mut r = Rd(&rest[1..]);
        let before = r.0.len();
        station(&mut r).unwrap();
        let one = &rest[1..1 + before - r.0.len()];
        let mut p = vec![ev::HEARD, 11];
        p.extend_from_slice(one);
        assert_eq!(parse_event(&p), Some(Event::Heard { count: 11, station: h.stations[0].clone() }));
        assert_eq!(parse_event(&[ev::UI, 1, 2]), Some(Event::Ui));
        assert_eq!(parse_event(&[9]), Some(Event::Unknown { code: 9 }));
        assert_eq!(parse_event(&[ev::MSG, 1]), None);
    }
}
