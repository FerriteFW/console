//! Remote keys (LINK-19): key names to stock key codes through ferrite's own key map
//! ([`ferrite_core::keys::MAP`]), and `KEY` payloads. Never a PTT: remote keys never transmit, and no name here
//! reaches a PTT code (24-26), nor remote PTT (0x80, LINK-20).

use ferrite_core::keys::{Key, MAP};
use ferrite_core::link::key;

/// What a key press does, `KEY`'s action byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Up = key::UP as isize,
    Down = key::DOWN as isize,
    Short = key::SHORT as isize,
    Long = key::LONG as isize,
}

impl Action {
    /// "short", "long", "down", "up" (as `ferrite_link.py`'s NAME:how).
    pub fn named(s: &str) -> Option<Action> {
        Some(match s.to_ascii_lowercase().as_str() {
            "short" => Action::Short,
            "long" => Action::Long,
            "down" => Action::Down,
            "up" => Action::Up,
            _ => return None,
        })
    }
}

/// A key name as `ferrite_link.py` takes it (case ignored): MENU/OK, BACK/EXIT, UP, DOWN, LEFT, RIGHT, SLOT/ABC,
/// VM/V/M, 0-9, STAR/*, HASH/#, SIDE1/PF1, SIDE2/PF2.
pub fn named(name: &str) -> Option<Key> {
    let n = name.to_ascii_uppercase();
    Some(match n.as_str() {
        "MENU" | "OK" => Key::Menu,
        "BACK" | "EXIT" => Key::Exit,
        "UP" => Key::Up,
        "DOWN" => Key::Down,
        "LEFT" => Key::Left,
        "RIGHT" => Key::Right,
        "SLOT" | "ABC" => Key::Slot,
        "VM" | "V/M" => Key::VfoMem,
        "STAR" | "*" => Key::Star,
        "HASH" | "#" => Key::Hash,
        "SIDE1" | "PF1" => Key::Side(1),
        "SIDE2" | "PF2" => Key::Side(2),
        d if d.len() == 1 && d.as_bytes()[0].is_ascii_digit() => Key::Digit(d.as_bytes()[0] - b'0'),
        _ => return None,
    })
}

/// A key's stock code, from ferrite's map: None for a PTT, or a key with no code.
pub fn code_of(k: Key) -> Option<u8> {
    if matches!(k, Key::Ptt(_)) {
        return None;
    }
    let c = MAP.iter().position(|m| *m == Some(k))? as u8;
    (c <= key::LAST_CODE).then_some(c)
}

/// A name's stock code.
pub fn code(name: &str) -> Option<u8> {
    code_of(named(name)?)
}

/// `KEY`'s payload for a named key and an action; None for an unknown name.
pub fn payload(name: &str, action: Action) -> Option<[u8; 2]> {
    Some([code(name)?, action as u8])
}

/// `KEY` payloads for knob steps (+ clockwise), at most [`key::KNOB_MAX`] each way per request.
pub fn knob_payloads(mut steps: i32) -> Vec<[u8; 2]> {
    let max = key::KNOB_MAX as i32;
    let mut out = Vec::new();
    while steps != 0 {
        let n = steps.clamp(-max, max);
        out.push([key::KNOB, n as i8 as u8]);
        steps -= n;
    }
    out
}

/// The keypad's keys, the names the UI sends (each with its stock code); the drawn keypad uses these.
pub const NAMES: [&str; 22] = [
    "MENU", "BACK", "UP", "DOWN", "LEFT", "RIGHT", "SLOT", "VM", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "STAR", "HASH", "SIDE1", "SIDE2",
];

#[cfg(test)]
mod tests {
    use super::*;

    /// LINK-19: the codes ferrite_link.py's KEY_CODES table gives, every name and alias.
    #[test]
    fn codes_match_ferrite_link_py() {
        let table: [(&str, u8); 31] = [
            ("MENU", 6),
            ("OK", 6),
            ("BACK", 9),
            ("EXIT", 9),
            ("UP", 7),
            ("DOWN", 8),
            ("LEFT", 4),
            ("RIGHT", 5),
            ("SLOT", 3),
            ("ABC", 3),
            ("VM", 2),
            ("V/M", 2),
            ("0", 17),
            ("1", 10),
            ("2", 11),
            ("3", 12),
            ("4", 14),
            ("5", 15),
            ("6", 16),
            ("7", 18),
            ("8", 19),
            ("9", 20),
            ("STAR", 13),
            ("*", 13),
            ("HASH", 21),
            ("#", 21),
            ("SIDE1", 0),
            ("PF1", 0),
            ("SIDE2", 1),
            ("PF2", 1),
            ("menu", 6),
        ];
        for (n, c) in table {
            assert_eq!(code(n), Some(c), "{n}");
        }
        for n in NAMES {
            assert!(code(n).is_some(), "{n}");
        }
        let mut codes: Vec<u8> = NAMES.iter().map(|n| code(n).unwrap()).collect();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), 22, "every keypad code once");
    }

    /// Never a PTT: no name reaches codes 24-26 or remote PTT.
    #[test]
    fn never_ptt() {
        for n in ["PTT", "PTTA", "PTT A", "PTTB", "24", "x", ""] {
            assert_eq!(code(n), None, "{n}");
        }
        for k in [Key::Ptt(0), Key::Ptt(1), Key::PTT] {
            assert_eq!(code_of(k), None);
        }
        assert_eq!(payload("MENU", Action::Long), Some([6, key::LONG]));
        assert_eq!(payload("HASH", Action::Short), Some([21, key::SHORT]));
        assert_eq!(payload("PTT", Action::Short), None);
        assert_eq!(Action::named("LONG"), Some(Action::Long));
        assert_eq!(Action::named("hold"), None);
    }

    #[test]
    fn knob_splits_at_twenty() {
        assert_eq!(knob_payloads(0), Vec::<[u8; 2]>::new());
        assert_eq!(knob_payloads(3), vec![[0x81, 3]]);
        assert_eq!(knob_payloads(-1), vec![[0x81, 0xFF]]);
        assert_eq!(knob_payloads(45), vec![[0x81, 20], [0x81, 20], [0x81, 5]]);
        assert_eq!(knob_payloads(-25), vec![[0x81, (-20i8) as u8], [0x81, (-5i8) as u8]]);
    }
}
