//! A channel and zone set, its backup file, and the write plan: what changes between what the radio holds and what
//! the table says, as the requests that make it so (LINK-9's `BEGIN` .. `END` session), checked first by running
//! the whole plan through ferrite's own link session ([`crate::radioside`]) seeded with the radio's set, so every
//! refusal shows before anything is sent.

use crate::answers::status_text;
use crate::channels::{channel_from_record, channel_record, zone_from_record, zone_record, ChanView, ZoneView};
use crate::radioside::{RadioSide, MAX_ZONES};
use crate::records::{begin_payload, delete_payload, write_payloads};
use ferrite_app::chan::{Channel, ChannelStore, Name, NO_ZONE};
use ferrite_app::data::ZoneCfg;
use ferrite_core::link::{msg, what};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A set in the radio's own types: zones (name, settings) in order, and channels.
pub type Parts = (Vec<(Name, ZoneCfg)>, Vec<Channel>);

/// Every zone (in order, numbered 1..) and channel (by number) on a radio, as the table holds them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Set {
    pub zones: Vec<ZoneView>,
    pub channels: Vec<ChanView>,
}

impl Set {
    /// The set from records as read (zone records in index order; channel records in any order). Records that
    /// don't parse are left out and named.
    pub fn from_records(zones: &[Vec<u8>], channels: &[Vec<u8>]) -> (Set, Vec<String>) {
        let mut bad = Vec::new();
        let mut set = Set::default();
        for (i, r) in zones.iter().enumerate() {
            match zone_from_record(r) {
                Some((n, c)) => set.zones.push(ZoneView::of(i as u8, n.as_bytes(), &c)),
                None => bad.push(format!("zone {}: a record of {} bytes didn't parse", i + 1, r.len())),
            }
        }
        for r in channels {
            match channel_from_record(r) {
                Some(c) => set.channels.push(ChanView::of(&c)),
                None => bad.push(format!("a channel record of {} bytes didn't parse", r.len())),
            }
        }
        set.channels.sort_by_key(|c| c.number);
        (set, bad)
    }

    /// The radio's types: zones and channels, or the first field that doesn't parse.
    pub fn parts(&self) -> Result<Parts, Problem> {
        let zones = self
            .zones
            .iter()
            .map(|z| z.zone().map_err(|e| Problem::zone(z.number, e)))
            .collect::<Result<Vec<_>, _>>()?;
        let chans = self
            .channels
            .iter()
            .map(|c| c.channel().map_err(|e| Problem::channel(c.number, e)))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((zones, chans))
    }
}

/// Something wrong with one record: which, and what (ferrite's own words when the check is the radio's).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    /// "zone", "channel" or "set".
    pub what: String,
    pub number: u16,
    pub error: String,
}

impl Problem {
    fn zone(n: u8, e: String) -> Self {
        Problem { what: "zone".into(), number: n as u16, error: e }
    }
    fn channel(n: u16, e: String) -> Self {
        Problem { what: "channel".into(), number: n, error: e }
    }
}

/// One request of a write session, ready for the link: `WRITE` parts or a `DELETE`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Op {
    /// "write" or "delete".
    pub kind: &'static str,
    /// "zone" or "channel".
    pub what: &'static str,
    /// As the radio shows it (1-based).
    pub number: u16,
    pub msg: u8,
    /// The payloads, in order: a `WRITE`'s parts, or the one `DELETE`.
    pub payloads: Vec<Vec<u8>>,
}

/// A field that changes: its name and the values before and after.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Field {
    pub field: String,
    pub from: String,
    pub to: String,
}

/// A record that changes, for the diff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Change {
    pub what: &'static str,
    pub number: u16,
    /// "added", "changed" or "deleted".
    pub kind: &'static str,
    /// The name (the new one, or the old one for a deletion).
    pub name: String,
    pub fields: Vec<Field>,
}

