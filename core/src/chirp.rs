//! CHIRP's generic CSV (the columns CHIRP's "Export to CSV" writes and its CSV radio reads) to and from the table's
//! channels. Ferrite has no CHIRP code of its own (TERM-26: the web app converts, the radio doesn't), so the
//! mapping lives here. Tones are CHIRP's own columns, written as CHIRP writes them; a channel's RX and TX tone are
//! still one field each on the radio (decision 205).
//!
//! - Location is the channel number as the radio shows it (1-1000). A file whose lowest Location is 0 (CHIRP's
//!   generic CSV radio counts from 0) is moved up by one.
//! - Duplex `off` (TX disabled) is RX only, with the TX frequency in Offset (0 for simplex) so its shift or split
//!   comes back; `split` puts the TX frequency in Offset. A signed Offset (-0.6) is the direction when Duplex is
//!   blank. Nothing is dropped silently (issue #85): a field not taken is a note on the import, and a channel left
//!   out of an export or one whose priority CHIRP's one Skip column can't carry is a note on the export.
//! - Tone, rToneFreq, cToneFreq, DtcsCode, DtcsPolarity, RxDtcsCode and CrossMode map to the RX and TX tone words
//!   both ways; `TSQL-R` and `DTCS-R` (reverse squelch) have no Ferrite equivalent and import without tones.
//! - Skip `S` is skip, `P` priority (skip and priority both: `S`, with a note). Power is High, Mid or Low (a watt figure: 4 W and up High, 1.5 W up Mid).
//! - Comment carries the zone's name: exported, and on import a Comment that names a zone puts the channel in it
//!   (the zone of that exact name, else one differing only in case).
//! - A name's leading spaces are kept (quoted on export; CHIRP's reader keeps them too), trailing ones dropped.
//! - Modes FM, NFM, AM, NAM (narrow AM, CHIRP's name too; ferrite decision 447), WFM (BCR-33), USB, LSB, CW; others
//!   (DV, DMR ...) are skipped with a note. The stock list's AM with Bandwidth Narrow is NAM, as FM's is NFM.
//! - Latitude and Longitude (or Lat, Long, Lon, Lng), as some RepeaterBook exports have, are the channel's position
//!   (LINK-53); CHIRP has no such column, so an export leaves positions out.
//! - The stock radio's channel list as other tools save it (`Index,Name,RX MHz,TX MHz,Duplex,Offset,RX Tone,TX Tone,
//!   Bandwidth,Power,Mode,...,Scan,...,Zone`; a user's file, Nov 16, 2026) is read too: [`from_stock_list`] turns
//!   each row into CHIRP's columns first, so it gets the same checks and notes.
//!
//! An import goes into the table one of three ways (the dialog picks): merge by number, replace every channel, or
//! [`into_new_zone`]: the file's channels, in their order, at free numbers in a new zone (a RepeaterBook or CHIRP
//! export numbers from 0 or 1, so merging it would overwrite the owner's first channels).

use crate::channels::{mhz_text, parse_mhz, ChanView, Position, ZoneView, MAX_SHIFT, ZONE_CAP};
use crate::plan::Set;
use crate::radioside::MAX_ZONES;
use ferrite_app::chan::MAX_CHANNELS;
use ferrite_app::slot::{DCS_FLAG, DCS_INV, MODES, STEPS};
use serde::Serialize;

/// CHIRP's generic CSV columns, in its order.
pub const COLUMNS: [&str; 21] = [
    "Location",
    "Name",
    "Frequency",
    "Duplex",
    "Offset",
    "Tone",
    "rToneFreq",
    "cToneFreq",
    "DtcsCode",
    "DtcsPolarity",
    "RxDtcsCode",
    "CrossMode",
    "Mode",
    "TStep",
    "Skip",
    "Power",
    "Comment",
    "URCALL",
    "RPT1CALL",
    "RPT2CALL",
    "DVCODE",
];

/// One field for CSV: quoted when it holds a comma, quote or line break, or starts or ends with a space (a name's
/// leading spaces are kept: issue #85; a spreadsheet may trim an unquoted field's).
fn field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) || s.starts_with(' ') || s.ends_with(' ') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn ctcss_text(t: u16) -> String {
    format!("{}.{}", t / 10, t % 10)
}

/// A tone word's CHIRP pieces: kind ("Tone", "DTCS" or ""), the CTCSS (0.1 Hz), the DCS code, polarity N or R.
fn tone_parts(t: u16) -> (&'static str, u16, u16, char) {
    if t == 0 {
        ("", 0, 0, 'N')
    } else if t & DCS_FLAG == 0 {
        ("Tone", t, 0, 'N')
    } else {
        ("DTCS", 0, t & 0x1FF, if t & DCS_INV != 0 { 'R' } else { 'N' })
    }
}

/// The CHIRP tone columns for TX and RX tone words: Tone, rToneFreq, cToneFreq, DtcsCode, DtcsPolarity,
/// RxDtcsCode, CrossMode.
pub fn tone_columns(tx: u16, rx: u16) -> [String; 7] {
    let (tk, tc, td, tp) = tone_parts(tx);
    let (rk, rc, rd, rp) = tone_parts(rx);
    let (mut r_tone, mut c_tone, mut dtcs, mut rx_dtcs) = (885u16, 885u16, 0o23u16, 0o23u16);
    let mode = match (tk, rk) {
        ("", "") => "",
        ("Tone", "") => {
            r_tone = tc;
            "Tone"
        }
        ("Tone", "Tone") if tc == rc => {
            (r_tone, c_tone) = (tc, rc);
            "TSQL"
        }
        ("DTCS", "DTCS") if td == rd => {
            (dtcs, rx_dtcs) = (td, rd);
            "DTCS"
        }
        _ => "Cross",
    };
    let mut cross = "Tone->Tone".to_string();
    if mode == "Cross" {
        if tk == "Tone" {
            r_tone = tc;
        }
        if tk == "DTCS" {
            dtcs = td;
        }
        if rk == "Tone" {
            c_tone = rc;
        }
        if rk == "DTCS" {
            rx_dtcs = rd;
        }
        cross = format!("{tk}->{rk}");
    }
    let pol = format!("{}{}", if tk == "DTCS" { tp } else { 'N' }, if rk == "DTCS" { rp } else { 'N' });
    [mode.into(), ctcss_text(r_tone), ctcss_text(c_tone), format!("{dtcs:03o}"), pol, format!("{rx_dtcs:03o}"), cross]
}

/// What [`export_report`] gives: the file, and what it couldn't carry.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Export {
    pub text: String,
    /// The channels written.
    pub channels: usize,
    /// Channels left out (a field the radio can't hold), by number.
    pub left_out: Vec<u16>,
    /// Channels both skipped and priority: CHIRP's one Skip column holds S, so their priority isn't in the file.
    pub lost_priority: Vec<u16>,
    /// The above as sentences, for the export's report.
    pub notes: Vec<String>,
}

/// The channels as a CHIRP CSV file (CRLF lines, as CHIRP writes it).
pub fn export(channels: &[ChanView], zones: &[ZoneView]) -> String {
    export_report(channels, zones).text
}

