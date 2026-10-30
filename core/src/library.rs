//! The channel library ("Add channels"): fixed sets (FRS, GMRS, MURS, PMR446, marine, weather, resource roads,
//! calling frequencies), airports near a place, and Canadian licensed sites (TAFL) near a place, as ported from
//! NeonPlug. The UI picks the entries; this module turns them into the table's channels and zones:
//!
//! - frequencies to the radio's 10 Hz, TX as simplex, a +/- shift (up to 10 MHz) or split;
//! - names to 16 printable ASCII characters; the step the largest of the radio's that fits the frequency;
//! - free channel numbers: the first run of free numbers that holds them all, else the gaps from 1; zones by name (an existing one, or a new one at the end);
//! - every channel checked by ferrite's own link code ([`crate::plan::check_channel`]): a channel ferrite won't
//!   let transmit is retried as RX only (and said so); one it refuses outright is skipped with its words;
//! - an entry the table already holds (same RX, TX, mode and zone) is skipped.
//!
//! Also here: places as typed (`lat,lon`, a grid square, an NMEA GGA sentence or the terminal's answers),
//! distances, airport channel names and the TAFL name groups.

use crate::channels::{mhz_text, ChanView, ZoneView};
use crate::plan::{check_channel, Set};
use crate::radioside::MAX_ZONES;
use ferrite_app::chan::MAX_CHANNELS;
use ferrite_app::slot::STEPS;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One library entry to add.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Item {
    pub name: String,
    /// MHz.
    pub rx: f64,
    /// MHz; absent or equal to `rx` for simplex.
    #[serde(default)]
    pub tx: Option<f64>,
    /// FM, NFM or AM.
    pub mode: String,
    /// Low, Mid or High; absent: Low.
    #[serde(default)]
    pub power: Option<String>,
    /// Never transmits (airband, weather).
    #[serde(default)]
    pub rx_only: bool,
    /// The zone's name; empty for no zone.
    #[serde(default)]
    pub zone: String,
    /// A CTCSS or DCS word for both directions (TERM-35.2's form), if the set has one.
    #[serde(default)]
    pub tone: Option<String>,
    /// Where it is, `[lat, lon]` in degrees (airports, TAFL sites): the channel's position (CHAN-2, LINK-53).
    #[serde(default)]
    pub pos: Option<crate::channels::Position>,
}

/// What [`add`] gives: the channels and zones to put in the table, and notes.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Added {
    pub channels: Vec<ChanView>,
    /// New zones only, numbered after the table's.
    pub zones: Vec<ZoneView>,
    pub notes: Vec<String>,
    pub skipped: usize,
    /// Of the added channels, how many were made RX only because ferrite refused them TX.
    pub made_rx_only: usize,
}

/// MHz to the radio's 10 Hz.
pub fn ten_hz(mhz: f64) -> u32 {
    (mhz * 100_000.0).round().max(0.0) as u32
}

/// A channel name the radio can hold: the name set (CHAN-31, others become '-'), 16 characters, no trailing spaces.
pub fn clean_name(s: &str) -> String {
    let n: String = crate::channels::map_name(s).chars().take(16).collect();
    n.trim_end().to_string()
}

/// A zone name the radio can hold: printable ASCII, 16 characters, no trailing spaces.
pub fn clean_zone_name(s: &str) -> String {
    let n: String = s.chars().map(|c| if (' '..='~').contains(&c) { c } else { '?' }).take(16).collect();
    n.trim_end().to_string()
}

/// The largest of the radio's steps that the frequency is a multiple of, from 25 kHz down to 5 kHz (8.33 kHz for
/// airband's 8.33 channels); 12.5 kHz if none.
pub fn step_for(rx: u32) -> &'static str {
    const PREF: [u32; 5] = [2500, 1250, 833, 625, 500];
    for p in PREF {
        let fits = if p == 833 { airband_833(rx) } else { rx.is_multiple_of(p) };
        if fits {
            return STEPS.iter().find(|s| s.0 == p).map_or("12.5 kHz", |s| s.1);
        }
    }
    "12.5 kHz"
}

/// An 8.33 kHz airband channel (118.005, 118.010 ...): a 5 kHz multiple that isn't on the 25 kHz raster.
fn airband_833(rx: u32) -> bool {
    (10_800_000..13_700_000).contains(&rx) && rx.is_multiple_of(500) && !rx.is_multiple_of(2500)
}

