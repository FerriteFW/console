//! The UI readback (LINK-19, decision 150; ferrite's `uistate.rs` writes it): what the screen shows as text lines,
//! parsed as `ferrite_link.py`'s `parse_ui` does, into a structure the Live View draws.
//!
//! A line is a kind word, then positional strings (bare words or double-quoted with `\"` and `\\`) and `key=value`
//! pairs (a value all digits is a number). The kinds the Live View knows get their own fields (`screen`, `state`,
//! `bar`, `card`, `row`, `toast`, `popup`, `qmenu`, `help`, `hints`, `bcast`); every other line (a screen's own:
//! `value`, `ask`, `squelch`, `setup`, ...) is kept in `other`, in order, so nothing the radio says is lost.

use serde::Serialize;
use serde_json::{Map, Number, Value};

/// One line: its kind, positional strings, and key=value pairs.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Line {
    pub kind: String,
    pub args: Vec<String>,
    pub kv: Map<String, Value>,
}

impl Line {
    pub fn str(&self, k: &str) -> Option<&str> {
        self.kv.get(k).and_then(Value::as_str)
    }

    pub fn int(&self, k: &str) -> Option<i64> {
        self.kv.get(k).and_then(Value::as_i64)
    }
}

/// A quoted string from `chars[i]` (the opening quote): its text and the index after the closing quote.
fn quoted(c: &[char], mut i: usize) -> (String, usize) {
    let mut out = String::new();
    i += 1;
    while i < c.len() && c[i] != '"' {
        if c[i] == '\\' && i + 1 < c.len() {
            i += 1;
        }
        out.push(c[i]);
        i += 1;
    }
    (out, i + 1)
}

/// A value as `parse_ui_line` reads it: an integer if it is one (an optional `-`, then digits), else a string.
fn value(v: String) -> Value {
    let digits = v.strip_prefix('-').unwrap_or(&v);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(n) = v.parse::<i64>() {
            return Value::Number(Number::from(n));
        }
    }
    Value::String(v)
}

