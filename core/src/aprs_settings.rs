//! APRS settings: all of MENU 0 5 the link can change, as the menu shows it. Most are in the APRS record (`what` 5,
//! LINK-43: the frequency, beacon mode, power, path, digipeater, beacon after voice, SSID, custom path and FX.25);
//! the rest of MENU 0 5 no record carries (the symbol, comment, ambiguity, Mic-E, telemetry, TX delay and level) are
//! read with the terminal's `dump` and changed with its `set` over the link (`CMD`, LINK-34: [`crate::settings::Term`]).
//! Shown, changed and checked as Radio Settings does the settings record: by ferrite's own App and link session,
//! never a copy of the menu. The settings record's MENU 0 5 settings (APRS mode, position, KISS, mute, Shared VHF)
//! stay in Radio Settings; [`View::elsewhere`] names them.
//!
//! The scratch radio holds the radio's settings record (its region decides "the region's" frequency), the APRS
//! record (written through ferrite's link session: `aprs_apply`'s checks) and the terminal-backed values. A MENU 0 5
//! setting is in the APRS record when what the menu shows follows that record; it is changed with the menu's knob or
//! the terminal's `set`, as Radio Settings changes a setting, and the record is then read back through the link.

use crate::plan::{hex, unhex, Op, Problem};
use crate::records::{begin_payload, write_payloads};
use crate::settings::{
    self, classify, leaves, parse_path, path_name, path_text, settings_of, term_cmds, term_item, term_items, term_set,
    with_call, Extras, Item, Kind, Scratch, NOT_A_VALUE, RADIO_ONLY,
};
use ferrite_app::settings::Settings;
use ferrite_core::link::{msg, what};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::BTreeMap;

/// The record's length (LINK-43), ferrite's own (25 since FX.25, decision 237).
pub const RECORD_LEN: usize = ferrite_app::link::APRS_REC;
/// The backup file's format name.
pub const BACKUP_FORMAT: &str = "ferrite-console-aprs";

/// A menu path and its value on a record of zeros.
type Leaf = (Vec<u8>, String);

thread_local! {
    static SCRATCH: RefCell<Option<Scratch>> = const { RefCell::new(None) };
    /// The settings that follow the APRS record (their menu paths, and what each shows on a record of zeros: a
    /// list's first choice), found once.
    static IN_RECORD: RefCell<Option<Vec<Leaf>>> = const { RefCell::new(None) };
    static ELSEWHERE: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

fn scratch<R>(f: impl FnOnce(&mut Scratch) -> R) -> R {
    SCRATCH.with(|c| f(c.borrow_mut().get_or_insert_with(Scratch::new)))
}

/// Two records differing in every field (both valid): a setting whose value differs between them follows the record.
fn probes() -> [Vec<u8>; 2] {
    // Past FX.25 (decision 347): message sound, symbol, TX delay, TX level, the comment, ambiguity, Mic-E, telemetry.
    const V2: usize = 25;
    const END: usize = V2 + 4 + ferrite_app::aprs::COMMENT_LEN;
    let mut a = vec![0u8; RECORD_LEN];
    a[V2 + 2] = ferrite_app::aprs::TXDELAY_MIN; // the lowest TX delay (0 isn't one)
    let mut b = vec![0u8; RECORD_LEN];
    b[..2].copy_from_slice(&28_960u16.to_le_bytes()); // 144.800 MHz
    b[2..8].copy_from_slice(&[4, 2, 3, 0x33, 1, 9]); // every 5 min, high, custom path, digi on + my call + 3 s, after voice, SSID 9
    b[8..15].copy_from_slice(b"WIDE2-2");
    b[24] = 32; // FX.25 on TX, 32 check bytes (APRS-45)
    b[V2..V2 + 4].copy_from_slice(&[2, 3, 50, 2]);
    b[V2 + 4..V2 + 9].copy_from_slice(b"probe");
    b[END..END + 3].copy_from_slice(&[2, 3, 1]);
    b[ferrite_app::link::APRS_REPLY_AT] = 1; // auto reply on (APRS-57, 0.8.2)
    b[ferrite_app::link::APRS_TEXT_AT] = 3; // the beacon text every 8th beacon (APRS-50.1, 0.8.5)
    [a, b]
}

/// The settings the record holds: MENU 0 5's leaves whose shown value follows it, each with its value on a record
/// of zeros.
fn in_record(sc: &mut Scratch, s: &Settings) -> Vec<Leaf> {
    if let Some(v) = IN_RECORD.with(|c| c.borrow().clone()) {
        return v;
    }
    let [a, b] = probes();
    let mut out = Vec::new();
    let s = with_call(*s);
    // MENU 0 5 (the record also holds the message sound, 0 7 5 5, but Radio Settings shows it, from the radio
    // record: decision 347).
    for (p, name, _, _) in leaves().into_iter().filter(|l| l.0[0] == 5) {
        sc.aprs = Some(a.clone());
        sc.load(&s);
        let va = sc.get(&p, name);
        sc.aprs = Some(b.clone());
        sc.load(&s);
        let vb = sc.get(&p, name);
        if !va.page && va.value != vb.value {
            out.push((p, va.value));
        }
    }
    sc.aprs = None;
    IN_RECORD.with(|c| *c.borrow_mut() = Some(out.clone()));
    out
}

/// The menu paths the APRS record holds. Never called inside `scratch`.
pub(crate) fn record_paths() -> Vec<Vec<u8>> {
    scratch(|sc| in_record(sc, &Settings::DEFAULT)).into_iter().map(|l| l.0).collect()
}

/// MENU 0 5 as APRS Settings shows it (in menu order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct View {
    pub items: Vec<Item>,
    /// Notes on the record as a whole (refused by this Console's ferrite, a length it doesn't know).
    pub notes: Vec<String>,
    /// MENU 0 5's settings in the settings record, shown in Radio Settings ("0 5 3 APRS mode").
    pub elsewhere: Vec<String>,
}

