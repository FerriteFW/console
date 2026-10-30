//! Channel and zone records (Appendix G, LINK-21): the bytes the link reads and writes, built and taken apart with
//! ferrite's own types (`ferrite_app::chan::Channel`, `ferrite_app::data::ZoneCfg`) and their own byte layouts
//! (`ferrite_app::persist`'s `Persist` impls), in the field order of ferrite's `link.rs` (`channel_save`,
//! `zone_save`, and `apply`'s reader). The tests check them against ferrite's real link session.
//!
//! [`ChanView`] and [`ZoneView`] are the same records as the table shows and edits them: frequencies in MHz, the
//! mode, step, power and tone words as the radio and its terminal write them (TERM-35.2's one-word tones:
//! `off`, `100.0`, `D023N`).

use ferrite_app::chan::{
    Channel, Name, END_TONES, FLAG_APRS, FLAG_HIDDEN, FLAG_PRIORITY, FLAG_RX_ONLY, FLAG_SKIP, MAX_CHANNELS, NO_ZONE,
    TAILS,
};
use ferrite_app::data::ZoneCfg;
use ferrite_app::persist::{Persist, Sink, Source};
use ferrite_app::slot::{SlotCfg, DCS_FLAG, DCS_INV, DEFAULT_CFG, MODES, SQ_GLOBAL, STEPS};
use serde::{Deserialize, Serialize};

/// A channel record's length over the link (Appendix G).
pub const CHANNEL_LEN: usize = 40;
/// The symbols a channel name may hold besides letters, digits and space (CHAN-31, decision 221): the same set as
/// ferrite's `ferrite_core::name`, which the radio maps every name to.
pub const NAME_SYMBOLS: &str = "-./_#+&()'!";

/// A character a channel name may hold (CHAN-31): A-Z, a-z, 0-9, space and [`NAME_SYMBOLS`].
pub fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == ' ' || NAME_SYMBOLS.contains(c)
}

/// A name for a channel, as the radio would keep it (CHAN-31): each character outside the set becomes '-'.
pub fn map_name(s: &str) -> String {
    s.chars().map(|c| if name_char(c) { c } else { '-' }).collect()
}
/// A zone record's length over the link.
pub const ZONE_LEN: usize = 26;
/// CTCSS tones a channel may hold (TONE-15): 60.0 to 260.0 Hz, in 0.1 Hz.
const CTCSS_MIN: u16 = 600;
const CTCSS_MAX: u16 = 2600;
/// Power names, 0-2.
pub const POWERS: [&str; 3] = ["Low", "Mid", "High"];
/// A zone's resume choices (SCAN-5): 0 the radio's, 1-10 s, 11 carrier drop, 12 stop on hit.
pub const RESUMES: [&str; 13] =
    ["Radio", "1 s", "2 s", "3 s", "4 s", "5 s", "6 s", "7 s", "8 s", "9 s", "10 s", "Carrier", "Stop"];
/// Flag bits the table doesn't show; kept as they were.
const FLAGS_SHOWN: u8 = FLAG_SKIP | FLAG_APRS | FLAG_RX_ONLY | FLAG_HIDDEN | FLAG_PRIORITY;

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

/// A channel's record, as the radio's `channel_save` writes it.
pub fn channel_record(c: &Channel) -> Vec<u8> {
    let mut s = Bytes(Vec::with_capacity(CHANNEL_LEN));
    c.num.save(&mut s);
    c.zone.save(&mut s);
    c.rx.save(&mut s);
    s.put(&c.name);
    c.cfg.save(&mut s);
    c.flags.save(&mut s);
    c.tones.save(&mut s);
    s.0
}

/// A channel from its record, as the radio's `apply` reads one (without its checks: those are the radio's, and
/// [`crate::plan`] runs them through ferrite's own code). None if the record is the wrong length.
pub fn channel_from_record(rec: &[u8]) -> Option<Channel> {
    if rec.len() != CHANNEL_LEN && rec.len() != CHANNEL_LEN - 1 {
        return None;
    }
    let mut c = Channel { num: 0, zone: NO_ZONE, rx: 0, name: [0; 16], cfg: SlotCfg::default(), flags: 0, tones: 0 };
    let mut r = Rd { b: rec, n: 0 };
    c.num.load(&mut r);
    c.zone.load(&mut r);
    c.rx.load(&mut r);
    if !r.take(&mut c.name) {
        return None;
    }
    c.cfg.load(&mut r);
    c.flags.load(&mut r);
    if r.n < rec.len() {
        c.tones.load(&mut r); // decision 86; an older writer leaves it off: Global
        c.tones = c.end_tone() | c.tail() << 3;
    }
    (r.n == rec.len()).then_some(c)
}