/// One `ui` line.
pub fn parse_line(line: &str) -> Line {
    let c: Vec<char> = line.chars().collect();
    let n = c.len();
    let (mut pos, mut kv, mut i) = (Vec::new(), Map::new(), 0);
    while i < n {
        if c[i] == ' ' {
            i += 1;
        } else if c[i] == '"' {
            let (v, j) = quoted(&c, i);
            pos.push(v);
            i = j;
        } else {
            let mut j = i;
            while j < n && !matches!(c[j], ' ' | '=' | '"') {
                j += 1;
            }
            let word: String = c[i..j].iter().collect();
            if j < n && c[j] == '=' {
                let v = if j + 1 < n && c[j + 1] == '"' {
                    let (v, k) = quoted(&c, j + 1);
                    i = k;
                    v
                } else {
                    let mut k = j + 1;
                    while k < n && c[k] != ' ' {
                        k += 1;
                    }
                    let v: String = c[j + 1..k].iter().collect();
                    i = k;
                    v
                };
                kv.insert(word, value(v));
            } else {
                pos.push(word);
                i = j;
            }
        }
    }
    let mut it = pos.into_iter();
    let kind = it.next().unwrap_or_default();
    Line { kind, args: it.collect(), kv }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Screen {
    /// The stable id (`Home`, `Group`, `Edit`, ...).
    pub id: String,
    pub name: String,
    /// The status bar's title.
    pub title: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Row {
    /// The number the row shows; None for none (the radio's 0 is "none" too, but ferrite_link.py keeps it).
    pub num: Option<i64>,
    pub name: String,
    pub value: String,
    pub sel: bool,
    pub dot: bool,
    pub grey: bool,
    /// A screen's own fields (`kind=`, `chips=`).
    pub kv: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Note {
    pub head: String,
    pub body: String,
}

/// The whole readback.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Ui {
    pub lines: Vec<String>,
    pub screen: Option<Screen>,
    /// `state`'s pairs (frame, dark, locked, active, keyed, remote, mode, fm).
    pub state: Map<String, Value>,
    /// `bar`'s pairs (lock, scan, watch, inbox, alert, gps, bt_on, bt, battery, low, cutoff, dry, clock, utc, call).
    pub bar: Map<String, Value>,
    pub toast: Option<Note>,
    pub popup: Option<Note>,
    /// Quick menu rows: key, name, value.
    pub qmenu: Vec<Vec<String>>,
    /// Home's cards: `slot` (A-C) and the card's pairs.
    pub cards: Vec<Map<String, Value>>,
    /// Broadcast reports by slot.
    pub bcast: Map<String, Value>,
    pub rows: Vec<Row>,
    /// The selected row's index in `rows`.
    pub sel: Option<usize>,
    pub help: Option<Note>,
    /// The hint bar: (key, label) pairs.
    pub hints: Vec<(String, String)>,
    /// Every other line, in order.
    pub other: Vec<Line>,
    /// LINK-19.5: the screen as drawn (its `t` lines' texts and fills, in drawing order), when the session asked
    /// for them; Home sends none (its cards are structured).
    pub items: Vec<Item>,
}

/// LINK-19.5: one thing on the screen: a text (its line box, font, colours) or a coloured fill.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "k")]
pub enum Item {
    #[serde(rename = "t")]
    /// `bg`: None on the screen's own background.
    Text { x: i32, y: i32, w: i32, h: i32, font: u8, fg: u16, bg: Option<u16>, s: String },
    #[serde(rename = "r")]
    Rect { x: i32, y: i32, w: i32, h: i32, c: u16 },
    /// An icon (a dot, a symbol) in its colour: drawn as a round mark of its size.
    #[serde(rename = "o")]
    Icon { x: i32, y: i32, w: i32, h: i32, c: u16 },
}

/// A `t` line's items: `x,y,w,h,font,fg,bg,` then the quoted text (two args), or `x,y,w,h,colour` (one).
fn items(args: &[String], out: &mut Vec<Item>) {
    let num = |s: &str| s.parse::<i32>().ok();
    let hex = |s: &str| u16::from_str_radix(s, 16).ok();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let f: Vec<&str> = a.trim_end_matches(',').split(',').collect();
        if a.ends_with(',') && f.len() == 7 {
            let s = it.next().cloned().unwrap_or_default();
            if let (Some(x), Some(y), Some(w), Some(h), Some(font), Some(fg)) =
                (num(f[0]), num(f[1]), num(f[2]), num(f[3]), f[4].parse::<u8>().ok(), hex(f[5]))
            {
                out.push(Item::Text { x, y, w, h, font, fg, bg: hex(f[6]), s });
            }
        } else if f.len() == 5 || f.len() == 6 && f[5] == "o" {
            if let (Some(x), Some(y), Some(w), Some(h), Some(c)) = (num(f[0]), num(f[1]), num(f[2]), num(f[3]), hex(f[4])) {
                out.push(if f.len() == 6 { Item::Icon { x, y, w, h, c } } else { Item::Rect { x, y, w, h, c } });
            }
        }
    }
}

/// `ui`'s text (all its chunks joined).
pub fn parse(text: &str) -> Ui {
    let mut ui = Ui::default();
    for raw in text.lines() {
        if raw.is_empty() {
            continue;
        }
        ui.lines.push(raw.to_string());
        let l = parse_line(raw);
        let a = |i: usize| l.args.get(i).cloned().unwrap_or_default();
        match l.kind.as_str() {
            "screen" => ui.screen = Some(Screen { id: a(0), name: a(1), title: l.str("title").unwrap_or("").into() }),
            "state" => ui.state = l.kv,
            "bar" => ui.bar = l.kv,
            "card" => {
                let mut m = l.kv.clone();
                m.insert("slot".into(), Value::String(a(0)));
                ui.cards.push(m);
            }
            "bcast" => {
                let mut m = l.kv.clone();
                m.insert("rds".into(), Value::String(a(1)));
                ui.bcast.insert(a(0), Value::Object(m));
            }
            "row" => {
                let (num, rest) = match l.args.first() {
                    Some(n) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => (n.parse().ok(), &l.args[1..]),
                    _ => (None, &l.args[..]),
                };
                let flag = |f: &str| rest.iter().skip(2).any(|w| w == f);
                let r = Row {
                    num,
                    name: rest.first().cloned().unwrap_or_default(),
                    value: rest.get(1).cloned().unwrap_or_default(),
                    sel: flag("sel"),
                    dot: flag("dot"),
                    grey: flag("grey"),
                    kv: l.kv,
                };
                if r.sel {
                    ui.sel = Some(ui.rows.len());
                }
                ui.rows.push(r);
            }
            "toast" | "popup" | "help" => {
                let n = Some(Note { head: a(0), body: a(1) });
                match l.kind.as_str() {
                    "toast" => ui.toast = n,
                    "popup" => ui.popup = n,
                    _ => ui.help = n,
                }
            }
            "qmenu" => ui.qmenu.push(l.args),
            "hints" => ui.hints = l.args.as_chunks::<2>().0.iter().map(|[k, v]| (k.clone(), v.clone())).collect(),
            "t" => items(&l.args, &mut ui.items),
            "" => {}
            _ => ui.other.push(l),
        }
    }
    ui
}

#[cfg(test)]
mod items_tests {
    use super::*;

    /// LINK-19.5: a `t` line's texts and fills, a quoted text with a comma and a quote in it.
    #[test]
    fn t_lines_parse() {
        let ui = parse("screen Group \"Settings group\" title=\"Scan\"\nt 6,30,228,20,1e2b 14,32,40,17,0,e73c,0841,\"Band, \\\"x\\\"\" 0,0,240,1,ffff 3,4,5,6,1,ffff,-,\"A\" 7,8,6,6,fd20,o\n");
        assert_eq!(ui.items.len(), 5);
        assert_eq!(ui.items[4], Item::Icon { x: 7, y: 8, w: 6, h: 6, c: 0xfd20 });
        assert_eq!(ui.items[3], Item::Text { x: 3, y: 4, w: 5, h: 6, font: 1, fg: 0xffff, bg: None, s: "A".into() });
        assert_eq!(ui.items[0], Item::Rect { x: 6, y: 30, w: 228, h: 20, c: 0x1e2b });
        assert_eq!(ui.items[1], Item::Text { x: 14, y: 32, w: 40, h: 17, font: 0, fg: 0xe73c, bg: Some(0x0841), s: "Band, \"x\"".into() });
        assert!(ui.other.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A home readback as ferrite's uistate.rs writes it (the shapes its link tests check).
    const HOME: &str = concat!(
        "screen Home \"Home\" title=\"\"\n",
        "state frame=12 ago=40 dark=0 locked=0 active=A keyed=- remote=0 mode=off fm=0\n",
        "bar lock=0 scan=0 watch=0 inbox=2 alert=0 gps=fix bt_on=1 bt=1 battery=80 low=0 cutoff=0 dry=1 clock=14:32 utc=0 call=\"\"\n",
        "card A active=1 head=\"VFO \u{b7} VHF\" state=\"RX\" freq=146.52000 name=\"\" mode=\"FM\" tone=\"T 88.5\" shift=\"-\" power=\"High\" s=\"S9\" meter=17 rx=1 scan=0 kind=slot\n",
        "card B active=0 head=\"CH 12 \u{b7} Club\" state=\"idle\" freq=446.47500 name=\"Club \\\"rpt\\\"\" mode=\"NFM\" tone=\"\" shift=\"\" power=\"No TX\" s=\"S0\" meter=0 rx=0 scan=0 kind=slot\n",
        "card C active=0 head=\"FM\" state=\"idle\" freq=98.10000 name=\"\" s=\"S0\" meter=0 rx=0 scan=0 kind=broadcast\n",
        "bcast C \"RADIO 1\" stereo=1 dbuv=48 snr=24\n",
        "hints \"MENU\" \"Quick\" \"#\" \"Status\"\n",
    );

    #[test]
    fn home_readback() {
        let ui = parse(HOME);
        assert_eq!(ui.lines.len(), 8);
        assert_eq!(ui.screen.as_ref().unwrap().id, "Home");
        assert_eq!(ui.state.get("active"), Some(&Value::from("A")));
        assert_eq!(ui.state.get("frame"), Some(&Value::from(12)));
        assert_eq!(ui.bar.get("clock"), Some(&Value::from("14:32")));
        assert_eq!(ui.bar.get("call"), Some(&Value::from("")));
        assert_eq!(ui.cards.len(), 3);
        assert_eq!(ui.cards[0]["slot"], "A");
        assert_eq!(ui.cards[0]["freq"], "146.52000", "five decimals: not a number");
        assert_eq!(ui.cards[0]["meter"], 17);
        assert_eq!(ui.cards[1]["name"], "Club \"rpt\"");
        assert_eq!(ui.bcast["C"]["rds"], "RADIO 1");
        assert_eq!(ui.hints, vec![("MENU".into(), "Quick".into()), ("#".into(), "Status".into())]);
        assert!(ui.other.is_empty());
    }

    #[test]
    fn list_readback() {
        let t = "screen Group \"Display\" title=\"Display\"\nrow 1 \"Theme\" \"Dark\" sel\nrow 2 \"Brightness\" \"8\" dot\nrow 0 \"Nearby\" \"3\" grey\nrow \"x\" \"y\" kind=chan\nhelp \"Theme\" \"Dark, daylight...\"\ntoast \"Saved\" \"\"\nvalue \"Squelch\" level=4\nhints \"OK\" \"Edit\"\n";
        let ui = parse(t);
        assert_eq!(ui.rows.len(), 4);
        assert_eq!(ui.sel, Some(0));
        assert_eq!((ui.rows[0].num, ui.rows[0].name.as_str(), ui.rows[0].value.as_str()), (Some(1), "Theme", "Dark"));
        assert!(ui.rows[1].dot && !ui.rows[1].sel && ui.rows[2].grey);
        assert_eq!(ui.rows[2].num, Some(0));
        assert_eq!((ui.rows[3].num, ui.rows[3].name.as_str()), (None, "x"));
        assert_eq!(ui.rows[3].kv["kind"], "chan");
        assert_eq!(ui.help.as_ref().unwrap().head, "Theme");
        assert_eq!(ui.toast.as_ref().unwrap().head, "Saved");
        assert_eq!(ui.other.len(), 1);
        assert_eq!((ui.other[0].kind.as_str(), ui.other[0].args[0].as_str()), ("value", "Squelch"));
        assert_eq!(ui.other[0].int("level"), Some(4));
    }

    /// parse_ui_line's corners: escapes, negative numbers, a bare word after a pair, an unterminated quote.
    #[test]
    fn line_corners() {
        let l = parse_line(r#"card A active=1 head="VFO \"x\"" off=-60 x=12a word "a\\b""#);
        assert_eq!(l.kind, "card");
        assert_eq!(l.args, vec!["A", "word", "a\\b"]);
        assert_eq!(l.str("head"), Some("VFO \"x\""));
        assert_eq!(l.int("off"), Some(-60));
        assert_eq!(l.str("x"), Some("12a"));
        assert_eq!(parse_line("").kind, "");
        assert_eq!(parse_line("toast \"open").args, vec!["open"]);
        assert_eq!(parse_line("a b=").str("b"), Some(""));
        assert_eq!(parse_line("a b=-").str("b"), Some("-"));
    }
}