/// What a write does: the diff, the requests (`begin` first, `END` after the ops), and what would be refused.
#[derive(Clone, Debug, Serialize)]
pub struct Plan {
    pub changes: Vec<Change>,
    pub begin: Vec<u8>,
    pub ops: Vec<Op>,
    pub problems: Vec<Problem>,
}

/// A refusal in ferrite's words: an `invalid` answer's reason, else the status's name.
fn reason(s: u8, rest: &[u8]) -> String {
    status_text(s, rest).trim_start_matches("invalid: ").to_string()
}

fn fields<T: Serialize>(a: &T, b: &T) -> Vec<Field> {
    let (serde_json::Value::Object(a), serde_json::Value::Object(b)) =
        (serde_json::to_value(a).unwrap_or_default(), serde_json::to_value(b).unwrap_or_default())
    else {
        return Vec::new();
    };
    let text = |v: Option<&serde_json::Value>| match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Null) | None => "none".into(),
        Some(v) => v.to_string(),
    };
    a.keys()
        .filter(|k| a.get(*k) != b.get(*k))
        .map(|k| Field { field: k.clone(), from: text(a.get(k)), to: text(b.get(k)) })
        .collect()
}

/// The plan that turns `base` (what the radio holds) into `want` (the table). Zones are written first (a new one
/// is the next index), then channels deleted and written, then zones past the new count deleted, last first
/// (their channels have moved by then). The whole plan is run through ferrite's link session first: its refusals
/// are the plan's problems, and a plan with problems must not be sent.
pub fn plan(base: &Set, want: &Set) -> Plan {
    let mut problems = Vec::new();
    let mut changes = Vec::new();
    let mut ops = Vec::new();
    let (base_parts, want_parts) = match (base.parts(), want.parts()) {
        (Ok(b), Ok(w)) => (b, w),
        (Err(p), _) => {
            problems.push(Problem { error: format!("the radio's own set: {}", p.error), ..p });
            return Plan { changes, begin: begin_payload(0), ops, problems };
        }
        (_, Err(p)) => {
            problems.push(p);
            return Plan { changes, begin: begin_payload(0), ops, problems };
        }
    };
    let (bz, bc) = &base_parts;
    let (wz, wc) = &want_parts;
    if wz.len() > MAX_ZONES {
        problems.push(Problem { what: "set".into(), number: 0, error: format!("at most {MAX_ZONES} zones") });
    }
    for (i, z) in want.zones.iter().enumerate() {
        if z.number as usize != i + 1 {
            problems.push(Problem::zone(z.number, format!("zones are numbered in order: this is zone {}", i + 1)));
        }
    }

    // Zones: written where new or changed.
    for (i, (n, c)) in wz.iter().enumerate() {
        let old = bz.get(i);
        if old.map(|(on, oc)| (on, oc)) == Some((n, c)) {
            continue;
        }
        let v = &want.zones[i];
        changes.push(Change {
            what: "zone",
            number: v.number as u16,
            kind: if old.is_some() { "changed" } else { "added" },
            name: v.name.clone(),
            fields: old.map_or_else(Vec::new, |(on, oc)| {
                fields(&ZoneView::of(i as u8, on.as_bytes(), oc), &ZoneView::of(i as u8, n.as_bytes(), c))
            }),
        });
        ops.push(Op {
            kind: "write",
            what: "zone",
            number: v.number as u16,
            msg: msg::WRITE,
            payloads: write_payloads(what::ZONE, i as u16, &zone_record(n.as_bytes(), c)),
        });
    }

    // Channels: deleted, then written.
    let old: BTreeMap<u16, (&Channel, &ChanView)> =
        bc.iter().zip(&base.channels).map(|(c, v)| (c.num, (c, v))).collect();
    let new: BTreeMap<u16, (&Channel, &ChanView)> =
        wc.iter().zip(&want.channels).map(|(c, v)| (c.num, (c, v))).collect();
    if new.len() != wc.len() {
        problems.push(Problem { what: "set".into(), number: 0, error: "two channels have the same number".into() });
    }
    for (num, (_, v)) in old.iter().filter(|(n, _)| !new.contains_key(n)) {
        changes.push(Change {
            what: "channel",
            number: v.number,
            kind: "deleted",
            name: v.name.clone(),
            fields: Vec::new(),
        });
        ops.push(Op {
            kind: "delete",
            what: "channel",
            number: v.number,
            msg: msg::DELETE,
            payloads: vec![delete_payload(what::CHANNEL, *num)],
        });
    }
    for (num, (c, v)) in &new {
        if c.zone != NO_ZONE && c.zone as usize >= wz.len() {
            problems.push(Problem::channel(v.number, format!("zone {}: there is no such zone", c.zone as u32 + 1)));
        }
        let was = old.get(num);
        if was.is_some_and(|(oc, _)| oc == c) {
            continue;
        }
        changes.push(Change {
            what: "channel",
            number: v.number,
            kind: if was.is_some() { "changed" } else { "added" },
            name: v.name.clone(),
            fields: was.map_or_else(Vec::new, |(oc, _)| fields(&ChanView::of(oc), &ChanView::of(c))),
        });
        ops.push(Op {
            kind: "write",
            what: "channel",
            number: v.number,
            msg: msg::WRITE,
            payloads: write_payloads(what::CHANNEL, *num, &channel_record(c)),
        });
    }

    // Zones past the new count, last first.
    for i in (wz.len()..bz.len()).rev() {
        let v = &base.zones[i];
        changes.push(Change {
            what: "zone",
            number: v.number as u16,
            kind: "deleted",
            name: v.name.clone(),
            fields: Vec::new(),
        });
        ops.push(Op {
            kind: "delete",
            what: "zone",
            number: v.number as u16,
            msg: msg::DELETE,
            payloads: vec![delete_payload(what::ZONE, i as u16)],
        });
    }

    problems.extend(dry_run(&base_parts, &ops, &want_parts));
    Plan { changes, begin: begin_payload(ops.len() as u16), ops, problems }
}

