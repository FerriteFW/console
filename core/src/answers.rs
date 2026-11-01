//! Request payloads and answer parsing for the session messages: `HELLO`, `AUTH`, `INFO`, `SLOT`, `BAUD` and the
//! text answers of `UI`, `CMD` and `MORE`. Byte layouts as `ferrite_link.py` reads them.

use crate::uid;
use ferrite_core::link::{build, PROTOCOL};
use serde::Serialize;

/// The status byte's names, as `ferrite_link.py` prints them (index = `ferrite_core::link::Status`).
pub const STATUS: [&str; 11] = [
    "ok",
    "bad frame",
    "unknown type",
    "bad argument",
    "refused",
    "not authorised",
    "pending",
    "busy",
    "not found",
    "invalid",
    "cancelled",
];

/// A status byte (and, for `invalid`, the reason that follows it) as text.
pub fn status_text(status: u8, rest: &[u8]) -> String {
    let name = STATUS.get(status as usize).map_or_else(|| format!("status {status}"), |s| s.to_string());
    if status == ferrite_core::link::Status::Invalid as u8 && !rest.is_empty() {
        format!("{name}: {}", String::from_utf8_lossy(rest))
    } else {
        name
    }
}

/// `HELLO`'s payload: the protocol version, 8 bytes reserved (zeros), then the client's name.
pub fn hello_payload(name: &str) -> Vec<u8> {
    let mut p = vec![PROTOCOL];
    p.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0]); // LINK-51: asks for compression (a radio from before ignores it)
    p.extend_from_slice(name.as_bytes());
    p
}

/// `AUTH`'s payload: the PIN's ASCII digits (LINK-30).
pub fn auth_payload(pin: &str) -> Vec<u8> {
    pin.as_bytes().to_vec()
}

/// `BAUD`'s payload: the rate, u32 little-endian (LINK-11).
pub fn baud_payload(rate: u32) -> Vec<u8> {
    rate.to_le_bytes().to_vec()
}

/// The build byte (LINK-35).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Build {
    pub byte: u8,
    /// "receive", "tx", "tx-dry", "tx+dry" (or "unknown").
    pub name: &'static str,
    /// Bench commands in (bit 7).
    pub bench: bool,
    /// The PA drive is held at 0 now (Dry TX on, or an old tx-dry build).
    pub dry: bool,
}

impl Build {
    pub fn of(byte: u8) -> Self {
        Build { byte, name: build::name(byte), bench: build::bench(byte), dry: build::dry(byte) }
    }

    /// How the connection bar names it: "tx+dry, bench".
    pub fn label(&self) -> String {
        if self.bench {
            format!("{}, bench", self.name)
        } else {
            self.name.to_string()
        }
    }
}

/// A length-prefixed ASCII string; it and the bytes after it.
fn text(b: &[u8]) -> Option<(String, &[u8])> {
    let (&n, rest) = b.split_first()?;
    let s = rest.get(..n as usize)?;
    Some((String::from_utf8_lossy(s).into_owned(), &rest[n as usize..]))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hello {
    pub protocol: u8,
    pub max_payload: u8,
    /// False: the radio's PIN lock is on and this is Bluetooth: `AUTH` first (LINK-30).
    pub may_go_on: bool,
    pub firmware: String,
    /// None before Oct 13, 2026's firmware.
    pub build: Option<Build>,
    /// LINK-35.2: what the radio does beyond protocol 2 (1 `STREAM`, 2 two `WRITE_MANY` frames in flight); 0 before.
    pub caps: u8,
    /// LINK-35.2: the second capability byte (1 range preset skip lists, LINK-58; 2 protocol 3's raw data and
    /// layouts, LINK-59 – LINK-62); 0 before decision 329.
    pub caps2: u8,
    /// LINK-62: the layout this firmware stores and the one the chip's data is in (with `caps2` 2); None before.
    pub layouts: Option<Layouts>,
}

/// LINK-62: the SPI flash layouts `HELLO` and `INFO` end with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Layouts {
    /// The layout this firmware stores (3).
    pub firmware: u8,
    /// The layout the chip's data is in: the same when all is well; another (2) while it waits for Console (UPD-16).
    pub chip: u8,
}

impl Layouts {
    /// The chip's data waits for Console to move it (the radio shows D25 "Finish the update").
    pub fn pending(&self) -> bool {
        self.firmware != self.chip
    }
}

