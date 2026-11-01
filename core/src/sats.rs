//! Satellites for satellite mode (manual chapter 28a; SAT-2, SAT-3, SAT-13, SAT-15, SAT-18, SAT-21; LINK-63 – LINK-65):
//! data.ferritefw.dev's `satellites/sats.json` (format `satellites-1`, the data repo's README) into the radio's
//! records, what the radio holds back into rows, the info record, the clock, and whether a connect should refresh
//! the radio's satellites by itself.
//!
//! - [`parse`]: the file into the satellites an FM handheld can work, each with its record (`ferrite_core::sat::wire`).
//!   A transmitter is kept when it is FM or APRS and every frequency it names is inside 144-148 or 430-440 MHz
//!   (SAT-13: the radio refuses any other); a satellite with none isn't offered. Up to five transmitters each.
//! - [`held`]: a record the radio gave back (`READ_MANY` of `what::SAT`) as a row.
//! - [`refresh`]: SAT-21's rewrite: the radio's own satellites again, by NORAD number and in its order, with the
//!   file's elements and transponders (one no longer in the file is written back as it was).
//! - [`sync_due`]: SAT-21's rule.

use ferrite_core::sat::wire::{self, Info, REC_LEN};
use ferrite_core::sat::{Elements, Kind, Sat, Status, Transponder, F32, TPS, Y2000};
use serde::{Deserialize, Serialize};

/// The format this Console reads.
pub const FORMAT: &str = "satellites-1";
/// The most satellites a radio keeps (SAT-2).
pub const MAX: usize = ferrite_core::link::SATS_MAX as usize;
/// SAT-21: at most one rewrite a day.
pub const SYNC_GAP_S: u32 = 86_400;
/// The ISS's catalogue number (its elements age faster: SAT-9).
pub const ISS: u32 = 25_544;

/// `sats.json` as published.
#[derive(Clone, Debug, Deserialize)]
pub struct File {
    pub format: String,
    pub built: String,
    #[serde(default)]
    pub licence: String,
    #[serde(default)]
    pub attribution: String,
    #[serde(default)]
    pub satellites: Vec<Entry>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Entry {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub short: Option<String>,
    #[serde(default)]
    pub status: String,
    pub elements: Omm,
    #[serde(default)]
    pub transmitters: Vec<Tx>,
}

/// CelesTrak's OMM numbers, as the file gives them.
#[derive(Clone, Debug, Deserialize)]
pub struct Omm {
    pub epoch: String,
    pub n: f64,
    pub e: f64,
    pub i: f64,
    pub raan: f64,
    pub w: f64,
    pub m: f64,
    pub bstar: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Tx {
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub up: Option<Vec<u64>>,
    #[serde(default)]
    pub down: Option<Vec<u64>>,
    #[serde(default)]
    pub tone: Option<String>,
    #[serde(default)]
    pub arm_tone: Option<String>,
}

/// A transponder as Console's list shows it: Hz, tones as text ("" none).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TpRow {
    pub desc: String,
    pub kind: &'static str,
    pub up: u64,
    pub down: u64,
    pub tone: String,
    pub arm: String,
}

/// A satellite as Console's lists show it (the file's or the radio's), with its record for the radio.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Row {
    pub id: u32,
    /// The file's full name (the radio's 16-character name for one the radio holds).
    pub name: String,
    /// The name on the radio.
    pub short: String,
    pub status: &'static str,
    /// The elements' epoch, UTC seconds since 1970.
    pub epoch: u32,
    pub tps: Vec<TpRow>,
    /// Transmitters in the file the radio can't use (outside 2 m and 70 cm, not FM, past five).
    pub dropped: usize,
    pub record: Vec<u8>,
}

/// The file read: when it was built (UTC seconds of its `built` date), its credits, and the workable satellites.
#[derive(Clone, Debug, Serialize)]
pub struct Parsed {
    pub built: u32,
    pub built_text: String,
    pub licence: String,
    pub attribution: String,
    pub sats: Vec<Row>,
    /// Satellites in the file with nothing the radio can use.
    pub skipped: Vec<String>,
}