/// The entries as channels and zones for `table`. Numbers are the first free ones; zones match by name.
pub fn add(items: &[Item], table: &Set) -> Added {
    let mut out = Added::default();
    let mut used: std::collections::BTreeSet<u16> = table.channels.iter().map(|c| c.number).collect();
    let mut zone_names: Vec<String> = table.zones.iter().map(|z| z.name.clone()).collect();
    // A set goes in one run of free numbers when there is one (the first that fits), else into the gaps.
    let want = items.len().min(MAX_CHANNELS as usize) as u16;
    let mut next = (1..=MAX_CHANNELS.saturating_sub(want).saturating_add(1))
        .find(|&s| (s..s + want).all(|n| !used.contains(&n)))
        .unwrap_or(1);
    let mut full = false;
    // What the table (and this add) already holds: (rx, duplex, offset, mode, zone).
    let key = |c: &ChanView| (c.rx.clone(), c.duplex.clone(), c.offset.clone(), c.mode.clone(), c.zone);
    let mut have: std::collections::BTreeSet<_> = table.channels.iter().map(key).collect();
    for it in items {
        let label = if it.name.is_empty() { format!("{:.4} MHz", it.rx) } else { it.name.clone() };
        // The zone: by name, else a new one.
        let zone = if it.zone.trim().is_empty() {
            None
        } else {
            let zn = clean_zone_name(&it.zone);
            match zone_names.iter().position(|z| z.eq_ignore_ascii_case(&zn)) {
                Some(i) => Some(i as u8),
                None if zone_names.len() < MAX_ZONES => {
                    let n = zone_names.len() as u8 + 1;
                    out.zones.push(ZoneView::new(n, &zn));
                    zone_names.push(zn);
                    Some(n - 1)
                }
                None => {
                    out.notes.push(format!("{label}: no room for zone {zn:?} (the radio has {MAX_ZONES}): no zone"));
                    None
                }
            }
        };
        let rx = ten_hz(it.rx);
        let mut v = ChanView::new(1, rx);
        v.name = clean_name(&it.name);
        v.mode = it.mode.clone();
        v.power = it.power.clone().unwrap_or_else(|| "Low".into());
        v.step = step_for(rx).into();
        v.zone = zone;
        v.rx_only = it.rx_only;
        v.pos = it.pos;
        if let Some(t) = &it.tone {
            v.tx_tone = t.clone();
            v.rx_tone = t.clone();
        }
        let tx = it.tx.map(ten_hz).unwrap_or(rx);
        if !it.rx_only && tx != rx {
            let d = tx as i64 - rx as i64;
            if d.unsigned_abs() <= 1_000_000 {
                v.duplex = if d > 0 { "+" } else { "-" }.into();
                v.offset = mhz_text(d.unsigned_abs() as u32);
            } else {
                v.duplex = "split".into();
                v.offset = mhz_text(tx);
            }
        }
        if have.contains(&key(&normal(&v))) {
            out.notes.push(format!("{label}: already in the table: skipped"));
            out.skipped += 1;
            continue;
        }
        if full {
            out.skipped += 1;
            continue;
        }
        while used.contains(&next) {
            next += 1;
        }
        if next > MAX_CHANNELS {
            next = (1..=MAX_CHANNELS).find(|n| !used.contains(n)).unwrap_or(MAX_CHANNELS + 1);
        }
        if next > MAX_CHANNELS {
            out.notes.push(format!("the radio holds {MAX_CHANNELS} channels: {label} and the rest skipped"));
            out.skipped += 1;
            full = true;
            continue;
        }
        v.number = next;
        let zones = (zone_names.len()) as u8;
        let v = match check_channel(&v, zones) {
            None => v,
            Some(e) if !v.rx_only => {
                // Ferrite won't transmit there: as RX only, if it takes that.
                let mut r = v.clone();
                r.rx_only = true;
                r.duplex.clear();
                r.offset.clear();
                if check_channel(&r, zones).is_some() {
                    out.notes.push(format!("{label}: {e}: skipped"));
                    out.skipped += 1;
                    continue;
                }
                out.notes.push(format!("{label}: RX only ({e})"));
                out.made_rx_only += 1;
                r
            }
            Some(e) => {
                out.notes.push(format!("{label}: {e}: skipped"));
                out.skipped += 1;
                continue;
            }
        };
        let v = normal(&v);
        have.insert(key(&v));
        used.insert(v.number);
        out.channels.push(v);
    }
    out
}

