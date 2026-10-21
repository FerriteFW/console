//! The event log over the link (`LOG_READ`, LINK-42; Appendix G "Event log records"): the Activity Log's rows.
//! Ages are seconds before the answer: the radio's clock may have no date, so the PC dates them from its own.

use crate::aprs::Rd;
use ferrite_core::link::{LOG_FIXED, LOG_POS, LOG_UNREAD};
use serde::{Deserialize, Serialize};

/// The sources a record names (LINK-42).
pub const SOURCES: [&str; 8] = ["APRS", "Pager", "SAME", "DSC", "AIS", "DTMF", "Selcall", "GPS"];

/// One record, with what its source's ID, x and y mean spelled out (`detail`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub seq: u32,
    pub ago_s: u32,
    pub source: String,
    pub slot: u8,
    /// "A", "B", "C" (or the number).
    pub slot_name: String,
    pub unread: bool,
    /// 10 Hz units, and as MHz text ("144.39000").
    pub freq: u32,
    pub mhz: String,
    pub id: u32,
    pub x: u16,
    pub y: u16,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub name: String,
    pub text: String,
    /// The ID, x and y as words for its source ("capcode 1234567, 1200 baud"), empty when they say nothing.
    pub detail: String,
}

/// `LOG_READ`'s answer: the next sequence number, the records held, and these (newest first).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Page {
    pub next: u32,
    pub held: u16,
    pub records: Vec<Record>,
}

/// `LOG_READ`'s payload: records below `before` (0xFFFFFFFF from the newest), at most `max` (0: as many as fit).
pub fn read_payload(before: u32, max: u8) -> Vec<u8> {
    let mut p = before.to_le_bytes().to_vec();
    p.push(max);
    p
}

fn detail(source: u8, id: u32, x: u16, y: u16) -> String {
    match source {
        1 => format!("capcode {id}, {x} baud, function {y}"),
        3 => {
            let cat = ["routine", "safety", "urgency", "distress"].get(x as usize).copied().unwrap_or("?");
            format!("MMSI {id}, {cat}")
        }
        4 => format!("MMSI {id}, course {x}°, {:.1} kn", y as f64 / 10.0),
        6 => format!("unit {id}"),
        _ => String::new(),
    }
}

fn record(r: &mut Rd) -> Option<Record> {
    let fixed = r.bytes(LOG_FIXED)?;
    let mut f = Rd(fixed);
    let seq = f.u32()?;
    let ago_s = f.u32()?;
    let src = f.u8()?;
    let slot = f.u8()?;
    let flags = f.u8()?;
    let freq = f.u32()?;
    let id = f.u32()?;
    let x = f.u16()?;
    let y = f.u16()?;
    let (mut lat, mut lon) = (None, None);
    if flags & LOG_POS != 0 {
        lat = Some(r.i32()? as f64 / 1e7);
        lon = Some(r.i32()? as f64 / 1e7);
    }
    let name = r.text()?;
    let text = r.text()?;
    Some(Record {
        seq,
        ago_s,
        source: SOURCES.get(src as usize).map_or_else(|| format!("source {src}"), |s| s.to_string()),
        slot,
        slot_name: ["A", "B", "C"].get(slot as usize).map_or_else(|| slot.to_string(), |s| s.to_string()),
        unread: flags & LOG_UNREAD != 0,
        freq,
        mhz: format!("{}.{:05}", freq / 100_000, freq % 100_000),
        id,
        x,
        y,
        lat,
        lon,
        name,
        text,
        detail: detail(src, id, x, y),
    })
}

pub fn parse_page(rest: &[u8]) -> Option<Page> {
    let mut r = Rd(rest);
    let next = r.u32()?;
    let held = r.u16()?;
    let n = r.u8()?;
    let records = (0..n).map(|_| record(&mut r)).collect::<Option<Vec<_>>>()?;
    Some(Page { next, held, records })
}

/// The rows as a CSV file (RFC 4180 quoting), dated by `times` (the PC's local time text for each, in order).
pub fn csv(records: &[Record], times: &[String]) -> String {
    let q = |s: &str| {
        if s.contains([',', '"', '\n', '\r']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };
    let mut out = String::from("time,seq,source,slot,frequency_mhz,name,text,detail,latitude,longitude,unread\r\n");
    for (i, r) in records.iter().enumerate() {
        let pos = |v: Option<f64>| v.map(|x| format!("{x:.5}")).unwrap_or_default();
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{}\r\n",
            q(times.get(i).map_or("", |s| s.as_str())),
            r.seq,
            q(&r.source),
            r.slot_name,
            r.mhz,
            q(&r.name),
            q(&r.text),
            q(&r.detail),
            pos(r.lat),
            pos(r.lon),
            r.unread as u8
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aprs::tests::ask_sample;
    use ferrite_core::link::msg;

    /// LINK-42: the sample store's log through ferrite's link session: newest first, every source's fields, paged
    /// by sequence number down to the oldest.
    #[test]
    fn log_pages_from_ferrites_session() {
        let (s, rest) = ask_sample(msg::LOG_READ, &read_payload(u32::MAX, 0));
        assert_eq!(s, 0);
        let p = parse_page(&rest).unwrap();
        assert!(p.records.len() >= 2 && p.held as usize >= p.records.len());
        assert!(p.records.windows(2).all(|w| w[0].seq > w[1].seq), "newest first");
        let last = p.records.last().unwrap().seq;
        let mut all = p.records.clone();
        let mut before = last;
        loop {
            let (_, rest) = ask_sample(msg::LOG_READ, &read_payload(before, 0));
            let q = parse_page(&rest).unwrap();
            if q.records.is_empty() {
                break;
            }
            before = q.records.last().unwrap().seq;
            all.extend(q.records);
        }
        assert_eq!(all.len(), p.held as usize);
        assert!(all.iter().any(|r| r.lat.is_some()));
        assert!(all.iter().any(|r| r.source == "Pager" && r.detail.starts_with("capcode")));
        let c = csv(&all[..1], &["2026-10-20 12:00".into()]);
        assert!(c.starts_with("time,seq") && c.lines().count() == 2);
    }

    #[test]
    fn csv_quotes() {
        let r = Record {
            seq: 1,
            ago_s: 0,
            source: "APRS".into(),
            slot: 2,
            slot_name: "C".into(),
            unread: true,
            freq: 14_439_000,
            mhz: "144.39000".into(),
            id: 0,
            x: 0,
            y: 0,
            lat: Some(45.5),
            lon: Some(-75.25),
            name: "VA3RTX".into(),
            text: "Net, \"8 pm\"".into(),
            detail: String::new(),
        };
        let c = csv(&[r], &["t".into()]);
        assert!(c.contains("\"Net, \"\"8 pm\"\"\""), "{c}");
        assert!(c.contains("45.50000,-75.25000,1"));
    }
}
