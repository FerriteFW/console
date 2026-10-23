//! Radio Settings: the radio-wide settings record (LINK-3's `what` 1: ferrite-app's `Settings` in its `Persist`
//! layout, as `link.rs`'s `settings_record` reads it), shown, changed and checked by ferrite's own code.
//!
//! Nothing about the menu is copied here. A scratch radio (ferrite-app's `App` over [`RadioSide`]) holds the record
//! and answers for it:
//! - the tree, names and help lines are the menu's own lists (`screens::groups`, through `Group::items`);
//! - each value is what the terminal's `get` shows (the menu's `wired` value);
//! - each setting's choices are found by turning the knob on its menu row, as on the radio (`change`), and its kind
//!   by what the stepping does: round and round (a choice), stopping at the ends (a level), or not stepping but
//!   typed (`set` takes a typed value: frequencies, the capcode, the fixed position);
//! - a change is the terminal's `set` (TERM-12: the knob walked to the value), so its checks are the radio's;
//! - a setting is in the record when changing the record's bytes changes what it shows; one the link never
//!   changes (LINK-5: region, Extend TX, PIN, cable port, KISS port) is found by writing it through ferrite's own
//!   link session (`keep_protected` keeps the radio's) and shows read only.
//!
//! The few text fields the menu edits on their own screens (the callsign, the power-on text, the owner card,
//! SETUP-11) are set on `Settings` directly with the radio's character rules.

use crate::answers::status_text;
use crate::plan::{hex, unhex, Op, Problem};
use crate::radioside::RadioSide;
use crate::records::{begin_payload, write_payloads, Reader};
use ferrite_app::persist::{Persist, Sink, Source};
use ferrite_app::screens::groups::Group;
use ferrite_app::screens::nav::Dest;
use ferrite_app::settings::Settings;
use ferrite_app::term::cmd::{self, Done};
use ferrite_app::Screen;
use ferrite_core::keys::Key;
use ferrite_core::link::{msg, what};
use ferrite_core::msg::Device;
use ferrite_ui::text::Buf;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

/// The backup file's format name.
pub const BACKUP_FORMAT: &str = "ferrite-console-settings";
/// The note on a setting the link never writes (LINK-5).
pub const RADIO_ONLY: &str = "changes only on the radio";
/// The most values a knob walk collects before the setting counts as typed (a frequency in 6.25 kHz steps).
const MANY: usize = 64;
/// What `set` is given to make it list a setting's values (or say why it can't).
pub(crate) const NOT_A_VALUE: &str = "~~~";

struct Bytes(Vec<u8>);

impl Sink for Bytes {
    fn put(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

struct Rd<'a> {
    b: &'a [u8],
    n: usize,
}

impl Source for Rd<'_> {
    fn take(&mut self, out: &mut [u8]) -> bool {
        match self.b.get(self.n..self.n + out.len()) {
            Some(s) => {
                out.copy_from_slice(s);
                self.n += out.len();
                true
            }
            None => false,
        }
    }
}

/// The record as the link reads it (`settings_record`): the PIN and its counters as zeros (LINK-7).
pub fn record_of(s: &Settings) -> Vec<u8> {
    let m = Settings { pin: 0, pin_misses: 0, pin_wait: 0, ..*s };
    let mut b = Bytes(Vec::new());
    m.save(&mut b);
    b.0
}

/// The settings a record holds, over the defaults (a short record leaves the rest at them, as the radio loads one).
pub fn settings_of(rec: &[u8]) -> Settings {
    let mut s = Settings::DEFAULT;
    s.load(&mut Rd { b: rec, n: 0 });
    s
}

/// The record's length in this Console's ferrite (the radio's INFO says its own: LINK-21, version-tied).
pub fn record_len() -> usize {
    record_of(&Settings::DEFAULT).len()
}

/// How a setting is edited.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// One of `choices`, round and round as the knob goes (a dropdown).
    Pick,
    /// One of `choices` in order, the knob stopping at the ends (a stepper).
    Level,
    /// Typed: `hint` says what it takes.
    Text,
    /// Shown, not changed here: `note` says why.
    Readonly,
}

/// One setting as the radio's menu shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    /// The menu number ("0 7 1"), or a text field's name ("owner.name").
    pub id: String,
    /// The menu number shown ("0 7 1"); empty for a field with no menu number of its own.
    pub path: String,
    pub name: String,
    /// The third-level list it is in ("Sounds"), empty for a group's own row.
    pub sub: String,
    pub help: String,
    /// What the radio shows.
    pub value: String,
    /// Not its default (MENU-12's dot).
    pub changed: bool,
    pub kind: Kind,
    pub choices: Vec<String>,
    pub hint: String,
    pub note: String,
}

/// A settings group (MENU 0 n).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupView {
    /// "0 7"; "owner" for the owner card.
    pub path: String,
    pub name: String,
    pub items: Vec<Item>,
    /// What of the group isn't in this record.
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct View {
    pub groups: Vec<GroupView>,
    /// Notes on the record as a whole (a length this Console doesn't know).
    pub notes: Vec<String>,
}

/// A text field the menu edits on a screen of its own: its id, name, help, where it goes, and its rules.
struct TextField {
    id: &'static str,
    name: &'static str,
    help: &'static str,
    get: fn(&Settings) -> &[u8],
    set: fn(&mut Settings, &[u8]),
    max: usize,
    /// Callsign rules (SETUP-12: capitals, digits and /) instead of printable ASCII.
    call: bool,
}