/// The plan through ferrite's own radio side, seeded with the radio's set: every refusal, with ferrite's reason;
/// then what it ends up holding, against what the table wants.
fn dry_run(base: &Parts, ops: &[Op], want: &Parts) -> Vec<Problem> {
    let mut r = RadioSide::new();
    r.seed(&base.0, &base.1);
    let mut out = Vec::new();
    let (s, rest) = r.ask(msg::BEGIN, &begin_payload(ops.len() as u16));
    if s != 0 {
        out.push(Problem { what: "set".into(), number: 0, error: status_text(s, &rest) });
    }
    for op in ops {
        for p in &op.payloads {
            let (s, rest) = r.ask(op.msg, p);
            if s != 0 {
                out.push(Problem { what: op.what.into(), number: op.number, error: reason(s, &rest) });
                break;
            }
        }
    }
    r.ask(msg::END, &[]);
    if out.is_empty() {
        let zones = r.store.zones.borrow().clone();
        if zones.len() != want.0.len() || zones.iter().zip(&want.0).any(|(a, b)| a.0 != b.0 || a.1 != b.1) {
            out.push(Problem {
                what: "set".into(),
                number: 0,
                error: "the zones would not end up as the table has them".into(),
            });
        }
        for c in &want.1 {
            if r.store.get(c.num) != Some(*c) {
                out.push(Problem::channel(c.num + 1, "the radio would store this channel differently".into()));
            }
        }
        if r.store.count() as usize != want.1.len() {
            out.push(Problem {
                what: "set".into(),
                number: 0,
                error: "the channel count would not match the table".into(),
            });
        }
    }
    out
}