/// Days from 1970-01-01 to a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2026-10-31T19:53:55.491936" (or a bare "2026-11-01", or with a trailing Z) as UTC seconds since 1970 and the
/// milliseconds (cut, not rounded, as the radio reads an OMM line: `ferrite_core::sat::tle::parse_csv`).
pub fn parse_iso(s: &str) -> Option<(i64, u16)> {
    let s = s.trim().trim_end_matches('Z');
    let (date, time) = s.split_once(['T', ' ']).unwrap_or((s, "00:00:00"));
    let mut d = date.split('-');
    let (y, mo, da): (i64, u32, u32) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next().unwrap_or("0").parse().ok()?;
    let sec = t.next().unwrap_or("0");
    let (whole, frac) = sec.split_once('.').unwrap_or((sec, ""));
    let whole: i64 = whole.parse().ok()?;
    let ms = format!("{:0<3}", &frac[..frac.len().min(3)]);
    let ms: u16 = if frac.is_empty() { 0 } else { ms.parse().ok()? };
    Some((days_from_civil(y, mo, da) * 86_400 + h * 3_600 + mi * 60 + whole, ms))
}

/// A value times `scale` to the nearest integer, half away from zero.
fn scaled(v: f64, scale: f64) -> Option<u32> {
    let r = (v * scale).round();
    (0.0..=u32::MAX as f64).contains(&r).then_some(r as u32)
}

/// SAT-3: the OMM numbers as the record's integers (angles 1e-7 degree, eccentricity 1e-7, mean motion 1e-8 rev a
/// day, B* as f32), the epoch as seconds since 2000 and its milliseconds.
pub fn elements(o: &Omm) -> Option<Elements> {
    let (unix, ms) = parse_iso(&o.epoch)?;
    let epoch = u32::try_from(unix - Y2000 as i64).ok()?;
    let el = Elements {
        epoch,
        epoch_ms: ms,
        incl: scaled(o.i, 1e7)?,
        raan: scaled(o.raan, 1e7)?,
        argp: scaled(o.w, 1e7)?,
        ma: scaled(o.m, 1e7)?,
        ecc: scaled(o.e, 1e7)?,
        n: scaled(o.n, 1e8)?,
        bstar: F32::new(o.bstar as f32),
    };
    (el.n != 0 && el.ecc < 10_000_000 && el.incl <= 1_800_000_000).then_some(el)
}

/// A tone in Hz as text ("67.0") as 0.1 Hz; None for one the radio can't send.
fn tone(t: &Option<String>) -> Option<u16> {
    match t.as_deref().map(str::trim) {
        None | Some("") => Some(0),
        Some(s) => {
            let v: f64 = s.parse().ok()?;
            let v = (v * 10.0).round();
            (600.0..=2_541.0).contains(&v).then_some(v as u16)
        }
    }
}

/// Hz as the record's 10 Hz.
fn f10(hz: u64) -> u32 {
    ((hz + 5) / 10).min(u32::MAX as u64) as u32
}

/// A transmitter the radio can work (SAT-13), as its transponder; None for one it can't.
fn transponder(t: &Tx) -> Option<Transponder> {
    let first = |v: &Option<Vec<u64>>| v.as_ref().and_then(|v| v.first().copied()).filter(|&f| f > 0);
    let down = first(&t.down)?;
    let up = first(&t.up);
    let kind = match (t.mode.as_str(), up) {
        ("APRS", _) => Kind::Aprs,
        ("FM", Some(_)) => Kind::Voice,
        ("FM", None) => Kind::Beacon,
        _ => return None,
    };
    let tp =
        Transponder { up: up.map_or(0, f10), down: f10(down), tone: tone(&t.tone)?, arm: tone(&t.arm_tone)?, kind };
    // every frequency the transmitter names (a range's both ends) inside the bands
    let ok = |v: &Option<Vec<u64>>| v.iter().flatten().all(|&f| Transponder { up: 0, down: f10(f), ..tp }.in_band());
    (tp.in_band() && ok(&t.up) && ok(&t.down)).then_some(tp)
}

fn status(s: &str) -> Status {
    match s {
        "active" => Status::Active,
        "inactive" => Status::Inactive,
        _ => Status::Unknown,
    }
}

fn status_name(s: Status) -> &'static str {
    match s {
        Status::Active => "active",
        Status::Inactive => "inactive",
        Status::Unknown => "unknown",
    }
}