/// The channels as a CHIRP CSV file, with what didn't go in (issue #85: never silently).
///
/// An RX-only channel is Duplex `off` (CHIRP's "transmit disabled") with its TX frequency in Offset, as a split
/// writes it, so its shift or split comes back on import ([`import`]); simplex writes Offset 0.
pub fn export_report(channels: &[ChanView], zones: &[ZoneView]) -> Export {
    let mut rep = Export::default();
    let mut out = COLUMNS.join(",");
    out.push_str("\r\n");
    for v in channels {
        let Ok(c) = v.channel() else {
            rep.left_out.push(v.number);
            continue;
        };
        rep.channels += 1;
        let g = &c.cfg;
        let (duplex, offset) = if v.rx_only {
            let tx = if g.split {
                g.offset.max(0) as u32
            } else {
                (c.rx as i64 + g.offset as i64).clamp(0, u32::MAX as i64) as u32
            };
            ("off".to_string(), if tx == c.rx { 0 } else { tx })
        } else if g.split {
            ("split".to_string(), g.offset.max(0) as u32)
        } else if g.offset > 0 {
            ("+".to_string(), g.offset as u32)
        } else if g.offset < 0 {
            ("-".to_string(), g.offset.unsigned_abs())
        } else {
            (String::new(), 0)
        };
        let t = tone_columns(g.tx_tone, g.rx_tone);
        let step = STEPS.get(g.step as usize).map_or(1250, |s| s.0);
        let skip = if v.skip {
            if v.priority {
                rep.lost_priority.push(v.number);
            }
            "S"
        } else if v.priority {
            "P"
        } else {
            ""
        };
        let zone = v.zone.and_then(|z| zones.get(z as usize)).map_or("", |z| z.name.as_str());
        let row = [
            v.number.to_string(),
            v.name.trim_end().to_string(),
            format!("{}0", mhz_text(c.rx)),
            duplex,
            format!("{}0", mhz_text(offset)),
            t[0].clone(),
            t[1].clone(),
            t[2].clone(),
            t[3].clone(),
            t[4].clone(),
            t[5].clone(),
            t[6].clone(),
            v.mode.clone(),
            format!("{}.{:02}", step / 100, step % 100),
            skip.into(),
            v.power.clone(),
            zone.into(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
        ];
        out.push_str(&row.iter().map(|s| field(s)).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    rep.text = out;
    rep.left_out.sort_unstable();
    rep.lost_priority.sort_unstable();
    let plural = |n: usize| if n == 1 { "channel" } else { "channels" };
    if !rep.left_out.is_empty() {
        let n = rep.left_out.len();
        rep.notes.push(format!(
            "{n} {} left out (a field the radio can't hold; fix it in the table): {}",
            plural(n),
            ranges(&rep.left_out)
        ));
    }
    if !rep.lost_priority.is_empty() {
        let n = rep.lost_priority.len();
        rep.notes.push(format!(
            "{n} {} lost priority (CHIRP has one Skip column: written as S): {}",
            plural(n),
            ranges(&rep.lost_priority)
        ));
    }
    rep
}

/// CSV text to rows of fields (quotes, doubled quotes, commas and line breaks inside quotes).
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(ch) = chars.next() {
        match (quoted, ch) {
            (true, '"') if chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            (true, '"') => quoted = false,
            (true, c) => cur.push(c),
            (false, '"') => quoted = true,
            (false, ',') => row.push(core::mem::take(&mut cur)),
            (false, '\r') => {}
            (false, '\n') => {
                row.push(core::mem::take(&mut cur));
                rows.push(core::mem::take(&mut row));
            }
            (false, c) => cur.push(c),
        }
    }
    if !cur.is_empty() || !row.is_empty() {
        row.push(cur);
        rows.push(row);
    }
    rows.retain(|r| r.iter().any(|f| !f.trim().is_empty()));
    rows
}

/// What an import gives: the channels, and notes on lines changed or skipped ("line 4: ...").
#[derive(Clone, Debug, Default, Serialize)]
pub struct Import {
    pub channels: Vec<ChanView>,
    pub notes: Vec<String>,
    pub skipped: usize,
}

fn ctcss_of(s: &str) -> Option<u16> {
    crate::channels::parse_tone(s).ok().filter(|t| *t != 0 && t & DCS_FLAG == 0)
}

/// A CTCSS column a tone mode uses; what it can't read goes in `bad` (issue #85: never dropped silently).
fn ctcss_field(col: &str, text: &str, bad: &mut Vec<String>) -> Option<u16> {
    let t = ctcss_of(text);
    if t.is_none() {
        bad.push(format!("{col} {text:?}: not a CTCSS tone (60.0 to 260.0 Hz)"));
    }
    t
}

/// A DCS column a tone mode uses, as [`ctcss_field`].
fn dcs_field(col: &str, text: &str, pol: char, bad: &mut Vec<String>) -> Option<u16> {
    let t = dcs_of(text, pol);
    if t.is_none() {
        bad.push(format!("{col} {text:?}: not a DCS code (000 to 777)"));
    }
    t
}

fn dcs_of(code: &str, pol: char) -> Option<u16> {
    let c = u16::from_str_radix(code.trim(), 8).ok().filter(|&c| c <= 0o777)?;
    Some(DCS_FLAG | if pol == 'R' || pol == 'I' { DCS_INV } else { 0 } | c)
}

fn power_of(s: &str) -> &'static str {
    let l = s.trim().to_ascii_lowercase();
    if l.is_empty() {
        return "Low";
    }
    if l.starts_with('h') {
        return "High";
    }
    if l.starts_with('m') {
        return "Mid";
    }
    if l.starts_with('l') {
        return "Low";
    }
    match l.trim_end_matches('w').trim().parse::<f32>() {
        Ok(w) if w >= 4.0 => "High",
        Ok(w) if w >= 1.5 => "Mid",
        _ => "Low",
    }
}

/// A tone of the stock list (`OFF`, `88.5`, `D023N`, `D023I`) as CHIRP's: ("Tone", the CTCSS) or ("DTCS", the code,
/// polarity N or R); None for none.
fn stock_tone(t: &str) -> Option<(&'static str, String, char)> {
    let t = t.trim();
    let up = t.to_ascii_uppercase();
    if t.is_empty() || up == "OFF" || up == "NONE" {
        return None;
    }
    if let Some(d) = up.strip_prefix('D') {
        return Some(match d.strip_suffix('N') {
            Some(code) => ("DTCS", code.to_string(), 'N'),
            None => match d.strip_suffix(['I', 'R']) {
                Some(code) => ("DTCS", code.to_string(), 'R'),
                None => ("DTCS", d.to_string(), 'N'),
            },
        });
    }
    Some(("Tone", t.to_string(), 'N'))
}

/// The stock radio's channel list (`Index`, `RX MHz`, `TX MHz`, `RX Tone`/`TX Tone`, `Bandwidth` Wide/Narrow, `Scan`
/// true/false, `Zone`) as CHIRP's rows, or None when `rows` isn't one. A TX frequency apart from RX with no Duplex is
/// a split; tones go as CHIRP's Cross (either side may be none); Scan false is skip; the Zone is the Comment (a zone
/// of that name takes the channel).
pub fn from_stock_list(rows: &[Vec<String>]) -> Option<Vec<Vec<String>>> {
    let head = rows.first()?;
    let col = |name: &str| head.iter().position(|h| h.trim().eq_ignore_ascii_case(name));
    let rx_col = col("RX MHz")?;
    let get = |r: &[String], name: &str| col(name).and_then(|i| r.get(i)).map_or(String::new(), |s| s.trim().to_string());
    let mut out = vec![COLUMNS.iter().map(|c| c.to_string()).collect::<Vec<_>>()];
    for r in &rows[1..] {
        let rx = r.get(rx_col).map_or("", |s| s.trim()).to_string();
        let tx = get(r, "TX MHz");
        let (mut duplex, mut offset) = (get(r, "Duplex"), get(r, "Offset"));
        if duplex.is_empty() && parse_mhz(&tx).is_some() && parse_mhz(&tx) != parse_mhz(&rx) {
            (duplex, offset) = ("split".into(), tx.clone());
        }
        let (t_tx, t_rx) = (stock_tone(&get(r, "TX Tone")), stock_tone(&get(r, "RX Tone")));
        let mut f = [String::new(), String::new(), String::new(), String::new()]; // rToneFreq, cToneFreq, DtcsCode, RxDtcsCode
        let mut pol = ['N', 'N'];
        if let Some((k, v, p)) = &t_tx {
            if *k == "Tone" {
                f[0] = v.clone();
            } else {
                (f[2], pol[0]) = (v.clone(), *p);
            }
        }
        if let Some((k, v, p)) = &t_rx {
            if *k == "Tone" {
                f[1] = v.clone();
            } else {
                (f[3], pol[1]) = (v.clone(), *p);
            }
        }
        let (tone, cross) = match (&t_tx, &t_rx) {
            (None, None) => (String::new(), String::new()),
            (a, b) => ("Cross".to_string(), format!("{}->{}", a.as_ref().map_or("", |t| t.0), b.as_ref().map_or("", |t| t.0))),
        };
        let mode = get(r, "Mode");
        let narrow = get(r, "Bandwidth").to_ascii_lowercase().starts_with('n');
        let mode = match () {
            _ if mode.eq_ignore_ascii_case("FM") && narrow => "NFM".to_string(),
            _ if mode.eq_ignore_ascii_case("AM") && narrow => "NAM".to_string(),
            _ => mode,
        };
        let skip = if get(r, "Scan").eq_ignore_ascii_case("false") { "S" } else { "" };
        let [r_tone, c_tone, dtcs, rx_dtcs] = f;
        // A name's leading spaces are kept (issue #85), as CHIRP's own reader keeps them
        let name = col("Name").and_then(|i| r.get(i)).map_or(String::new(), |s| s.trim_end().to_string());
        out.push(vec![
            get(r, "Index"),
            name,
            rx,
            duplex,
            offset,
            tone,
            r_tone,
            c_tone,
            dtcs,
            pol.iter().collect(),
            rx_dtcs,
            cross,
            mode,
            String::new(),
            skip.into(),
            get(r, "Power"),
            get(r, "Zone"),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
        ]);
    }
    Some(out)
}

/// A CHIRP CSV file (or the stock radio's channel list, [`from_stock_list`]) to channels. `zones` (the table's) let
/// a Comment name a zone.
pub fn import(text: &str, zones: &[ZoneView]) -> Result<Import, String> {
    let rows = parse_csv(text);
    let rows = from_stock_list(&rows).unwrap_or(rows);
    let Some(head) = rows.first() else { return Err("the file is empty".into()) };
    let col = |name: &str| head.iter().position(|h| h.trim().eq_ignore_ascii_case(name));
    let Some(fcol) = col("Frequency") else {
        return Err("not a channel list Console reads: a CHIRP CSV file (a Frequency column) or the stock radio's list (RX MHz)".into());
    };
    let cols: Vec<Option<usize>> = COLUMNS.iter().map(|c| col(c)).collect();
    let field_of = |r: &[String], name: &str| -> String {
        let i = COLUMNS.iter().position(|c| *c == name).and_then(|i| cols[i]);
        i.and_then(|i| r.get(i)).cloned().unwrap_or_default()
    };
    let get = |r: &[String], name: &str| -> String { field_of(r, name).trim().to_string() };
    // RepeaterBook's exports (some) carry the site's coordinates: the channel's position (CHAN-2, LINK-53).
    // CHIRP's own CSV has no such column.
    let any_col = |names: &[&str]| names.iter().find_map(|n| col(n));
    let (lat_col, lon_col) = (any_col(&["Latitude", "Lat"]), any_col(&["Longitude", "Long", "Lon", "Lng"]));
    let locs: Vec<Option<u32>> = rows[1..].iter().map(|r| get(r, "Location").parse().ok()).collect();
    let shift = u32::from(locs.iter().flatten().min() == Some(&0));
    let mut out = Import::default();
    let mut next = 1u32;
    for (k, r) in rows[1..].iter().enumerate() {
        let line = k + 2;
        let mut note = |m: String| out.notes.push(format!("line {line}: {m}"));
        let Some(rx) = r.get(fcol).and_then(|f| parse_mhz(f)).filter(|&f| f > 0) else {
            note("no frequency: skipped".into());
            out.skipped += 1;
            continue;
        };
        let number = match locs[k] {
            Some(l) => l.saturating_add(shift),
            None => next,
        };
        next = number.saturating_add(1);
        if !(1..=MAX_CHANNELS as u32).contains(&number) {
            note(format!("location {number}: the radio has channels 1 to {MAX_CHANNELS}: skipped"));
            out.skipped += 1;
            continue;
        }
        let mode = get(r, "Mode");
        let mode = if mode.is_empty() { "FM".to_string() } else { mode };
        let Some(m) = MODES.iter().find(|m| m.eq_ignore_ascii_case(&mode)) else {
            note(format!("mode {mode}: Ferrite has FM, NFM, AM, NAM, WFM, USB, LSB and CW: skipped"));
            out.skipped += 1;
            continue;
        };
        let mut v = ChanView::new(number as u16, rx);
        v.mode = m.to_string();
        // Name: 16 characters of the name set (CHAN-31), others mapped to '-' as the radio would.
        // Leading spaces are the name's (issue #85): CHIRP's reader keeps them and the radio holds them; trailing
        // ones go, as the radio's names don't keep them (ChanView::channel).
        let raw = field_of(r, "Name").trim_end().to_string();
        let name = crate::channels::map_name(&raw);
        if name.len() > 16 {
            note(format!("name {raw:?} cut to 16 characters"));
        } else if name != raw {
            note(format!("name {raw:?}: characters a channel name can't hold became -"));
        }
        v.name = name.chars().take(16).collect::<String>().trim_end().to_string();
        // Duplex and offset. Offset may carry a sign (some tools write -0.600000): with Duplex blank it is the
        // direction, with + or - it must agree (issue #85).
        let off_text = get(r, "Offset").replace('\u{2212}', "-");
        let (sign, mag) = match off_text.as_bytes().first() {
            Some(b'-') => (Some('-'), off_text[1..].trim()),
            Some(b'+') => (Some('+'), off_text[1..].trim()),
            _ => (None, off_text.as_str()),
        };
        let off = match parse_mhz(mag) {
            Some(o) => o,
            None if mag.is_empty() => 0,
            None => {
                note(format!("offset {off_text:?}: not a frequency: taken as none"));
                0
            }
        };
        let duplex = get(r, "Duplex").to_ascii_lowercase();
        match (duplex.as_str(), sign) {
            ("" | "+" | "-", _) if off == 0 => {}
            ("", Some(d)) | ("+", Some(d @ '+')) | ("-", Some(d @ '-')) => {
                v.duplex = d.to_string();
                v.offset = mhz_text(off);
            }
            ("+" | "-", None) => {
                v.duplex = duplex.clone();
                v.offset = mhz_text(off);
            }
            ("+" | "-", Some(_)) => {
                note(format!("duplex {duplex} with offset {off_text}: taken as {duplex}"));
                v.duplex = duplex.clone();
                v.offset = mhz_text(off);
            }
            ("", None) => {} // CHIRP's simplex: an offset left there is not used
            ("split", Some('-')) => note(format!("split with offset {off_text}: a TX frequency can't be negative: taken as simplex")),
            ("split", _) if off > 0 => {
                v.duplex = "split".into();
                v.offset = mhz_text(off);
            }
            ("split", _) => note("split with no TX frequency: taken as simplex".into()),
            ("off", _) => {
                // TX disabled: RX only. Offset is the TX frequency as this export writes it (and a split's), or a
                // shift left there (CHIRP keeps a turned-off channel's offset): a value within MAX_SHIFT of RX, or
                // above MAX_SHIFT, is a TX frequency; a smaller one a shift (+ unless signed).
                v.rx_only = true;
                if off > 0 && sign.is_none() && (off > MAX_SHIFT || off.abs_diff(rx) <= MAX_SHIFT) {
                    match v.with_tx(&mhz_text(off)) {
                        Ok(t) => (v.duplex, v.offset) = (t.duplex, t.offset),
                        Err(e) => note(format!("offset {off_text}: {e}: taken as simplex")),
                    }
                } else if off > 0 {
                    v.duplex = sign.unwrap_or('+').to_string();
                    v.offset = mhz_text(off);
                }
            }
            (d, _) => note(format!("duplex {d:?}: taken as simplex")),
        }
        // Tones.
        let pol: Vec<char> = get(r, "DtcsPolarity").to_ascii_uppercase().chars().collect();
        let (tp, rp) = (pol.first().copied().unwrap_or('N'), pol.get(1).copied().unwrap_or('N'));
        // A tone the mode uses that isn't one the radio holds is a note, never dropped silently (issue #85).
        let mut bad: Vec<String> = Vec::new();
        let tone = get(r, "Tone");
        let (tx, rxt) = match tone.as_str() {
            "" => (None, None),
            "Tone" => (ctcss_field("rToneFreq", &get(r, "rToneFreq"), &mut bad), None),
            "TSQL" => {
                let c = ctcss_field("cToneFreq", &get(r, "cToneFreq"), &mut bad);
                (c, c)
            }
            "DTCS" => {
                let code = get(r, "DtcsCode");
                (dcs_field("DtcsCode", &code, tp, &mut bad), dcs_of(&code, rp))
            }
            "Cross" => {
                let cm = get(r, "CrossMode");
                let (a, b) = cm.split_once("->").unwrap_or(("Tone", "Tone"));
                let tx = match a.trim() {
                    "Tone" => ctcss_field("rToneFreq", &get(r, "rToneFreq"), &mut bad),
                    "DTCS" => dcs_field("DtcsCode", &get(r, "DtcsCode"), tp, &mut bad),
                    _ => None,
                };
                let rx = match b.trim() {
                    "Tone" => ctcss_field("cToneFreq", &get(r, "cToneFreq"), &mut bad),
                    "DTCS" => dcs_field("RxDtcsCode", &get(r, "RxDtcsCode"), rp, &mut bad),
                    _ => None,
                };
                (tx, rx)
            }
            t => {
                note(format!("tone mode {t}: Ferrite has no reverse squelch; imported without tones"));
                (None, None)
            }
        };
        for b in bad {
            note(format!("{b}: imported without it"));
        }
        v.tx_tone = crate::channels::tone_word(tx.unwrap_or(0));
        v.rx_tone = crate::channels::tone_word(rxt.unwrap_or(0));
        // Step: kHz to the radio's nearest step.
        if let Ok(k) = get(r, "TStep").parse::<f64>() {
            let want = (k * 100.0).round() as u32;
            match STEPS.iter().find(|s| s.0 == want) {
                Some(s) => v.step = s.1.into(),
                None => note(format!("step {k} kHz: not one of the radio's; 12.5 kHz")),
            }
        }
        // CHIRP's Skip holds one of S or P (so a channel both skipped and priority exports as S: export_report)
        match get(r, "Skip").to_ascii_uppercase().as_str() {
            "S" => v.skip = true,
            "P" => v.priority = true,
            _ => {}
        }
        v.power = power_of(&get(r, "Power")).into();
        let comment = get(r, "Comment");
        // The zone of that name: exactly first, then ignoring case (issue #85: zones differing in case stay apart)
        let named = |exact: bool| {
            zones.iter().position(|z| {
                let n = z.name.trim_end();
                !comment.is_empty() && if exact { n == comment } else { n.eq_ignore_ascii_case(&comment) }
            })
        };
        v.zone = named(true).or_else(|| named(false)).map(|i| i as u16);
        if let (Some(a), Some(b)) = (lat_col, lon_col) {
            let deg = |i: usize| r.get(i).and_then(|s| s.trim().parse::<f64>().ok());
            match (deg(a), deg(b)) {
                (Some(lat), Some(lon)) if lat != 0.0 || lon != 0.0 => match Position::from_degrees(lat, lon) {
                    Some(p) => v.pos = Some(p),
                    None => note(format!("position {lat}, {lon}: not on the map: left out")),
                },
                _ => {} // blank (or 0, 0): no position
            }
        }
        if let Some(e) = crate::plan::check_channel(&v, zones.len() as u16) {
            note(format!("channel {number}: {e}: skipped"));
            out.skipped += 1;
            continue;
        }
        if let Some(i) = out.channels.iter().position(|c| c.number == v.number) {
            note(format!("channel {number} appears twice: the later line kept"));
            out.channels.remove(i);
        }
        out.channels.push(v.normal().map_err(|e| format!("line {line}: {e}"))?);
    }
    out.channels.sort_by_key(|c| c.number);
    Ok(out)
}

/// A new zone's name from the file's name: without the extension, `_` as spaces, the name set (CHAN-31), 16
/// characters; with " 2", " 3" ... when the table has a zone of that name.
pub fn zone_name_for(file: &str, zones: &[ZoneView]) -> String {
    let stem = file.rsplit(['/', '\\']).next().unwrap_or(file);
    let stem = stem.rsplit_once('.').map_or(stem, |(s, _)| s).replace('_', " ");
    let mut base = crate::library::clean_name(stem.trim());
    if base.is_empty() {
        base = "Import".into();
    }
    let taken = |n: &str| zones.iter().any(|z| z.name.trim_end().eq_ignore_ascii_case(n));
    if !taken(&base) {
        return base;
    }
    for k in 2..=MAX_ZONES + 1 {
        let sfx = format!(" {k}");
        let cut: String = base.chars().take(16 - sfx.len()).collect();
        let name = format!("{}{sfx}", cut.trim_end());
        if !taken(&name) {
            return name;
        }
    }
    base
}

/// Numbers as ranges: "501-534", "12-20, 40, 990-1000".
pub fn ranges(nums: &[u16]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < nums.len() {
        let mut j = i;
        while j + 1 < nums.len() && nums[j + 1] == nums[j] + 1 {
            j += 1;
        }
        out.push(if i == j { nums[i].to_string() } else { format!("{}-{}", nums[i], nums[j]) });
        i = j + 1;
    }
    out.join(", ")
}

/// What [`into_new_zone`] gives: the channels renumbered into the new zone (zones: a list longer than a zone holds
/// is split over several, CHAN-35), the zones, their numbers as ranges, and why it can't be done: `room` (not enough
/// free numbers or zones left: the option is off) or `name_error` (the name as typed: fix it).
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewZone {
    pub channels: Vec<ChanView>,
    /// The new zones, in order: one, or for more than 256 channels one per 256 ("Repeaters 1", "Repeaters 2", ...).
    pub zones: Vec<ZoneView>,
    pub numbers: String,
    pub room: String,
    pub name_error: String,
}

/// The imported channels, in their order, at free numbers in a new zone named `name` at the end of the table's.
/// Numbers: the run right after the table's highest channel when it fits below 4000; else the first free run that
/// holds them all; else the free numbers from 1 up. A Comment that named a zone is ignored: every channel goes in
/// the new zone. More than 256 (CHAN-35): split over new zones of 256, `name` 1, `name` 2 and so on.
pub fn into_new_zone(channels: &[ChanView], table: &Set, name: &str) -> NewZone {
    let mut out = NewZone::default();
    let n = channels.len();
    let used: std::collections::BTreeSet<u16> = table.channels.iter().map(|c| c.number).collect();
    let free: Vec<u16> = (1..=MAX_CHANNELS).filter(|k| !used.contains(k)).collect();
    let parts = n.div_ceil(ZONE_CAP).max(1);
    if table.zones.len() + parts > MAX_ZONES {
        out.room = if parts == 1 {
            format!("the table has {MAX_ZONES} zones, the most the radio holds")
        } else {
            format!(
                "{n} channels need {parts} zones of {ZONE_CAP}, but the table has {} of the radio's {MAX_ZONES} zones",
                table.zones.len()
            )
        };
        return out;
    }
    if free.len() < n {
        out.room = format!("{n} channels, but only {} channel numbers are free", free.len());
        return out;
    }
    if n == 0 {
        out.room = "no channels to add".into();
        return out;
    }
    let fits = |s: u16| (s as usize + n - 1) <= MAX_CHANNELS as usize && (s..s + n as u16).all(|k| !used.contains(&k));
    let after = used.iter().next_back().map_or(1, |h| h + 1);
    let nums: Vec<u16> = if fits(after) {
        (after..after + n as u16).collect()
    } else if let Some(s) = (1..=MAX_CHANNELS).find(|&s| fits(s)) {
        (s..s + n as u16).collect()
    } else {
        free[..n].to_vec()
    };
    out.numbers = ranges(&nums);
    // As the zone table takes a name: printable ASCII, 16 characters.
    let clean = crate::library::clean_zone_name(name.trim());
    if clean.is_empty() {
        out.name_error = "the new zone needs a name".into();
    } else if clean != name.trim() {
        out.name_error = "a zone name is 1 to 16 printable ASCII characters".into();
    } else if table.zones.iter().any(|z| z.name.trim_end().eq_ignore_ascii_case(&clean)) {
        out.name_error = format!("the table has a zone named {clean:?}");
    }
    let index = table.zones.len() as u16;
    if parts == 1 {
        out.zones.push(ZoneView::new(index + 1, &clean));
    } else {
        for k in 0..parts {
            let part = crate::zonecap::part_name(&clean, k + 1);
            if out.name_error.is_empty() && table.zones.iter().any(|z| z.name.trim_end().eq_ignore_ascii_case(&part)) {
                out.name_error = format!("the table has a zone named {part:?}");
            }
            out.zones.push(ZoneView::new(index + 1 + k as u16, &part));
        }
    }
    out.channels = channels
        .iter()
        .zip(&nums)
        .enumerate()
        .map(|(i, (c, &k))| ChanView { number: k, zone: Some(index + (i / ZONE_CAP) as u16), ..c.clone() })
        .collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::parse_tone;

    const FILE: &str = "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,RPT1CALL,RPT2CALL,DVCODE\r\n\
0,Calling,146.520000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,High,,,,,\r\n\
1,North hill,146.940000,-,0.600000,Tone,100.0,88.5,023,NN,023,Tone->Tone,NFM,12.50,,5.0W,Repeaters,,,,\r\n\
2,TSQL rpt,443.475000,+,5.000000,TSQL,88.5,123.0,023,NN,023,Tone->Tone,NFM,12.50,S,Low,,,,,\r\n\
3,\"DCS, inverted\",444.200000,+,5.000000,DTCS,88.5,88.5,023,RN,023,Tone->Tone,NFM,12.50,P,Mid,,,,,\r\n\
4,Cross,145.290000,-,0.600000,Cross,110.9,88.5,023,NR,754,Tone->DTCS,NFM,12.50,,1W,,,,,\r\n\
5,Split,145.800000,split,437.800000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,Low,,,,,\r\n\
6,Listen,162.550000,off,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,25.00,,Low,,,,,\r\n\
7,Broadcast,101.100000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,WFM,100.00,,Low,,,,,\r\n\
8,A very long channel name,146.550000,,0.000000,TSQL-R,88.5,88.5,023,NN,023,Tone->Tone,FM,7.00,,Low,,,,,\r\n";

    /// The stock radio's channel list as other tools save it (made-up rows, the columns of a user's file, Nov 16,
    /// 2026): RX and TX MHz, tones as OFF, CTCSS or D023N/D023I, Bandwidth, Scan, Zone.
    #[test]
    fn stock_list() {
        let file = "Index,Name,RX MHz,TX MHz,Duplex,Offset,RX Tone,TX Tone,Bandwidth,Power,Mode,Encrypt,Scrambler,Busy Lock,Scan,FHSS,FHSS Code,Signal Group,PTT ID,Zone\r\n\
1,Simplex,146.52000,146.52000,,0.000,OFF,OFF,Wide,High,FM,0,0,false,true,false,,0,0,Local\r\n\
2,Rpt minus,146.94000,146.34000,-,0.600,OFF,100.0,Wide,Low,FM,0,0,false,true,false,,0,0,Repeaters\r\n\
3,TSQL,443.47500,448.47500,+,5.000,123.0,123.0,Narrow,Mid,FM,0,0,false,false,false,,0,0,\r\n\
4,DCS inv,152.97500,152.97500,,0.000,D054I,D054N,Wide,High,FM,0,0,false,true,false,,0,0,Nowhere\r\n\
5,Split,145.80000,437.80000,,0,OFF,OFF,Wide,High,FM,0,0,false,true,false,,0,0,\r\n\
7,No TX col,146.08500,,,0,OFF,110.9,Wide,High,FM,0,0,false,true,false,,0,0,\r\n\
8,UHF*1,447.00000,447.00000,,0.000,OFF,OFF,Wide,High,FM,0,0,false,false,false,,0,0,\r\n";
        let i = import(file, &zones()).unwrap();
        assert_eq!((i.channels.len(), i.skipped), (7, 0), "{:?}", i.notes);
        assert_eq!(i.notes, ["line 8: name \"UHF*1\": characters a channel name can't hold became -"]);
        let by = |n: u16| i.channels.iter().find(|c| c.number == n).unwrap();
        let c = by(1);
        assert_eq!((c.rx.as_str(), c.duplex.as_str(), c.tx_tone.as_str(), c.rx_tone.as_str(), c.zone), ("146.52000", "", "off", "off", Some(0)));
        let c = by(2);
        assert_eq!((c.duplex.as_str(), c.offset.as_str(), c.tx_tone.as_str(), c.rx_tone.as_str(), c.power.as_str(), c.zone), ("-", "0.60000", "100.0", "off", "Low", Some(1)));
        let c = by(3);
        assert_eq!((c.duplex.as_str(), c.tx_tone.as_str(), c.rx_tone.as_str(), c.mode.as_str(), c.power.as_str(), c.skip), ("+", "123.0", "123.0", "NFM", "Mid", true));
        let c = by(4);
        assert_eq!((c.tx_tone.as_str(), c.rx_tone.as_str(), c.zone), ("D054N", "D054I", None));
        let c = by(5);
        assert_eq!((c.duplex.as_str(), c.offset.as_str()), ("split", "437.80000"));
        assert_eq!((by(7).duplex.as_str(), by(7).tx_tone.as_str()), ("", "110.9"));
        assert_eq!((by(8).name.as_str(), by(8).skip), ("UHF-1", true));
        // Not a list Console reads: says what it reads.
        assert!(import("Foo,Bar\r\n1,2\r\n", &[]).unwrap_err().contains("RX MHz"));
    }

    fn zones() -> Vec<ZoneView> {
        vec![ZoneView::new(1, "Local"), ZoneView::new(2, "Repeaters")]
    }

    #[test]
    fn imports_chirps_columns() {
        let i = import(FILE, &zones()).unwrap();
        assert_eq!(i.skipped, 0, "{:?}", i.notes); // WFM imports (BCR-33)
        let by = |n: u16| i.channels.iter().find(|c| c.number == n).unwrap();
        // Location 0 is moved up: CHIRP's 0 is channel 1.
        assert_eq!(
            (by(1).name.as_str(), by(1).rx.as_str(), by(1).power.as_str(), by(1).step.as_str()),
            ("Calling", "146.52000", "High", "5 kHz")
        );
        let n = by(2);
        assert_eq!(
            (n.duplex.as_str(), n.offset.as_str(), n.tx_tone.as_str(), n.rx_tone.as_str(), n.power.as_str(), n.zone),
            ("-", "0.60000", "100.0", "off", "High", Some(1))
        );
        let t = by(3);
        assert_eq!((t.tx_tone.as_str(), t.rx_tone.as_str(), t.skip), ("123.0", "123.0", true));
        let d = by(4);
        assert_eq!(
            (d.name.as_str(), d.tx_tone.as_str(), d.rx_tone.as_str(), d.priority, d.power.as_str()),
            ("DCS- inverted", "D023I", "D023N", true, "Mid")
        );
        // CHAN-31: the comma isn't a name character: mapped to '-', with a note
        assert!(i.notes.iter().any(|n| n.contains("DCS, inverted") && n.contains("became -")), "{:?}", i.notes);
        let x = by(5);
        assert_eq!((x.tx_tone.as_str(), x.rx_tone.as_str(), x.power.as_str()), ("110.9", "D754I", "Low"));
        let s = by(6);
        assert_eq!((s.duplex.as_str(), s.offset.as_str()), ("split", "437.80000"));
        assert!(by(7).rx_only);
        let l = by(9);
        assert_eq!((l.name.as_str(), l.rx_tone.as_str(), l.step.as_str()), ("A very long chan", "off", "12.5 kHz"));
        assert!(i.notes.iter().any(|n| n.contains("reverse squelch")));
    }

    /// Export then import gives the same channels (zones by name in Comment, tones in CHIRP's columns).
    #[test]
    fn round_trip() {
        let z = zones();
        let first = import(FILE, &z).unwrap().channels;
        let csv = export(&first, &z);
        assert!(csv.starts_with("Location,Name,Frequency,Duplex"));
        assert!(csv.contains(",DCS- inverted,"));
        let again = import(&csv, &z).unwrap();
        assert!(again.notes.is_empty(), "{:?}", again.notes);
        assert_eq!(again.channels, first);
    }

    /// NAM (narrow AM, ferrite decision 447) is CHIRP's NAM both ways, stored as 7 with the narrow filter; the stock
    /// list's AM with Bandwidth Narrow is NAM too.
    #[test]
    fn nam_round_trip() {
        let z = zones();
        let csv = "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,Mode,TStep,Skip\r\n\
                   1,CYVR TWR,118.700000,,0.000000,,88.5,88.5,023,NN,NAM,8.33,\r\n\
                   2,Guard,121.500000,,0.000000,,88.5,88.5,023,NN,AM,25.00,\r\n";
        let i = import(csv, &z).unwrap();
        assert!(i.notes.is_empty(), "{:?}", i.notes);
        assert_eq!(i.channels.iter().map(|c| c.mode.as_str()).collect::<Vec<_>>(), ["NAM", "AM"]);
        let c = i.channels[0].channel().unwrap();
        assert_eq!((c.cfg.mode, c.cfg.narrow), (ferrite_app::slot::NAM, true));
        let out = export(&i.channels, &z);
        assert!(out.contains(",NAM,8.33,"), "{out}");
        assert!(out.contains(",AM,25.00,"), "{out}");
        assert_eq!(import(&out, &z).unwrap().channels, i.channels);
        let rows = vec![
            ["Index", "Name", "RX MHz", "TX MHz", "Bandwidth", "Mode"].map(String::from).to_vec(),
            ["1", "Tower", "118.700", "118.700", "Narrow", "AM"].map(String::from).to_vec(),
            ["2", "Guard", "121.500", "121.500", "Wide", "AM"].map(String::from).to_vec(),
        ];
        let r = from_stock_list(&rows).unwrap();
        let mode = COLUMNS.iter().position(|c| *c == "Mode").unwrap();
        assert_eq!((r[1][mode].as_str(), r[2][mode].as_str()), ("NAM", "AM"));
    }

    /// Every pair of tone words survives CHIRP's columns.
    #[test]
    fn tone_pairs() {
        let words = ["off", "88.5", "100.0", "D023N", "D023I", "D754N"];
        for tx in words {
            for rx in words {
                let (t, r) = (parse_tone(tx).unwrap(), parse_tone(rx).unwrap());
                let c = tone_columns(t, r);
                let mut v = ChanView::new(1, 14_652_000);
                v.tx_tone = tx.into();
                v.rx_tone = rx.into();
                let csv = export(&[v.clone()], &[]);
                let back = import(&csv, &[]).unwrap();
                assert_eq!((back.channels[0].tx_tone.as_str(), back.channels[0].rx_tone.as_str()), (tx, rx), "{c:?}");
            }
        }
        assert_eq!(tone_columns(885, 885)[0], "TSQL");
        assert_eq!(tone_columns(1000, 0)[0], "Tone");
        assert_eq!(
            tone_columns(DCS_FLAG | 0o23, DCS_FLAG | DCS_INV | 0o23)[..5],
            ["DTCS", "88.5", "88.5", "023", "NR"]
        );
        assert_eq!(tone_columns(0, 1000)[6], "->Tone");
    }

    #[test]
    fn csv_fields() {
        let rows = parse_csv("a,\"b,c\",\"say \"\"hi\"\"\"\r\n\r\n1,2,3");
        assert_eq!(rows, vec![vec!["a", "b,c", "say \"hi\""], vec!["1", "2", "3"]]);
        assert!(import("Name,Other\r\nx,y", &[]).is_err());
    }

    const RADIO: &str = include_str!("../../tests/e2e/fixtures/chirp-radio-export.csv");
    const REPEATERBOOK: &str = include_str!("../../tests/e2e/fixtures/repeaterbook-bc.csv");

    /// A CHIRP "Export to CSV" from a radio (tests/e2e/fixtures/chirp-radio-export.csv): Location from 0, every
    /// column, power in watts; the DV row skipped with its note (WFM imports: BCR-33).
    #[test]
    fn chirp_radio_export() {
        let i = import(RADIO, &zones()).unwrap();
        assert_eq!((i.channels.len(), i.skipped), (11, 1), "{:?}", i.notes);
        assert_eq!(i.notes.len(), 1);
        assert!(i.notes[0].starts_with("line 11: mode DV") && i.notes[0].ends_with("skipped"), "{:?}", i.notes);
        let nums: Vec<u16> = i.channels.iter().map(|c| c.number).collect();
        assert_eq!(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12]);
        assert_eq!(i.channels.iter().find(|c| c.number == 9).unwrap().mode, "WFM");
        let by = |n: &str| i.channels.iter().find(|c| c.name == n).unwrap();
        let t =
            |c: &ChanView| (c.duplex.clone(), c.offset.clone(), c.tx_tone.clone(), c.rx_tone.clone(), c.mode.clone());
        let s = |a: &str, b: &str, c: &str, d: &str, e: &str| (a.into(), b.into(), c.into(), d.into(), e.into());
        assert_eq!(t(by("CALL 2M")), s("", "", "off", "off", "FM"));
        assert_eq!(t(by("NSHORE")), s("-", "0.60000", "127.3", "off", "FM"));
        assert_eq!(t(by("BURNABY")), s("+", "0.60000", "100.0", "100.0", "FM"));
        assert_eq!(t(by("DCS RPT")), s("+", "5.00000", "D023N", "D023N", "FM"));
        assert_eq!(t(by("DCS REV")), s("+", "5.00000", "D754I", "D754N", "NFM"));
        assert_eq!(t(by("SAT UP")), s("split", "437.80000", "off", "off", "FM"));
        assert!(by("WX VAN").rx_only && by("WX VAN").skip);
        assert!(by("SURREY").skip && by("SAT UP").skip && !by("NSHORE").skip);
        let p: Vec<&str> = ["CALL 2M", "SURREY", "WX VAN"].iter().map(|n| by(n).power.as_str()).collect();
        assert_eq!(p, ["High", "Low", "Low"]); // 5.0W, 1.0W, 0.5W
        assert!(i.channels.iter().all(|c| c.zone.is_none()));
    }

    /// RepeaterBook's CHIRP download (tests/e2e/fixtures/repeaterbook-bc.csv: invented southern BC repeaters,
    /// fictional callsigns): Location from 1, a city in Comment that names no zone.
    #[test]
    fn repeaterbook_export() {
        let i = import(REPEATERBOOK, &zones()).unwrap();
        assert_eq!((i.channels.len(), i.skipped, i.notes.len()), (12, 0, 0), "{:?}", i.notes);
        assert_eq!(i.channels.iter().map(|c| c.number).collect::<Vec<_>>(), (1..=12).collect::<Vec<u16>>());
        let c = &i.channels;
        assert_eq!(
            (c[0].name.as_str(), c[0].rx.as_str(), c[0].duplex.as_str(), c[0].tx_tone.as_str()),
            ("Vancouver", "146.94000", "-", "127.3")
        );
        assert_eq!((c[3].tx_tone.as_str(), c[3].rx_tone.as_str()), ("156.7", "156.7")); // TSQL
        assert_eq!((c[8].tx_tone.as_str(), c[8].rx_tone.as_str()), ("D047N", "D047N")); // DTCS
        assert_eq!((c[7].offset.as_str(), c[7].duplex.as_str()), ("5.00000", "+"));
        assert_eq!(c.iter().filter(|c| c.rx.starts_with("14")).count(), 7);
        assert!(c.iter().all(|c| c.power == "High" && c.mode == "FM" && c.zone.is_none()));
    }

    /// A RepeaterBook export with the sites' coordinates (tests/e2e/fixtures/repeaterbook-latlon.csv, fictional):
    /// Latitude and Longitude are the channels' positions (LINK-53), rounded to the radio's 1e-7 degree; a row
    /// without them has none. "Lat" and "Long" headers work too; CHIRP's export writes none.
    #[test]
    fn repeaterbook_positions() {
        let i = import(include_str!("../../tests/e2e/fixtures/repeaterbook-latlon.csv"), &[]).unwrap();
        assert_eq!((i.channels.len(), i.notes.len()), (3, 0), "{:?}", i.notes);
        assert_eq!(i.channels[0].pos, Some(Position { lat: 454_215_296, lon: -756_971_931 }));
        assert_eq!(i.channels[1].pos, Some(Position { lat: 453_088_000, lon: -758_987_000 }));
        assert_eq!(i.channels[2].pos, None);
        let short = "Location,Name,Frequency,Lat,Long\r\n1,A,146.52,49.2827,-123.1207\r\n2,B,146.55,91,0\r\n";
        let s = import(short, &[]).unwrap();
        assert_eq!(s.channels[0].pos, Position::from_degrees(49.2827, -123.1207));
        assert_eq!(s.channels[1].pos, None);
        assert!(s.notes[0].contains("not on the map"), "{:?}", s.notes);
        // Export leaves them out (CHIRP has no column), so its own round trip has none.
        let csv = export(&i.channels, &[]);
        assert!(!csv.contains("45.42") && import(&csv, &[]).unwrap().channels.iter().all(|c| c.pos.is_none()));
    }

    fn table(numbers: impl IntoIterator<Item = u16>, zones: &[&str]) -> Set {
        Set {
            zones: zones.iter().enumerate().map(|(i, z)| ZoneView::new(i as u16 + 1, z)).collect(),
            channels: numbers.into_iter().map(|n| ChanView::new(n, 14_652_000)).collect(),
        }
    }

    /// Into a new zone: after the highest number, keeping the file's order; a Comment's zone ignored.
    /// CHAN-35: a list longer than a zone holds goes into new zones of 256, named 1, 2, ...
    #[test]
    fn long_list_split_over_zones() {
        let chans: Vec<ChanView> = (1..=600u16).map(|n| ChanView::new(n, 44_000_000 + n as u32 * 1250)).collect();
        let t = table([1, 2], &["Local"]);
        let z = into_new_zone(&chans, &t, "Repeaters");
        assert_eq!((z.room.as_str(), z.name_error.as_str()), ("", ""));
        let names: Vec<(u16, &str)> = z.zones.iter().map(|z| (z.number, z.name.as_str())).collect();
        assert_eq!(names, [(2, "Repeaters 1"), (3, "Repeaters 2"), (4, "Repeaters 3")]);
        let per = |k: u16| z.channels.iter().filter(|c| c.zone == Some(k)).count();
        assert_eq!((per(1), per(2), per(3)), (256, 256, 88));
        assert_eq!(z.channels[0].number, 3, "after the table's highest");
        let t = table([1], &["Local", "Repeaters 2"]);
        assert!(into_new_zone(&chans, &t, "Repeaters").name_error.contains("Repeaters 2"));
        let full: Vec<String> = (1..=510).map(|k| format!("Z{k}")).collect();
        let t = table([1], &full.iter().map(|s| s.as_str()).collect::<Vec<_>>());
        assert!(into_new_zone(&chans, &t, "x").room.contains("need 3 zones"), "{}", into_new_zone(&chans, &t, "x").room);
    }

    #[test]
    fn new_zone_numbers() {
        let i = import(FILE, &zones()).unwrap();
        assert!(i.channels.iter().any(|c| c.zone == Some(1))); // "Repeaters" by Comment
        let t = table([1, 2, 3, 500], &["Local", "Repeaters"]);
        let z = into_new_zone(&i.channels, &t, "My file");
        assert_eq!((z.room.as_str(), z.name_error.as_str(), z.numbers.as_str()), ("", "", "501-509"));
        assert_eq!(z.zones.iter().map(|z| (z.number, z.name.as_str())).collect::<Vec<_>>(), [(3, "My file")]);
        assert!(z.channels.iter().all(|c| c.zone == Some(2)));
        let names: Vec<&str> = z.channels.iter().map(|c| c.name.as_str()).collect();
        let want: Vec<&str> = i.channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, want);
        for c in &z.channels {
            assert_eq!(crate::plan::check_channel(c, 3), None);
        }
        // No room after 3995: the first free run that holds 9.
        let t = table((1..=5).chain([3995]), &[]);
        assert_eq!(into_new_zone(&i.channels, &t, "x").numbers, "6-14");
        // No run of 9: the free numbers from 1.
        let t = table((1..=4000).filter(|n| n % 4 != 0), &[]);
        assert_eq!(into_new_zone(&i.channels, &t, "x").numbers, "4, 8, 12, 16, 20, 24, 28, 32, 36");
        // Too few free numbers, or no zone left: the option is off.
        let t = table(1..=3995, &[]);
        assert_eq!(into_new_zone(&i.channels, &t, "x").room, "9 channels, but only 5 channel numbers are free");
        let full: Vec<String> = (1..=512).map(|k| format!("Z{k}")).collect();
        let t = table([1], &full.iter().map(|s| s.as_str()).collect::<Vec<_>>());
        assert!(into_new_zone(&i.channels, &t, "x").room.contains("512 zones"));
        // The name: needed, printable, 16 characters, not one the table has.
        let t = table([1], &["Local"]);
        assert_eq!(into_new_zone(&i.channels, &t, " ").name_error, "the new zone needs a name");
        assert!(!into_new_zone(&i.channels, &t, "local").name_error.is_empty());
        assert!(!into_new_zone(&i.channels, &t, "Seventeen chars!!").name_error.is_empty());
        assert!(into_new_zone(&i.channels, &t, "Exactly 16 chars").name_error.is_empty());
    }

    #[test]
    fn new_zone_names() {
        let z = [ZoneView::new(1, "Repeaters"), ZoneView::new(2, "Repeaters 2")];
        assert_eq!(zone_name_for("repeaterbook_bc.csv", &[]), "repeaterbook bc");
        assert_eq!(zone_name_for("C:\\Users\\me\\repeaters.csv", &z), "repeaters 3");
        assert_eq!(zone_name_for("RepeaterBook BC.csv", &[ZoneView::new(1, "RepeaterBook BC")]), "RepeaterBook B 2");
        assert_eq!(zone_name_for("A much longer file name.csv", &[]), "A much longer fi");
        assert_eq!(zone_name_for("A much longer fi.csv", &[ZoneView::new(1, "A much longer fi")]), "A much longer 2");
        assert_eq!(zone_name_for("Café, BC.csv", &[]), "Caf-- BC");
        assert_eq!(zone_name_for(".csv", &[]), "Import");
        assert_eq!(ranges(&[1, 2, 3, 7, 9, 10]), "1-3, 7, 9-10");
    }

    // ---- issue #85: what a round trip used to lose, from channel records (not re-imported files) ----

    fn chan(number: u16, rx: &str) -> ChanView {
        ChanView::new(number, parse_mhz(rx).unwrap())
    }

    /// Export, then import into the same zones.
    fn trip(chans: &[ChanView], z: &[ZoneView]) -> Import {
        import(&export(chans, z), z).unwrap()
    }

    /// Issue #85 item 1: an RX-only channel keeps its shift (+ and -) and its split: Duplex `off` with the TX
    /// frequency in Offset, which CHIRP's own `off` (TX disabled) leaves alone. A CHIRP file's `off` with a shift
    /// left in Offset (0.6) keeps it as a + shift.
    #[test]
    fn issue85_rx_only_keeps_shift() {
        let mut a = chan(1, "146.94").with_shift("-0.6").unwrap();
        let mut b = chan(2, "443.5").with_shift("+5").unwrap();
        let mut c = chan(3, "222.00125").with_tx("146.34").unwrap();
        let mut d = chan(4, "162.55");
        for v in [&mut a, &mut b, &mut c, &mut d] {
            v.rx_only = true;
        }
        let csv = export(&[a.clone(), b.clone(), c.clone(), d.clone()], &[]);
        assert!(csv.contains(",146.940000,off,146.340000,"), "{csv}");
        assert!(csv.contains(",162.550000,off,0.000000,"), "{csv}");
        let got = import(&csv, &[]).unwrap();
        assert!(got.notes.is_empty(), "{:?}", got.notes);
        assert_eq!(got.channels, [a, b, c, d]);
        let f = "Location,Name,Frequency,Duplex,Offset\r\n1,Leftover,146.940000,off,0.600000\r\n";
        let l = &import(f, &[]).unwrap().channels[0];
        assert_eq!((l.rx_only, l.duplex.as_str(), l.offset.as_str()), (true, "+", "0.60000"));
    }

    /// Issue #85 item 2 (TONE-15's 60.0-260.0 Hz): "88.50" and "88.500000" are 88.5; a tone the mode uses that
    /// isn't one (123.45, 300.0, a DCS code 999) is a note, not silently none.
    #[test]
    fn issue85_tone_formats() {
        assert_eq!(parse_tone("88.50"), Ok(885));
        assert_eq!(parse_tone("88.500000"), Ok(885));
        assert_eq!(parse_tone("100"), Ok(1000));
        assert_eq!(parse_tone("88.5 Hz"), Ok(885));
        assert!(parse_tone("123.45").is_err());
        let f = "Location,Name,Frequency,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode\r\n\
                 1,A,146.940000,Tone,88.50,88.5,023,NN,023,Tone->Tone\r\n\
                 2,B,146.940000,TSQL,88.5,123.45,023,NN,023,Tone->Tone\r\n\
                 3,C,146.940000,Cross,300.0,88.5,023,NN,999,Tone->DTCS\r\n\
                 4,D,146.940000,,300.0,123.45,999,NN,999,Tone->Tone\r\n";
        let i = import(f, &[]).unwrap();
        let tones: Vec<(&str, &str)> = i.channels.iter().map(|c| (c.tx_tone.as_str(), c.rx_tone.as_str())).collect();
        assert_eq!(tones, [("88.5", "off"), ("off", "off"), ("off", "off"), ("off", "off")]);
        let has = |line: u32, what: &str| i.notes.iter().any(|n| n.starts_with(&format!("line {line}:")) && n.contains(what));
        assert!(has(3, "cToneFreq \"123.45\""), "{:?}", i.notes);
        assert!(has(4, "rToneFreq \"300.0\"") && has(4, "RxDtcsCode \"999\""), "{:?}", i.notes);
        assert!(!i.notes.iter().any(|n| n.starts_with("line 5:")), "unused columns aren't checked: {:?}", i.notes);
    }

    /// Issue #85 item 3: a signed Offset is the direction when Duplex is blank or agrees; one that disagrees keeps
    /// Duplex with a note; a negative split is a note. Never silently simplex.
    #[test]
    fn issue85_signed_offset() {
        let f = "Location,Name,Frequency,Duplex,Offset\r\n\
                 1,A,146.940000,,-0.600000\r\n\
                 2,B,146.940000,-,-0.600000\r\n\
                 3,C,443.500000,,+5.000000\r\n\
                 4,D,146.940000,+,-0.600000\r\n\
                 5,E,146.940000,split,-146.340000\r\n\
                 6,F,146.940000,-,0.6 MHz\r\n";
        let i = import(f, &[]).unwrap();
        let d: Vec<(&str, &str)> = i.channels.iter().map(|c| (c.duplex.as_str(), c.offset.as_str())).collect();
        assert_eq!(d, [("-", "0.60000"), ("-", "0.60000"), ("+", "5.00000"), ("+", "0.60000"), ("", ""), ("", "")]);
        assert_eq!(i.notes.len(), 3, "{:?}", i.notes);
        assert!(i.notes[0].starts_with("line 5:") && i.notes[0].contains("taken as +"), "{:?}", i.notes);
        assert!(i.notes[1].starts_with("line 6:") && i.notes[2].starts_with("line 7:"), "{:?}", i.notes);
    }

    /// Issue #85 item 4: CHIRP's one Skip column keeps S for a channel both skipped and priority, and the export
    /// says which lost priority; P alone and S alone come back as they were.
    #[test]
    fn issue85_skip_and_priority() {
        let mut a = chan(1, "146.52");
        (a.skip, a.priority) = (true, true);
        let mut b = chan(2, "146.52");
        b.priority = true;
        let mut c = chan(3, "146.52");
        c.skip = true;
        let e = export_report(&[a.clone(), b.clone(), c.clone()], &[]);
        assert_eq!(e.lost_priority, [1]);
        assert_eq!(e.notes, ["1 channel lost priority (CHIRP has one Skip column: written as S): 1"]);
        let got = import(&e.text, &[]).unwrap().channels;
        assert_eq!(got, [ChanView { priority: false, ..a }, b, c]);
    }

    /// Issue #85 item 5: zones named apart only by case stay apart (the exact name first, then any case).
    #[test]
    fn issue85_zone_case() {
        let z = vec![ZoneView::new(1, "Local"), ZoneView::new(2, "LOCAL"), ZoneView::new(3, "Hills")];
        let mut a = chan(1, "146.52");
        a.zone = Some(0);
        let mut b = chan(2, "146.52");
        b.zone = Some(1);
        let mut c = chan(3, "146.52");
        c.zone = Some(2);
        let got = trip(&[a.clone(), b.clone(), c.clone()], &z);
        assert_eq!(got.channels, [a, b, c]);
        let f = "Location,Name,Frequency,Comment\r\n1,A,146.520000,hills\r\n";
        assert_eq!(import(f, &z).unwrap().channels[0].zone, Some(2));
    }

    /// Issue #85 item 6 (CHAN-31: space is a name character): a name's leading spaces are kept both ways (quoted
    /// on export; CHIRP's reader keeps them too); trailing ones go, as `ChanView::channel` drops them.
    #[test]
    fn issue85_name_spaces() {
        let mut a = chan(1, "146.52");
        a.name = "  Indent".into();
        let mut b = chan(2, "146.52");
        b.name = " A B".into();
        let csv = export(&[a.clone(), b.clone()], &[]);
        assert!(csv.contains(",\"  Indent\","), "{csv}");
        assert_eq!(import(&csv, &[]).unwrap().channels, [a, b]);
        let f = "Location,Name,Frequency\r\n1, Lead ,146.520000\r\n";
        assert_eq!(import(f, &[]).unwrap().channels[0].name, " Lead");
    }

    /// Issue #85 item 7: a channel the radio can't hold (here a name with a character outside CHAN-31's set) is
    /// left out of the export and said so, by number.
    #[test]
    fn issue85_left_out_said() {
        let a = chan(1, "146.52");
        let mut b = chan(5, "146.52");
        b.name = "Bad@name".into();
        let mut c = chan(6, "146.52");
        c.rx = "not MHz".into();
        let e = export_report(&[a, b, c], &[]);
        assert_eq!((e.channels, e.left_out.as_slice()), (1, &[5u16, 6][..]));
        assert!(e.notes[0].starts_with("2 channels left out") && e.notes[0].ends_with(": 5-6"), "{:?}", e.notes);
        assert_eq!(e.text.lines().count(), 2);
    }
}