/// MENU 0 5's settings Radio Settings shows (the settings record's), found once. Never called inside `scratch`.
fn elsewhere() -> Vec<String> {
    if let Some(v) = ELSEWHERE.with(|c| c.borrow().clone()) {
        return v;
    }
    let v: Vec<String> = settings::view(&settings::record_of(&Settings::DEFAULT), &Extras::new())
        .groups
        .iter()
        .flat_map(|g| &g.items)
        .filter(|i| i.path.starts_with("0 5 "))
        .map(|i| format!("{} {}", i.path, i.name))
        .collect();
    ELSEWHERE.with(|c| *c.borrow_mut() = Some(v.clone()));
    v
}

/// The settings record to use: the radio's, or the defaults when it wasn't read (the region then is the default's).
fn settings_or_default(settings_rec: &[u8]) -> Settings {
    if settings_rec.is_empty() {
        Settings::DEFAULT
    } else {
        settings_of(settings_rec)
    }
}

/// The APRS record and the terminal-backed values (`ex`) as MENU 0 5 shows them, the radio's settings record
/// (`settings_rec`, may be empty) beside them.
pub fn view(settings_rec: &[u8], rec: &[u8], ex: &Extras) -> View {
    let s = settings_or_default(settings_rec);
    let term = term_items();
    let elsewhere = elsewhere();
    scratch(|sc| {
        let paths = in_record(sc, &s);
        let mut notes = Vec::new();
        if rec.len() != RECORD_LEN {
            notes.push(format!(
                "This radio's APRS record is {} bytes; this Console's ferrite has {RECORD_LEN}: read only.",
                rec.len()
            ));
        }
        sc.aprs = None;
        sc.load(&s);
        if let Err(e) = sc.write_record(what::APRS, rec) {
            notes
                .push(format!("This Console's ferrite refuses the record ({e}): the values shown aren't the radio's."));
        }
        let base = sc.read_record(what::APRS).unwrap_or_default();
        sc.aprs = Some(base);
        sc.term = Some((term.clone(), ex.clone()));
        let mut items = Vec::new();
        for (p, name, help, sub) in leaves() {
            if let Some(t) = term.iter().find(|t| t.path == p && p[0] == 5) {
                items.push(term_item(sc, &s, t, ex, sub, &help));
                continue;
            }
            let Some((_, first)) = paths.iter().find(|x| x.0 == p) else { continue };
            sc.load(&s);
            let got = sc.get(&p, name);
            let (kind, mut choices, hint, note) = classify(sc, &s, &p, name, &got.value);
            // a round list from its own first (as on a fresh radio), not from where the knob was
            if kind == Kind::Pick {
                if let Some(i) = choices.iter().position(|c| c == first) {
                    choices.rotate_left(i);
                }
            }
            let id = path_text(&p);
            items.push(Item {
                id: id.clone(),
                path: id,
                name: name.into(),
                sub: sub.into(),
                help,
                value: got.value,
                changed: got.changed,
                kind,
                choices: if kind == Kind::Readonly { Vec::new() } else { choices },
                hint,
                note,
            });
        }
        if rec.len() == RECORD_LEN {
            items.extend(reply_items(rec));
        }
        sc.aprs = None;
        sc.term = None;
        View { items, notes, elsewhere }
    })
}