/// The view as the radio would hold it (frequencies to five decimals, tones as words).
fn normal(v: &ChanView) -> ChanView {
    v.normal().unwrap_or_else(|_| v.clone())
}

// ---- fixed sets ----

/// A fixed set as `public/data/fixed-channels.json` holds it (NeonPlug's format, plus `rxOnly`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedSet {
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub description: String,
    pub default_power: String,
    /// "12.5kHz" (NFM) or "25kHz" (FM).
    pub default_bandwidth: String,
    #[serde(default)]
    pub rx_only: bool,
    pub frequencies: Vec<FixedFreq>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedFreq {
    pub name: String,
    pub rx: f64,
    pub tx: f64,
    #[serde(default)]
    pub ctcss: Option<f64>,
    #[serde(default)]
    pub dcs: Option<u16>,
    #[serde(default)]
    pub rx_only: bool,
}

/// The picked channels of a fixed set (indices into its frequencies) as entries for [`add`], into `zone`.
pub fn fixed_items(set: &FixedSet, picks: &[usize], zone: &str) -> Vec<Item> {
    let mode = if set.default_bandwidth.starts_with("12.5") { "NFM" } else { "FM" };
    picks
        .iter()
        .filter_map(|&i| set.frequencies.get(i))
        .map(|f| Item {
            name: f.name.clone(),
            rx: f.rx,
            tx: Some(f.tx),
            mode: mode.into(),
            power: Some(set.default_power.clone()),
            rx_only: set.rx_only || f.rx_only,
            zone: zone.into(),
            tone: f.ctcss.map(|t| format!("{t:.1}")).or_else(|| f.dcs.map(|d| format!("D{d:03}N"))),
            pos: None,
        })
        .collect()
}

// ---- places ----

/// A place in degrees.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Place {
    pub lat: f64,
    pub lon: f64,
}

/// A Maidenhead grid square (4 or 6 characters) as its centre, as ferrite reads one (GPS-21).
pub fn grid_place(g: &str) -> Option<Place> {
    let g = g.trim().as_bytes();
    if g.len() != 4 && g.len() != 6 {
        return None;
    }
    let up = |i: usize| g[i].to_ascii_uppercase();
    let letter = |i: usize, max: u8| up(i).checked_sub(b'A').filter(|&v| v < max).map(f64::from);
    let digit = |i: usize| g[i].checked_sub(b'0').filter(|&v| v < 10).map(f64::from);
    let mut lon = letter(0, 18)? * 20.0 + digit(2)? * 2.0;
    let mut lat = letter(1, 18)? * 10.0 + digit(3)?;
    if g.len() == 6 {
        lon += letter(4, 24)? * 2.0 / 24.0 + 1.0 / 24.0;
        lat += letter(5, 24)? / 24.0 + 1.0 / 48.0;
    } else {
        lon += 1.0;
        lat += 0.5;
    }
    Some(Place { lat: lat - 90.0, lon: lon - 180.0 })
}

/// The six-character grid square of a place.
pub fn grid_of(p: Place) -> String {
    let lon = (p.lon + 180.0).clamp(0.0, 359.999_999);
    let lat = (p.lat + 90.0).clamp(0.0, 179.999_999);
    let c = |base: u8, v: f64| (base + v as u8) as char;
    [
        c(b'A', lon / 20.0),
        c(b'A', lat / 10.0),
        c(b'0', lon % 20.0 / 2.0),
        c(b'0', lat % 10.0),
        c(b'a', lon % 2.0 * 12.0),
        c(b'a', lat % 1.0 * 24.0),
    ]
    .iter()
    .collect()
}

/// An NMEA latitude or longitude (ddmm.mmmm or dddmm.mmmm) and its hemisphere.
fn nmea_deg(v: &str, h: &str) -> Option<f64> {
    let x: f64 = v.parse().ok()?;
    let d = (x / 100.0).trunc() + (x % 100.0) / 60.0;
    match h {
        "N" | "E" => Some(d),
        "S" | "W" => Some(-d),
        _ => None,
    }
}