const CALLSIGN: TextField = TextField {
    id: "0 8 6 1",
    name: "Callsign",
    help: "",
    get: |s| s.callsign.as_bytes(),
    set: |s, v| s.set_callsign(v),
    max: 10,
    call: true,
};
const PON_TEXT: TextField = TextField {
    id: "pon_text",
    name: "Power-on text",
    help: "Shown at power on when the message is Text.",
    get: |s| s.pon_text.as_bytes(),
    set: |s, v| s.pon_text.set(v),
    max: 16,
    call: false,
};
/// The owner card (SETUP-11): entered on the radio in setup, then edited here.
const OWNER: [TextField; 3] = [
    TextField {
        id: "owner.name",
        name: "Name",
        help: "On the owner card (boot screen).",
        get: |s| s.owner[0].as_bytes(),
        set: |s, v| s.owner[0].set(v),
        max: 20,
        call: false,
    },
    TextField {
        id: "owner.phone",
        name: "Phone",
        help: "On the owner card.",
        get: |s| s.owner[1].as_bytes(),
        set: |s, v| s.owner[1].set(v),
        max: 20,
        call: false,
    },
    TextField {
        id: "owner.email",
        name: "E-mail",
        help: "On the owner card.",
        get: |s| s.owner[2].as_bytes(),
        set: |s, v| s.owner[2].set(v),
        max: 20,
        call: false,
    },
];

fn text_field(id: &str) -> Option<&'static TextField> {
    [&CALLSIGN, &PON_TEXT, &OWNER[0], &OWNER[1], &OWNER[2]].into_iter().find(|f| f.id == id)
}

impl TextField {
    fn hint(&self) -> String {
        if self.call {
            format!("Capitals, digits and /; up to {}", self.max)
        } else {
            format!("Up to {} characters", self.max)
        }
    }

    fn check(&self, v: &str) -> Result<Vec<u8>, String> {
        let v = v.trim();
        let b: Vec<u8> = if self.call { v.to_ascii_uppercase().into_bytes() } else { v.as_bytes().to_vec() };
        if b.len() > self.max {
            return Err(format!("{}: up to {} characters", self.name, self.max));
        }
        let ok = |c: &u8| {
            if self.call {
                c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'/'
            } else {
                (0x20..0x7F).contains(c)
            }
        };
        if !b.iter().all(ok) {
            return Err(if self.call {
                format!("{}: capitals, digits and / only", self.name)
            } else {
                format!("{}: printable ASCII only", self.name)
            });
        }
        Ok(b)
    }

    fn item(&self, s: &Settings, path: &str, sub: &str) -> Item {
        let v = String::from_utf8_lossy((self.get)(s)).into_owned();
        Item {
            id: self.id.into(),
            path: path.into(),
            name: self.name.into(),
            sub: sub.into(),
            help: self.help.into(),
            changed: (self.get)(s) != (self.get)(&Settings::DEFAULT),
            value: v,
            kind: Kind::Text,
            choices: Vec::new(),
            hint: self.hint(),
            note: String::new(),
        }
    }
}

/// "0 7 1".
pub fn path_text(p: &[u8]) -> String {
    let mut s = String::from("0");
    for x in p {
        s.push_str(&format!(" {x}"));
    }
    s
}

/// "0 7 1" back to [7, 1].
pub(crate) fn parse_path(id: &str) -> Option<Vec<u8>> {
    let mut w = id.split_whitespace();
    (w.next()? == "0").then_some(())?;
    let p: Vec<u8> = w.map(|x| x.parse().ok()).collect::<Option<_>>()?;
    (2..=3).contains(&p.len()).then_some(p)
}

/// A menu path's name, if it names an item.
pub(crate) fn path_name(p: &[u8]) -> Option<&'static str> {
    match *p {
        [g, m] if (1..=9).contains(&g) => items(g, 0).get((m as usize).checked_sub(1)?).map(|e| e.name()),
        [g, m, i] if (1..=9).contains(&g) => items(g, m).get((i as usize).checked_sub(1)?).map(|e| e.name()),
        _ => None,
    }
}

fn items(g: u8, sub: u8) -> &'static [ferrite_app::screens::groups::Entry] {
    Group { g, sub, row: 0 }.items()
}

/// The menu's leaves (settings and pages), in menu order: path, name, help, and the third-level list's name.
pub(crate) fn leaves() -> Vec<(Vec<u8>, &'static str, &'static str, &'static str)> {
    let mut out = Vec::new();
    for g in 1..=9u8 {
        for (i, e) in items(g, 0).iter().enumerate() {
            let m = i as u8 + 1;
            let sub = items(g, m);
            if sub.is_empty() {
                out.push((vec![g, m], e.name(), e.help(), ""));
            } else {
                for (j, s) in sub.iter().enumerate() {
                    out.push((vec![g, m, j as u8 + 1], s.name(), s.help(), e.name()));
                }
            }
        }
    }
    out
}

/// A group's name as its screen heads itself.
fn group_name(g: u8) -> String {
    let mut b = Buf::<32>::new();
    Dest::Group(g).heading(&mut b);
    String::from_utf8_lossy(b.as_bytes()).into_owned()
}

/// What `get` says for a path.
pub(crate) struct Got {
    pub(crate) value: String,
    pub(crate) changed: bool,
    pub(crate) page: bool,
}

/// A radio in memory to ask: ferrite's App, its link session and a channel store ([`RadioSide`]), driven by the
/// terminal's commands and the keys and knob as a person would.
pub(crate) struct Scratch {
    rs: RadioSide,
    dev: Device,
    t: u32,
    /// The APRS record (LINK-43) each load puts back, through ferrite's link session, for APRS settings.
    pub(crate) aprs: Option<Vec<u8>>,
}

