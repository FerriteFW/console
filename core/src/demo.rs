//! A demo radio: answers the link protocol from memory, so Console can be tried (and its UI tested) with no radio.
//! Radio side of the codec is ferrite's own (`link::parse`, `link::build`). It knows `HELLO`, `INFO`, `UI` (with
//! `MORE` pages), `KEY` (keypad, knob; remote PTT is refused), `CMD` (a line of text) and `BAUD`; the rest answers
//! `unknown type`. Its screens are a home with three cards and a small quick menu: a look-alike, not the firmware.
//! Its `HELLO` says the capabilities its records have ([`DEMO_CAPS`], [`DEMO_CAPS2`]), so Console's editors for them
//! show against it.
//!
//! Records are the firmware's own: `READ`, `WRITE`, `DELETE`, `BEGIN` and `END` go to ferrite's link session
//! over an in-memory store ([`crate::radioside`]), seeded with [`demo_set`], so channel programming against the demo
//! meets every check the radio makes. `INFO` counts that store's channels and zones.

use crate::channels::{ChanView, ZoneView};
use crate::plan::Set;
use crate::radioside::RadioSide;
use ferrite_app::chan::ChannelStore;
use ferrite_core::link::{self, key, msg, Status, ANSWER, MAX_PAYLOAD, MAX_WIRE};

/// The UI text a `UI` answer carries at most (as the radio's pages: under the 240-byte payload).
const PAGE: usize = 200;

/// LINK-35.2: what the demo's records do (ferrite's own session over its store): channel deletes in `WRITE_MANY`,
/// channel positions, the quick messages, waypoints, DTMF memories and the event log. Not `STREAM`, compression,
/// audio or the drawn screen: the demo's own answers don't have them.
pub const DEMO_CAPS: u8 = link::caps::LISTS | link::caps::POSITION | 8;
/// The second capability byte: range preset skip lists (LINK-58).
pub const DEMO_CAPS2: u8 = link::caps2::PRESET_SKIPS;

pub struct DemoRadio {
    /// Ferrite's radio side, for the records.
    side: RadioSide,
    rx: Vec<u8>,
    /// Home (None) or the quick menu (Some(selected row)).
    menu: Option<usize>,
    active: usize,
    freq: [u32; 3],
    frame: u32,
    /// What `MORE` still has to give.
    more: Vec<u8>,
    toast: Option<(&'static str, String)>,
    pub locked: bool,
}

const MENU: [(&str, &str); 6] =
    [("Squelch", "4"), ("TX power", "Mid"), ("Mode", "FM"), ("Tones", "Off"), ("Offset", "0.600"), ("Step", "12.5k")];

impl Default for DemoRadio {
    fn default() -> Self {
        let mut side = RadioSide::new();
        let (zones, chans) = demo_set().parts().unwrap_or_default();
        side.seed(&zones, &chans);
        side.seed_presets(&demo_presets());
        demo_lists(&mut side);
        DemoRadio {
            side,
            rx: Vec::new(),
            menu: None,
            active: 0,
            freq: [14_549_500, 44_647_500, 9_810_000],
            frame: 1,
            more: Vec::new(),
            toast: None,
            locked: false,
        }
    }
}

fn mhz(f: u32) -> String {
    format!("{}.{:05}", f / 100_000, f % 100_000)
}

impl DemoRadio {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bytes from the PC; the bytes the radio sends back.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for &b in bytes {
            if b != 0 {
                if self.rx.len() < MAX_WIRE {
                    self.rx.push(b);
                }
                continue;
            }
            let mut raw = core::mem::take(&mut self.rx);
            if raw.is_empty() || raw == [3] {
                continue; // a sync, or Ctrl-C then the sync
            }
            match link::parse(&mut raw) {
                Ok(f) => {
                    let (ty, seq, p) = (f.ty, f.seq, f.payload.to_vec());
                    let (status, rest) = match ty {
                        msg::READ
                        | msg::WRITE
                        | msg::READ_MANY
                        | msg::WRITE_MANY
                        | msg::USED
                        | msg::DELETE
                        | msg::BEGIN
                        | msg::END
                        | msg::LOG_READ
                        | msg::SUBSCRIBE => {
                            self.side.ask(ty, &p)
                        }
                        _ => {
                            let (s, r) = self.answer(ty, &p);
                            (s as u8, r)
                        }
                    };
                    let mut pay = vec![status];
                    pay.extend(rest);
                    pay.truncate(MAX_PAYLOAD);
                    let mut w = [0u8; MAX_WIRE];
                    if let Some(n) = link::build(ty | ANSWER, seq, &pay, &mut w) {
                        out.extend_from_slice(&w[..n]);
                    }
                }
                Err(e) => {
                    let mut w = [0u8; MAX_WIRE];
                    if let Some(n) = link::build(e.ty | ANSWER, e.seq, &[Status::BadFrame as u8], &mut w) {
                        out.extend_from_slice(&w[..n]);
                    }
                }
            }
        }
        out
    }