/// The name on the radio: `short` when it fits 16 printable characters, else the name, cut to 16.
fn radio_name(e: &Entry) -> [u8; 16] {
    let pick = e.short.as_deref().filter(|s| !s.trim().is_empty() && s.len() <= 16).unwrap_or(&e.name);
    let mut name = [0u8; 16];
    let mut n = 0;
    for c in pick.trim().chars() {
        if n == 16 {
            break;
        }
        name[n] = if (' '..='~').contains(&c) { c as u8 } else { b'?' };
        n += 1;
    }
    if n == 0 {
        name[..3].copy_from_slice(b"SAT");
    }
    name
}

fn tp_row(t: &Transponder, desc: String) -> TpRow {
    let tenth = |v: u16| if v == 0 { String::new() } else { format!("{}.{}", v / 10, v % 10) };
    TpRow {
        desc,
        kind: t.kind.name(),
        up: t.up as u64 * 10,
        down: t.down as u64 * 10,
        tone: tenth(t.tone),
        arm: tenth(t.arm),
    }
}

/// One file entry as the radio's satellite (flags 0: Doppler both sides, full duplex, SAT-8, SAT-11), with the
/// transmitters it couldn't use counted; None when nothing is workable or the elements don't read.
pub fn sat_of(e: &Entry) -> Option<(Sat, Vec<String>, usize)> {
    let el = elements(&e.elements)?;
    let mut tps = [Transponder::default(); TPS];
    let mut descs = Vec::new();
    let mut ntp = 0;
    for t in &e.transmitters {
        if ntp == TPS {
            break;
        }
        if let Some(tp) = transponder(t) {
            tps[ntp] = tp;
            descs.push(t.desc.clone());
            ntp += 1;
        }
    }
    if ntp == 0 {
        return None;
    }
    let sat = Sat { id: e.id, name: radio_name(e), status: status(&e.status), el, tps, ntp: ntp as u8, flags: 0 };
    Some((sat, descs, e.transmitters.len() - ntp))
}

fn row(s: &Sat, name: String, descs: &[String], dropped: usize) -> Row {
    Row {
        id: s.id,
        name,
        short: String::from_utf8_lossy(s.name()).into_owned(),
        status: status_name(s.status),
        epoch: s.el.epoch_unix(),
        tps: s.tps[..s.ntp as usize]
            .iter()
            .enumerate()
            .map(|(k, t)| tp_row(t, descs.get(k).cloned().unwrap_or_default()))
            .collect(),
        dropped,
        record: wire::encode(s).to_vec(),
    }
}

/// `sats.json` into the satellites the radio can work, in the file's order (by NORAD number).
pub fn parse(json: &str) -> Result<Parsed, String> {
    let f: File = serde_json::from_str(json).map_err(|e| format!("The satellite file didn't read: {e}"))?;
    if f.format != FORMAT {
        return Err(format!(
            "The satellite file is format {}, newer than this Console reads; update Console",
            f.format
        ));
    }
    let built =
        parse_iso(&f.built).and_then(|(t, _)| u32::try_from(t).ok()).ok_or("The satellite file has no build date")?;
    let mut sats = Vec::new();
    let mut skipped = Vec::new();
    for e in &f.satellites {
        match sat_of(e) {
            Some((s, descs, dropped)) => {
                debug_assert!(wire::decode(&wire::encode(&s)).is_ok());
                sats.push(row(&s, e.name.clone(), &descs, dropped));
            }
            None => skipped.push(e.name.clone()),
        }
    }
    Ok(Parsed { built, built_text: f.built, licence: f.licence, attribution: f.attribution, sats, skipped })
}

/// A record the radio gave back, as a row (its name the radio's); None for one that doesn't read.
pub fn held(rec: &[u8]) -> Option<Row> {
    let s = wire::decode(rec).ok()?;
    let name = String::from_utf8_lossy(s.name()).into_owned();
    Some(row(&s, name, &[], 0))
}