impl Scratch {
    pub(crate) fn new() -> Self {
        Scratch { rs: RadioSide::new(), dev: Device { tx_built: true, ..Device::default() }, t: 1000, aprs: None }
    }

    fn drain(&mut self) {
        while self.rs.app.pop_cmd().is_some() {}
        while let Some(w) = self.rs.app.pop_write() {
            self.rs.store.apply(w);
        }
    }

    pub(crate) fn load(&mut self, s: &Settings) {
        *self.rs.app.settings_mut() = *s;
        self.rs.app.go_home();
        self.drain();
        if let Some(a) = self.aprs.clone() {
            let _ = self.write_record(what::APRS, &a);
        }
    }

    /// A record written through ferrite's link session (`BEGIN`, the `WRITE` parts, `END`): the refusal, if any.
    pub(crate) fn write_record(&mut self, w: u8, rec: &[u8]) -> Result<(), String> {
        let mut err = None;
        let (s, rest) = self.rs.ask(msg::BEGIN, &begin_payload(1));
        if s != 0 {
            err = Some(status_text(s, &rest));
        }
        if err.is_none() {
            for p in write_payloads(w, 0, rec) {
                let (s, rest) = self.rs.ask(msg::WRITE, &p);
                if s != 0 {
                    err = Some(status_text(s, &rest));
                    break;
                }
            }
        }
        self.rs.ask(msg::END, &[]);
        self.drain();
        err.map_or(Ok(()), Err)
    }

    /// A record read through ferrite's link session.
    pub(crate) fn read_record(&mut self, w: u8) -> Result<Vec<u8>, String> {
        let mut r = Reader::new(w, 0);
        while !r.done() {
            let (s, rest) = self.rs.ask(msg::READ, &r.next_payload());
            if s != 0 || !r.take(&rest) {
                return Err(format!("the read back: {}", status_text(s, &rest)));
            }
        }
        Ok(r.record)
    }

    /// For the menu: channel-only mode (PIN-5) keeps MENU 0 shut, so it is off while the knob walks.
    pub(crate) fn load_for_menu(&mut self, s: &Settings) {
        self.load(&Settings { chan_only: false, ..*s });
    }

    pub(crate) fn settings(&self) -> Settings {
        *self.rs.app.settings()
    }

    /// One terminal line: what it said, or its refusal.
    pub(crate) fn run(&mut self, line: &str) -> Result<String, String> {
        let r = cmd::run(&mut self.rs.app, &self.rs.store, &self.dev, line.as_bytes(), false);
        self.drain();
        match r {
            Ok(Done::Said(m)) => Ok(String::from_utf8_lossy(m.as_bytes()).into_owned()),
            Ok(_) => Ok(String::new()),
            Err(m) => Err(String::from_utf8_lossy(m.as_bytes()).into_owned()),
        }
    }

    pub(crate) fn get(&mut self, p: &[u8], name: &str) -> Got {
        let line = self.run(&format!("get {}", path_text(p))).unwrap_or_default();
        let head = format!("{} {}: ", path_text(p), name);
        let mut v = line.strip_prefix(&head).unwrap_or(&line).to_string();
        let page = v == "a page on the radio, not a setting";
        let changed = v.ends_with(" (not the default)");
        if changed {
            v.truncate(v.len() - " (not the default)".len());
        }
        // The terminal writes a byte outside ASCII as `?`: the menu's one such character is the degree sign
        // (TONE-5's phases, "120\u{b0}"), two bytes in UTF-8.
        let v = v.replace("??", "\u{b0}");
        Got { value: if page { String::new() } else { v }, changed, page }
    }

    /// The knob on the setting's menu row until it shows `want` (up, then down for a level that stopped): the
    /// settings then, or None if the menu never shows it.
    pub(crate) fn step_to(&mut self, s: &Settings, p: &[u8], name: &str, want: &str) -> Option<Settings> {
        self.load_for_menu(s);
        if !self.open_row(p) {
            return None;
        }
        let start = self.get(p, name).value;
        for d in [1, -1] {
            for _ in 0..MANY {
                let v = self.get(p, name).value;
                if v == want {
                    return Some(Settings { chan_only: s.chan_only, ..self.settings() });
                }
                self.knob(d);
                let w = self.get(p, name).value;
                if w == v || w == start {
                    break;
                }
            }
        }
        None
    }

    /// `set`, from home (TERM-17 refuses a setting open on the menu).
    pub(crate) fn set(&mut self, p: &[u8], value: &str) -> Result<String, String> {
        self.rs.app.go_home();
        self.run(&format!("set {} {}", path_text(p), value))
    }

    fn tap(&mut self, k: Key) {
        self.rs.app.key_down(k, self.t, &self.rs.store);
        self.t += 20;
        self.rs.app.key_up(k, self.t, &self.rs.store);
        self.t += 20;
        self.drain();
    }

    pub(crate) fn knob(&mut self, d: i8) {
        self.rs.app.knob(d, self.t, &self.rs.store);
        self.t += 20;
        self.drain();
    }

    /// The menu open on this setting's row (MENU 0 g, or MENU 0 g m), as ▼ gets there.
    pub(crate) fn open_row(&mut self, p: &[u8]) -> bool {
        self.rs.app.go_home();
        let (dest, row) = match *p {
            [g, m] => (Dest::Group(g), m - 1),
            [g, m, i] => (Dest::Sub(g, m), i - 1),
            _ => return false,
        };
        self.rs.app.open(dest);
        self.drain();
        for _ in 0..row {
            self.tap(Key::Down);
        }
        matches!(self.rs.app.screen(), Screen::Group(gr) if gr.row == row)
    }

