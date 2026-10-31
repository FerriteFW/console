//! The crossband repeater's settings (manual chapter 19: sides, power, timeout, hang time, tone gate, ID, speaker):
//! `Settings::xb` in the settings record, set on the repeater's start page (MENU 0 3 5), not in the menu tree, so
//! Radio Settings shows them as a group of their own.
//!
//! Nothing about the rules is copied: each setting's choices are found by turning the knob on its start-page cell of
//! a scratch radio (ferrite's own `Crossband` screen: a side never on the other side's slot, power never above Mid
//! (XB-3), the timeout and hang time lists), and a change is the knob walked to the value there.

use crate::radioside::RadioSide;
use crate::settings::{GroupView, Item, Kind};
use ferrite_app::screens::xb::Crossband;
use ferrite_app::screens::View;
use ferrite_app::settings::Settings;
use ferrite_core::msg::XbCfg;
use std::cell::RefCell;

/// The rows: id, name, help, the start page's cell (0 side 1, 1 side 2, then the grid).
const ROWS: [(&str, &str, &str, u8); 8] = [
    ("xb.side1", "Side 1", "One side's slot: one VHF, one UHF, on different chips", 0),
    ("xb.side2", "Side 2", "The other side's slot", 1),
    ("xb.power", "Power", "Low or Mid, never High: unattended transmitting heats the PA (XB-3)", 2),
    ("xb.timeout", "Timeout", "Each pass's limit; after it, that side waits for its signal to drop (XB-9)", 3),
    ("xb.hang", "Hang time", "How long a pass stays keyed after the signal drops (XB-7)", 4),
    ("xb.tone", "Tone gate", "On: a pass needs the receiving side's tone; off: any carrier (XB-4)", 5),
    ("xb.id", "ID", "The repeater's own CW ID every 10 min; 0 8 6 2 doesn't apply (XB-12)", 6),
    ("xb.speaker", "Speaker", "Hear the passes on the radio's speaker (XB-15)", 7),
];

/// A cell's value as the start page words it (the manual's table).
fn word(c: &XbCfg, cell: u8) -> String {
    let slot = |s: u8| ["A", "B", "C"].get(s as usize).map_or_else(|| format!("{s}"), |x| x.to_string());
    let on = |bit: u8, yes: &str, no: &str| if c.flags & bit != 0 { yes.to_string() } else { no.to_string() };
    match cell {
        0 => slot(c.side1),
        1 => slot(c.side2),
        2 => if c.power == 0 { "Low" } else { "Mid" }.into(),
        3 => {
            let s = c.timeout_10s as u32 * 10;
            if s < 60 {
                format!("{s} s")
            } else if s.is_multiple_of(60) {
                format!("{} min", s / 60)
            } else {
                format!("{} min {} s", s / 60, s % 60)
            }
        }
        4 => format!("{}.{} s", c.hang_ds / 10, c.hang_ds % 10),
        5 => on(XbCfg::TONE_GATE, "On", "Off (carrier)"),
        6 => on(XbCfg::ID, "CW every 10 min", "Off"),
        _ => on(XbCfg::SPEAKER, "On", "Off"),
    }
}

thread_local! {
    static R: RefCell<RadioSide> = RefCell::new(RadioSide::new());
}

/// The knob turned `d` on `cell` of the start page, from `c`: what the radio makes of it.
fn turn(r: &mut RadioSide, c: XbCfg, cell: u8, d: i32) -> XbCfg {
    r.app.settings_mut().xb = c;
    Crossband { cell }.knob(&mut r.app, d, &r.store);
    r.app.settings_mut().xb
}

/// Every value the knob reaches on `cell` from `c` (in the radio's order, from the low end), as configs.
fn reach(c: XbCfg, cell: u8) -> Vec<XbCfg> {
    R.with_borrow_mut(|r| {
        let mut x = c;
        for _ in 0..12 {
            let n = turn(r, x, cell, -1);
            if word(&n, cell) == word(&x, cell) {
                break; // the low end
            }
            x = n;
        }
        let mut out = vec![x];
        for _ in 0..12 {
            let n = turn(r, *out.last().unwrap(), cell, 1);
            if out.iter().any(|o| word(o, cell) == word(&n, cell)) {
                break; // the high end, or round again
            }
            out.push(n);
        }
        if cell < 2 {
            out.sort_by_key(|o| if cell == 0 { o.side1 } else { o.side2 }); // the slots in order, A first
        }
        out
    })
}