/// SAT-21's rewrite: the satellites the radio holds (its records, in its order), each again from the file by NORAD
/// number with fresh elements and transponders, its starting flags kept; one the file no longer has (or can't be
/// worked any more) goes back as it was. Records that don't read are left out.
pub fn refresh(json: &str, held: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, String> {
    let f: File = serde_json::from_str(json).map_err(|e| format!("The satellite file didn't read: {e}"))?;
    let mut out = Vec::new();
    for rec in held {
        let Ok(old) = wire::decode(rec) else { continue };
        let fresh = f.satellites.iter().find(|e| e.id == old.id).and_then(sat_of);
        out.push(match fresh {
            Some((mut s, _, _)) => {
                s.flags = old.flags;
                wire::encode(&s).to_vec()
            }
            None => rec.to_vec(),
        });
    }
    Ok(out)
}

/// The info record (LINK-64): the declination (0.1°, east positive), the file's build time and when Console wrote.
pub fn info_record(decl: Option<i16>, stamp: u32, written: u32) -> Vec<u8> {
    Info { decl, stamp, written }.encode().to_vec()
}

/// The info record read back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InfoRow {
    pub decl: Option<i16>,
    pub stamp: u32,
    pub written: u32,
}

pub fn info_of(rec: &[u8]) -> Option<InfoRow> {
    Info::decode(rec).ok().map(|i| InfoRow { decl: i.decl, stamp: i.stamp, written: i.written })
}

/// SAT-21: whether a connect rewrites the radio's satellites by itself: the radio holds some (the user picks first),
/// the file was built after the data the radio holds, and Console last wrote them more than a day ago (at most one
/// rewrite a day; a radio with no info record counts as never written).
pub fn sync_due(built: u32, held: usize, info: Option<InfoRow>, now: u32) -> bool {
    let (stamp, written) = info.map_or((0, 0), |i| (i.stamp, i.written));
    held > 0 && built > stamp && now.saturating_sub(written) > SYNC_GAP_S
}

/// LINK-65: `CLOCK`'s answer after the status: the radio's UTC (0 none) and where it came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Clock {
    pub now: u32,
    pub source: &'static str,
}

pub fn clock_of(rest: &[u8]) -> Option<Clock> {
    if rest.len() < 5 {
        return None;
    }
    let now = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]);
    let source = match rest[4] {
        1 => "GPS",
        2 => "set",
        _ => "none",
    };
    Some(Clock { now, source })
}

/// The record length (for the callers' checks).
pub const RECORD_LEN: usize = REC_LEN;

#[cfg(test)]
mod tests {
    use super::*;