    fn answer(&mut self, ty: u8, p: &[u8]) -> (Status, Vec<u8>) {
        match ty {
            msg::HELLO => {
                let mut r = vec![link::PROTOCOL, MAX_PAYLOAD as u8, 1];
                push_text(&mut r, "demo");
                r.push(link::build::of(true, true, false));
                r.extend([DEMO_CAPS, DEMO_CAPS2]);
                (Status::Ok, r)
            }
            msg::INFO => {
                let mut r = Vec::new();
                push_text(&mut r, "demo");
                r.extend(self.side.store.count().to_le_bytes());
                r.extend(self.side.store.zones().to_le_bytes()); // protocol 3: 2 bytes
                r.push(self.side.store.presets.borrow().len() as u8);
                r.extend(400u16.to_le_bytes());
                r.push(0);
                push_text(&mut r, "N0CALL");
                r.push(link::build::of(true, true, false));
                r.extend(ferrite_core::uid::bytes([0x3F2A_91C0, 0x7D44_0123, 0x89AB_CDEF]));
                r.extend([3, 3]); // LINK-62: the layouts (this firmware's, the chip's)
                (Status::Ok, r)
            }
            msg::UI => {
                self.more = self.readback().into_bytes();
                self.page()
            }
            msg::MORE => self.page(),
            msg::CMD => {
                let line = String::from_utf8_lossy(p).into_owned();
                let mut r = vec![0];
                r.extend(format!("demo radio: no terminal here ({line})\n").bytes());
                (Status::Ok, r)
            }
            msg::BAUD => (Status::Refused, Vec::new()),
            msg::KEY => self.key(p),
            _ => (Status::UnknownType, Vec::new()),
        }
    }

    fn page(&mut self) -> (Status, Vec<u8>) {
        let n = self.more.len().min(PAGE);
        let chunk: Vec<u8> = self.more.drain(..n).collect();
        let mut r = vec![(!self.more.is_empty()) as u8];
        r.extend(chunk);
        (Status::Ok, r)
    }

    fn key(&mut self, p: &[u8]) -> (Status, Vec<u8>) {
        let (Some(&code), Some(&action)) = (p.first(), p.get(1)) else {
            return (Status::BadArg, Vec::new());
        };
        if code == key::PTT {
            let mut r = Vec::new();
            r.extend(b"demo radio: no transmit");
            return (
                if action == key::OFF { Status::Ok } else { Status::Invalid },
                if action == key::OFF { Vec::new() } else { r },
            );
        }
        self.frame += 1;
        if code == key::KNOB {
            self.step(action as i8 as i32);
            return (Status::Ok, Vec::new());
        }
        if code > key::LAST_CODE || action > key::LONG {
            return (Status::BadArg, Vec::new());
        }
        if action != key::SHORT && action != key::LONG {
            return (Status::Ok, Vec::new());
        }
        let long = action == key::LONG;
        let Some(k) = ferrite_core::keys::key(code) else {
            return (Status::BadArg, Vec::new());
        };
        use ferrite_core::keys::Key;
        self.toast = None;
        if self.locked && !(k == Key::Hash && long) {
            self.toast = Some(("Locked", "Hold # to unlock".into()));
            return (Status::Ok, Vec::new());
        }
        match (k, self.menu) {
            (Key::Hash, _) if long => {
                self.locked = !self.locked;
                self.toast = Some((if self.locked { "Keys locked" } else { "Keys unlocked" }, String::new()));
            }
            (Key::Menu, None) => self.menu = Some(0),
            (Key::Exit, Some(_)) => self.menu = None,
            (Key::Up, Some(s)) => self.menu = Some((s + MENU.len() - 1) % MENU.len()),
            (Key::Down, Some(s)) => self.menu = Some((s + 1) % MENU.len()),
            (Key::Menu, Some(s)) => self.toast = Some(("Demo", format!("{} can't change here", MENU[s].0))),
            (Key::Up, None) => self.step(1),
            (Key::Down, None) => self.step(-1),
            (Key::Slot, None) => self.active = (self.active + 1) % 3,
            (Key::Digit(d), None) if long => self.toast = Some(("Shortcut", format!("Long {d}"))),
            _ => {}
        }
        (Status::Ok, Vec::new())
    }