/// LINK-53 (decision 325): a channel position's record for `WRITE_MANY` of `what::POSITION`: latitude and longitude
/// in 1e-7 degree (north and east positive), little-endian, 8 bytes; None clears it (an empty record). Only for a
/// radio whose `HELLO` says `caps::POSITION`.
pub fn position_record(pos: Option<(i32, i32)>) -> Vec<u8> {
    match pos {
        Some((lat, lon)) => lat.to_le_bytes().into_iter().chain(lon.to_le_bytes()).collect(),
        None => Vec::new(),
    }
}

/// LINK-53: a position from a `READ_MANY` of `what::POSITION` record, (latitude, longitude) in 1e-7 degree; None if
/// the record isn't 8 bytes.
pub fn position_from_record(rec: &[u8]) -> Option<(i32, i32)> {
    let r: &[u8; 8] = rec.try_into().ok()?;
    Some((i32::from_le_bytes([r[0], r[1], r[2], r[3]]), i32::from_le_bytes([r[4], r[5], r[6], r[7]])))
}

/// A zone's record, as the radio's `zone_save` writes it.
pub fn zone_record(name: &[u8], c: &ZoneCfg) -> Vec<u8> {
    let mut s = Bytes(Vec::with_capacity(ZONE_LEN));
    let mut n = [0u8; 16];
    let k = name.len().min(16);
    n[..k].copy_from_slice(&name[..k]);
    s.put(&n);
    for v in [c.scan_all, c.shown, c.by_distance] {
        v.save(&mut s);
    }
    c.resume.save(&mut s);
    c.dwell.save(&mut s);
    0u8.save(&mut s); // reserved: it was smart scan (SCAN-23)
    c.pri.save(&mut s);
    s.0
}

/// A zone from its record (name and settings), as the radio's `apply` reads one.
pub fn zone_from_record(rec: &[u8]) -> Option<(Name, ZoneCfg)> {
    if rec.len() != ZONE_LEN {
        return None;
    }
    let mut r = Rd { b: rec, n: 0 };
    let mut name = [0u8; 16];
    if !r.take(&mut name) {
        return None;
    }
    let mut c = ZoneCfg::default();
    for v in [&mut c.scan_all, &mut c.shown, &mut c.by_distance] {
        v.load(&mut r);
    }
    c.resume.load(&mut r);
    c.dwell.load(&mut r);
    0u8.load(&mut r);
    c.pri.load(&mut r);
    let n = name.iter().position(|&b| b == 0).unwrap_or(16);
    (r.n == rec.len()).then(|| (Name::from(&name[..n]), c))
}

/// A frequency in 10 Hz as MHz with five decimals: "146.52000".
pub fn mhz_text(f: u32) -> String {
    format!("{}.{:05}", f / 100_000, f % 100_000)
}

/// MHz as text ("146.52", "146.520000") to 10 Hz; None if it isn't a number or is finer than 10 Hz.
pub fn parse_mhz(s: &str) -> Option<u32> {
    let s = s.trim();
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty() && frac.is_empty()
        || !int.bytes().all(|b| b.is_ascii_digit())
        || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let frac = frac.trim_end_matches('0');
    if frac.len() > 5 || int.len() > 5 {
        return None;
    }
    let i: u32 = if int.is_empty() { 0 } else { int.parse().ok()? };
    let f: u32 = format!("{frac:0<5}").parse().ok()?;
    i.checked_mul(100_000)?.checked_add(f)
}

/// A tone word as one word (TERM-35.2): "off", "100.0", "D023N", "D754I".
pub fn tone_word(t: u16) -> String {
    if t == 0 {
        "off".into()
    } else if t & DCS_FLAG == 0 {
        format!("{}.{}", t / 10, t % 10)
    } else {
        let c = t & 0x1FF;
        format!("D{:03o}{}", c, if t & DCS_INV != 0 { "I" } else { "N" })
    }
}