    /// The values the knob steps through on this row, and whether it stops at its ends (a level). A level comes
    /// lowest first; a round list from where the knob was.
    pub(crate) fn walk(&mut self, s: &Settings, p: &[u8], name: &str) -> (Vec<String>, bool) {
        self.load_for_menu(s);
        let start = self.get(p, name).value;
        if !self.open_row(p) {
            return (vec![start], false);
        }
        let mut seen = vec![start.clone()];
        let mut level = false;
        for _ in 0..MANY {
            self.knob(1);
            let v = self.get(p, name).value;
            if &v == seen.last().unwrap() {
                level = true;
                break;
            }
            if v == start {
                break;
            }
            seen.push(v);
        }
        if level {
            let mut down = vec![seen.last().unwrap().clone()];
            for _ in 0..MANY {
                self.knob(-1);
                let v = self.get(p, name).value;
                if &v == down.last().unwrap() {
                    break;
                }
                down.push(v);
            }
            down.reverse();
            seen = down;
        }
        (seen, level)
    }

    /// The record after a write through ferrite's link session (`apply`, with `keep_protected`), the radio holding
    /// `old` before it; or the refusal. `BEGIN` .. `END` as Console sends it.
    fn through_link(&mut self, old: &Settings, rec: &[u8]) -> Result<Vec<u8>, String> {
        self.load(old);
        let mut err = None;
        let (s, rest) = self.rs.ask(msg::BEGIN, &begin_payload(1));
        if s != 0 {
            err = Some(status_text(s, &rest));
        }
        if err.is_none() {
            for p in write_payloads(what::SETTINGS, 0, rec) {
                let (s, rest) = self.rs.ask(msg::WRITE, &p);
                if s != 0 {
                    err = Some(status_text(s, &rest));
                    break;
                }
            }
        }
        self.rs.ask(msg::END, &[]);
        self.drain();
        if let Some(e) = err {
            return Err(e);
        }
        let mut r = Reader::new(what::SETTINGS, 0);
        while !r.done() {
            let (s, rest) = self.rs.ask(msg::READ, &r.next_payload());
            if s != 0 || !r.take(&rest) {
                return Err(format!("the read back: {}", status_text(s, &rest)));
            }
        }
        Ok(r.record)
    }
}

/// What the scratch radios found about each setting, which doesn't depend on the record: found once.
#[derive(Clone)]
struct Class {
    /// What shows depends on the record.
    in_record: bool,
    /// The first of its choices on a record of zeros (the list's own first), for ordering a round list.
    first: Option<String>,
    /// The link writes it (LINK-5), when it is a choice.
    linked: Option<bool>,
}

thread_local! {
    static SCRATCH: RefCell<Option<Scratch>> = const { RefCell::new(None) };
    static LINKSIDE: RefCell<Option<Scratch>> = const { RefCell::new(None) };
    static CLASS: RefCell<HashMap<Vec<u8>, Class>> = RefCell::new(HashMap::new());
}

fn scratch<R>(f: impl FnOnce(&mut Scratch) -> R) -> R {
    SCRATCH.with(|c| f(c.borrow_mut().get_or_insert_with(Scratch::new)))
}

fn linkside<R>(f: impl FnOnce(&mut Scratch) -> R) -> R {
    LINKSIDE.with(|c| f(c.borrow_mut().get_or_insert_with(Scratch::new)))
}

/// Whether what the path shows follows the record: the record with each bit k flipped in every byte, for k in 0..8.
fn in_record(sc: &mut Scratch, rec: &[u8], p: &[u8], name: &str) -> bool {
    sc.load(&settings_of(rec));
    let base = sc.get(p, name).value;
    (0..8).any(|k| {
        let flipped: Vec<u8> = rec.iter().map(|b| b ^ (1 << k)).collect();
        sc.load(&settings_of(&flipped));
        sc.get(p, name).value != base
    })
}

/// A callsign for walks: CW ID (0 8 6 2) won't step without one (VOX-10).
pub(crate) fn with_call(mut s: Settings) -> Settings {
    if s.callsign.is_empty() {
        s.set_callsign(b"N0CALL");
    }
    s
}

/// How a setting (in the record) is changed here, found with `set` and the knob.
pub(crate) fn classify(
    sc: &mut Scratch,
    s: &Settings,
    p: &[u8],
    name: &str,
    cur: &str,
) -> (Kind, Vec<String>, String, String) {
    sc.load(s);
    let strip = |e: &str| e.strip_prefix(&format!("{name}: ")).unwrap_or(e).to_string();
    match sc.set(p, NOT_A_VALUE) {
        Ok(_) => (Kind::Text, Vec::new(), String::new(), String::new()),
        Err(e) if e.contains(RADIO_ONLY) => (Kind::Readonly, Vec::new(), String::new(), RADIO_ONLY.into()),
        Err(e) if e.contains("can't be set yet") => (Kind::Readonly, Vec::new(), String::new(), RADIO_ONLY.into()),
        Err(e) if e.contains(": one of ") => {
            let (mut v, level) = sc.walk(&with_call(*s), p, name);
            if v.len() >= MANY {
                return (Kind::Text, Vec::new(), String::new(), String::new());
            }
            let first = class_of(p).and_then(|c| c.first);
            if !level {
                if let Some(i) = first.and_then(|f| v.iter().position(|x| *x == f)) {
                    v.rotate_left(i);
                }
            }
            (if level { Kind::Level } else { Kind::Pick }, v, String::new(), String::new())
        }
        Err(e) => {
            sc.load(s);
            match sc.set(p, cur) {
                Ok(_) => (Kind::Text, Vec::new(), strip(&e), String::new()),
                Err(why) => (Kind::Readonly, Vec::new(), String::new(), strip(&why)),
            }
        }
    }
}

