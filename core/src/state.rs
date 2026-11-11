//! The radio state (LINK-67, LINK-68; ferrite decision 373): `STATE`'s fixed record, read whole or kept up to date
//! by `SUBSCRIBE`'s state events (only the parts that changed), and `TUNE`'s payloads. Live View's slot panel takes
//! it from here on any screen, instead of the home cards the readback shows only on home.

use ferrite_core::link::{state as m, tune};
use serde::Serialize;

/// The radio's part and the three slots, as the UI shows them.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RadioState {
    /// 0-2: A, B, C.
    pub active: u8,
    pub transmitting: bool,
    pub dry_tx: bool,
    pub locked: bool,
    pub battery_pct: u8,
    pub battery_mv: u16,
    pub battery_low: bool,
    /// "off", "searching", "fix".
    pub gps: &'static str,
    pub sats: u8,
    /// [latitude, longitude] in degrees, or None.
    pub pos: Option<[f64; 2]>,
    pub slots: Vec<SlotState>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SlotState {
    /// "A", "B", "C".
    pub slot: &'static str,
    pub on_channel: bool,
    pub scanning: bool,
    pub open: bool,
    pub transmitting: bool,
    pub aprs: bool,
    pub broadcast: bool,
    pub muted: bool,
    pub off: bool,
    /// The channel's number as the radio shows it (1-based), or None on the VFO.
    pub channel: Option<u16>,
    /// The zone (0-based), "Local" as -1; None on a VFO.
    pub zone: Option<i32>,
    /// Hz.
    pub hz: u64,
    /// "FM", "NFM", "AM", "WFM".
    pub mode: &'static str,
    /// "Low", "Mid", "High".
    pub power: &'static str,
    /// dBm while the squelch is open.
    pub dbm: Option<i16>,
    pub name: String,
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

/// The record decoded, or None when it isn't one this Console reads (another length or version).
pub fn parse(rec: &[u8]) -> Option<RadioState> {
    if rec.len() != m::LEN || rec[0] != m::VERSION {
        return None;
    }
    let r = &rec[..m::RADIO_LEN];
    let lat = i32::from_le_bytes(r[8..12].try_into().ok()?);
    let lon = i32::from_le_bytes(r[12..16].try_into().ok()?);
    let slots = (0..3)
        .map(|s| {
            let at = m::RADIO_LEN + s * m::SLOT_LEN;
            let b = &rec[at..at + m::SLOT_LEN];
            let f = b[0];
            let channel = u16_at(b, 1);
            let zone = u16_at(b, 3);
            let dbm = i16::from_le_bytes([b[11], b[12]]);
            let name = &b[13..13 + m::NAME_LEN];
            let name = &name[..name.iter().position(|&c| c == 0).unwrap_or(m::NAME_LEN)];
            SlotState {
                slot: ["A", "B", "C"][s],
                on_channel: f & m::ON_CHANNEL != 0,
                scanning: f & m::SCANNING != 0,
                open: f & m::OPEN != 0,
                transmitting: f & m::TRANSMITTING != 0,
                aprs: f & m::APRS != 0,
                broadcast: f & m::BROADCAST != 0,
                muted: f & m::MUTED != 0,
                off: f & m::OFF != 0,
                channel: (channel != m::NONE).then(|| channel + 1),
                zone: match zone {
                    m::NONE => None,
                    m::LOCAL => Some(-1),
                    z => Some(z as i32),
                },
                hz: u32::from_le_bytes(b[5..9].try_into().unwrap()) as u64 * 10,
                mode: match b[9] {
                    0 => "FM",
                    1 => "NFM",
                    2 => "AM",
                    6 => "WFM",
                    _ => "",
                },
                power: ["Low", "Mid", "High"].get(b[10] as usize).copied().unwrap_or(""),
                dbm: (dbm != m::NO_SIGNAL).then_some(dbm),
                name: String::from_utf8_lossy(name).into_owned(),
            }
        })
        .collect();
    Some(RadioState {
        active: r[1],
        transmitting: r[2] & m::TX != 0,
        dry_tx: r[2] & m::DRY != 0,
        locked: r[2] & m::LOCKED != 0,
        battery_low: r[2] & m::BATTERY_LOW != 0,
        battery_pct: r[3],
        battery_mv: u16_at(r, 4),
        gps: ["off", "searching", "fix"].get(r[6] as usize).copied().unwrap_or("off"),
        sats: r[7],
        pos: (lat != m::NO_POS).then(|| [lat as f64 / 1e7, lon as f64 / 1e7]),
        slots,
    })
}

/// A state event's body (after the kind byte: the parts mask, then those parts) applied to the record kept so far:
/// the new record, or None when it can't be (no record yet and not every part in it, or cut short): ask `STATE`.
pub fn merge(prev: Option<&[u8]>, body: &[u8]) -> Option<Vec<u8>> {
    let (&parts, mut rest) = body.split_first()?;
    let mut rec = match prev {
        Some(p) if p.len() == m::LEN => p.to_vec(),
        _ if parts == m::PART_ALL => vec![0; m::LEN],
        _ => return None,
    };
    for i in 0..4 {
        if parts & 1 << i == 0 {
            continue;
        }
        let (at, len) = if i == 0 { (0, m::RADIO_LEN) } else { (m::RADIO_LEN + (i - 1) * m::SLOT_LEN, m::SLOT_LEN) };
        let part = rest.get(..len)?;
        rec[at..at + len].copy_from_slice(part);
        rest = &rest[len..];
    }
    rest.is_empty().then_some(rec)
}

/// `TUNE`'s payload: the slot (0-2) and what to do; or why not.
///
/// `op`: "channel" (`value` the number as the radio shows it, 1-based), "step" (▲▼, -100 to 100), "group" (◀▶,
/// -20 to 20), "zone" (0-based; -1 Local), "scan" (1 start, 0 stop).
pub fn tune_payload(slot: u8, op: &str, value: i32) -> Result<Vec<u8>, String> {
    if slot > 2 {
        return Err("slot: A, B or C".into());
    }
    let mut p = vec![slot];
    match op {
        "channel" if (1..=4000).contains(&value) => {
            p.push(tune::CHANNEL);
            p.extend_from_slice(&((value - 1) as u16).to_le_bytes());
        }
        "step" if value != 0 && value.abs() <= 100 => p.extend_from_slice(&[tune::STEP, value as i8 as u8]),
        "group" if value != 0 && value.abs() <= 20 => p.extend_from_slice(&[tune::GROUP, value as i8 as u8]),
        "zone" if (-1..=511).contains(&value) => {
            p.push(tune::ZONE);
            p.extend_from_slice(&(if value < 0 { m::LOCAL } else { value as u16 }).to_le_bytes());
        }
        "scan" if value == 0 || value == 1 => p.extend_from_slice(&[tune::SCAN, value as u8]),
        "channel" => return Err("channel: 1 to 4000".into()),
        _ => return Err(format!("{op} {value}: not a tune")),
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radioside::RadioSide;
    use ferrite_core::link::msg;

    /// LINK-67: the radio's own record (the radio side Console's tests run) reads back whole, and a state event's
    /// parts merge into it as the radio sends them.
    #[test]
    fn state_reads_and_merges() {
        let mut rs = RadioSide::new();
        let (st, rec) = rs.ask(msg::STATE, &[]);
        assert_eq!(st, 0, "{rec:?}");
        let s = parse(&rec).expect("a record this Console reads");
        assert_eq!(s.slots.len(), 3);
        assert!(s.active < 3);
        // slot B's part alone, changed: merged over the record
        let mut b = rec[m::RADIO_LEN + m::SLOT_LEN..m::RADIO_LEN + 2 * m::SLOT_LEN].to_vec();
        b[0] |= m::OPEN;
        b[11..13].copy_from_slice(&(-90i16).to_le_bytes());
        let mut body = vec![m::PART_SLOT << 1];
        body.extend_from_slice(&b);
        let new = merge(Some(&rec), &body).unwrap();
        let s2 = parse(&new).unwrap();
        assert_eq!((s2.slots[1].open, s2.slots[1].dbm), (true, Some(-90)));
        assert_eq!(s2.slots[0], s.slots[0]);
        // without a record, only a whole one will do; cut short is refused
        assert_eq!(merge(None, &body), None);
        let mut all = vec![m::PART_ALL];
        all.extend_from_slice(&rec);
        assert_eq!(merge(None, &all).as_deref(), Some(&rec[..]));
        assert_eq!(merge(Some(&rec), &body[..10]), None);
        assert!(parse(&rec[1..]).is_none());
    }

    /// LINK-68: the payloads the radio takes, and the ones refused before they go.
    #[test]
    fn tune_payloads() {
        let mut rs = RadioSide::new();
        let (st, a) = rs.ask(msg::TUNE, &tune_payload(1, "step", 1).unwrap());
        assert_eq!((st, a.len(), a[0]), (0, 19, 1), "{a:?}");
        assert_eq!(tune_payload(1, "channel", 12).unwrap(), vec![1, tune::CHANNEL, 11, 0]);
        assert_eq!(tune_payload(0, "zone", -1).unwrap(), vec![0, tune::ZONE, 0xFE, 0xFF]);
        assert_eq!(tune_payload(2, "group", -2).unwrap(), vec![2, tune::GROUP, 0xFE]);
        assert_eq!(tune_payload(2, "scan", 1).unwrap(), vec![2, tune::SCAN, 1]);
        for (s, op, v) in [(3, "step", 1), (0, "step", 0), (0, "step", 101), (0, "group", 21), (0, "channel", 0), (0, "scan", 2), (0, "fly", 1)] {
            assert!(tune_payload(s, op, v).is_err(), "{s} {op} {v}");
        }
    }
}