    fn step(&mut self, n: i32) {
        match self.menu {
            Some(s) => self.menu = Some((s as i32 + n).rem_euclid(MENU.len() as i32) as usize),
            None => {
                let f = &mut self.freq[self.active];
                *f = (*f as i64 + n as i64 * 1_250).clamp(1_800_000, 99_999_999) as u32;
            }
        }
    }

    /// The readback text, in uistate.rs's shapes.
    pub fn readback(&self) -> String {
        let mut t = String::new();
        let (id, name) = if self.menu.is_some() { ("Quick", "Quick settings") } else { ("Home", "Home") };
        let title = if self.menu.is_some() { "Quick" } else { "" };
        t += &format!("screen {id} \"{name}\" title=\"{title}\"\n");
        let act = (b'A' + self.active as u8) as char;
        t += &format!(
            "state frame={} ago=0 dark=0 locked={} active={act} keyed=- remote=0 mode=off fm=0\n",
            self.frame, self.locked as u8
        );
        t += &format!(
            "bar lock={} scan=0 watch=0 inbox=1 alert=0 gps=fix bt_on=1 bt=1 battery=76 low=0 cutoff=0 dry=1 clock=12:34 utc=0 call=\"\"\n",
            self.locked as u8
        );
        if let Some((h, b)) = &self.toast {
            t += &format!("toast \"{h}\" \"{b}\"\n");
        }
        match self.menu {
            None => {
                let cards = [
                    ("VFO \u{b7} VHF", "RX", "", "FM", "T 88.5", "-", "Mid", "S9", 17, 1, "slot"),
                    ("CH 12 \u{b7} Club", "idle", "Club rpt", "NFM", "", "", "Low", "S0", 0, 0, "slot"),
                    ("VFO \u{b7} FM", "idle", "", "FM", "", "", "No TX", "S0", 0, 0, "slot"),
                ];
                for (i, c) in cards.iter().enumerate() {
                    let slot = (b'A' + i as u8) as char;
                    t += &format!(
                        "card {slot} active={} head=\"{}\" state=\"{}\" freq={} name=\"{}\" mode=\"{}\" tone=\"{}\" shift=\"{}\" power=\"{}\" s=\"{}\" meter={} rx={} scan=0 kind={}\n",
                        (i == self.active) as u8, c.0, c.1, mhz(self.freq[i]), c.2, c.3, c.4, c.5, c.6, c.7, c.8, c.9, c.10
                    );
                }
                t += "hints \"MENU\" \"Quick\" \"#\" \"Status\" \"V/M\" \"Channels\"\n";
            }
            Some(s) => {
                for (i, (n, v)) in MENU.iter().enumerate() {
                    t += &format!("row {} \"{n}\" \"{v}\"{}\n", i + 1, if i == s { " sel" } else { "" });
                }
                t += "hints \"OK\" \"Edit\" \"BACK\" \"Home\"\n";
            }
        }
        t
    }
}