fn class_of(p: &[u8]) -> Option<Class> {
    CLASS.with(|c| c.borrow().get(p).cloned())
}

/// Finds each leaf's [`Class`] once (on `rec`, any record of this layout).
fn learn(rec: &[u8]) {
    if CLASS.with(|c| !c.borrow().is_empty()) {
        return;
    }
    let zeros = vec![0u8; rec.len()];
    let zero = with_call(settings_of(&zeros));
    let s = settings_of(rec);
    let mut map = HashMap::new();
    scratch(|sc| {
        for (p, name, _, _) in leaves() {
            let mut in_rec = in_record(sc, rec, &p, name);
            if in_rec {
                // Shown from the record but kept elsewhere (APRS's frequency follows the region): the knob changes
                // what shows and not the record.
                sc.load_for_menu(&with_call(s));
                let (r0, v0) = (record_of(&sc.settings()), sc.get(&p, name).value);
                if sc.open_row(&p) {
                    sc.knob(1);
                    if sc.get(&p, name).value != v0 && record_of(&sc.settings()) == r0 {
                        in_rec = false;
                    }
                }
            }
            let mut c = Class { in_record: in_rec, first: None, linked: None };
            if in_rec {
                sc.load(&zero);
                if let Err(e) = sc.set(&p, NOT_A_VALUE) {
                    if e.contains(": one of ") {
                        c.first = sc.walk(&zero, &p, name).0.first().cloned();
                        // LINK-5: another value, written through ferrite's link session from this record.
                        let (vals, _) = sc.walk(&with_call(s), &p, name);
                        sc.load(&with_call(s));
                        let cur = sc.get(&p, name).value;
                        if let Some(alt) = vals.iter().find(|v| **v != cur) {
                            if let Some(n) = sc.step_to(&with_call(s), &p, name, alt) {
                                let want = record_of(&n);
                                let old = with_call(s);
                                let back = linkside(|l| l.through_link(&old, &want));
                                c.linked = Some(back.is_ok_and(|b| {
                                    sc.load(&settings_of(&b));
                                    sc.get(&p, name).value == *alt
                                }));
                            }
                        }
                    }
                }
            }
            map.insert(p, c);
        }
    });
    CLASS.with(|c| *c.borrow_mut() = map);
}

/// The record as the radio's menu shows it, grouped as MENU 0 groups it.
pub fn view(rec: &[u8]) -> View {
    learn(rec);
    let s = settings_of(rec);
    let mut notes = Vec::new();
    if rec.len() != record_len() {
        notes.push(format!(
            "This radio's settings record is {} bytes; this Console's ferrite has {}: read only until both are the same version.",
            rec.len(),
            record_len()
        ));
    }
    let mut groups: Vec<GroupView> = (1..=9)
        .map(|g| GroupView { path: format!("0 {g}"), name: group_name(g), items: Vec::new(), note: String::new() })
        .collect();
    let mut elsewhere: Vec<Vec<&str>> = vec![Vec::new(); 9];
    scratch(|sc| {
        for (p, name, help, sub) in leaves() {
            let g = p[0] as usize - 1;
            let id = path_text(&p);
            if id == CALLSIGN.id {
                groups[g].items.push(CALLSIGN.item(&s, &id, sub));
                continue;
            }
            sc.load(&s);
            let got = sc.get(&p, name);
            if got.page {
                continue;
            }
            let class = class_of(&p).unwrap_or(Class { in_record: false, first: None, linked: None });
            if !class.in_record {
                if !got.value.is_empty() {
                    elsewhere[g].push(name);
                }
                continue;
            }
            let (mut kind, choices, hint, mut note) = classify(sc, &s, &p, name, &got.value);
            if class.linked == Some(false) {
                (kind, note) = (Kind::Readonly, RADIO_ONLY.into());
            }
            groups[g].items.push(Item {
                id: id.clone(),
                path: id,
                name: name.into(),
                sub: sub.into(),
                help: help.into(),
                value: got.value,
                changed: got.changed,
                kind,
                choices: if kind == Kind::Readonly { Vec::new() } else { choices },
                hint,
                note,
            });
            if p == [7, 3, 2] {
                groups[g].items.push(PON_TEXT.item(&s, "", sub));
            }
        }
    });
    for (g, names) in elsewhere.iter().enumerate() {
        if names.is_empty() {
            continue;
        }
        groups[g].note = if g == 4 {
            format!("In the APRS record: Tools › APRS › APRS Settings: {}.", names.join(", "))
        } else {
            format!("Not in the settings record (on the radio only): {}.", names.join(", "))
        };
    }
    groups.push(GroupView {
        path: "owner".into(),
        name: "Owner card".into(),
        items: OWNER.iter().map(|f| f.item(&s, "", "")).collect(),
        note: "Setup's page 4 (SETUP-11); shown at boot when 0 7 3 3 Boot screen is Owner card.".into(),
    });
    groups.retain(|g| !g.items.is_empty() || !g.note.is_empty());
    View { groups, notes }
}

