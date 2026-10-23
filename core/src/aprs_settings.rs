//! APRS settings (LINK-43): the APRS record (`what` 5, 25 bytes: MENU 0 5's frequency, beacon mode, power, path,
//! digipeater, beacon after voice, SSID, custom path and FX.25), shown, changed and checked as Radio Settings does the
//! settings record: by ferrite's own App and link session, never a copy of the menu.
//!
//! The scratch radio holds the radio's settings record (its region decides "the region's" frequency) and the APRS
//! record, written through ferrite's link session (`aprs_apply`'s checks). A MENU 0 5 setting is in the APRS record
//! when what the menu shows follows that record; it is changed with the menu's knob or the terminal's `set`, as
//! Radio Settings changes a setting, and the record is then read back through the link.

use crate::plan::{hex, unhex, Op, Problem};
use crate::records::{begin_payload, write_payloads};
use crate::settings::{
    self, classify, leaves, parse_path, path_name, path_text, settings_of, with_call, Item, Kind, Scratch, NOT_A_VALUE,
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
}

fn scratch<R>(f: impl FnOnce(&mut Scratch) -> R) -> R {
    SCRATCH.with(|c| f(c.borrow_mut().get_or_insert_with(Scratch::new)))
}

/// Two records differing in every field (both valid): a setting whose value differs between them follows the record.
fn probes() -> [Vec<u8>; 2] {
    let a = vec![0u8; RECORD_LEN];
    let mut b = vec![0u8; RECORD_LEN];
    b[..2].copy_from_slice(&28_960u16.to_le_bytes()); // 144.800 MHz
    b[2..8].copy_from_slice(&[4, 2, 3, 0x33, 1, 9]); // every 5 min, high, custom path, digi on + my call + 3 s, after voice, SSID 9
    b[8..15].copy_from_slice(b"WIDE2-2");
    b[24] = 32; // FX.25 on TX, 32 check bytes (APRS-45)
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
    IN_RECORD.with(|c| *c.borrow_mut() = Some(out.clone()));
    out
}

/// The record's settings as MENU 0 5 shows them (in menu order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct View {
    pub items: Vec<Item>,
    /// Notes on the record as a whole (refused by this Console's ferrite, a length it doesn't know).
    pub notes: Vec<String>,
}

/// The settings record to use: the radio's, or the defaults when it wasn't read (the region then is the default's).
fn settings_or_default(settings_rec: &[u8]) -> Settings {
    if settings_rec.is_empty() {
        Settings::DEFAULT
    } else {
        settings_of(settings_rec)
    }
}

/// The APRS record as MENU 0 5 shows it, the radio's settings record (`settings_rec`, may be empty) beside it.
pub fn view(settings_rec: &[u8], rec: &[u8]) -> View {
    let s = settings_or_default(settings_rec);
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
        let mut items = Vec::new();
        for (p, name, help, sub) in leaves() {
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
                help: help.into(),
                value: got.value,
                changed: got.changed,
                kind,
                choices: if kind == Kind::Readonly { Vec::new() } else { choices },
                hint,
                note,
            });
        }
        sc.aprs = None;
        View { items, notes }
    })
}

/// One setting changed (`id` its menu number) to a value as the menu shows it: the new record, or the radio's reason.
pub fn set(settings_rec: &[u8], rec: &[u8], id: &str, value: &str) -> Result<Vec<u8>, String> {
    let s = settings_or_default(settings_rec);
    let p = parse_path(id).filter(|p| p[0] == 5).ok_or_else(|| format!("{id}: not an APRS setting"))?;
    let name = path_name(&p).ok_or_else(|| format!("{id}: not a setting"))?;
    let value = value.trim();
    scratch(|sc| {
        if !in_record(sc, &s).iter().any(|x| x.0 == p) {
            return Err(format!("{id} {name}: not in the APRS record"));
        }
        sc.aprs = Some(rec.to_vec());
        let r = (|| {
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
            sc.read_record(what::APRS)
        })();
        sc.aprs = None;
        r
    })
}

/// A setting that differs between two records.
pub type Change = settings::Change;

/// What differs, setting by setting; bytes no setting shows as one "Other" line.
pub fn diff(settings_rec: &[u8], old: &[u8], new: &[u8]) -> Vec<Change> {
    let (a, b) = (view(settings_rec, old), view(settings_rec, new));
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

/// An APRS write: the diff, `BEGIN`'s payload, the one write, and what ferrite's own link session would refuse or
/// keep otherwise (a write with problems must not be sent).
#[derive(Clone, Debug, Serialize)]
pub struct Plan {
    pub changes: Vec<Change>,
    pub begin: Vec<u8>,
    pub ops: Vec<Op>,
    pub problems: Vec<Problem>,
}

/// The write from `base` (the radio's record, read just now) to `want`, run first through ferrite's link session.
pub fn plan(settings_rec: &[u8], base: &[u8], want: &[u8]) -> Plan {
    let changes = diff(settings_rec, base, want);
    let mut problems = Vec::new();
    let mut ops = Vec::new();
    let problem = |e: String| Problem { what: "aprs".into(), number: 0, error: e };
    if base.len() != RECORD_LEN || want.len() != RECORD_LEN {
        problems.push(problem(format!("the APRS record is {} bytes here, {RECORD_LEN} in this Console", want.len())));
    } else if !changes.is_empty() {
        ops.push(Op {
            kind: "write",
            what: "aprs",
            number: 0,
            msg: msg::WRITE,
            payloads: write_payloads(what::APRS, 0, want),
        });
        let s = settings_or_default(settings_rec);
        let r = scratch(|sc| {
            sc.aprs = Some(base.to_vec());
            sc.load(&s);
            sc.aprs = None;
            sc.write_record(what::APRS, want).and_then(|_| sc.read_record(what::APRS))
        });
        match r {
            Err(e) => problems.push(problem(e)),
            Ok(back) if back != want => {
                for c in diff(settings_rec, want, &back) {
                    problems.push(problem(format!("{} {}: the radio would keep {}", c.path, c.name, c.to)));
                }
            }
            Ok(_) => {}
        }
    }
    Plan { changes, begin: begin_payload(ops.len() as u16), ops, problems }
}

/// The backup file: the record (hex), with the settings as the menu shows them beside it for reading.
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

pub fn backup(settings_rec: &[u8], rec: &[u8], saved: &str, radio: BTreeMap<String, String>) -> String {
    let settings =
        view(settings_rec, rec).items.iter().map(|i| (format!("{} {}", i.path, i.name), i.value.clone())).collect();
    let b = Backup { format: BACKUP_FORMAT.into(), version: 1, saved: saved.into(), radio, record: hex(rec), settings };
    serde_json::to_string_pretty(&b).unwrap_or_default()
}

pub fn restore(text: &str) -> Result<(Vec<u8>, Backup), String> {
    let b: Backup = serde_json::from_str(text).map_err(|e| format!("not a Ferrite Console APRS backup: {e}"))?;
    if b.format != BACKUP_FORMAT {
        return Err(format!("not an APRS backup (format {:?})", b.format));
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
    use crate::radioside::RadioSide;
    use crate::records::Reader;
    use crate::settings::record_of;

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
}