/// One word back to a tone word, as the terminal reads it: off (or empty), a CTCSS tone 60.0-260.0 Hz, or a DCS
/// code D000-D777 with N or I (N if neither).
pub fn parse_tone(w: &str) -> Result<u16, String> {
    let w = w.trim();
    if w.is_empty() || w.eq_ignore_ascii_case("off") || w.eq_ignore_ascii_case("none") {
        return Ok(0);
    }
    let bad = || format!("{w}: off, a CTCSS tone (100.0) or a DCS code (D023N, D023I)");
    if let Some(d) = w.strip_prefix(['D', 'd']) {
        let (code, inv) = match d.as_bytes().last() {
            Some(b'N' | b'n') => (&d[..d.len() - 1], false),
            Some(b'I' | b'i') => (&d[..d.len() - 1], true),
            _ => (d, false),
        };
        if code.len() != 3 || !code.bytes().all(|c| (b'0'..=b'7').contains(&c)) {
            return Err(bad());
        }
        let c = u16::from_str_radix(code, 8).map_err(|_| bad())?;
        return Ok(DCS_FLAG | if inv { DCS_INV } else { 0 } | c);
    }
    let w = w.strip_prefix(['T', 't']).unwrap_or(w).trim();
    let (i, f) = w.split_once('.').unwrap_or((w, "0"));
    let ok = !i.is_empty() && i.bytes().all(|b| b.is_ascii_digit()) && f.len() == 1 && f.as_bytes()[0].is_ascii_digit();
    if !ok {
        return Err(bad());
    }
    let t: u16 = i.parse::<u16>().map_err(|_| bad())?.saturating_mul(10).saturating_add(f.parse::<u16>().unwrap_or(0));
    if !(CTCSS_MIN..=CTCSS_MAX).contains(&t) {
        return Err(format!("{w}: CTCSS is 60.0 to 260.0 Hz"));
    }
    Ok(t)
}

/// A channel as the table shows and edits it. `number` is as the radio shows it, 1-1000.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChanView {
    pub number: u16,
    pub name: String,
    /// MHz, five decimals.
    pub rx: String,
    /// "" simplex, "+" or "-" a shift, "split" a TX frequency of its own.
    pub duplex: String,
    /// MHz: the shift (+/-), or the split's TX frequency; empty for simplex.
    pub offset: String,
    /// FM, NFM, AM (and USB, LSB, CW on an HF channel).
    pub mode: String,
    pub rx_tone: String,
    pub tx_tone: String,
    pub power: String,
    pub step: String,
    /// "Global" (the slot's level) or 0-9.
    pub squelch: String,
    /// The zone's index (0-253), or None.
    pub zone: Option<u8>,
    pub busy: bool,
    pub reverse: bool,
    pub skip: bool,
    pub aprs: bool,
    pub rx_only: bool,
    pub hidden: bool,
    pub priority: bool,
    /// END_TONES' names: Global, Off, Beep, ...
    pub end_tone: String,
    /// TAILS' names: Global, Off, On.
    pub tail: String,
    /// Flag bits the table doesn't show, kept as read.
    #[serde(default)]
    pub keep: u8,
    /// Where the channel is (CHAN-2), read and written apart from the record (LINK-53); left out when it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<Position>,
}

/// A channel's position (CHAN-2, LINK-53) in 1e-7 degree, north and east positive, as the radio holds it. In JSON
/// (the table, `.ferrite`'s channels.json) it is `[lat, lon]` in degrees with up to seven decimals.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub lat: i32,
    pub lon: i32,
}

/// The radio's limits (the terminal's `pos=`, LINK-53's check).
const LAT_MAX: i64 = 900_000_000;
const LON_MAX: i64 = 1_800_000_000;

/// What a position field takes, in the terminal's words (TERM-9's `pos=`).
pub const POSITION_HELP: &str = "lat, lon in degrees (45.4215, -75.6972) or a grid square (FN25dk)";

impl Position {
    /// Degrees to the radio's 1e-7 (rounded); None outside -90..90 and -180..180 or not a number.
    pub fn from_degrees(lat: f64, lon: f64) -> Option<Self> {
        let e7 = |d: f64, max: i64| {
            let v = (d * 1e7).round();
            (v.is_finite() && v.abs() <= max as f64).then_some(v as i32)
        };
        Some(Position { lat: e7(lat, LAT_MAX)?, lon: e7(lon, LON_MAX)? })
    }

    /// (latitude, longitude) in degrees.
    pub fn degrees(self) -> (f64, f64) {
        (self.lat as f64 / 1e7, self.lon as f64 / 1e7)
    }