/// One setting changed in a record: the menu's `set` (the knob walked to it, with the radio's checks), or a text
/// field set by the radio's rules. The new record, or why not in the radio's words.
pub fn set(rec: &[u8], id: &str, value: &str) -> Result<Vec<u8>, String> {
    let mut s = settings_of(rec);
    if let Some(f) = text_field(id) {
        let v = f.check(value)?;
        (f.set)(&mut s, &v);
        return Ok(record_of(&s));
    }
    let p = parse_path(id).ok_or_else(|| format!("{id}: not a setting"))?;
    if class_of(&p).is_some_and(|c| c.linked == Some(false)) {
        return Err(format!("{id}: {RADIO_ONLY}"));
    }
    let name = path_name(&p).ok_or_else(|| format!("{id}: not a setting"))?;
    let value = value.trim();
    scratch(|sc| {
        // A choice: the knob turned to it on the menu row, as on the radio (`change`).
        if class_of(&p).is_some_and(|c| c.first.is_some()) {
            return match sc.step_to(&s, &p, name, value) {
                Some(n) => Ok(record_of(&n)),
                None => Err(match sc.set(&p, NOT_A_VALUE) {
                    Err(e) if e.contains(": one of ") && e.contains(value) => {
                        format!("{name}: the radio won't take {value} now")
                    }
                    Err(e) => e.replace("??", "\u{b0}"),
                    Ok(_) => format!("{name}: not changed"),
                }),
            };
        }
        // Typed (or refused): the terminal's `set`, with the radio's checks.
        sc.load(&s);
        sc.set(&p, value)?;
        Ok(record_of(&sc.settings()))
    })
}

/// A setting that differs between two records.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Change {
    pub id: String,
    pub path: String,
    pub group: String,
    pub name: String,
    pub from: String,
    pub to: String,
}

/// What differs, setting by setting, as the menu shows them; bytes no setting shows come as one "Other" line.
pub fn diff(old: &[u8], new: &[u8]) -> Vec<Change> {
    let (a, b) = (view(old), view(new));
    let mut out = Vec::new();
    for (ga, gb) in a.groups.iter().zip(&b.groups) {
        for (x, y) in ga.items.iter().zip(&gb.items) {
            if x.id == y.id && x.value != y.value {
                out.push(Change {
                    id: y.id.clone(),
                    path: y.path.clone(),
                    group: gb.name.clone(),
                    name: y.name.clone(),
                    from: x.value.clone(),
                    to: y.value.clone(),
                });
            }
        }
    }
    if out.is_empty() && old != new {
        let n = old.iter().zip(new).filter(|(x, y)| x != y).count() + old.len().abs_diff(new.len());
        out.push(Change {
            id: "other".into(),
            path: String::new(),
            group: String::new(),
            name: "Other settings".into(),
            from: String::new(),
            to: format!("{n} bytes no menu item shows"),
        });
    }
    out
}

/// A settings write: the diff, `BEGIN`'s payload, the one write (its parts), and what ferrite's own link session
/// would refuse or keep (a write with problems must not be sent).
#[derive(Clone, Debug, Serialize)]
pub struct Plan {
    pub changes: Vec<Change>,
    pub begin: Vec<u8>,
    pub ops: Vec<Op>,
    pub problems: Vec<Problem>,
}

/// The write from `base` (the radio's record, read just now) to `want`, run first through ferrite's link session
/// seeded with `base`: refusals, and any setting that wouldn't end up as asked (LINK-5's), are problems.
pub fn plan(base: &[u8], want: &[u8]) -> Plan {
    let changes = diff(base, want);
    let mut problems = Vec::new();
    let mut ops = Vec::new();
    let problem = |e: String| Problem { what: "settings".into(), number: 0, error: e };
    if base.len() != record_len() || want.len() != record_len() {
        problems.push(problem(format!(
            "the radio's settings record is {} bytes, this Console's {}: update one so they match",
            base.len(),
            record_len()
        )));
    } else if !changes.is_empty() {
        ops.push(Op {
            kind: "write",
            what: "settings",
            number: 0,
            msg: msg::WRITE,
            payloads: write_payloads(what::SETTINGS, 0, want),
        });
        match linkside(|l| l.through_link(&settings_of(base), want)) {
            Err(e) => problems.push(problem(e)),
            Ok(back) if back != want => {
                for c in diff(want, &back) {
                    problems.push(problem(format!(
                        "{} {}: the radio would keep {} ({})",
                        c.path, c.name, c.to, RADIO_ONLY
                    )));
                }
            }
            Ok(_) => {}
        }
    }
    Plan { changes, begin: begin_payload(ops.len() as u16), ops, problems }
}

/// The backup file: Console's own JSON, the record as the link carries it (hex), with the settings as the menu
/// shows them beside it for reading.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub saved: String,
    #[serde(default)]
    pub radio: BTreeMap<String, String>,
    pub record: String,
    #[serde(default)]
    pub settings: BTreeMap<String, String>,
}

pub fn backup(rec: &[u8], saved: &str, radio: BTreeMap<String, String>) -> String {
    let settings = view(rec)
        .groups
        .iter()
        .flat_map(|g| {
            g.items
                .iter()
                .map(|i| (format!("{} {}", if i.path.is_empty() { &i.id } else { &i.path }, i.name), i.value.clone()))
        })
        .collect();
    let b = Backup { format: BACKUP_FORMAT.into(), version: 1, saved: saved.into(), radio, record: hex(rec), settings };
    serde_json::to_string_pretty(&b).unwrap_or_default()
}

