//! The owner's lists over the link (LINK-54 – LINK-56, decision 327; Appendix G "Records" 8–10): the quick messages
//! (TEXT-7), the waypoints (GPS-10) and the DTMF memories with their names (DTMF-12), by `READ_MANY` and `WRITE_MANY`
//! as the channels go. Only for a radio whose `HELLO` says `caps::LISTS`; an older one answers `bad argument`.
//!
//! The records are built and read here; every check is the radio's own (ferrite's link session answers `invalid`
//! with its reason), so these only shape the bytes. The tests write through ferrite's own session
//! ([`crate::radioside`]).

use crate::aprs::Rd;
use ferrite_core::link::{QUICK_OWN, WAYPOINT_LEN};
use serde::{Deserialize, Serialize};

pub use ferrite_core::link::ADD as WAYPOINT_ADD;

/// `(index, record)` pairs, as `READ_MANY` gives them and `WRITE_MANY` takes them.
pub type Records = Vec<(u16, Vec<u8>)>;

/// How many quick messages there are (TEXT-7).
pub const QUICK_COUNT: u16 = ferrite_app::words::QUICK as u16;
/// The DTMF memories (DTMF-12).
pub const DTMF_COUNT: u16 = ferrite_app::data::DTMF_MEMS as u16;
/// GPS-10: the most waypoints the radio keeps.
pub const WAYPOINT_MAX: u16 = 256;
/// A waypoint's sources, in their record order (GPS-10).
pub const SOURCES: [&str; 4] = ["marked", "aprs", "link", "grid"];

/// A quick message: the owner's own text, or the factory text (`own` false: `text` is what the radio uses).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuickMessage {
    pub own: bool,
    pub text: String,
}

/// A waypoint: its name, position (1e-7 degree, north and east positive) and source (one of [`SOURCES`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Waypoint {
    pub name: String,
    pub lat: i32,
    pub lon: i32,
    pub source: String,
}

/// A DTMF memory: its symbols (`0-9 A-D * #`) and name (up to 10 characters; empty for none).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DtmfMemory {
    pub symbols: String,
    pub name: String,
}

/// LINK-54: a quick message's record: flags (the owner's own), then the text. `own` false puts the factory text
/// back (the text is ignored).
pub fn quick_record(q: &QuickMessage) -> Vec<u8> {
    let mut r = vec![if q.own { QUICK_OWN } else { 0 }];
    if q.own {
        r.extend_from_slice(q.text.as_bytes());
    }
    r
}

pub fn quick_from_record(rec: &[u8]) -> Option<QuickMessage> {
    let (&f, t) = rec.split_first()?;
    Some(QuickMessage { own: f & QUICK_OWN != 0, text: String::from_utf8_lossy(t).into_owned() })
}

/// LINK-55: a waypoint's record (25 bytes); None deletes the one at its index (an empty record). The name is cut to
/// 16 bytes; an unknown source is sent as 2 (link). Write a new one at [`WAYPOINT_ADD`].
pub fn waypoint_record(w: Option<&Waypoint>) -> Vec<u8> {
    let Some(w) = w else { return Vec::new() };
    let mut r = vec![0u8; 16];
    let n = w.name.as_bytes();
    r[..n.len().min(16)].copy_from_slice(&n[..n.len().min(16)]);
    r.extend(w.lat.to_le_bytes());
    r.extend(w.lon.to_le_bytes());
    r.push(SOURCES.iter().position(|s| *s == w.source).unwrap_or(2) as u8);
    debug_assert_eq!(r.len(), WAYPOINT_LEN);
    r
}

pub fn waypoint_from_record(rec: &[u8]) -> Option<Waypoint> {
    if rec.len() != WAYPOINT_LEN {
        return None;
    }
    let name = &rec[..rec[..16].iter().position(|&c| c == 0).unwrap_or(16)];
    let mut r = Rd(&rec[16..]);
    let (lat, lon, src) = (r.i32()?, r.i32()?, r.u8()?);
    Some(Waypoint {
        name: String::from_utf8_lossy(name).into_owned(),
        lat,
        lon,
        source: SOURCES.get(src as usize).map_or_else(|| format!("source {src}"), |s| s.to_string()),
    })
}