    /// The radio's record pair (LINK-53's 8 bytes).
    pub fn e7(self) -> (i32, i32) {
        (self.lat, self.lon)
    }

    /// The six-character Maidenhead grid square ("FN25dk"), from ferrite's own code (GPS-21).
    pub fn grid(self) -> String {
        String::from_utf8_lossy(&ferrite_app::grid(ferrite_app::data::Pos { lat: self.lat, lon: self.lon }))
            .into_owned()
    }

    /// Degrees to five decimals, as the table shows them: "45.42150, -75.69720".
    pub fn text(self) -> String {
        let (a, b) = self.degrees();
        format!("{a:.5}, {b:.5}")
    }

    /// A typed position: "45.4215, -75.6972" (degrees, north and east positive; a space or none after the comma;
    /// more than seven decimals rounded, as a map's copied coordinates have), a 4- or 6-character grid square (its
    /// centre, from ferrite's own code: GPS-21), or empty / "none" for no position (Ok(None)).
    pub fn parse(text: &str) -> Result<Option<Self>, String> {
        let t = text.trim();
        if t.is_empty() || t.eq_ignore_ascii_case("none") {
            return Ok(None);
        }
        let bad = || format!("Position: {POSITION_HELP}");
        if let Some((a, b)) = t.split_once(',') {
            let deg = |w: &str| {
                let w = w.trim().trim_end_matches('°');
                let digits = w.strip_prefix(['-', '+']).unwrap_or(w);
                let ok = !digits.is_empty()
                    && digits.bytes().all(|c| c.is_ascii_digit() || c == b'.')
                    && digits.bytes().filter(|&c| c == b'.').count() <= 1
                    && digits.bytes().any(|c| c.is_ascii_digit());
                ok.then(|| w.parse::<f64>().ok()).flatten()
            };
            let (lat, lon) = (deg(a).ok_or_else(bad)?, deg(b).ok_or_else(bad)?);
            if lat.abs() > 90.0 {
                return Err("Position: latitude is -90 to 90 degrees".into());
            }
            if lon.abs() > 180.0 {
                return Err("Position: longitude is -180 to 180 degrees".into());
            }
            return Position::from_degrees(lat, lon).map(Some).ok_or_else(bad);
        }
        ferrite_app::grid_pos(t.as_bytes()).map(|p| Some(Position { lat: p.lat, lon: p.lon })).ok_or_else(bad)
    }
}

impl Serialize for Position {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let (a, b) = self.degrees();
        [a, b].serialize(s)
    }
}

impl<'de> Deserialize<'de> for Position {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let [a, b] = <[f64; 2]>::deserialize(d)?;
        Position::from_degrees(a, b)
            .ok_or_else(|| serde::de::Error::custom("pos: [lat, lon] in degrees, within 90 and 180"))
    }
}

fn pick(list: &[&str], v: &str, what: &str) -> Result<usize, String> {
    list.iter()
        .position(|x| x.eq_ignore_ascii_case(v.trim()))
        .ok_or_else(|| format!("{what}: one of {}", list.join(", ")))
}

impl ChanView {
    pub fn of(c: &Channel) -> Self {
        let g = &c.cfg;
        let (duplex, offset) = match (g.split, g.offset) {
            (true, o) => ("split", mhz_text(o.max(0) as u32)),
            (false, 0) => ("", String::new()),
            (false, o) if o > 0 => ("+", mhz_text(o as u32)),
            (false, o) => ("-", mhz_text(o.unsigned_abs())),
        };
        ChanView {
            number: c.num + 1,
            name: String::from_utf8_lossy(c.name()).into_owned(),
            rx: mhz_text(c.rx),
            duplex: duplex.into(),
            offset,
            mode: MODES.get(g.mode as usize).unwrap_or(&"FM").to_string(),
            rx_tone: tone_word(g.rx_tone),
            tx_tone: tone_word(g.tx_tone),
            power: POWERS.get(g.power as usize).unwrap_or(&"Low").to_string(),
            step: STEPS.get(g.step as usize).map_or("12.5 kHz", |s| s.1).to_string(),
            squelch: if g.squelch >= SQ_GLOBAL { "Global".into() } else { g.squelch.to_string() },
            zone: (c.zone != NO_ZONE).then_some(c.zone),
            busy: g.busy != 0,
            reverse: g.reverse,
            skip: c.flags & FLAG_SKIP != 0,
            aprs: c.flags & FLAG_APRS != 0,
            rx_only: c.flags & FLAG_RX_ONLY != 0,
            hidden: c.flags & FLAG_HIDDEN != 0,
            priority: c.flags & FLAG_PRIORITY != 0,
            end_tone: END_TONES[c.end_tone() as usize].into(),
            tail: TAILS[c.tail() as usize].into(),
            keep: c.flags & !FLAGS_SHOWN,
            pos: None,
        }
    }