/// One channel's problem, checked as the radio would (its fields, then ferrite's own link checks with `zones`
/// zones), or None. For the table, as a row is edited.
pub fn check_channel(v: &ChanView, zones: u8) -> Option<String> {
    let c = match v.channel() {
        Ok(c) => c,
        Err(e) => return Some(e),
    };
    if c.zone != NO_ZONE && c.zone >= zones {
        return Some(format!("zone {}: there is no such zone", c.zone as u32 + 1));
    }
    thread_local! {
        static R: std::cell::RefCell<RadioSide> = std::cell::RefCell::new(RadioSide::new());
    }
    R.with_borrow_mut(|r| {
        let zs: Vec<(Name, ZoneCfg)> =
            (0..zones).map(|i| (Name::from(format!("Zone {}", i + 1).as_bytes()), ZoneCfg::default())).collect();
        r.seed(&zs, &[]);
        for p in write_payloads(what::CHANNEL, c.num, &channel_record(&c)) {
            let (s, rest) = r.ask(msg::WRITE, &p);
            if s != 0 {
                return Some(reason(s, &rest));
            }
        }
        None
    })
}

/// The backup file: Console's own JSON, the records as the radio's bytes (hex), with the views beside them for
/// reading. A restore reads the records only.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Backup {
    pub format: String,
    pub version: u32,
    /// When it was saved (ISO 8601, the caller's clock).
    pub saved: String,
    /// The radio it came from: firmware, callsign, unique ID text (whatever the caller knew).
    #[serde(default)]
    pub radio: BTreeMap<String, String>,
    pub zones: Vec<BackupRecord>,
    pub channels: Vec<BackupRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupRecord {
    pub number: u16,
    pub name: String,
    /// The record as the link carries it, hex.
    pub record: String,
}

pub const BACKUP_FORMAT: &str = "ferrite-console-channels";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    s.len().is_multiple_of(2).then_some(())?;
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// The set as a backup file (pretty JSON).
pub fn backup(set: &Set, saved: &str, radio: BTreeMap<String, String>) -> Result<String, Problem> {
    let (zones, chans) = set.parts()?;
    let b = Backup {
        format: BACKUP_FORMAT.into(),
        version: 1,
        saved: saved.into(),
        radio,
        zones: zones
            .iter()
            .zip(&set.zones)
            .map(|((n, c), v)| BackupRecord {
                number: v.number as u16,
                name: v.name.clone(),
                record: hex(&zone_record(n.as_bytes(), c)),
            })
            .collect(),
        channels: chans
            .iter()
            .zip(&set.channels)
            .map(|(c, v)| BackupRecord { number: v.number, name: v.name.clone(), record: hex(&channel_record(c)) })
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&b).unwrap_or_default())
}