/// LINK-56: a DTMF memory's record: the symbols (a length, then the text), then the name; None clears the memory
/// and its name (an empty record).
pub fn dtmf_record(m: Option<&DtmfMemory>) -> Vec<u8> {
    let Some(m) = m else { return Vec::new() };
    let s = &m.symbols.as_bytes()[..m.symbols.len().min(255)];
    let mut r = vec![s.len() as u8];
    r.extend_from_slice(s);
    r.extend_from_slice(m.name.as_bytes());
    r
}

pub fn dtmf_from_record(rec: &[u8]) -> Option<DtmfMemory> {
    let (&n, rest) = rec.split_first()?;
    let (sym, name) = (rest.get(..n as usize)?, rest.get(n as usize..)?);
    Some(DtmfMemory { symbols: String::from_utf8_lossy(sym).into_owned(), name: String::from_utf8_lossy(name).into_owned() })
}

/// LINK-55: the writes that take the radio's list `old` to `new` (both newest first), in an order where each index
/// means the list as the radio has it then. Same length: each waypoint that differs is replaced in its place. Else
/// the longest run at the old end of `new` that `old` holds in order is kept, the rest of `old` deleted from the
/// highest index down, and the newer ones added from the oldest of them (each add becomes the newest). Returns
/// `(index, record)` pairs for `WRITE_MANY`, in order; nothing when the lists are the same.
pub fn waypoint_writes(old: &[Waypoint], new: &[Waypoint]) -> Records {
    if old.len() == new.len() {
        return old.iter().zip(new).enumerate().filter(|(_, (o, n))| o != n).map(|(i, (_, n))| (i as u16, waypoint_record(Some(n)))).collect();
    }
    // Match `new` from its oldest against `old` from its oldest: what matches in order is kept.
    let mut keep = vec![false; old.len()];
    let (mut i, mut j) = (old.len(), new.len());
    while i > 0 && j > 0 {
        if old[i - 1] == new[j - 1] {
            keep[i - 1] = true;
            j -= 1;
        }
        i -= 1;
    }
    let mut out: Vec<(u16, Vec<u8>)> = (0..old.len()).rev().filter(|&k| !keep[k]).map(|k| (k as u16, waypoint_record(None))).collect();
    out.extend(new[..j].iter().rev().map(|w| (WAYPOINT_ADD, waypoint_record(Some(w)))));
    out
}