    /// The view as the radio would hold it (each field through [`ChanView::channel`] and back), its position kept.
    pub fn normal(&self) -> Result<ChanView, String> {
        Ok(ChanView { pos: self.pos, ..ChanView::of(&self.channel()?) })
    }

    /// A new channel at `number` (1-1000) on `rx`: the radio's VFO defaults, squelch Global (the slot's level).
    pub fn new(number: u16, rx: u32) -> Self {
        let cfg = SlotCfg { squelch: SQ_GLOBAL, ..DEFAULT_CFG };
        let c = Channel { num: number.saturating_sub(1), zone: NO_ZONE, rx, name: [0; 16], cfg, flags: 0, tones: 0 };
        Self::of(&c)
    }

    /// The channel, or what is wrong with a field ("rx: ..."). The radio's own checks (bands, TX limits) come on
    /// top, from ferrite's code ([`crate::plan`]).
    pub fn channel(&self) -> Result<Channel, String> {
        if !(1..=MAX_CHANNELS).contains(&self.number) {
            return Err(format!("number: 1 to {MAX_CHANNELS}"));
        }
        let name = self.name.trim_end();
        if name.len() > 16 || !name.chars().all(name_char) {
            return Err("name: up to 16 letters, digits, spaces and - . / _ # + & ( ) ' !".into());
        }
        let rx = parse_mhz(&self.rx).ok_or("rx: a frequency in MHz, e.g. 146.52")?;
        let mut g = DEFAULT_CFG;
        g.mode = pick(&MODES, &self.mode, "mode")? as u8;
        g.narrow = g.mode == 1;
        g.rx_tone = parse_tone(&self.rx_tone).map_err(|e| format!("rx tone: {e}"))?;
        g.tx_tone = parse_tone(&self.tx_tone).map_err(|e| format!("tx tone: {e}"))?;
        let off = || parse_mhz(&self.offset).ok_or_else(|| "offset: MHz, e.g. 0.6".to_string());
        (g.split, g.offset) = match self.duplex.trim() {
            "" | "off" | "simplex" => (false, 0),
            "+" => (false, off()? as i32),
            "-" => (false, -(off()? as i32)),
            d if d.eq_ignore_ascii_case("split") => (true, off()? as i32),
            _ => return Err("duplex: none, +, - or split".into()),
        };
        g.power = pick(&POWERS, &self.power, "power")? as u8;
        let steps: Vec<&str> = STEPS.iter().map(|s| s.1).collect();
        g.step = pick(&steps, &self.step, "step")? as u8;
        g.squelch = if self.squelch.trim().eq_ignore_ascii_case("global") {
            SQ_GLOBAL
        } else {
            self.squelch.trim().parse::<u8>().ok().filter(|&s| s <= 9).ok_or("squelch: Global or 0 to 9")?
        };
        g.busy = self.busy as u8;
        g.reverse = self.reverse;
        let mut c = Channel {
            num: self.number - 1,
            zone: self.zone.unwrap_or(NO_ZONE),
            rx,
            name: [0; 16],
            cfg: g,
            flags: 0,
            tones: 0,
        };
        c.set_name(name.as_bytes());
        for (on, f) in [
            (self.skip, FLAG_SKIP),
            (self.aprs, FLAG_APRS),
            (self.rx_only, FLAG_RX_ONLY),
            (self.hidden, FLAG_HIDDEN),
            (self.priority, FLAG_PRIORITY),
        ] {
            if on {
                c.flags |= f;
            }
        }
        c.flags |= self.keep & !FLAGS_SHOWN;
        c.set_end_tone(pick(&END_TONES, &self.end_tone, "end tone")? as u8);
        c.set_tail(pick(&TAILS, &self.tail, "tail")? as u8);
        Ok(c)
    }
}

/// A zone as the table shows and edits it. `number` is as the radio shows it, 1-254.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZoneView {
    pub number: u8,
    pub name: String,
    pub scan_all: bool,
    pub shown: bool,
    pub by_distance: bool,
    /// RESUMES' names.
    pub resume: String,
    /// "Radio", or 1-254 seconds.
    pub dwell: String,
    /// Priority channels, 1-1000.
    pub pri1: Option<u16>,
    pub pri2: Option<u16>,
}