/// APRS-57: auto reply's page (MENU 0 5 9 9) beyond its on/off row: who it answers, the delay and the reply,
/// from the record's end (0.8.2). Their ids aren't menu numbers: `reply.to`, `reply.delay`, `reply.text`.
fn reply_items(rec: &[u8]) -> Vec<Item> {
    use ferrite_app::aprs::{REPLY_DELAY_NAMES, REPLY_TO_LEN};
    let at = ferrite_app::link::APRS_REPLY_AT;
    let text = |b: &[u8]| String::from_utf8_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())]).into_owned();
    let to = match text(&rec[at + 1..at + 1 + REPLY_TO_LEN]) {
        t if t.is_empty() => "*".to_string(),
        t => t,
    };
    let delay = (rec[at] >> 4) as usize % REPLY_DELAY_NAMES.len();
    let reply = text(&rec[at + 1 + REPLY_TO_LEN..]);
    let item = |id: &str, name: &str, help: &str, value: String, changed: bool, kind: Kind, choices: Vec<String>, hint: &str| Item {
        id: id.into(),
        path: "0 5 9 9".into(),
        name: name.into(),
        sub: "Auto reply".into(),
        help: help.into(),
        value,
        changed,
        kind,
        choices,
        hint: hint.into(),
        note: String::new(),
    };
    vec![
        item("reply.to", "Reply to", "Who gets the reply: * everyone, VE7* every call starting VE7, or one callsign-SSID.", to.clone(), to != "*", Kind::Text, Vec::new(), "* everyone, VE7* a prefix, or one callsign-SSID"),
        item("reply.delay", "Delay", "How long after a message the reply goes.", REPLY_DELAY_NAMES[delay].into(), delay != 0, Kind::Pick, REPLY_DELAY_NAMES.iter().map(|n| n.to_string()).collect(), ""),
        item("reply.text", "Message", "What is sent, once per station in 30 minutes. None is sent without one.", reply.clone(), !reply.is_empty(), Kind::Text, Vec::new(), "up to 45 characters"),
    ]
}

/// APRS-57: one of auto reply's page values set: the record with it changed, checked by ferrite's own link session
/// (`aprs_apply`, as the page checks it), or the radio's reason.
fn set_reply(s: &Settings, rec: &[u8], ex: &Extras, field: &str, value: &str) -> Result<(Vec<u8>, Extras), String> {
    use ferrite_app::aprs::{REPLY_DELAY_NAMES, REPLY_TEXT_LEN, REPLY_TO_LEN};
    if rec.len() != RECORD_LEN {
        return Err("auto reply needs Ferrite 0.8.2 or later on the radio".into());
    }
    let at = ferrite_app::link::APRS_REPLY_AT;
    let mut r = rec.to_vec();
    let put = |r: &mut [u8], v: &[u8], max: usize, what: &str| -> Result<(), String> {
        if v.len() > max {
            return Err(format!("{what}: up to {max} characters"));
        }
        r[..max].fill(0);
        r[..v.len()].copy_from_slice(v);
        Ok(())
    };
    match field {
        "to" => put(&mut r[at + 1..], value.to_ascii_uppercase().as_bytes(), REPLY_TO_LEN, "Reply to")?,
        "text" => put(&mut r[at + 1 + REPLY_TO_LEN..], value.as_bytes(), REPLY_TEXT_LEN, "Message")?,
        "delay" => {
            let i = REPLY_DELAY_NAMES.iter().position(|n| *n == value).ok_or_else(|| format!("Delay: one of {}", REPLY_DELAY_NAMES.join(", ")))?;
            r[at] = r[at] & 0x0F | (i as u8) << 4;
        }
        _ => return Err(format!("reply.{field}: not an auto reply setting")),
    }
    scratch(|sc| {
        sc.aprs = None;
        sc.load(s);
        sc.write_record(what::APRS, &r)?;
        let back = sc.read_record(what::APRS)?;
        Ok((back, ex.clone()))
    })
}