    const SO50: &str = r#"{"id":27607,"name":"SAUDISAT 1C (SO-50)","short":"SO-50","status":"active",
 "tle":["1 27607U 02058C   26304.82911449  .00000904  00000+0  12403-3 0  9995","2 27607  64.5527  66.1378 0068979 237.1936 122.2515 14.83296838284727"],
 "elements":{"epoch":"2026-10-31T19:53:55.491936","n":14.83296838,"e":0.00689796,"i":64.5527,"raan":66.1378,"w":237.1936,"m":122.2515,"bstar":0.00012402588,"ndot":9.04e-06,"nddot":0,"rev":28472},
 "transmitters":[{"desc":"Mode V/U FM Voice CTCSS 67.0 Hz","mode":"FM","up":[145850000,145850000],"down":[436795000,436795000],"tone":"67.0","invert":false,"arm_tone":"74.4"},
   {"desc":"10 m beacon","mode":"FM","up":null,"down":[29400000,29400000],"tone":null,"invert":false},
   {"desc":"Telemetry","mode":"FM","down":[437000000,437000000],"tone":null,"invert":false},
   {"desc":"SSB","mode":"USB","up":[145900000,145950000],"down":[435800000,435850000],"tone":null,"invert":true}]}"#;

    fn file(sats: &[&str], built: &str) -> String {
        format!(
            r#"{{"format":"satellites-1","built":"{built}","licence":"CC BY-SA 4.0","attribution":"x","newest_epoch":"","oldest_epoch":"","satellites":[{}]}}"#,
            sats.join(",")
        )
    }

    /// SAT-2, SAT-3, SAT-10, SAT-13, LINK-63: a sats.json entry into the radio's record: elements exactly, the
    /// epoch to the millisecond, the tones, the kinds, only the transmitters inside 2 m and 70 cm.
    #[test]
    fn a_record_from_the_file() {
        let e: Entry = serde_json::from_str(SO50).unwrap();
        let (s, descs, dropped) = sat_of(&e).unwrap();
        assert_eq!(s.name(), b"SO-50");
        assert_eq!(
            (s.el.incl, s.el.raan, s.el.argp, s.el.ma),
            (645_527_000, 661_378_000, 2_371_936_000, 1_222_515_000)
        );
        assert_eq!(s.el.ecc, 68_980, "0.00689796 rounds half away from zero");
        assert_eq!(s.el.n, 1_483_296_838);
        assert!((s.el.bstar.get() - 1.2402588e-4).abs() < 1e-10);
        // the TLE's epoch day 26304.82911449 is the same second; the milliseconds cut as the radio's own reader does
        let t = ferrite_core::sat::tle::parse(e_tle(SO50, 0).as_bytes(), e_tle(SO50, 1).as_bytes()).unwrap();
        assert_eq!((s.el.epoch, s.el.epoch_ms), (t.epoch, 491));
        assert_eq!(s.ntp, 2, "the 10 m beacon and the SSB transponder dropped");
        assert_eq!(dropped, 2);
        assert_eq!(s.tps[0], Transponder { up: 14_585_000, down: 43_679_500, tone: 670, arm: 744, kind: Kind::Voice });
        assert_eq!(s.tps[1], Transponder { up: 0, down: 43_700_000, tone: 0, arm: 0, kind: Kind::Beacon });
        assert_eq!(descs[1], "Telemetry");
        let rec = wire::encode(&s);
        assert_eq!(wire::decode(&rec), Ok(s), "the radio's own check takes it");
    }

    fn e_tle(entry: &str, k: usize) -> String {
        let v: serde_json::Value = serde_json::from_str(entry).unwrap();
        v["tle"][k].as_str().unwrap().to_string()
    }

    /// SAT-13, SAT-15: the list offers only what an FM handheld can work; names fit 16; APRS is kind 1.
    #[test]
    fn the_list() {
        let iss = r#"{"id":25544,"name":"ISS (ZARYA)","short":"ISS","status":"active","elements":{"epoch":"2026-10-31T18:10:07.723776","n":15.49131714,"e":0.0007028,"i":51.6332,"raan":344.2755,"w":332.5119,"m":27.5497,"bstar":0.00012291},
            "transmitters":[{"desc":"FM","mode":"FM","up":[145990000,145990000],"down":[437800000,437800000],"tone":"67.0"},{"desc":"a","mode":"FM","up":[144490000,144490000],"down":[145800000,145800000],"tone":null},
            {"desc":"b","mode":"FM","up":[145200000,145200000],"down":[145800000,145800000],"tone":null},{"desc":"APRS","mode":"APRS","up":[145825000,145825000],"down":[145825000,145825000],"tone":null},
            {"desc":"APRS 70","mode":"APRS","up":[437825000,437825000],"down":[437825000,437825000],"tone":null},{"desc":"sixth","mode":"FM","up":[145990000,145990000],"down":[437800000,437800000],"tone":null}]}"#;
        let ten = r#"{"id":1,"name":"A VERY LONG SATELLITE NAME","short":"TOO LONG A SHORT NAME","status":"unknown","elements":{"epoch":"2026-10-01T00:00:00","n":14.0,"e":0.001,"i":98.0,"raan":1.0,"w":2.0,"m":3.0,"bstar":0.0},
            "transmitters":[{"desc":"10 m","mode":"FM","up":[29500000,29500000],"down":[29400000,29400000],"tone":null}]}"#;
        let long = r#"{"id":2,"name":"A VERY LONG SATELLITE NAME","short":null,"status":"unknown","elements":{"epoch":"2026-10-01T00:00:00Z","n":14.0,"e":0.001,"i":98.0,"raan":1.0,"w":2.0,"m":3.0,"bstar":-1e-5},
            "transmitters":[{"desc":"FM","mode":"FM","up":[145900000,145900000],"down":[435900000,435900000],"tone":"88.5"}]}"#;
        let p = parse(&file(&[iss, SO50, ten, long], "2026-11-01")).unwrap();
        assert_eq!(p.built, 1_793_491_200);
        assert_eq!(p.sats.iter().map(|s| s.id).collect::<Vec<_>>(), [25_544, 27_607, 2]);
        assert_eq!(p.skipped, ["A VERY LONG SATELLITE NAME"]);
        let iss = &p.sats[0];
        assert_eq!(iss.tps.len(), 5, "five at most");
        assert_eq!(iss.dropped, 1);
        assert_eq!(iss.tps[3].kind, "APRS");
        assert_eq!(iss.tps[0].tone, "67.0");
        assert_eq!(iss.epoch, 1_793_470_207);
        assert_eq!(p.sats[2].short, "A VERY LONG SATE");
        assert_eq!(p.sats[2].status, "unknown");
        assert_eq!(p.sats[2].record.len(), 152);
        assert_eq!(held(&p.sats[2].record).unwrap().short, "A VERY LONG SATE");
        assert_eq!(held(&p.sats[1].record).unwrap().tps[0].arm, "74.4");
        assert!(parse(r#"{"format":"satellites-2","built":"2026-11-01","satellites":[]}"#)
            .unwrap_err()
            .contains("update Console"));
    }

    /// SAT-21: the rewrite keeps the radio's satellites and their order, fresh elements from the file, the flags
    /// the radio's record had; a satellite gone from the file goes back unchanged.
    #[test]
    fn refresh_keeps_the_picks() {
        let p = parse(&file(&[SO50], "2026-11-01")).unwrap();
        let mut old = wire::decode(&p.sats[0].record).unwrap();
        old.el.epoch -= 5 * 86_400;
        old.flags = Sat::HD;
        let mut gone = old;
        gone.id = 99_999;
        let held = vec![wire::encode(&gone).to_vec(), wire::encode(&old).to_vec()];
        let out = refresh(&file(&[SO50], "2026-11-02"), &held).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], held[0], "not in the file: as it was");
        let fresh = wire::decode(&out[1]).unwrap();
        assert_eq!(fresh.id, 27_607);
        assert_eq!(fresh.el.epoch, old.el.epoch + 5 * 86_400, "fresh elements");
        assert_eq!(fresh.flags, Sat::HD, "its flags kept");
    }

    /// SAT-21: a connect rewrites only a radio holding satellites, with older data, written more than a day ago.
    #[test]
    fn sync_rule() {
        let now = 1_793_541_600;
        let info = |stamp, written| Some(InfoRow { decl: None, stamp, written });
        let built = 1_793_491_200;
        assert!(sync_due(built, 3, info(built - 86_400, now - 2 * 86_400), now));
        assert!(
            !sync_due(built, 0, info(built - 86_400, now - 2 * 86_400), now),
            "no satellites: the user picks first"
        );
        assert!(!sync_due(built, 3, info(built, now - 2 * 86_400), now), "the radio has this build");
        assert!(!sync_due(built, 3, info(built - 86_400, now - 3_600), now), "written an hour ago: one a day");
        assert!(sync_due(built, 3, None, now), "no info record: never written");
        assert!(
            !sync_due(built, 3, info(built - 86_400, now + 3_600), now),
            "written 'later' (a clock off): not again"
        );
    }

    /// LINK-64, LINK-65: the info record and the clock's answer.
    #[test]
    fn info_and_clock() {
        let r = info_record(Some(-155), 1_793_491_200, 1_793_541_600);
        assert_eq!(r.len(), 16);
        assert_eq!(info_of(&r), Some(InfoRow { decl: Some(-155), stamp: 1_793_491_200, written: 1_793_541_600 }));
        assert_eq!(info_of(&info_record(None, 0, 0)).unwrap().decl, None);
        let mut a = 1_793_541_600u32.to_le_bytes().to_vec();
        a.push(1);
        assert_eq!(clock_of(&a), Some(Clock { now: 1_793_541_600, source: "GPS" }));
        assert_eq!(clock_of(&[0, 0]), None);
    }

    #[test]
    fn iso_dates() {
        assert_eq!(parse_iso("2000-01-01T00:00:00"), Some((Y2000 as i64, 0)));
        assert_eq!(parse_iso("2026-11-01"), Some((1_793_491_200, 0)));
        assert_eq!(parse_iso("2024-02-29T12:00:01.5"), Some((1_709_208_001, 500)));
        assert_eq!(parse_iso("nope"), None);
    }
}