impl ZoneView {
    pub fn of(index: u8, name: &[u8], c: &ZoneCfg) -> Self {
        ZoneView {
            number: index + 1,
            name: String::from_utf8_lossy(name).into_owned(),
            scan_all: c.scan_all,
            shown: c.shown,
            by_distance: c.by_distance,
            resume: RESUMES.get(c.resume as usize).unwrap_or(&"Radio").to_string(),
            dwell: if c.dwell == 255 { "Radio".into() } else { c.dwell.to_string() },
            pri1: c.pri[0].map(|n| n + 1),
            pri2: c.pri[1].map(|n| n + 1),
        }
    }

    /// A new zone at `number` as the radio makes one: shown in ◀▶, the radio's resume and dwell.
    pub fn new(number: u8, name: &str) -> Self {
        Self::of(number - 1, name.as_bytes(), &ZoneCfg { shown: true, dwell: 255, ..ZoneCfg::default() })
    }

    pub fn zone(&self) -> Result<(Name, ZoneCfg), String> {
        let name = self.name.trim_end();
        if name.is_empty() || name.len() > 16 || !name.bytes().all(|b| (0x20..0x7F).contains(&b)) {
            return Err("name: 1 to 16 printable ASCII characters".into());
        }
        let pri = |p: Option<u16>| match p {
            None => Ok(None),
            Some(n) if (1..=MAX_CHANNELS).contains(&n) => Ok(Some(n - 1)),
            Some(_) => Err(format!("priority channel: 1 to {MAX_CHANNELS}")),
        };
        let dwell = if self.dwell.trim().eq_ignore_ascii_case("radio") || self.dwell.trim().is_empty() {
            255
        } else {
            self.dwell
                .trim()
                .trim_end_matches('s')
                .trim()
                .parse::<u8>()
                .ok()
                .filter(|d| (1..=254).contains(d))
                .ok_or("dwell: Radio or 1 to 254 s")?
        };
        let c = ZoneCfg {
            scan_all: self.scan_all,
            shown: self.shown,
            by_distance: self.by_distance,
            resume: pick(&RESUMES, &self.resume, "resume")? as u8,
            dwell,
            pri: [pri(self.pri1)?, pri(self.pri2)?],
        };
        Ok((Name::from(name.as_bytes()), c))
    }
}