/// LINK-58: a range preset's skip list record (its skipped frequencies, 10 Hz, u32 each); an empty list clears it.
/// Write it after the presets: the list stays with the preset in its place.
pub fn preset_skips_record(f: &[u32]) -> Vec<u8> {
    f.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// LINK-58: a `READ_MANY` record of `what` 11 as the skipped frequencies; None if its length isn't a multiple of 4.
pub fn preset_skips_from_record(rec: &[u8]) -> Option<Vec<u32>> {
    rec.len().is_multiple_of(4).then(|| rec.chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// TEXT-7: the factory quick messages, in order (what "Back to the factory text" puts back).
pub fn quick_factory() -> Vec<String> {
    (0..QUICK_COUNT as usize).map(|i| String::from_utf8_lossy(ferrite_app::words::quick(i)).into_owned()).collect()
}

/// A refusal's reason as the editors show it ("invalid: " taken off), or None for `ok`.
fn reason(s: u8, rest: &[u8]) -> Option<String> {
    (s != 0).then(|| crate::answers::status_text(s, rest).trim_start_matches("invalid: ").to_string())
}

/// LINK-54: why the radio would refuse this quick message (compose's rules: TEXT-7), or None. The factory text
/// (`own` false) is always taken. Ferrite's own link session decides.
pub fn check_quick(q: &QuickMessage) -> Option<String> {
    if !q.own {
        return None;
    }
    let (s, rest) = crate::radioside::RadioSide::new().write_one(ferrite_core::link::what::QUICK, 0, &quick_record(q));
    reason(s, &rest)
}

/// LINK-55: why the radio would refuse this waypoint (its name and position, GPS-10), or None.
pub fn check_waypoint(w: &Waypoint) -> Option<String> {
    let (s, rest) = crate::radioside::RadioSide::new().write_one(ferrite_core::link::what::WAYPOINT, WAYPOINT_ADD, &waypoint_record(Some(w)));
    reason(s, &rest)
}

/// LINK-56: why the radio would refuse this DTMF memory (its symbols and name, DTMF-12), or None.
pub fn check_dtmf(m: &DtmfMemory) -> Option<String> {
    let (s, rest) = crate::radioside::RadioSide::new().write_one(ferrite_core::link::what::DTMF, 0, &dtmf_record(Some(m)));
    reason(s, &rest)
}

/// A list `READ_MANY` answer's records: `(index, record)`, and the index to go on from (LINK-40).
pub fn parse_many(rest: &[u8]) -> Option<(u16, Records)> {
    let mut r = Rd(rest);
    let next = r.u16()?;
    let mut recs = Vec::new();
    while !r.is_empty() {
        let i = r.u16()?;
        let n = r.u8()? as usize;
        recs.push((i, r.bytes(n)?.to_vec()));
    }
    Some((next, recs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radioside::RadioSide;
    use ferrite_core::link::{caps, event as ev, msg, what, Status};

    fn all(r: &mut RadioSide, w: u8) -> Vec<(u16, Vec<u8>)> {
        let mut got = Vec::new();
        let mut first = 0u16;
        loop {
            let mut p = vec![w];
            p.extend(first.to_le_bytes());
            p.extend(1000u16.to_le_bytes());
            let (s, rest) = r.ask(msg::READ_MANY, &p);
            assert_eq!(s, 0);
            let (next, recs) = parse_many(&rest).unwrap();
            if recs.is_empty() {
                return got;
            }
            got.extend(recs);
            first = next;
        }
    }

    fn write_many(r: &mut RadioSide, w: u8, recs: &[(u16, Vec<u8>)]) -> (u8, Vec<u8>) {
        let mut p = vec![w];
        for (i, rec) in recs {
            p.extend(i.to_le_bytes());
            p.push(rec.len() as u8);
            p.extend_from_slice(rec);
        }
        r.ask(msg::WRITE_MANY, &p)
    }

    /// LINK-35.2: ferrite's session says `LISTS` (128).
    #[test]
    fn hello_says_lists() {
        let mut r = RadioSide::new();
        let (s, a) = r.ask(msg::HELLO, &crate::answers::hello_payload("test"));
        assert_eq!(s, 0);
        let h = crate::answers::Hello::parse(&a).unwrap();
        assert!(h.caps & caps::LISTS != 0, "caps {:#x}", h.caps);
    }

    /// LINK-58: a preset's skip list written and read back through ferrite's session; it stays with its preset when
    /// the one before is deleted; one outside the range is refused with ferrite's reason; caps2 says so.
    #[test]
    fn preset_skips_through_ferrites_link() {
        use ferrite_app::data::RangePreset;
        let mut r = RadioSide::new();
        let (_, a) = r.ask(msg::HELLO, &crate::answers::hello_payload("test"));
        assert!(crate::answers::Hello::parse(&a).unwrap().caps2 & ferrite_core::link::caps2::PRESET_SKIPS != 0);
        let pr = |n: &[u8], start: u32| RangePreset { name: ferrite_ui::text::Buf::from(n), start, end: start + 400_000, step: 10, mode: 0, narrow: true, skips: 0, resume: 0 };
        r.seed_presets(&[pr(b"2 m", 14_400_000), pr(b"70 cm", 43_000_000)]);
        assert!(all(&mut r, what::PRESET_SKIPS).is_empty());
        let list: Vec<u32> = (1..=30).map(|j| 43_000_000 + 2_500 * j).collect();
        assert_eq!(write_many(&mut r, what::PRESET_SKIPS, &[(1, preset_skips_record(&list))]).0, 0);
        assert_eq!(preset_skips_from_record(&r.read_one(what::PRESET_SKIPS, 1).unwrap()), Some(list.clone()));
        assert_eq!(r.ask(msg::DELETE, &[what::PRESET, 0, 0]).0, 0);
        assert_eq!(preset_skips_from_record(&r.read_one(what::PRESET_SKIPS, 0).unwrap()), Some(list), "with its preset");
        let (s, why) = write_many(&mut r, what::PRESET_SKIPS, &[(0, preset_skips_record(&[14_400_000]))]);
        assert_eq!(s, Status::Invalid as u8);
        assert!(String::from_utf8_lossy(&why).contains("range"));
        assert_eq!(preset_skips_from_record(&[1, 2, 3]), None);
    }

    /// LINK-54: the nine quick messages read as the factory texts; one Console sets reads back as the owner's, the
    /// factory flag puts it back, and a text APRS can't carry is refused with ferrite's reason.
    #[test]
    fn quick_messages_through_ferrites_link() {
        let mut r = RadioSide::new();
        let q: Vec<QuickMessage> = all(&mut r, what::QUICK).iter().map(|x| quick_from_record(&x.1).unwrap()).collect();
        assert_eq!(q.len(), QUICK_COUNT as usize);
        assert!(q.iter().all(|m| !m.own && !m.text.is_empty()), "{q:?}");
        let mine = QuickMessage { own: true, text: "At the club".into() };
        assert_eq!(write_many(&mut r, what::QUICK, &[(3, quick_record(&mine))]).0, 0);
        assert_eq!(quick_from_record(&r.read_one(what::QUICK, 3).unwrap()), Some(mine));
        let (s, why) = write_many(&mut r, what::QUICK, &[(3, quick_record(&QuickMessage { own: true, text: "a|b".into() }))]);
        assert_eq!(s, Status::Invalid as u8);
        assert!(String::from_utf8_lossy(&why).contains("no | ~ {"));
        assert_eq!(write_many(&mut r, what::QUICK, &[(3, quick_record(&QuickMessage { own: false, text: String::new() }))]).0, 0);
        assert_eq!(quick_from_record(&r.read_one(what::QUICK, 3).unwrap()).map(|m| m.own), Some(false));
    }

    fn wp(n: i32) -> Waypoint {
        Waypoint { name: format!("WP {n}"), lat: 450_000_000 + n, lon: -750_000_000 - n, source: "link".into() }
    }

    fn waypoints(r: &mut RadioSide) -> Vec<Waypoint> {
        all(r, what::WAYPOINT).iter().map(|x| waypoint_from_record(&x.1).unwrap()).collect()
    }

    /// LINK-55: waypoints added at 0xFFFF become the newest; one replaced in place; [`waypoint_writes`] takes a list
    /// to another in one `WRITE_MANY` frame, whatever was added, moved or deleted; a bad name is refused with
    /// ferrite's reason.
    #[test]
    fn waypoints_through_ferrites_link() {
        let mut r = RadioSide::new();
        assert!(waypoints(&mut r).is_empty());
        let recs: Vec<_> = (0..3).map(|n| (WAYPOINT_ADD, waypoint_record(Some(&wp(n))))).collect();
        assert_eq!(write_many(&mut r, what::WAYPOINT, &recs), (0, vec![3]));
        assert_eq!(waypoints(&mut r), vec![wp(2), wp(1), wp(0)], "newest first");
        assert_eq!(write_many(&mut r, what::WAYPOINT, &[(1, waypoint_record(Some(&wp(9))))]).0, 0);
        assert_eq!(waypoints(&mut r), vec![wp(2), wp(9), wp(0)], "in its place");
        for want in [vec![wp(5), wp(2), wp(0)], vec![wp(2), wp(0)], vec![wp(0), wp(2), wp(7)], vec![], vec![wp(1)]] {
            let old = waypoints(&mut r);
            let w = waypoint_writes(&old, &want);
            if !w.is_empty() {
                assert_eq!(write_many(&mut r, what::WAYPOINT, &w).0, 0, "{old:?} -> {want:?}: {w:?}");
            }
            assert_eq!(waypoints(&mut r), want, "from {old:?}");
        }
        assert!(waypoint_writes(&[wp(1)], &[wp(1)]).is_empty(), "nothing to do");
        let bad = Waypoint { name: String::new(), ..wp(1) };
        let (s, why) = write_many(&mut r, what::WAYPOINT, &[(0, waypoint_record(Some(&bad)))]);
        assert_eq!(s, Status::Invalid as u8);
        assert!(String::from_utf8_lossy(&why).contains("name"));
        assert_eq!(waypoint_from_record(&waypoint_record(Some(&wp(3)))), Some(wp(3)));
    }

    /// LINK-56: a DTMF memory with its name written and read back (the symbols in capitals), cleared with an empty
    /// record; bad symbols refused with ferrite's reason; only the memories set are listed.
    #[test]
    fn dtmf_through_ferrites_link() {
        let mut r = RadioSide::new();
        assert!(all(&mut r, what::DTMF).is_empty());
        let m = DtmfMemory { symbols: "*79#a".into(), name: "Link on".into() };
        assert_eq!(write_many(&mut r, what::DTMF, &[(4, dtmf_record(Some(&m)))]).0, 0);
        let back = all(&mut r, what::DTMF);
        assert_eq!(back.len(), 1);
        assert_eq!((back[0].0, dtmf_from_record(&back[0].1)), (4, Some(DtmfMemory { symbols: "*79#A".into(), name: "Link on".into() })));
        let (s, why) = write_many(&mut r, what::DTMF, &[(4, dtmf_record(Some(&DtmfMemory { symbols: "12E".into(), name: String::new() })))]);
        assert_eq!(s, Status::Invalid as u8);
        assert!(String::from_utf8_lossy(&why).contains("symbols"));
        assert_eq!(write_many(&mut r, what::DTMF, &[(4, dtmf_record(None))]).0, 0);
        assert!(all(&mut r, what::DTMF).is_empty());
    }

    /// The editors' checks are ferrite's: a quick message APRS can't carry, a waypoint without a name or off the
    /// globe, DTMF symbols the dialer can't send; the factory texts are the radio's.
    #[test]
    fn checks_are_ferrites() {
        assert_eq!(quick_factory().len(), QUICK_COUNT as usize);
        assert!(quick_factory().iter().all(|t| !t.is_empty()));
        assert_eq!(check_quick(&QuickMessage { own: true, text: "QRV on 146.52".into() }), None);
        assert!(check_quick(&QuickMessage { own: true, text: "a~b".into() }).unwrap().contains("no | ~ {"));
        assert!(check_quick(&QuickMessage { own: true, text: "x".repeat(68) }).is_some());
        assert_eq!(check_quick(&QuickMessage { own: false, text: "a~b".into() }), None, "the factory text");
        assert_eq!(check_waypoint(&wp(1)), None);
        assert!(check_waypoint(&Waypoint { name: String::new(), ..wp(1) }).unwrap().contains("name"));
        assert!(check_waypoint(&Waypoint { lat: 910_000_000, ..wp(1) }).is_some());
        assert_eq!(check_dtmf(&DtmfMemory { symbols: "*79#".into(), name: "Link on".into() }), None);
        assert!(check_dtmf(&DtmfMemory { symbols: "12E".into(), name: String::new() }).unwrap().contains("symbols"));
        assert!(check_dtmf(&DtmfMemory { symbols: "1".repeat(17), name: String::new() }).is_some());
    }

    /// LINK-57: subscribed to the event log, an event logged on the radio side comes as kind 5 and reads as the
    /// Activity Log's record.
    #[test]
    fn event_log_events_through_ferrites_link() {
        let mut r = RadioSide::new();
        let (s, _) = r.ask(msg::SUBSCRIBE, &crate::aprs::subscribe_payload(ev::SUB_LOG, 0, false, false));
        assert_eq!(s, 0);
        r.store.log("*79#");
        let evs = r.events();
        assert_eq!(evs.len(), 1, "{evs:?}");
        match crate::aprs::parse_event(&evs[0]) {
            Some(crate::aprs::Event::Log { record }) => assert_eq!((record.source.as_str(), record.text.as_str(), record.seq), ("DTMF", "*79#", 0)),
            e => panic!("{e:?}"),
        }
        assert!(r.events().is_empty(), "each once");
    }
}