/// A place from text: "45.4215,-75.6972" (or with a space), a grid square ("FN25", "FN25dk"), a GGA sentence with
/// a fix (as the terminal's `gps` shows it), or the terminal's `get 0 6 9` answer. None if there's none in it.
pub fn parse_place(text: &str) -> Option<Place> {
    let ok = |p: Place| (p.lat.abs() <= 90.0 && p.lon.abs() <= 180.0).then_some(p);
    // A GGA sentence: fields 2-5 the place, 6 the fix quality (0 none).
    if let Some(i) = text.rfind("GGA,") {
        let f: Vec<&str> = text[i..].split([',', '*']).collect();
        if f.len() > 6 && f[6].trim().parse::<u8>().is_ok_and(|q| q > 0) {
            return ok(Place { lat: nmea_deg(f[2], f[3])?, lon: nmea_deg(f[4], f[5])? });
        }
        return None;
    }
    // Two decimal numbers.
    let nums: Vec<f64> = text
        .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .filter(|s| s.contains('.'))
        .filter_map(|s| s.parse().ok())
        .collect();
    if nums.len() >= 2 {
        return ok(Place { lat: nums[0], lon: nums[1] });
    }
    // A grid square word.
    text.split(|c: char| !c.is_ascii_alphanumeric()).find_map(grid_place)
}

/// Great-circle distance in km.
pub fn distance_km(a: Place, b: Place) -> f64 {
    let r = 6371.0088;
    let (la1, la2) = (a.lat.to_radians(), b.lat.to_radians());
    let dla = la2 - la1;
    let dlo = (b.lon - a.lon).to_radians();
    let h = (dla / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlo / 2.0).sin().powi(2);
    2.0 * r * h.sqrt().min(1.0).asin()
}

/// Of `coords` (lat, lon pairs back to back), the indices within `radius_km` of `at`, nearest first, at most
/// `limit`; with their distances.
pub fn near(at: Place, radius_km: f64, coords: &[f64], limit: usize) -> Vec<(u32, f64)> {
    // A cheap latitude box first: 11 MB of TAFL is 200,000 places.
    let dlat = radius_km / 111.0;
    let mut out: Vec<(u32, f64)> = coords
        .as_chunks::<2>()
        .0
        .iter()
        .enumerate()
        .filter(|(_, c)| (c[0] - at.lat).abs() <= dlat)
        .filter_map(|(i, c)| {
            let d = distance_km(at, Place { lat: c[0], lon: c[1] });
            (d <= radius_km).then_some((i as u32, d))
        })
        .collect();
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out.truncate(limit);
    out
}

// ---- airports ----

/// Airport frequency type codes (NeonPlug's airportdata.py) to the type's name and the short form for channel
/// names.
pub const AIRPORT_TYPES: [(&str, &str, &str); 33] = [
    ("C", "CTAF", "CTAF"),
    ("U", "UNICOM", "UNI"),
    ("T", "TOWER", "TWR"),
    ("G", "GROUND", "GND"),
    ("A", "APP", "APP"),
    ("I", "ATIS", "ATIS"),
    ("D", "DEP", "DEP"),
    ("M", "MISC", "MISC"),
    ("S", "ASOW", "ASOW"),
    ("F", "FSS", "FSS"),
    ("R", "RADIO", "RAD"),
    ("L", "CLD", "CLD"),
    ("N", "INFO", "INFO"),
    ("Z", "AFIS", "AFIS"),
    ("Y", "A/G", "A/G"),
    ("O", "OPS", "OPS"),
    ("X", "RADAR", "RDR"),
    ("P", "APRON", "APR"),
    ("H", "ATF", "ATF"),
    ("Q", "RCO", "RCO"),
    ("V", "TRAFFIC", "TRF"),
    ("W", "TMA", "TMA"),
    ("B", "ASOS", "ASOS"),
    ("J", "PAL", "PAL"),
    ("K", "AAS", "AAS"),
    ("E", "DIR", "DIR"),
    ("AA", "A/A", "A/A"),
    ("FC", "FCC", "FCC"),
    ("AC", "ACP", "ACP"),
    ("TB", "TIBA", "TIBA"),
    ("AD", "A/D", "A/D"),
    ("CC", "ACC", "ACC"),
    ("RT", "ARTC", "ARTC"),
];