/// The demo radio's channels and zones: a radio's worth around Ottawa, on the bands Ferrite covers.
/// The demo radio's range presets (MENU 0 1 4): 2 m, 70 cm, airband and marine.
pub fn demo_presets() -> Vec<ferrite_app::data::RangePreset> {
    use crate::presets::PresetView;
    [("2 m", "144", "148", "12.5 kHz", "NFM", "Global"), ("70 cm", "430", "450", "25 kHz", "NFM", "Global"), ("Airband", "118", "137", "25 kHz", "AM", "After 3 s"), ("Marine", "156", "162.025", "25 kHz", "FM", "Carrier drop")]
        .iter()
        .enumerate()
        .filter_map(|(i, (name, low, high, step, mode, resume))| {
            let v = PresetView { name: (*name).into(), low: (*low).into(), high: (*high).into(), step: (*step).into(), mode: (*mode).into(), resume: (*resume).into(), ..PresetView::new(i as u8 + 1, name) };
            v.preset().ok()
        })
        .collect()
}

/// The demo's lists, written through ferrite's own link session as Console would: a quick message of the owner's,
/// three waypoints around Ottawa, two DTMF memories, a skip list on the 2 m range, and one event logged.
fn demo_lists(side: &mut RadioSide) {
    use crate::lists::{dtmf_record, preset_skips_record, quick_record, waypoint_record, DtmfMemory, QuickMessage, Waypoint, WAYPOINT_ADD};
    use link::what;
    side.write_one(what::QUICK, 8, &quick_record(&QuickMessage { own: true, text: "At the club tonight, 146.94".into() }));
    for (name, lat, lon, source) in [("Camp Fortune", 455_090_000, -758_590_000, "marked"), ("Club shack", 453_960_000, -757_160_000, "link"), ("VE3RSB-1", 454_240_000, -756_950_000, "aprs")] {
        side.write_one(what::WAYPOINT, WAYPOINT_ADD, &waypoint_record(Some(&Waypoint { name: name.into(), lat, lon, source: source.into() })));
    }
    side.write_one(what::DTMF, 0, &dtmf_record(Some(&DtmfMemory { symbols: "*79#".into(), name: "Link on".into() })));
    side.write_one(what::DTMF, 1, &dtmf_record(Some(&DtmfMemory { symbols: "#79#".into(), name: "Link off".into() })));
    side.write_one(what::PRESET_SKIPS, 0, &preset_skips_record(&[14_439_000, 14_580_000]));
    side.store.log("*79#");
}

pub fn demo_set() -> Set {
    let zone = |n: u16, name: &str, scan: bool| ZoneView { scan_all: scan, ..ZoneView::new(n, name) };
    #[allow(clippy::type_complexity)]
    let rows: [(u16, &str, &str, &str, &str, &str, &str, &str, Option<u16>); 22] = [
        // number, name, rx MHz, duplex, offset, mode, tx tone, power, zone
        (1, "Calling 2 m", "146.52", "", "", "FM", "off", "Mid", Some(0)),
        (2, "Calling 70 cm", "446.0", "", "", "FM", "off", "Mid", Some(0)),
        (3, "Simplex B", "147.555", "", "", "NFM", "off", "Low", Some(0)),
        (4, "Bench 2 m", "145.495", "", "", "NFM", "off", "Low", Some(0)),
        (5, "Bench 70 cm", "446.475", "", "", "NFM", "off", "Low", Some(0)),
        (10, "North hill", "146.94", "-", "0.6", "FM", "100.0", "High", Some(1)),
        (11, "Club repeater", "443.475", "+", "5.0", "NFM", "100.0", "High", Some(1)),
        (12, "Downtown DCS", "444.2", "+", "5.0", "NFM", "D023N", "Mid", Some(1)),
        (13, "Camp Fortune", "147.15", "+", "0.6", "FM", "100.0", "High", Some(1)),
        (14, "Far east", "145.29", "-", "0.6", "FM", "110.9", "High", Some(1)),
        (30, "Guard", "121.5", "", "", "AM", "off", "Low", Some(2)),
        (31, "Tower", "119.1", "", "", "AM", "off", "Low", Some(2)),
        (32, "ATIS", "132.95", "", "", "AM", "off", "Low", Some(2)),
        (40, "Marine 16", "156.8", "", "", "FM", "off", "High", Some(3)),
        (41, "Marine 68", "156.425", "", "", "FM", "off", "Mid", Some(3)),
        (42, "Marine 72", "156.625", "", "", "FM", "off", "Mid", Some(3)),
        (50, "WX1", "162.55", "", "", "FM", "off", "Low", Some(4)),
        (51, "WX2", "162.4", "", "", "FM", "off", "Low", Some(4)),
        (52, "WX3", "162.475", "", "", "FM", "off", "Low", Some(4)),
        (60, "ISS downlink", "145.8", "", "", "FM", "off", "Low", None),
        (61, "Hotspot", "438.8", "", "", "NFM", "off", "Low", None),
        (62, "Satellite split", "145.8", "split", "437.8", "FM", "67.0", "Low", None),
    ];
    let channels = rows
        .iter()
        .map(|&(n, name, rx, duplex, offset, mode, tone, power, zone)| {
            let mut v = ChanView::new(n, crate::channels::parse_mhz(rx).unwrap_or(14_652_000));
            v.name = name.into();
            v.duplex = duplex.into();
            v.offset = offset.into();
            v.mode = mode.into();
            v.tx_tone = tone.into();
            v.power = power.into();
            v.zone = zone;
            v.rx_only = zone == Some(2) || zone == Some(4);
            v.skip = n == 32;
            v.channel().map(|c| ChanView::of(&c)).unwrap_or(v)
        })
        .collect();
    Set {
        zones: vec![
            zone(1, "Local", true),
            zone(2, "Repeaters", true),
            zone(3, "Air", false),
            zone(4, "Marine", false),
            zone(5, "Weather", false),
        ],
        channels,
    }
}