/// A backup file back to its record, or why not.
pub fn restore(text: &str) -> Result<(Vec<u8>, Backup), String> {
    let b: Backup = serde_json::from_str(text).map_err(|e| format!("not a Ferrite Console settings backup: {e}"))?;
    if b.format != BACKUP_FORMAT {
        return Err(format!("not a settings backup (format {:?})", b.format));
    }
    if b.version != 1 {
        return Err(format!("backup version {} is newer than this Console reads", b.version));
    }
    let rec = unhex(&b.record).ok_or("its record isn't hex")?;
    Ok((rec, b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::read_payload;

    /// A radio's record read over ferrite's link session (READ, part by part).
    fn read_over_link(r: &mut RadioSide) -> Vec<u8> {
        let mut rd = Reader::new(what::SETTINGS, 0);
        while !rd.done() {
            let (s, rest) = r.ask(msg::READ, &rd.next_payload());
            assert_eq!(s, 0, "{}", status_text(s, &rest));
            assert!(rd.take(&rest));
        }
        rd.record
    }

    fn radio_with(s: Settings) -> RadioSide {
        let mut r = RadioSide::new();
        *r.app.settings_mut() = s;
        r
    }

    fn item<'a>(v: &'a View, id: &str) -> &'a Item {
        v.groups.iter().flat_map(|g| &g.items).find(|i| i.id == id).unwrap_or_else(|| panic!("{id} not in the view"))
    }

    fn changed_radio() -> Settings {
        let mut s = Settings::DEFAULT;
        s.set_callsign(b"n0call");
        s.theme = 1;
        s.key_beep = false;
        s.region = 1;
        s.pin_len = 4;
        s.pin = 1234;
        s.mic_gain = 7;
        s
    }

    /// The record read from ferrite's link session is the one `record_of` makes (the PIN as zeros), and it
    /// decodes back to the radio's settings.
    #[test]
    fn record_matches_ferrites_session() {
        let s = changed_radio();
        let mut r = radio_with(s);
        let rec = read_over_link(&mut r);
        assert_eq!(rec, record_of(&s));
        assert_eq!(rec.len(), record_len());
        assert_eq!(settings_of(&rec), Settings { pin: 0, ..s });
        // INFO's length is the same (LINK-21).
        let (st, info) = r.ask(msg::INFO, &[]);
        assert_eq!(st, 0);
        assert_eq!(crate::answers::Info::parse(&info).unwrap().settings_len as usize, record_len());
        let (st, _) = r.ask(msg::READ, &read_payload(what::SETTINGS, 1, 0, 10));
        assert_ne!(st, 0, "one settings record only");
    }

    /// The view: the menu's numbers, names and values; choices from the knob; LINK-5's read only.
    #[test]
    fn view_is_the_menus() {
        let rec = record_of(&changed_radio());
        let v = view(&rec);
        let names: Vec<&str> = v.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(
            &names[..],
            [
                "Watch and scan",
                "Channels",
                "Tools",
                "Decoders and alerts",
                "APRS",
                "GPS and time",
                "Display, sound, power",
                "Transmit",
                "System",
                "Owner card"
            ]
        );
        let theme = item(&v, "0 7 1");
        assert_eq!((theme.name.as_str(), theme.value.as_str(), theme.kind), ("Theme", "Daylight", Kind::Pick));
        assert_eq!(theme.choices, ["Dark", "Daylight", "Night red", "Cyberpunk"]);
        assert!(theme.changed);
        let beep = item(&v, "0 7 5 1");
        assert_eq!((beep.name.as_str(), beep.sub.as_str(), beep.value.as_str()), ("Key beep", "Sounds", "Off"));
        assert_eq!(beep.choices, ["Off", "On"]);
        let mic = item(&v, "0 8 3");
        assert_eq!((mic.kind, mic.value.as_str()), (Kind::Level, "7"));
        assert_eq!(mic.choices, ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
        let tot = item(&v, "0 8 1");
        assert_eq!(tot.kind, Kind::Level);
        assert_eq!((tot.choices.first().unwrap().as_str(), tot.choices.last().unwrap().as_str()), ("30 s", "600 s"));
        // LINK-5: never changed over the link.
        for id in ["0 9 4", "0 8 8 4", "0 9 3 1", "0 9 2 3", "0 5 8"] {
            let i = item(&v, id);
            assert_eq!((i.kind, i.note.as_str()), (Kind::Readonly, RADIO_ONLY), "{id}");
        }
        assert_eq!(item(&v, "0 9 4").value, "United States");
        // Typed: the pager frequency.
        assert_eq!(item(&v, "0 4 2 2").kind, Kind::Text);
        let call = item(&v, "0 8 6 1");
        assert_eq!((call.kind, call.value.as_str()), (Kind::Text, "N0CALL"));
        // Not in this record: Watch (slot state), Dry TX (this power-on), APRS's own record.
        for id in ["0 1 1", "0 8 8 5", "0 5 5 1", "0 5 4"] {
            assert!(v.groups.iter().flat_map(|g| &g.items).all(|i| i.id != id), "{id}");
        }
        let aprs = &v.groups[4];
        assert!(aprs.note.contains("APRS record") && aprs.note.contains("SSID"), "{}", aprs.note);
        assert!(item(&v, "0 5 3").kind == Kind::Pick, "APRS mode is in the record");
        assert!(v.notes.is_empty());
    }

    /// A change: the menu's own `set`, ferrite's refusal for a value it doesn't have, text rules.
    #[test]
    fn set_and_diff() {
        let rec = record_of(&changed_radio());
        let new = set(&rec, "0 7 1", "Cyberpunk").unwrap();
        assert_eq!(settings_of(&new).theme, 3);
        let new = set(&new, "0 7 5 1", "On").unwrap();
        let d = diff(&rec, &new);
        let got: Vec<(&str, &str, &str)> =
            d.iter().map(|c| (c.path.as_str(), c.from.as_str(), c.to.as_str())).collect();
        assert_eq!(got, [("0 7 1", "Daylight", "Cyberpunk"), ("0 7 5 1", "Off", "On")]);
        // DISP-23: night red keeps its own brightness, and the menu shows it: the diff says what 0 7 4 2 will show.
        let night = set(&rec, "0 7 1", "Night red").unwrap();
        assert!(diff(&rec, &night).iter().any(|c| c.path == "0 7 4 2" && c.to == "3"));
        let e = set(&rec, "0 7 1", "Purple").unwrap_err();
        assert!(e.starts_with("Theme: one of ") && e.contains("Night red"), "{e}");
        assert!(set(&rec, "0 9 4", "Canada").unwrap_err().contains(RADIO_ONLY));
        assert!(set(&rec, "0 9 2 3", "Terminal").unwrap_err().contains(RADIO_ONLY));
        let new = set(&rec, "0 4 2 2", "439.9875").unwrap();
        assert_eq!(settings_of(&new).pocsag_freq, 43_998_750);
        assert!(set(&rec, "0 4 2 2", "nonsense").is_err());
        let new = set(&rec, "0 8 6 1", "w1aw/7").unwrap();
        assert_eq!(settings_of(&new).callsign.as_bytes(), b"W1AW/7");
        assert!(set(&rec, "0 8 6 1", "W1AW-7").is_err());
        let new = set(&rec, "owner.name", "Alex").unwrap();
        assert_eq!(settings_of(&new).owner[0].as_bytes(), b"Alex");
        assert!(set(&rec, "owner.name", "x".repeat(21).as_str()).is_err());
        assert!(diff(&rec, &rec).is_empty());
        // Channel-only mode on: still changed (the menu walk runs with it off, and it stays on).
        let mut co = settings_of(&rec);
        co.chan_only = true;
        let new = set(&record_of(&co), "0 7 1", "Dark").unwrap();
        assert_eq!((settings_of(&new).theme, settings_of(&new).chan_only), (0, true));
        // A value with the degree sign, stepped to on the menu.
        let new = set(&rec, "0 8 8 3", "180\u{b0}").unwrap();
        assert_eq!(settings_of(&new).tail_phase, 2);
        assert_eq!(item(&view(&new), "0 8 8 3").value, "180\u{b0}");
    }

    /// A changed setting survives the write through ferrite's link session and reads back; the plan finds no
    /// problems; a write the radio would partly keep (a LINK-5 setting in the record) is a problem.
    #[test]
    fn write_and_read_back() {
        let s = changed_radio();
        let mut radio = radio_with(s);
        let base = read_over_link(&mut radio);
        let want = set(&set(&base, "0 7 1", "Cyberpunk").unwrap(), "0 7 5 1", "On").unwrap();
        let p = plan(&base, &want);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.changes.len(), 2);
        assert_eq!(p.ops.len(), 1);
        // The plan's requests, sent to the radio as Console sends them.
        assert_eq!(radio.ask(msg::BEGIN, &p.begin).0, 0);
        for op in &p.ops {
            for part in &op.payloads {
                let (st, rest) = radio.ask(op.msg, part);
                assert_eq!(st, 0, "{}", status_text(st, &rest));
            }
        }
        assert_eq!(radio.ask(msg::END, &[]).0, 0);
        let back = read_over_link(&mut radio);
        assert_eq!(back, want);
        assert_eq!(radio.app.settings().theme, 3);
        assert!(radio.app.settings().key_beep);
        assert_eq!(radio.app.settings().pin, 1234, "the PIN stays the radio's (LINK-7)");
        // Put back.
        let p = plan(&back, &base);
        assert!(p.problems.is_empty());
        // LINK-5: a record that changes the region (a restored file from elsewhere) would be kept by the radio.
        let mut other = settings_of(&base);
        other.region = 4;
        let p = plan(&base, &record_of(&other));
        assert_eq!(p.problems.len(), 1, "{:?}", p.problems);
        assert!(p.problems[0].error.contains("0 9 4 Region"), "{}", p.problems[0].error);
        // Nothing to write.
        assert!(plan(&base, &base).ops.is_empty());
    }

    #[test]
    fn backup_round_trip() {
        let rec = record_of(&changed_radio());
        let text = backup(&rec, "2026-10-20T12:00:00Z", BTreeMap::from([("callsign".into(), "N0CALL".into())]));
        let (back, b) = restore(&text).unwrap();
        assert_eq!(back, rec);
        assert_eq!(b.settings.get("0 7 1 Theme").map(String::as_str), Some("Daylight"));
        assert!(restore("{}").is_err());
        assert!(restore(&text.replace(BACKUP_FORMAT, "ferrite-console-channels")).is_err());
    }

    /// A record of another length (another firmware) shows, but isn't written.
    #[test]
    fn other_length_read_only() {
        let mut rec = record_of(&Settings::DEFAULT);
        rec.push(0);
        assert_eq!(view(&rec).notes.len(), 1);
        let want = set(&rec, "0 7 1", "Daylight").unwrap();
        assert!(!plan(&rec, &want).problems.is_empty());
    }
}