/// A type code's name ("T" is TOWER); an unknown code as it is, or by the frequency when there is none.
pub fn airport_type(code: &str, khz: u32) -> String {
    if let Some(t) = AIRPORT_TYPES.iter().find(|t| t.0 == code) {
        return t.1.into();
    }
    if !code.is_empty() {
        return code.to_ascii_uppercase();
    }
    match khz {
        121_500 => "EMERG".into(),
        121_600..=121_900 => "GROUND".into(),
        122_000..=123_000 => "CTAF".into(),
        108_000..=117_999 => "ASOS".into(),
        _ => "AIR".into(),
    }
}

/// A channel name for an airport's frequency: "CYVR TWR", "KSEA ATIS", in 16 characters (the frequency's kHz
/// added when the airport has two of one type: "CYVR TWR 119.55").
pub fn airport_name(icao: &str, type_name: &str, khz: u32, repeat: bool) -> String {
    let short = AIRPORT_TYPES.iter().find(|t| t.1 == type_name).map_or(type_name, |t| t.2);
    let mut n = format!("{icao} {short}");
    if repeat {
        let mhz = format!("{}.{:03}", khz / 1000, khz % 1000);
        let mhz = mhz.trim_end_matches('0').trim_end_matches('.');
        if n.len() + 1 + mhz.len() <= 16 {
            n = format!("{n} {mhz}");
        }
    }
    clean_name(&n)
}

// ---- TAFL ----