/// One setting changed (`id` its menu number) to a value as the menu shows it: the new record and terminal-backed
/// values, or the radio's reason.
pub fn set(settings_rec: &[u8], rec: &[u8], ex: &Extras, id: &str, value: &str) -> Result<(Vec<u8>, Extras), String> {
    let s = settings_or_default(settings_rec);
    if let Some(field) = id.strip_prefix("reply.") {
        return set_reply(&s, rec, ex, field, value.trim()); // APRS-57
    }
    let p = parse_path(id).filter(|p| p[0] == 5).ok_or_else(|| format!("{id}: not an APRS setting"))?;
    let name = path_name(&p).ok_or_else(|| format!("{id}: not a setting"))?;
    let value = value.trim();
    let term = term_items();
    scratch(|sc| {
        let in_rec = in_record(sc, &s).iter().any(|x| x.0 == p);
        let t = term.iter().find(|t| t.path == p);
        if !in_rec && t.is_none() {
            return Err(format!("{id} {name}: not an APRS Settings setting"));
        }
        sc.aprs = Some(rec.to_vec());
        sc.term = Some((term.clone(), ex.clone()));
        let r = (|| {
            if let Some(t) = t {
                let ex = term_set(sc, &s, t, ex, value)?;
                return Ok((sc.read_record(what::APRS)?, ex));
            }
            sc.load(&s);
            match sc.set(&p, NOT_A_VALUE) {
                // A choice: the knob turned to it on the menu row, as on the radio.
                Err(e) if e.contains(": one of ") => {
                    if sc.step_to(&with_call(s), &p, name, value).is_none() {
                        return Err(if e.contains(value) {
                            format!("{name}: the radio won't take {value} now")
                        } else {
                            e.replace("??", "\u{b0}")
                        });
                    }
                }
                // Typed: the terminal's `set`, with the radio's checks.
                _ => {
                    sc.load(&s);
                    sc.set(&p, value)?;
                }
            }
            Ok((sc.read_record(what::APRS)?, ex.clone()))
        })();
        sc.aprs = None;
        sc.term = None;
        r
    })
}

/// A setting that differs between two records.
pub type Change = settings::Change;

/// What differs, setting by setting; bytes no setting shows as one "Other" line.
pub fn diff(settings_rec: &[u8], old: &[u8], old_ex: &Extras, new: &[u8], new_ex: &Extras) -> Vec<Change> {
    let (a, b) = (view(settings_rec, old, old_ex), view(settings_rec, new, new_ex));
    let mut out: Vec<Change> = a
        .items
        .iter()
        .zip(&b.items)
        .filter(|(x, y)| x.id == y.id && x.value != y.value)
        .map(|(x, y)| Change {
            id: y.id.clone(),
            path: y.path.clone(),
            group: "APRS".into(),
            name: y.name.clone(),
            from: x.value.clone(),
            to: y.value.clone(),
        })
        .collect();
    if out.is_empty() && old != new {
        let n = old.iter().zip(new).filter(|(x, y)| x != y).count() + old.len().abs_diff(new.len());
        out.push(Change {
            id: "other".into(),
            path: String::new(),
            group: String::new(),
            name: "Other".into(),
            from: String::new(),
            to: format!("{n} bytes no menu item shows"),
        });
    }
    out
}

/// An APRS write: the diff, `BEGIN`'s payload, the one write, the terminal's `set` lines (sent after it), and what
/// ferrite's own link session would refuse or keep otherwise (a write with problems must not be sent).
pub type Plan = settings::Plan;