impl Hello {
    /// From the answer's payload after the status byte.
    pub fn parse(rest: &[u8]) -> Option<Hello> {
        let [protocol, max_payload, may, ref tail @ ..] = *rest else {
            return None;
        };
        let (firmware, after) = text(tail)?;
        Some(Hello {
            protocol,
            max_payload,
            may_go_on: may != 0,
            firmware,
            build: after.first().map(|&b| Build::of(b)),
            caps: after.get(1).copied().unwrap_or(0),
            caps2: after.get(2).copied().unwrap_or(0),
            layouts: match after.get(2) {
                Some(c) if c & ferrite_core::link::caps2::DATA != 0 => {
                    after.get(3..5).map(|l| Layouts { firmware: l[0], chip: l[1] })
                }
                _ => None,
            },
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Info {
    pub firmware: String,
    pub channels: u16,
    /// Zones the radio holds (2 bytes since protocol 3; one byte before).
    pub zones: u16,
    pub presets: u8,
    pub settings_len: u16,
    pub region: u8,
    pub callsign: String,
    pub build: Option<Build>,
    /// The unique ID's 12 bytes (LINK-35.1), when given.
    pub uid: Option<Vec<u8>>,
    /// As About shows it: 20 base32 digits in groups of five; None when absent or all zero.
    pub uid_text: Option<String>,
    /// LINK-62: the layouts (firmware, chip), from a protocol 3 radio.
    pub layouts: Option<Layouts>,
}

impl Info {
    /// From the answer after the status byte; `protocol` is `HELLO`'s (3: the zone count is 2 bytes, and the
    /// layouts end it).
    pub fn parse(rest: &[u8], protocol: u8) -> Option<Info> {
        let (firmware, r) = text(rest)?;
        let wide = protocol >= 3;
        let k = if wide { 8 } else { 7 };
        let f = r.get(..k)?;
        let channels = u16::from_le_bytes([f[0], f[1]]);
        let zones = if wide { u16::from_le_bytes([f[2], f[3]]) } else { f[2] as u16 };
        let f = &f[k - 4..];
        let presets = f[0];
        let settings_len = u16::from_le_bytes([f[1], f[2]]);
        let region = f[3];
        let (callsign, tail) = text(&r[k..])?;
        let build = tail.first().map(|&b| Build::of(b));
        let id = tail.get(1..13).map(|b| b.to_vec());
        let uid_text = id.as_deref().and_then(uid::text);
        let layouts = if wide { tail.get(13..15).map(|l| Layouts { firmware: l[0], chip: l[1] }) } else { None };
        Some(Info { firmware, channels, zones, presets, settings_len, region, callsign, build, uid: id, uid_text, layouts })
    }
}

/// One chunk of a text answer (`UI`, `CMD`, `MORE`): whether more follows, and the text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TextChunk {
    pub more: bool,
    pub text: String,
    /// `more` with no text: the radio is still working; ask `MORE` again after [`crate::timing::MORE_WAIT_MS`].
    pub working: bool,
}

impl TextChunk {
    pub fn parse(rest: &[u8]) -> Option<TextChunk> {
        let (&more, t) = rest.split_first()?;
        Some(TextChunk {
            more: more != 0,
            text: String::from_utf8_lossy(t).into_owned(),
            working: more != 0 && t.is_empty(),
        })
    }
}

/// A slot's working fields, `SLOT`'s answer (LINK-33): `<BBHIBBHHiB`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Slot {
    /// 0-2: A-C.
    pub slot: u8,
    pub active: bool,
    /// The channel (0-based), None in VFO or APRS.
    pub channel: Option<u16>,
    /// 10 Hz units.
    pub freq: u32,
    /// 0 FM, 1 NFM, 2 AM.
    pub mode: u8,
    /// 0 low, 1 mid, 2 high.
    pub power: u8,
    pub rx_tone: u16,
    pub tx_tone: u16,
    /// The signed shift (10 Hz), or the split's TX frequency when `split`.
    pub offset: i32,
    pub split: bool,
    pub aprs: bool,
    pub scanning: bool,
}

impl Slot {
    pub fn parse(r: &[u8]) -> Option<Slot> {
        let r = r.get(..19)?;
        let u16at = |i: usize| u16::from_le_bytes([r[i], r[i + 1]]);
        let ch = u16at(2);
        let fl = r[18];
        use ferrite_core::link::slot as s;
        Some(Slot {
            slot: r[0],
            active: r[1] != 0,
            channel: (ch != 0xFFFF).then_some(ch),
            freq: u32::from_le_bytes([r[4], r[5], r[6], r[7]]),
            mode: r[8],
            power: r[9],
            rx_tone: u16at(10),
            tx_tone: u16at(12),
            offset: i32::from_le_bytes([r[14], r[15], r[16], r[17]]),
            split: fl & s::SPLIT != 0,
            aprs: fl & s::APRS != 0,
            scanning: fl & s::SCANNING != 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lp(s: &str) -> Vec<u8> {
        let mut v = vec![s.len() as u8];
        v.extend_from_slice(s.as_bytes());
        v
    }

    #[test]
    fn hello_payload_and_answer() {
        let p = hello_payload("Ferrite Console");
        assert_eq!(p[0], 3, "protocol 3 (decision 333)");
        assert_eq!(&p[1..9], &[1, 0, 0, 0, 0, 0, 0, 0], "LINK-51: compression asked for");
        assert_eq!(&p[9..], b"Ferrite Console");
        let mut a = vec![2, 240, 1];
        a.extend(lp("0.1.0-abc"));
        a.push(0x83);
        let h = Hello::parse(&a).unwrap();
        assert_eq!((h.protocol, h.max_payload, h.may_go_on, h.firmware.as_str()), (2, 240, true, "0.1.0-abc"));
        let b = h.build.unwrap();
        assert_eq!((b.name, b.bench, b.dry, b.label().as_str()), ("tx+dry", true, true, "tx+dry, bench"));
        let mut old = vec![2, 240, 0];
        old.extend(lp("0.0.9"));
        let h = Hello::parse(&old).unwrap();
        assert!(!h.may_go_on && h.build.is_none());
        assert!(Hello::parse(&[2, 240]).is_none());
        // LINK-62: protocol 3's two layout bytes after the second capability byte (with its 2).
        let mut a = vec![3, 240, 1];
        a.extend(lp("0.9.0"));
        a.extend([1, 0xFF, 3, 3, 2]);
        let h = Hello::parse(&a).unwrap();
        assert_eq!(h.layouts, Some(Layouts { firmware: 3, chip: 2 }));
        assert!(h.layouts.unwrap().pending());
        let k = a.len() - 3;
        a[k] = 1; // no DATA capability: the bytes after aren't layouts
        assert_eq!(Hello::parse(&a).unwrap().layouts, None);
    }

    /// LINK-35, LINK-35.1: INFO's fields, the build byte and the 12 ID bytes after the callsign.
    #[test]
    fn info_answer() {
        // Protocol 3 (decision 333): the zone count is 2 bytes, and the layouts end it.
        let mut a = lp("0.9.0");
        a.extend(4000u16.to_le_bytes());
        a.extend(300u16.to_le_bytes());
        a.push(8);
        a.extend(412u16.to_le_bytes());
        a.push(1);
        a.extend(lp("N0CALL"));
        a.push(1);
        a.extend([0u8; 12]);
        a.extend([3, 2]);
        let i = Info::parse(&a, 3).unwrap();
        assert_eq!((i.channels, i.zones, i.presets, i.settings_len, i.region), (4000, 300, 8, 412, 1));
        assert_eq!((i.callsign.as_str(), i.layouts), ("N0CALL", Some(Layouts { firmware: 3, chip: 2 })));
        // Protocol 2: one zone byte.
        let mut a = lp("0.1.0");
        a.extend(1000u16.to_le_bytes());
        a.extend([32, 8]);
        a.extend(412u16.to_le_bytes());
        a.push(1);
        a.extend(lp("N0CALL"));
        a.push(1);
        let id = ferrite_core::uid::bytes([0x3F2A_91C0, 0x7D44_0123, 0x89AB_CDEF]);
        a.extend(id);
        let i = Info::parse(&a, 2).unwrap();
        assert_eq!((i.channels, i.zones, i.presets, i.settings_len, i.region), (1000, 32, 8, 412, 1));
        assert_eq!(i.layouts, None);
        assert_eq!((i.firmware.as_str(), i.callsign.as_str()), ("0.1.0", "N0CALL"));
        assert_eq!(i.build.unwrap().label(), "tx");
        assert_eq!(i.uid.as_deref(), Some(&id[..]));
        let t = ferrite_core::uid::text([0x3F2A_91C0, 0x7D44_0123, 0x89AB_CDEF]);
        let t = core::str::from_utf8(&t).unwrap();
        let grouped = format!("{} {} {} {}", &t[..5], &t[5..10], &t[10..15], &t[15..]);
        assert_eq!(i.uid_text.as_deref(), Some(grouped.as_str()));
        // Older firmware: no build byte, no ID.
        let i = Info::parse(&a[..a.len() - 13], 2).unwrap();
        assert!(i.build.is_none() && i.uid.is_none() && i.uid_text.is_none());
    }

    #[test]
    fn text_chunks_and_status() {
        let c = TextChunk::parse(b"\x01screen Home \"Home\"\n").unwrap();
        assert!(c.more && !c.working && c.text.starts_with("screen"));
        assert!(TextChunk::parse(&[1]).unwrap().working);
        assert!(!TextChunk::parse(&[0]).unwrap().more);
        assert_eq!(status_text(7, &[]), "busy");
        assert_eq!(status_text(9, b"no name"), "invalid: no name");
        assert_eq!(status_text(42, &[]), "status 42");
        assert_eq!(baud_payload(460_800), 460_800u32.to_le_bytes());
        assert_eq!(auth_payload("1234"), b"1234");
    }

    #[test]
    fn slot_answer() {
        let mut r = vec![1, 1];
        r.extend(0xFFFFu16.to_le_bytes());
        r.extend(14_652_000u32.to_le_bytes());
        r.extend([1, 2]);
        r.extend(0x0885u16.to_le_bytes());
        r.extend(0u16.to_le_bytes());
        r.extend((-60_000i32).to_le_bytes());
        r.push(4);
        let s = Slot::parse(&r).unwrap();
        assert_eq!((s.slot, s.active, s.channel, s.freq, s.offset), (1, true, None, 14_652_000, -60_000));
        assert!(s.scanning && !s.split && !s.aprs);
        assert!(Slot::parse(&r[..18]).is_none());
    }
}