/// A backup file back to a set (zones in their numbers' order), or why not.
pub fn restore(text: &str) -> Result<(Set, Backup), String> {
    let b: Backup = serde_json::from_str(text).map_err(|e| format!("not a Ferrite Console backup: {e}"))?;
    if b.format != BACKUP_FORMAT {
        return Err(format!("not a channel backup (format {:?})", b.format));
    }
    if b.version != 1 {
        return Err(format!("backup version {} is newer than this Console reads", b.version));
    }
    let mut zones = b.zones.clone();
    zones.sort_by_key(|z| z.number);
    for (i, z) in zones.iter().enumerate() {
        if z.number as usize != i + 1 {
            return Err(format!("zone {} is missing from the backup", i + 1));
        }
    }
    let rec =
        |r: &BackupRecord, w: &str| unhex(&r.record).ok_or_else(|| format!("{w} {}: its record isn't hex", r.number));
    let zr = zones.iter().map(|z| rec(z, "zone")).collect::<Result<Vec<_>, _>>()?;
    let cr = b.channels.iter().map(|c| rec(c, "channel")).collect::<Result<Vec<_>, _>>()?;
    let (set, bad) = Set::from_records(&zr, &cr);
    if let Some(e) = bad.first() {
        return Err(e.clone());
    }
    Ok((set, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Set {
        let mut z1 = ZoneView::new(1, "Local");
        z1.scan_all = true;
        let z2 = ZoneView::new(2, "Repeaters");
        let mut a = ChanView::new(1, 14_652_000);
        a.name = "Calling 2 m".into();
        a.zone = Some(0);
        let mut b = ChanView::new(10, 14_694_000);
        b.name = "North hill".into();
        b.zone = Some(1);
        b.duplex = "-".into();
        b.offset = "0.6".into();
        b.tx_tone = "100.0".into();
        let b = ChanView::of(&b.channel().unwrap());
        let mut c = ChanView::new(20, 44_600_000);
        c.name = "Calling 70 cm".into();
        Set { zones: vec![z1, z2], channels: vec![a, b, c] }
    }

    #[test]
    fn nothing_changed_nothing_sent() {
        let p = plan(&base(), &base());
        assert!(p.changes.is_empty() && p.ops.is_empty() && p.problems.is_empty(), "{p:?}");
        assert_eq!(p.begin, [0, 0]);
    }

    /// LINK-9: a write session in order (zones, channel deletes and writes, zones removed last), checked against
    /// ferrite's link session with nothing refused, and the diff names the fields.
    #[test]
    fn edits_add_delete() {
        let b = base();
        let mut w = b.clone();
        w.channels[1].name = "North hill rpt".into();
        w.channels[1].power = "High".into();
        w.channels.remove(2);
        let mut n = ChanView::new(30, 14_557_500);
        n.name = "Simplex".into();
        n.zone = Some(2);
        w.channels.push(n);
        w.zones.push(ZoneView::new(3, "New"));
        let p = plan(&b, &w);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        let kinds: Vec<_> = p.ops.iter().map(|o| (o.kind, o.what, o.number)).collect();
        assert_eq!(
            kinds,
            [("write", "zone", 3), ("delete", "channel", 20), ("write", "channel", 10), ("write", "channel", 30)]
        );
        assert_eq!(p.begin, [4, 0]);
        let ch = p.changes.iter().find(|c| c.number == 10).unwrap();
        assert_eq!(ch.kind, "changed");
        let f: Vec<_> = ch.fields.iter().map(|f| (f.field.as_str(), f.from.as_str(), f.to.as_str())).collect();
        assert_eq!(f, [("name", "North hill", "North hill rpt"), ("power", "Low", "High")]);
    }

    /// Removing the last zone: its channels must move first, and the zone goes last.
    #[test]
    fn zone_removed_last() {
        let b = base();
        let mut w = b.clone();
        w.zones.pop();
        let p = plan(&b, &w);
        assert!(p.problems.iter().any(|x| x.number == 10 && x.error.contains("no such zone")), "{:?}", p.problems);
        w.channels[1].zone = None;
        let p = plan(&b, &w);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.ops.last().map(|o| (o.kind, o.what, o.number)), Some(("delete", "zone", 2)));
    }

    /// The radio's own checks refuse in the dry run, with ferrite's words.
    #[test]
    fn ferrite_refusals_show_before_writing() {
        let b = base();
        let mut w = b.clone();
        w.channels[0].rx = "700.0".into();
        w.channels[2].mode = "USB".into();
        let p = plan(&b, &w);
        let e: Vec<_> = p.problems.iter().map(|x| (x.number, x.error.clone())).collect();
        assert_eq!(e.len(), 2, "{e:?}");
        assert!(e[0].1.contains("756-1300 MHz") && e[1].1.contains("mode or step"), "{e:?}");
        assert_eq!(check_channel(&w.channels[0], 2).as_deref().map(|s| s.contains("756-1300")), Some(true));
        assert_eq!(check_channel(&b.channels[1], 2), None);
        assert!(check_channel(&b.channels[1], 1).unwrap().contains("no such zone"));
    }

    #[test]
    fn backup_round_trip() {
        let b = base();
        let mut radio = BTreeMap::new();
        radio.insert("firmware".into(), "0.1.0".into());
        let text = backup(&b, "2026-10-20T12:00:00Z", radio).unwrap();
        let (back, file) = restore(&text).unwrap();
        assert_eq!(back, b);
        assert_eq!(file.radio["firmware"], "0.1.0");
        assert!(restore("{}").is_err());
        assert!(restore(&text.replace(BACKUP_FORMAT, "other")).is_err());
    }
}
