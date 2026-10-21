//! A demo radio: answers the link protocol from memory, so Console can be tried (and its UI tested) with no radio.
//! Radio side of the codec is ferrite's own (`link::parse`, `link::build`). It knows `HELLO`, `INFO`, `UI` (with
//! `MORE` pages), `KEY` (keypad, knob; remote PTT is refused), `CMD` (a line of text) and `BAUD`; the rest answers
//! `unknown type`. Its screens are a home with three cards and a small quick menu: a look-alike, not the firmware.

use ferrite_core::link::{self, key, msg, Status, ANSWER, MAX_PAYLOAD, MAX_WIRE};

/// The UI text a `UI` answer carries at most (as the radio's pages: under the 240-byte payload).
const PAGE: usize = 200;

#[derive(Clone, Debug)]
pub struct DemoRadio {
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
        DemoRadio {
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
                    let (status, rest) = self.answer(ty, &p);
                    let mut pay = vec![status as u8];
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
                (Status::Ok, r)
            }
            msg::INFO => {
                let mut r = Vec::new();
                push_text(&mut r, "demo");
                r.extend(1000u16.to_le_bytes());
                r.extend([32, 8]);
                r.extend(400u16.to_le_bytes());
                r.push(0);
                push_text(&mut r, "N0CALL");
                r.push(link::build::of(true, true, false));
                r.extend(ferrite_core::uid::bytes([0x3F2A_91C0, 0x7D44_0123, 0x89AB_CDEF]));
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
        let (_, i) = ask(&mut r, &mut s, msg::INFO, &[]);
        assert_eq!(Info::parse(&i).unwrap().uid_text.unwrap().len(), 23);
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
}