/// MENU 0 5's terminal-backed values only.
fn own(ex: &Extras) -> Extras {
    ex.iter().filter(|(k, _)| k.starts_with("0 5 ")).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// The write from `base` (the radio's record and values, read just now) to `want`, run first through ferrite's link
/// session.
pub fn plan(settings_rec: &[u8], base: &[u8], base_ex: &Extras, want: &[u8], want_ex: &Extras) -> Plan {
    let changes = diff(settings_rec, base, base_ex, want, want_ex);
    let mut problems = Vec::new();
    let mut ops = Vec::new();
    let mut cmds = Vec::new();
    let problem = |e: String| Problem { what: "aprs".into(), number: 0, error: e };
    if base.len() != RECORD_LEN || want.len() != RECORD_LEN {
        problems.push(problem(format!("the APRS record is {} bytes here, {RECORD_LEN} in this Console", want.len())));
    } else if !changes.is_empty() {
        if base != want {
            ops.push(Op {
                kind: "write",
                what: "aprs",
                number: 0,
                msg: msg::WRITE,
                payloads: write_payloads(what::APRS, 0, want),
            });
        }
        cmds = term_cmds(&own(base_ex), &own(want_ex));
        let s = settings_or_default(settings_rec);
        let term = term_items();
        let r = scratch(|sc| {
            sc.aprs = Some(base.to_vec());
            sc.term = Some((term, base_ex.clone()));
            sc.load(&s);
            sc.aprs = None;
            sc.term = None;
            let r = (|| {
                if !ops.is_empty() {
                    sc.write_record(what::APRS, want)?;
                }
                for c in &cmds {
                    sc.link_cmd(c).map_err(|e| format!("{c}: {e}"))?;
                }
                Ok::<_, String>((sc.read_record(what::APRS)?, sc.dump_values()))
            })();
            r
        });
        match r {
            Err(e) => problems.push(problem(e)),
            Ok((back, now)) => {
                let back_ex: Extras =
                    want_ex.keys().filter_map(|k| now.get(k).map(|v| (k.clone(), v.clone()))).collect();
                for c in diff(settings_rec, want, want_ex, &back, &back_ex) {
                    problems.push(problem(format!("{} {}: the radio would keep {} ({RADIO_ONLY})", c.path, c.name, c.to)));
                }
            }
        }
    }
    Plan { changes, begin: begin_payload(ops.len() as u16), ops, cmds, problems }
}

/// The backup file: the record (hex), the terminal-backed values, with the settings as the menu shows them beside
/// them for reading.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub saved: String,
    #[serde(default)]
    pub radio: BTreeMap<String, String>,
    pub record: String,
    /// MENU 0 5's settings no record carries, as the terminal's `dump` writes them (absent in a file before them).
    #[serde(default)]
    pub extras: Extras,
    #[serde(default)]
    pub settings: BTreeMap<String, String>,
}

pub fn backup(settings_rec: &[u8], rec: &[u8], ex: &Extras, saved: &str, radio: BTreeMap<String, String>) -> String {
    let settings = view(settings_rec, rec, ex)
        .items
        .iter()
        .map(|i| (format!("{} {}", i.path, i.name), i.value.clone()))
        .collect();
    let b = Backup {
        format: BACKUP_FORMAT.into(),
        version: 1,
        saved: saved.into(),
        radio,
        record: hex(rec),
        extras: own(ex),
        settings,
    };
    serde_json::to_string_pretty(&b).unwrap_or_default()
}