fn push_text(r: &mut Vec<u8>, s: &str) {
    r.push(s.len() as u8);
    r.extend_from_slice(s.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::answers::{Hello, Info, TextChunk};
    use crate::session::Session;

    fn ask(r: &mut DemoRadio, s: &mut Session, ty: u8, p: &[u8]) -> (u8, Vec<u8>) {
        let req = s.request(ty, p, 0.0).unwrap();
        let a = s.feed(&r.feed(&req.wire));
        assert_eq!(a.len(), 1);
        assert!(a[0].answers(ty, req.seq), "{ty:02X} {} {:?}", req.seq, a[0]);
        (a[0].status, a[0].rest.clone())
    }

    /// The whole client path against the demo: open, HELLO, INFO, UI in pages, keys and the knob.
    #[test]
    fn session_against_the_demo() {
        let (mut r, mut s) = (DemoRadio::new(), Session::new());
        assert!(r.feed(&Session::opening()).is_empty());
        assert!(r.feed(&s.take_cable(0.0)).is_empty());
        let (st, h) = ask(&mut r, &mut s, msg::HELLO, &crate::answers::hello_payload("test"));
        assert_eq!(st, 0);
        let h = Hello::parse(&h).unwrap();
        assert!(h.may_go_on && h.build.unwrap().dry);
        assert_eq!((h.caps, h.caps2), (DEMO_CAPS, DEMO_CAPS2), "the demo says what its records do");
        let (_, i) = ask(&mut r, &mut s, msg::INFO, &[]);
        assert_eq!(Info::parse(&i, 3).unwrap().uid_text.unwrap().len(), 23);
        let ui_text = |r: &mut DemoRadio, s: &mut Session| {
            let (_, mut rest) = ask(r, s, msg::UI, &[0]);
            let mut t = String::new();
            loop {
                let c = TextChunk::parse(&rest).unwrap();
                t += &c.text;
                if !c.more {
                    return crate::ui::parse(&t);
                }
                rest = ask(r, s, msg::MORE, &[]).1;
            }
        };
        let ui = ui_text(&mut r, &mut s);
        assert_eq!(ui.cards.len(), 3);
        assert_eq!(ui.cards[0]["freq"], "145.49500");
        ask(&mut r, &mut s, msg::KEY, &crate::keys::knob_payloads(2)[0]);
        assert_eq!(ui_text(&mut r, &mut s).cards[0]["freq"], "145.52000");
        ask(&mut r, &mut s, msg::KEY, &crate::keys::payload("MENU", crate::keys::Action::Short).unwrap());
        let ui = ui_text(&mut r, &mut s);
        assert_eq!((ui.screen.unwrap().id.as_str(), ui.sel), ("Quick", Some(0)));
        let (st, _) = ask(&mut r, &mut s, msg::KEY, &[key::PTT, key::ON, key::ACTIVE]);
        assert_eq!(st, Status::Invalid as u8, "the demo never transmits");
        assert_eq!(ask(&mut r, &mut s, 0x55, &[]).0, Status::UnknownType as u8);
    }

    /// The capabilities the demo's HELLO says are there: its lists read back as seeded, a skip list with its preset,
    /// the event log by `LOG_READ`, and `SUBSCRIBE` with the event log's mask taken.
    #[test]
    fn demo_lists_through_the_link() {
        let (mut r, mut s) = (DemoRadio::new(), Session::new());
        r.feed(&s.take_cable(0.0));
        let many = |r: &mut DemoRadio, s: &mut Session, w: u8| {
            let mut p = vec![w];
            p.extend(0u16.to_le_bytes());
            p.extend(300u16.to_le_bytes());
            let (st, rest) = ask(r, s, msg::READ_MANY, &p);
            assert_eq!(st, 0);
            crate::lists::parse_many(&rest).unwrap().1
        };
        let wps = many(&mut r, &mut s, link::what::WAYPOINT);
        assert_eq!(wps.len(), 3);
        assert_eq!(crate::lists::waypoint_from_record(&wps[0].1).unwrap().name, "VE3RSB-1", "newest first");
        assert_eq!(many(&mut r, &mut s, link::what::DTMF).len(), 2);
        let q = many(&mut r, &mut s, link::what::QUICK);
        assert!(crate::lists::quick_from_record(&q[8].1).unwrap().own);
        let sk = many(&mut r, &mut s, link::what::PRESET_SKIPS);
        assert_eq!((sk.len(), sk[0].0), (1, 0));
        let (st, rest) = ask(&mut r, &mut s, msg::LOG_READ, &crate::log::read_payload(u32::MAX, 0));
        assert_eq!(st, 0);
        assert_eq!(crate::log::parse_page(&rest).unwrap().records.len(), 1);
        let (st, _) = ask(&mut r, &mut s, msg::SUBSCRIBE, &crate::aprs::subscribe_payload(link::event::SUB_LOG, 0, false, false));
        assert_eq!(st, 0);
    }

    /// The demo's records are ferrite's: its set reads back through the link as built, and INFO counts it.
    #[test]
    fn demo_records() {
        let (mut r, mut s) = (DemoRadio::new(), Session::new());
        r.feed(&s.take_cable(0.0));
        let set = demo_set();
        assert!(set.parts().is_ok());
        assert!(crate::plan::plan(&set, &set).problems.is_empty());
        let i = Info::parse(&ask(&mut r, &mut s, msg::INFO, &[]).1, 3).unwrap();
        assert_eq!((i.channels as usize, i.zones as usize), (set.channels.len(), set.zones.len()));
        let mut zones = Vec::new();
        for z in 0..i.zones {
            let mut p = vec![link::what::ZONE];
            p.extend(z.to_le_bytes());
            p.extend(1u16.to_le_bytes());
            let (st, rest) = ask(&mut r, &mut s, msg::READ_MANY, &p);
            assert_eq!(st, 0);
            zones.push(rest[5..5 + rest[4] as usize].to_vec());
        }
        let mut chans = Vec::new();
        for n in 0..1000u16 {
            let mut p = vec![link::what::CHANNEL];
            p.extend(n.to_le_bytes());
            p.extend(1u16.to_le_bytes());
            let (st, rest) = ask(&mut r, &mut s, msg::READ_MANY, &p);
            if st == 0 && rest.len() > 2 {
                chans.push(rest[5..5 + rest[4] as usize].to_vec());
            }
        }
        let (back, bad) = Set::from_records(&zones, &chans);
        assert!(bad.is_empty());
        assert_eq!(back, set);
    }
}