/// The group as Radio Settings shows it.
pub fn group(s: &Settings) -> GroupView {
    let c = s.xb;
    let items = ROWS
        .iter()
        .map(|&(id, name, help, cell)| Item {
            id: id.into(),
            path: String::new(),
            name: name.into(),
            sub: String::new(),
            help: help.into(),
            value: word(&c, cell),
            changed: word(&c, cell) != word(&XbCfg::DEFAULT, cell),
            kind: Kind::Pick,
            choices: reach(c, cell).iter().map(|o| word(o, cell)).collect(),
            hint: String::new(),
            note: String::new(),
        })
        .collect();
    GroupView {
        path: "xb".into(),
        name: "Crossband repeater".into(),
        items,
        note: "Set here or on its start page (MENU 0 3 5); the repeater itself starts on the radio, or with xb start on the Terminal page.".into(),
    }
}

/// One crossband setting changed as the start page's knob would: the new settings, None when `id` isn't one of
/// them, or why the radio won't take `value`.
pub fn set(s: &Settings, id: &str, value: &str) -> Option<Result<Settings, String>> {
    let &(_, name, _, cell) = ROWS.iter().find(|r| r.0 == id)?;
    let want = value.trim();
    let found = reach(s.xb, cell).into_iter().find(|o| word(o, cell).eq_ignore_ascii_case(want));
    Some(match found {
        Some(xb) => Ok(Settings { xb, ..*s }),
        None if cell < 2 && ["A", "B", "C"].iter().any(|x| x.eq_ignore_ascii_case(want)) => {
            Err(format!("{name}: the other side is on slot {}", want.to_ascii_uppercase()))
        }
        None => {
            let all: Vec<String> = reach(s.xb, cell).iter().map(|o| word(o, cell)).collect();
            Err(format!("{name}: one of {}", all.join(", ")))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item<'a>(g: &'a GroupView, id: &str) -> &'a Item {
        g.items.iter().find(|i| i.id == id).unwrap()
    }

    /// The choices are the start page's own: power never above Mid, the timeout and hang lists, a side never on
    /// the other's slot; defaults as the manual's table.
    #[test]
    fn choices_from_the_start_page() {
        let g = group(&Settings::DEFAULT);
        assert_eq!(g.items.len(), 8);
        assert_eq!(item(&g, "xb.power").choices, ["Low", "Mid"]);
        assert_eq!(item(&g, "xb.timeout").choices, ["30 s", "1 min", "2 min", "3 min", "5 min", "10 min"]);
        assert_eq!(item(&g, "xb.hang").choices, ["0.0 s", "0.5 s", "1.0 s", "1.5 s", "2.0 s", "2.5 s", "3.0 s"]);
        assert_eq!(item(&g, "xb.side1").choices, ["A", "C"], "never B: side 2 is on it");
        assert_eq!(item(&g, "xb.tone").choices, ["On", "Off (carrier)"]);
        let vals: Vec<&str> = g.items.iter().map(|i| i.value.as_str()).collect();
        assert_eq!(vals, ["A", "B", "Low", "3 min", "1.0 s", "On", "Off", "Off"]);
        assert!(g.items.iter().all(|i| !i.changed));
    }

    #[test]
    fn set_walks_the_knob() {
        let s = set(&Settings::DEFAULT, "xb.timeout", "10 min").unwrap().unwrap();
        assert_eq!(s.xb.timeout_10s, 60);
        let s = set(&s, "xb.side1", "c").unwrap().unwrap();
        assert_eq!((s.xb.side1, s.xb.side2), (2, 1));
        assert_eq!(set(&s, "xb.side2", "C").unwrap().unwrap_err(), "Side 2: the other side is on slot C");
        assert!(set(&s, "xb.power", "High").unwrap().unwrap_err().starts_with("Power: one of Low, Mid"));
        let s = set(&s, "xb.id", "CW every 10 min").unwrap().unwrap();
        assert_ne!(s.xb.flags & XbCfg::ID, 0);
        assert!(set(&s, "0 7 1", "x").is_none());
    }

    /// Through the settings record: Radio Settings' own set, diff and write plan (ferrite's link session keeps it).
    #[test]
    fn written_through_the_record() {
        use crate::settings::{self, record_of};
        let ex = crate::settings::read_extras(&mut RadioSide::new());
        let base = record_of(&Settings::DEFAULT);
        let (want, _) = settings::set(&base, &ex, "xb.hang", "2.5 s").unwrap();
        let p = settings::plan(&base, &ex, &want, &ex);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.changes.len(), 1);
        assert_eq!(
            (p.changes[0].group.as_str(), p.changes[0].name.as_str(), p.changes[0].to.as_str()),
            ("Crossband repeater", "Hang time", "2.5 s")
        );
        assert!(settings::set(&base, &ex, "xb.power", "High").is_err());
    }
}