pub fn restore(text: &str) -> Result<(Vec<u8>, Backup), String> {
    let mut b: Backup = serde_json::from_str(text).map_err(|e| format!("not a Ferrite Console APRS backup: {e}"))?;
    if b.format != BACKUP_FORMAT {
        return Err(format!("not an APRS backup (format {:?})", b.format));
    }
    if b.version != 1 {
        return Err(format!("backup version {} is newer than this Console reads", b.version));
    }
    b.extras = own(&b.extras);
    let mut rec = unhex(&b.record).ok_or("its record isn't hex")?;
    // A backup from before auto reply (Console 0.8.1, the record ending at it): auto reply's defaults, off, everyone
    // and no message (APRS-57), so it restores whole.
    if rec.len() == ferrite_app::link::APRS_REPLY_AT {
        rec.push(0);
        rec.extend_from_slice(&ferrite_app::aprs::REPLY_TO_DEFAULT);
        rec.extend_from_slice(&[0; ferrite_app::aprs::REPLY_TEXT_LEN]);
    }
    // A backup from before the text rate (0.8.4 and older, the record ending at it): every beacon's text, the
    // default (APRS-50.1).
    if rec.len() == ferrite_app::link::APRS_TEXT_AT {
        rec.push(0);
    }
    Ok((rec, b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radioside::RadioSide;
    use crate::records::Reader;
    use crate::settings::{read_extras, record_of};

    fn ex0() -> Extras {
        read_extras(&mut RadioSide::new())
    }

    // The record-only forms the tests below were written for: the terminal-backed values a default radio's.
    fn view(srec: &[u8], rec: &[u8]) -> View {
        super::view(srec, rec, &ex0())
    }
    fn set(srec: &[u8], rec: &[u8], id: &str, value: &str) -> Result<Vec<u8>, String> {
        super::set(srec, rec, &ex0(), id, value).map(|r| r.0)
    }
    fn plan(srec: &[u8], base: &[u8], want: &[u8]) -> Plan {
        super::plan(srec, base, &ex0(), want, &ex0())
    }
    fn backup(srec: &[u8], rec: &[u8], saved: &str, radio: BTreeMap<String, String>) -> String {
        super::backup(srec, rec, &ex0(), saved, radio)
    }

    fn ask_read(rs: &mut RadioSide) -> Vec<u8> {
        let mut r = Reader::new(what::APRS, 0);
        while !r.done() {
            let (s, rest) = rs.ask(msg::READ, &r.next_payload());
            assert_eq!(s, 0);
            assert!(r.take(&rest));
        }
        r.record
    }

    fn default_record() -> Vec<u8> {
        ask_read(&mut RadioSide::new())
    }

    fn item<'a>(v: &'a View, id: &str) -> &'a Item {
        v.items
            .iter()
            .find(|i| i.id == id)
            .unwrap_or_else(|| panic!("{id} in {:?}", v.items.iter().map(|i| &i.id).collect::<Vec<_>>()))
    }

    /// LINK-43: the record's settings are MENU 0 5's own, named and valued as the menu shows them.
    #[test]
    fn view_is_the_menus() {
        let rec = default_record();
        assert_eq!(rec.len(), RECORD_LEN);
        let v = view(&record_of(&Settings::DEFAULT), &rec);
        assert!(v.notes.is_empty(), "{:?}", v.notes);
        let ids: Vec<&str> = v.items.iter().map(|i| i.id.as_str()).collect();
        for id in [
            "0 5 5 1", "0 5 6 1", "0 5 6 2", "0 5 6 3", "0 5 9 1", "0 5 9 2", "0 5 4", "0 5 7 1", "0 5 7 2",
            "0 5 7 3",
        ] {
            assert!(ids.contains(&id), "{id} in {ids:?}");
        }
        assert!(!ids.contains(&"0 5 3"), "APRS mode is the settings record's");
        assert_eq!(item(&v, "0 5 6 3").kind, Kind::Pick);
        assert!(item(&v, "0 5 5 1").choices[0].starts_with("0 "), "SSIDs from 0: {:?}", item(&v, "0 5 5 1").choices);
        assert!(item(&v, "0 5 6 3").choices.contains(&"High".to_string()));
        assert_eq!(item(&v, "0 5 4").kind, Kind::Text);
        assert_eq!(item(&v, "0 5 9 2").kind, Kind::Text);
    }

    /// APRS-57, LINK-43: auto reply on this page: its on/off row (MENU 0 5 9 9, from the record) and its page's
    /// three values; each changes through ferrite's own checks, a bad one refused with the radio's reason.
    #[test]
    fn auto_reply() {
        let srec = record_of(&Settings::DEFAULT);
        let rec = default_record();
        let v = view(&srec, &rec);
        assert_eq!(item(&v, "0 5 9 9").value, "Off");
        assert_eq!((item(&v, "reply.to").value.as_str(), item(&v, "reply.delay").value.as_str(), item(&v, "reply.text").value.as_str()), ("*", "10 s", ""));
        assert_eq!(item(&v, "reply.delay").choices, ["10 s", "30 s", "1 min", "2 min"]);
        let r = set(&srec, &rec, "0 5 9 9", "On").unwrap();
        let r = set(&srec, &r, "reply.to", "ve7*").unwrap();
        let r = set(&srec, &r, "reply.delay", "1 min").unwrap();
        let r = set(&srec, &r, "reply.text", "Away, back at 5").unwrap();
        let v = view(&srec, &r);
        assert_eq!(item(&v, "0 5 9 9").value, "On");
        assert_eq!((item(&v, "reply.to").value.as_str(), item(&v, "reply.delay").value.as_str(), item(&v, "reply.text").value.as_str()), ("VE7*", "1 min", "Away, back at 5"));
        assert!(item(&v, "reply.to").changed && item(&v, "reply.text").changed);
        assert!(set(&srec, &r, "reply.to", "VE7/ABC").unwrap_err().contains("auto reply"), "the radio's reason");
        assert!(set(&srec, &r, "reply.to", "VE7ABCDEFG").is_err(), "10 characters");
        assert!(set(&srec, &r, "reply.text", &"x".repeat(46)).is_err());
        assert!(set(&srec, &r, "reply.delay", "5 min").is_err());
        let r2 = set(&srec, &r, "reply.to", "").unwrap();
        assert_eq!(item(&view(&srec, &r2), "reply.to").value, "*", "empty is everyone");
        let d = diff(&srec, &rec, &Extras::default(), &r, &Extras::default());
        assert!(d.iter().any(|c| c.name == "Message" && c.to == "Away, back at 5"), "{d:?}");
        assert!(set(&srec, &rec[..rec.len() - 55], "reply.text", "x").is_err(), "a 0.8.1 radio's record");
        // a backup from before auto reply restores whole, auto reply at its defaults
        let old = backup(&srec, &rec[..ferrite_app::link::APRS_REPLY_AT], "2026-11-09T22:00:00.000Z", BTreeMap::new());
        let (back, _) = restore(&old).unwrap();
        assert_eq!(back, rec, "the defaults after it");
    }

    /// LINK-43: a change is the menu's; a refusal is the radio's; the plan writes through ferrite's link session and
    /// the radio's record afterwards is the one asked for.
    #[test]
    fn set_plan_and_write() {
        let srec = record_of(&Settings::DEFAULT);
        let rec = default_record();
        let r2 = set(&srec, &rec, "0 5 6 3", "High").unwrap();
        assert_ne!(r2, rec);
        assert_eq!(item(&view(&srec, &r2), "0 5 6 3").value, "High");
        let r3 = set(&srec, &r2, "0 5 5 1", "9 Mobile").or_else(|_| {
            let v = view(&srec, &r2);
            let c = item(&v, "0 5 5 1").choices.iter().find(|c| c.starts_with("9")).cloned().unwrap();
            set(&srec, &r2, "0 5 5 1", &c)
        });
        let r3 = r3.unwrap();
        assert!(item(&view(&srec, &r3), "0 5 5 1").value.starts_with('9'));
        assert!(set(&srec, &r3, "0 5 4", "500").is_err(), "outside 64-300 MHz");
        let r4 = set(&srec, &r3, "0 5 9 2", "WIDE2-2").unwrap();
        assert!(set(&srec, &r4, "0 5 9 2", "not a path at all").is_err());
        let p = plan(&srec, &rec, &r4);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert!(p.changes.len() >= 3, "{:?}", p.changes);
        // the plan's write, sent to a radio
        let mut rs = RadioSide::new();
        assert_eq!(rs.ask(msg::BEGIN, &p.begin).0, 0);
        for op in &p.ops {
            for pl in &op.payloads {
                assert_eq!(rs.ask(op.msg, pl).0, 0);
            }
        }
        rs.ask(msg::END, &[]);
        assert_eq!(ask_read(&mut rs), r4);
        // a refused record is a problem, not a write
        let mut bad = r4.clone();
        bad[7] = 40; // SSID 40
        assert!(!plan(&srec, &rec, &bad).problems.is_empty());
    }

    #[test]
    fn backup_round_trip() {
        let rec = default_record();
        let t = backup(&[], &rec, "2026-10-20T12:00:00Z", BTreeMap::new());
        let (back, b) = restore(&t).unwrap();
        assert_eq!(back, rec);
        assert!(b.settings.keys().any(|k| k.starts_with("0 5 6 3")));
        assert!(restore("{}").is_err());
    }

    /// MENU 0 5's settings the record carries since decision 347 (telemetry, the comment, Mic-E, ...): on this page in
    /// menu order, changed on the scratch radio, written with the record alone (no `set` lines), read back with the
    /// dump; kept in the backup file.
    #[test]
    fn term_settings_write_and_read_back() {
        let srec = record_of(&Settings::DEFAULT);
        let mut rs = RadioSide::new();
        let rec = ask_read(&mut rs);
        let ex = read_extras(&mut rs);
        let v = super::view(&srec, &rec, &ex);
        let ids: Vec<&str> = v.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "0 5 4", "0 5 5 1", "0 5 5 2", "0 5 5 3", "0 5 5 6", "0 5 5 7", "0 5 6 1", "0 5 6 2", "0 5 6 3",
                "0 5 6 4", "0 5 6 5", "0 5 7 1", "0 5 7 2", "0 5 7 3", "0 5 9 1", "0 5 9 2", "0 5 9 3", "0 5 9 4", "0 5 9 5", "0 5 9 9", "reply.to", "reply.delay", "reply.text"
            ]
        );
        assert_eq!(v.elsewhere.iter().filter(|e| e.starts_with("0 5 9 7")).count(), 1, "{:?}", v.elsewhere);
        let tel = item(&v, "0 5 6 4");
        assert_eq!((tel.kind, tel.value.as_str(), tel.choices.clone()), (Kind::Pick, "Off", vec!["Off".to_string(), "On".into()]));
        assert_eq!(item(&v, "0 5 5 3").kind, Kind::Text);
        // Changes: telemetry, a comment, Mic-E and power, all the record's since decision 347: no `set` lines.
        let (r, x) = super::set(&srec, &rec, &ex, "0 5 6 4", "On").unwrap();
        let (r, x) = super::set(&srec, &r, &x, "0 5 5 3", "Ferrite test, 73").unwrap();
        let (r, x) = super::set(&srec, &r, &x, "0 5 5 7", "En route").unwrap();
        let (r, x) = super::set(&srec, &r, &x, "0 5 6 3", "High").unwrap();
        assert!(super::set(&srec, &r, &x, "0 5 5 3", &"x".repeat(41)).is_err());
        // A '#' is fine in the record (only a dump line's note forbade it).
        assert!(super::set(&srec, &r, &x, "0 5 5 3", "a # here").is_ok());
        let v2 = super::view(&srec, &r, &x);
        assert_eq!(item(&v2, "0 5 5 3").value, "Ferrite test, 73", "the whole comment, not the row's start");
        let p = super::plan(&srec, &rec, &ex, &r, &x);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.changes.len(), 4, "{:?}", p.changes);
        assert_eq!(p.ops.len(), 1);
        assert!(p.cmds.is_empty(), "{:?}", p.cmds);
        // Sent as Console sends it: the record's write.
        assert_eq!(rs.ask(msg::BEGIN, &p.begin).0, 0);
        for op in &p.ops {
            for pl in &op.payloads {
                assert_eq!(rs.ask(op.msg, pl).0, 0);
            }
        }
        rs.ask(msg::END, &[]);
        assert_eq!(ask_read(&mut rs), r);
        let c = rs.app.aprs_cfg();
        assert!(c.telemetry && c.mic_e == 2 && &c.comment[..16] == b"Ferrite test, 73", "{c:?}");
        // The backup keeps them, in its record.
        let t = super::backup(&srec, &r, &x, "2026-10-27T12:00:00Z", BTreeMap::new());
        let (back, _) = restore(&t).unwrap();
        assert_eq!(back, r);
        // Back: the plan from what the radio holds now to the first read, the record alone.
        let p = super::plan(&srec, &r, &x, &rec, &ex);
        assert!(p.problems.is_empty() && p.cmds.is_empty(), "{:?} {:?}", p.problems, p.cmds);
    }
}