/// TAFL's name groups (NeonPlug's `groupTaflEntriesByName`): entries whose first word is shared by `min` or more
/// go under it (or under their first two words, when those also make groups); the rest stand alone. One group
/// name per entry, in order.
pub fn tafl_groups(names: &[String], min: usize) -> Vec<String> {
    let words = |s: &str| -> Vec<String> {
        let sep = if s.contains('_') { '_' } else { ' ' };
        s.split(sep).filter(|w| !w.is_empty()).map(String::from).collect()
    };
    let first = |s: &str| words(s).first().cloned().unwrap_or_else(|| s.to_string());
    let two = |s: &str| {
        let w = words(s);
        if w.len() >= 2 {
            format!("{} {}", w[0], w[1])
        } else {
            first(s)
        }
    };
    let mut by_first: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, n) in names.iter().enumerate() {
        by_first.entry(first(n)).or_default().push(i);
    }
    let mut out = vec![String::new(); names.len()];
    for (w, idx) in by_first {
        if idx.len() < min {
            for i in idx {
                out[i] = names[i].clone();
            }
            continue;
        }
        let mut by_two: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for &i in &idx {
            by_two.entry(two(&names[i])).or_default().push(i);
        }
        // Two words when every two-word group is big enough on its own and there's more than one.
        let use_two = by_two.len() > 1 && by_two.values().all(|v| v.len() >= min);
        for (tw, v) in by_two {
            for i in v {
                out[i] = if use_two { tw.clone() } else { w.clone() };
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, rx: f64, tx: Option<f64>, mode: &str, zone: &str) -> Item {
        Item { name: name.into(), rx, tx, mode: mode.into(), zone: zone.into(), ..Item::default() }
    }

    fn table() -> Set {
        let mut c = ChanView::new(1, 14_652_000);
        c.name = "Calling".into();
        c.mode = "FM".into();
        Set { zones: vec![ZoneView::new(1, "Local")], channels: vec![c, ChanView::new(3, 14_655_000)] }
    }

    /// A run of free numbers, a new zone at the end, an existing one by name; every channel passes
    /// ferrite's own check.
    #[test]
    fn numbers_and_zones() {
        let items = [
            item("FRS 1", 462.5625, Some(462.5625), "NFM", "FRS"),
            item("FRS 2", 462.5875, None, "NFM", "frs"),
            item("MURS 1", 151.82, None, "NFM", "Local"),
        ];
        let a = add(&items, &table());
        // One run that holds all three: 4-6 (2 is a gap of one).
        assert_eq!(a.channels.iter().map(|c| c.number).collect::<Vec<_>>(), [4, 5, 6], "{:?}", a.notes);
        assert_eq!(a.zones.len(), 1);
        assert_eq!((a.zones[0].number, a.zones[0].name.as_str()), (2, "FRS"));
        assert_eq!(a.channels.iter().map(|c| c.zone).collect::<Vec<_>>(), [Some(1), Some(1), Some(0)]);
        assert_eq!((a.channels[0].rx.as_str(), a.channels[0].mode.as_str()), ("462.56250", "NFM"));
        assert_eq!(a.channels[0].step, "12.5 kHz");
        assert_eq!(step_for(ten_hz(446.00625)), "6.25 kHz");
        for c in &a.channels {
            assert_eq!(check_channel(c, 2), None);
        }
    }

    /// TX as a shift, or split beyond 10 MHz.
    #[test]
    fn duplex() {
        let items = [item("GMRS 15R", 462.55, Some(467.55), "NFM", ""), item("Split", 145.8, Some(437.8), "FM", "")];
        let a = add(&items, &Set::default());
        let s = |i: usize| (a.channels[i].duplex.as_str(), a.channels[i].offset.as_str());
        assert_eq!(s(0), ("+", "5.00000"), "{:?}", a.notes);
        assert_eq!(s(1), ("split", "437.80000"));
    }

    /// Airband: AM, RX only, ferrite takes it; 8.33 kHz channels get the 8.33 step.
    #[test]
    fn airband() {
        let mut it = item("CYVR TWR", 119.55, None, "AM", "CYVR");
        it.rx_only = true;
        let mut b = it.clone();
        b.rx = 118.005;
        let a = add(&[it, b], &Set::default());
        assert!(a.notes.is_empty(), "{:?}", a.notes);
        assert_eq!(a.channels.len(), 2);
        assert!(a.channels[0].rx_only && a.channels[0].mode == "AM");
        assert_eq!(a.channels[0].step, "25 kHz");
        assert_eq!(a.channels[1].step, "8.33 kHz");
    }

    /// Ferrite's refusals: a frequency it can't tune is skipped with its words; a WFM-like mode too.
    #[test]
    fn refusals() {
        let a =
            add(&[item("Too high", 700.0, None, "FM", ""), item("Bad mode", 146.5, None, "WFM", "")], &Set::default());
        assert_eq!((a.channels.len(), a.skipped), (0, 2));
        assert!(a.notes[0].contains("Too high") && a.notes[0].contains("rx"), "{:?}", a.notes);
        assert!(a.notes[1].contains("mode"), "{:?}", a.notes);
    }

    /// The same entry twice, or one the table holds, goes in once.
    #[test]
    fn duplicates() {
        let items = [
            item("Calling", 146.52, None, "FM", ""),
            item("A", 146.94, None, "FM", ""),
            item("B", 146.94, None, "FM", ""),
        ];
        let a = add(&items, &table());
        assert_eq!(a.channels.len(), 1, "{:?} {:?}", a.notes, a.channels);
        assert_eq!(a.skipped, 2);
    }

    /// 1000 channels at most: the rest skipped with a note.
    #[test]
    fn full() {
        let items: Vec<Item> = (0..1005).map(|i| item("x", 440.0 + i as f64 * 0.0125, None, "NFM", "")).collect();
        let a = add(&items, &Set::default());
        assert_eq!(a.channels.len(), 1000);
        assert_eq!(a.skipped, 5);
        assert!(a.notes.iter().any(|n| n.contains("1000 channels")));
    }

    /// No run long enough: the gaps, lowest first.
    #[test]
    fn gaps() {
        let t = Set {
            zones: vec![],
            channels: (1..=998).filter(|&n| n != 5).map(|n| ChanView::new(n, 14_400_000 + n as u32 * 1250)).collect(),
        };
        let items: Vec<Item> = (0..3).map(|i| item("g", 446.0 + i as f64 * 0.0125, None, "NFM", "")).collect();
        let a = add(&items, &t);
        assert_eq!(a.channels.iter().map(|c| c.number).collect::<Vec<_>>(), [5, 999, 1000], "{:?}", a.notes);
    }

    #[test]
    fn names() {
        assert_eq!(clean_name("A very long channel name"), "A very long chan");
        // CHAN-31: a channel name maps to the name set; a zone name keeps printable ASCII
        assert_eq!(clean_name("Café"), "Caf-");
        assert_eq!(clean_name("Club @ 5*"), "Club - 5-");
        assert_eq!(clean_zone_name("Club @ 5*"), "Club @ 5*");
        assert_eq!(airport_name("CYVR", "TOWER", 119_550, false), "CYVR TWR");
        assert_eq!(airport_name("CYVR", "TOWER", 119_550, true), "CYVR TWR 119.55");
        assert_eq!(airport_name("KSEA", &airport_type("I", 118_000), 118_000, false), "KSEA ATIS");
        assert_eq!(airport_type("", 121_500), "EMERG");
        assert_eq!(airport_type("ARCAL", 122_900), "ARCAL");
        assert!(airport_name("ABCDEFGHIJ", "TRAFFIC", 123_450, true).len() <= 16);
    }

    /// Every channel of every fixed set goes in as ferrite takes it (TX, or RX only where ferrite won't
    /// transmit); none is refused outright.
    #[test]
    fn fixed_sets() {
        let sets: Vec<FixedSet> = serde_json::from_str(include_str!("../../public/data/fixed-channels.json")).unwrap();
        assert!(sets.len() >= 8);
        for s in &sets {
            let picks: Vec<usize> = (0..s.frequencies.len()).collect();
            let a = add(&fixed_items(s, &picks, &s.name), &Set::default());
            let rx_only = a.channels.iter().filter(|c| c.rx_only).count();
            println!(
                "{}: {} added, {} skipped, {} RX only ({} by ferrite)",
                s.name,
                a.channels.len(),
                a.skipped,
                rx_only,
                a.made_rx_only
            );
            for n in a.notes.iter().take(3) {
                println!("  {n}");
            }
            assert!(
                a.notes.iter().all(|n| !n.ends_with("skipped") || n.contains("already")),
                "{}: {:?}",
                s.name,
                a.notes
            );
            assert_eq!(a.zones.len(), 1);
        }
        let wx = sets.iter().find(|s| s.name == "Weather").unwrap();
        let a = add(&fixed_items(wx, &[0], "WX"), &Set::default());
        assert!(a.channels[0].rx_only && a.channels[0].mode == "FM");
    }

    #[test]
    fn places() {
        let p = parse_place("45.4215,-75.6972").unwrap();
        assert_eq!((p.lat, p.lon), (45.4215, -75.6972));
        assert_eq!(parse_place(" 49.2 -123.1 ").unwrap(), Place { lat: 49.2, lon: -123.1 });
        let g = parse_place("fn25").unwrap();
        assert_eq!((g.lat, g.lon), (45.5, -75.0));
        assert_eq!(grid_of(Place { lat: 45.4215, lon: -75.6972 }), "FN25dk");
        let c = grid_place("FN25dk").unwrap();
        assert!((c.lat - 45.4375).abs() < 1e-9 && (c.lon - -75.708_333).abs() < 1e-5 && 0.0f64.abs() < 1e-9);
        let gga = "  GGA, 3 s ago: $GNGGA,123519.00,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47";
        let p = parse_place(gga).unwrap();
        assert!((p.lat - 48.1173).abs() < 1e-4 && (p.lon - 11.516_666).abs() < 1e-4);
        assert_eq!(parse_place("$GPGGA,123519,,,,,0,00,,,M,,M,,*66"), None);
        assert_eq!(parse_place("0 6 9 Fixed position: 45.4215,-75.6972 (FN25dk)").unwrap().lat, 45.4215);
        assert_eq!(parse_place("0 6 9 Fixed position: None"), None);
        assert_eq!(parse_place("95.0,10.0"), None);
    }

    #[test]
    fn distances() {
        let yvr = Place { lat: 49.195, lon: -123.184 };
        let sea = Place { lat: 47.449, lon: -122.309 };
        let d = distance_km(yvr, sea);
        assert!((d - 205.0).abs() < 3.0, "{d}");
        let coords = [47.449, -122.309, 49.195, -123.184, 10.0, 10.0, 49.25, -123.1];
        let n = near(Place { lat: 49.2, lon: -123.15 }, 50.0, &coords, 10);
        assert_eq!(n.iter().map(|x| x.0).collect::<Vec<_>>(), [1, 3]);
        assert_eq!(near(yvr, 300.0, &coords, 2).len(), 2);
    }

    #[test]
    fn tafl_grouping() {
        let names: Vec<String> =
            ["bc ferries a", "bc ferries b", "bc hydro x", "bc hydro y", "lone site", "teck coal", "teck mine"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        let g = tafl_groups(&names, 2);
        assert_eq!(g, ["bc ferries", "bc ferries", "bc hydro", "bc hydro", "lone site", "teck", "teck"]);
    }
}