/// What a table's selects offer, for the UI.
pub fn choices() -> serde_json::Value {
    serde_json::json!({
        "modes": MODES,
        "powers": POWERS,
        "steps": STEPS.iter().map(|s| s.1).collect::<Vec<_>>(),
        "endTones": END_TONES,
        "tails": TAILS,
        "resumes": RESUMES,
        "duplex": ["", "+", "-", "split"],
        "squelch": ["Global", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
        "ctcss": ferrite_app::slot::CTCSS.iter().map(|&t| tone_word(t)).collect::<Vec<_>>(),
        "dcs": ferrite_app::slot::DCS.iter().map(|&d| format!("{d:03o}")).collect::<Vec<_>>(),
        "maxChannels": MAX_CHANNELS,
        "maxZones": crate::radioside::MAX_ZONES,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radioside::RadioSide;
    use ferrite_core::link::{what, Status};

    fn read(r: &mut RadioSide, w: u8, idx: u16) -> Result<Vec<u8>, u8> {
        r.read_one(w, idx)
    }

    fn write(r: &mut RadioSide, w: u8, idx: u16, rec: &[u8]) -> (u8, Vec<u8>) {
        r.write_one(w, idx, rec)
    }

    fn sample() -> Channel {
        let mut v = ChanView::new(12, 14_694_000);
        v.name = "North hill".into();
        v.duplex = "-".into();
        v.offset = "0.6".into();
        v.tx_tone = "100.0".into();
        v.rx_tone = "D023I".into();
        v.power = "Mid".into();
        v.squelch = "Global".into();
        v.skip = true;
        v.priority = true;
        v.end_tone = "Quindar".into();
        v.tail = "On".into();
        v.channel().unwrap()
    }

    /// LINK-21 (Appendix G): the channel record Console builds is the one ferrite's link session reads out, byte
    /// for byte, and reads back as the same channel; 40 bytes.
    #[test]
    fn channel_record_matches_ferrites_link() {
        let mut r = RadioSide::new();
        let c = sample();
        r.seed(&[], &[c]);
        let from_radio = read(&mut r, what::CHANNEL, c.num).unwrap();
        assert_eq!(from_radio, channel_record(&c));
        assert_eq!(from_radio.len(), CHANNEL_LEN);
        assert_eq!(channel_from_record(&from_radio), Some(c));
        assert_eq!(
            channel_from_record(&from_radio[..39]).map(|x| x.tones),
            Some(0),
            "a writer without byte 40: Global"
        );
        assert_eq!(channel_from_record(&from_radio[..30]), None);
    }

    /// LINK-5: a record Console writes goes in through ferrite's own `apply`, checks and all, and is stored as built.
    #[test]
    fn channel_write_through_ferrites_link() {
        let mut r = RadioSide::new();
        let c = sample();
        assert_eq!(write(&mut r, what::CHANNEL, c.num, &channel_record(&c)).0, 0);
        assert_eq!(r.store.chans.borrow().get(&c.num), Some(&c));
        // A bad one is refused with ferrite's reason.
        let mut v = ChanView::of(&c);
        v.rx = "700.0".into();
        let (s, why) = write(&mut r, what::CHANNEL, c.num, &channel_record(&v.channel().unwrap()));
        assert_eq!(s, Status::Invalid as u8);
        assert!(String::from_utf8_lossy(&why).contains("756-1300 MHz"));
    }

    /// LINK-53: a position Console builds goes in through ferrite's own link session, reads back the same, and an
    /// empty record clears it; one out of range is refused with ferrite's reason.
    #[test]
    fn position_through_ferrites_link() {
        let mut r = RadioSide::new();
        let c = sample();
        r.seed(&[], &[c]);
        assert_eq!(read(&mut r, what::POSITION, c.num), Err(Status::NotFound as u8), "none yet");
        let p = (454_215_000, -756_972_000);
        assert_eq!(write(&mut r, what::POSITION, c.num, &position_record(Some(p))).0, 0);
        let back = read(&mut r, what::POSITION, c.num).unwrap();
        assert_eq!(position_from_record(&back), Some(p));
        assert_eq!(read(&mut r, what::CHANNEL, c.num).unwrap(), channel_record(&c), "the channel as it was");
        let (s, why) = write(&mut r, what::POSITION, c.num, &position_record(Some((910_000_000, 0))));
        assert_eq!(s, Status::Invalid as u8);
        assert!(String::from_utf8_lossy(&why).contains("latitude"));
        assert_eq!(write(&mut r, what::POSITION, c.num, &position_record(None)).0, 0);
        assert_eq!(read(&mut r, what::POSITION, c.num), Err(Status::NotFound as u8), "cleared");
        assert_eq!(position_from_record(&[0; 7]), None);
    }

    /// CHAN-2, LINK-53: a position typed as degrees (with or without a space, a map's long decimals rounded) or a
    /// grid square (ferrite's own centre, GPS-21), shown to five decimals with its grid square; JSON is degrees.
    #[test]
    fn positions_typed_and_shown() {
        let p = Position::parse("45.4215, -75.6972").unwrap().unwrap();
        assert_eq!(p, Position { lat: 454_215_000, lon: -756_972_000 });
        assert_eq!(Position::parse("45.4215,-75.6972").unwrap(), Some(p));
        assert_eq!(Position::parse(" +45.4215 , -75.6972° ").unwrap(), Some(p));
        assert_eq!(
            Position::parse("45.42153272870819, -75.69718564455287").unwrap(),
            Some(Position { lat: 454_215_327, lon: -756_971_856 })
        );
        let g = ferrite_app::grid_pos(b"FN25dk").unwrap();
        assert_eq!(Position::parse("fn25DK").unwrap(), Some(Position { lat: g.lat, lon: g.lon }));
        assert_eq!(Position::parse("FN25").unwrap().unwrap().grid(), "FN25mm");
        assert_eq!(p.grid(), "FN25dk");
        assert_eq!(p.text(), "45.42150, -75.69720");
        assert_eq!(Position::parse("").unwrap(), None);
        assert_eq!(Position::parse("none").unwrap(), None);
        assert!(Position::parse("91, 0").unwrap_err().contains("latitude"));
        assert!(Position::parse("0, -180.5").unwrap_err().contains("longitude"));
        for bad in ["45.4, x", "1e3, 0", "FN2", "ZZ00", "45.4", "-, 1", "1.2.3, 4"] {
            assert!(Position::parse(bad).is_err(), "{bad}");
        }
        assert_eq!(serde_json::to_string(&p).unwrap(), "[45.4215,-75.6972]");
        assert_eq!(serde_json::from_str::<Position>("[45.4215,-75.6972]").unwrap(), p);
        assert!(serde_json::from_str::<Position>("[0,181]").is_err());
        assert_eq!(position_record(Some(p.e7())), position_record(Some((454_215_000, -756_972_000))));
        // The table's JSON: no `pos` key without one; normalising keeps it.
        let mut v = ChanView::of(&sample());
        assert!(!serde_json::to_string(&v).unwrap().contains("pos"));
        v.pos = Some(p);
        assert_eq!(v.normal().unwrap().pos, Some(p));
    }

    /// CHAN-31: the editor takes only the name set and says which; imports map with [`map_name`].
    #[test]
    fn channel_names_in_the_name_set() {
        let mut v = ChanView::of(&sample());
        v.name = "Rpt (N)/2 #1".into();
        assert!(v.channel().is_ok());
        v.name = "Club@1".into();
        assert!(v.channel().unwrap_err().contains("letters, digits"));
        assert_eq!(map_name("Café @1"), "Caf- -1");
    }

    /// The zone record round-trips through ferrite's link: written (the next index creates), read back the same.
    #[test]
    fn zone_record_matches_ferrites_link() {
        let mut r = RadioSide::new();
        let mut z = ZoneView::new(1, "Repeaters");
        z.scan_all = true;
        z.resume = "Carrier".into();
        z.dwell = "5".into();
        z.pri1 = Some(12);
        let (name, cfg) = z.zone().unwrap();
        let rec = zone_record(name.as_bytes(), &cfg);
        assert_eq!(rec.len(), ZONE_LEN);
        assert_eq!(write(&mut r, what::ZONE, 0, &rec).0, 0);
        assert_eq!(r.store.zones.borrow().len(), 1);
        let back = read(&mut r, what::ZONE, 0).unwrap();
        assert_eq!(back, rec);
        let (n2, c2) = zone_from_record(&back).unwrap();
        assert_eq!(ZoneView::of(0, n2.as_bytes(), &c2), z);
        // Zones are made in order: index 2 with one zone is not found.
        assert_eq!(write(&mut r, what::ZONE, 2, &rec).0, Status::NotFound as u8);
    }

    #[test]
    fn views_round_trip() {
        let c = sample();
        let v = ChanView::of(&c);
        assert_eq!(v.number, 12);
        assert_eq!((v.rx.as_str(), v.duplex.as_str(), v.offset.as_str()), ("146.94000", "-", "0.60000"));
        assert_eq!((v.tx_tone.as_str(), v.rx_tone.as_str()), ("100.0", "D023I"));
        assert_eq!(v.channel().unwrap(), c);
        let mut s = v.clone();
        s.duplex = "split".into();
        s.offset = "147.54".into();
        assert_eq!(ChanView::of(&s.channel().unwrap()).offset, "147.54000");
        for bad in [("rx", "abc"), ("mode", "WFM"), ("rx_tone", "D029N"), ("squelch", "12"), ("power", "5W")] {
            let mut b = v.clone();
            match bad.0 {
                "rx" => b.rx = bad.1.into(),
                "mode" => b.mode = bad.1.into(),
                "rx_tone" => b.rx_tone = bad.1.into(),
                "squelch" => b.squelch = bad.1.into(),
                _ => b.power = bad.1.into(),
            }
            assert!(b.channel().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn mhz_and_tones() {
        assert_eq!(parse_mhz("146.52"), Some(14_652_000));
        assert_eq!(parse_mhz("446.00625"), Some(44_600_625));
        assert_eq!(parse_mhz("0.6"), Some(60_000));
        assert_eq!(parse_mhz("146.520001"), None);
        assert_eq!(parse_mhz("1e3"), None);
        assert_eq!(mhz_text(44_600_625), "446.00625");
        for t in ["off", "67.0", "254.1", "D023N", "D754I", "D777N"] {
            assert_eq!(tone_word(parse_tone(t).unwrap()), t);
        }
        assert_eq!(parse_tone("T 88.5"), Ok(885));
        assert_eq!(parse_tone("d023"), Ok(DCS_FLAG | 0o23));
        assert!(parse_tone("300.0").is_err() && parse_tone("D08").is_err());
    }
}
