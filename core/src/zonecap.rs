//! A zone holds at most 256 channels (CHAN-35, decision 333); "no zone" has no limit. The radio refuses a 257th
//! whichever way it comes, so Console refuses it first, everywhere a channel can enter a zone: the table's editors,
//! Add channels, the CHIRP and RepeaterBook imports, a codeplug or backup opened. A list longer than a zone holds is
//! split over zones instead ([`split_full_zones`]), the way the radio's own update splits one (Appendix G, "Layout 2
//! to 3": the first 256 by number stay, the rest go 256 at a time to new zones named " 2", " 3" and so on).

use crate::channels::{ZoneView, ZONE_CAP};
use crate::plan::Set;
use crate::radioside::MAX_ZONES;
use serde::Serialize;

/// The refusal's words, as the radio's terminal says them (CHAN-35).
pub const FULL: &str = "zone full (256 channels at most)";

/// Channels in each of the table's zones, by index (channels naming a zone the table doesn't have aren't counted).
pub fn counts(set: &Set) -> Vec<usize> {
    let mut n = vec![0usize; set.zones.len()];
    for c in &set.channels {
        if let Some(k) = c.zone.and_then(|z| n.get_mut(z as usize)) {
            *k += 1;
        }
    }
    n
}

/// A zone holding more channels than it may.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Over {
    /// As the radio shows it, 1-512.
    pub number: u16,
    pub name: String,
    pub count: usize,
}

/// The table's zones over [`ZONE_CAP`], in order.
pub fn over_cap(set: &Set) -> Vec<Over> {
    counts(set)
        .into_iter()
        .enumerate()
        .filter(|&(_, n)| n > ZONE_CAP)
        .map(|(i, n)| Over { number: i as u16 + 1, name: set.zones[i].name.trim_end().to_string(), count: n })
        .collect()
}

/// What an over-full zone means, in words: "Zone 3 Repeaters would hold 300 channels: a zone holds 256 at most".
pub fn over_text(o: &Over) -> String {
    format!("zone {} {} would hold {} channels: a zone holds {ZONE_CAP} at most", o.number, o.name, o.count)
}

/// The `k`th part's name of a zone named `base`: `base` cut so " k" still fits the 16 characters a zone name holds.
pub fn part_name(base: &str, k: usize) -> String {
    let suffix = format!(" {k}");
    let base = base.trim_end();
    let keep = 16usize.saturating_sub(suffix.len());
    let cut: String = base.chars().take(keep).collect();
    format!("{}{suffix}", cut.trim_end())
}

/// What [`split_full_zones`] did.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Split {
    pub set: Set,
    /// One line per zone split ("Zone Repeaters had 300 channels: 44 moved to a new zone, Repeaters 2 (a zone holds
    /// 256 at most)"); empty when nothing was over.
    pub notes: Vec<String>,
    /// Zones made.
    pub made: usize,
    /// Channels left with no zone because the radio's 512 zones ran out.
    pub unzoned: usize,
}

/// Every zone over 256 split: its first 256 channels (by number) stay; the rest go, 256 at a time, to new zones at the
/// end of the table, each a copy of the zone's settings named " 2", " 3" and so on (cut to 16 characters; a name the
/// table already has takes the next number). With no zone number left (512), the rest go to no zone, said so.
pub fn split_full_zones(set: &Set) -> Split {
    let mut out = Split { set: set.clone(), ..Split::default() };
    let over = over_cap(set);
    for o in over {
        let idx = (o.number - 1) as usize;
        let src = out.set.zones[idx].clone();
        let mut members: Vec<usize> =
            (0..out.set.channels.len()).filter(|&i| out.set.channels[i].zone == Some(idx as u16)).collect();
        members.sort_by_key(|&i| out.set.channels[i].number);
        let rest = &members[ZONE_CAP..];
        let mut made = Vec::new();
        let mut unzoned = 0;
        let mut k = 2;
        for chunk in rest.chunks(ZONE_CAP) {
            if out.set.zones.len() >= MAX_ZONES {
                for &i in chunk {
                    out.set.channels[i].zone = None;
                }
                unzoned += chunk.len();
                continue;
            }
            let name = loop {
                let n = part_name(&src.name, k);
                k += 1;
                if !out.set.zones.iter().any(|z| z.name.trim_end().eq_ignore_ascii_case(&n)) {
                    break n;
                }
            };
            let number = out.set.zones.len() as u16 + 1;
            out.set.zones.push(ZoneView { number, name: name.clone(), pri1: None, pri2: None, ..src.clone() });
            for &i in chunk {
                out.set.channels[i].zone = Some(number - 1);
            }
            made.push((name, chunk.len()));
        }
        let moved: Vec<String> = made.iter().map(|(n, c)| format!("{c} to {n}")).collect();
        let mut line = format!("Zone {} had {} channels (a zone holds {ZONE_CAP} at most)", o.name, o.count);
        if !moved.is_empty() {
            line += &format!(": {} moved to {}", made.iter().map(|m| m.1).sum::<usize>(), if made.len() == 1 { "a new zone" } else { "new zones" });
            line += &format!(" ({})", moved.join(", "));
        }
        if unzoned > 0 {
            line += &format!("; {unzoned} left with no zone (the radio holds {MAX_ZONES} zones)");
        }
        out.notes.push(line);
        out.made += made.len();
        out.unzoned += unzoned;
    }
    out
}

/// Whether `numbers` (as the radio shows them) may all go into zone `zone` (its index): the zone's channels after the
/// move, against the cap. `None` (no zone) always may. The count after, or the refusal's words.
pub fn room(set: &Set, numbers: &[u16], zone: Option<u16>) -> Result<usize, String> {
    let Some(z) = zone else { return Ok(0) };
    let moving: std::collections::BTreeSet<u16> = numbers.iter().copied().collect();
    let staying = set.channels.iter().filter(|c| c.zone == Some(z) && !moving.contains(&c.number)).count();
    let entering = set.channels.iter().filter(|c| moving.contains(&c.number)).count();
    let after = staying + entering;
    if after > ZONE_CAP {
        let name = set.zones.get(z as usize).map_or(String::new(), |v| format!(" {}", v.name.trim_end()));
        let left = ZONE_CAP.saturating_sub(staying);
        return Err(format!(
            "Zone {}{name} is full: it holds {ZONE_CAP} channels at most ({staying} there, {entering} to move; room for {left})",
            z + 1
        ));
    }
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::ChanView;

    fn set(zones: &[&str], members: &[(u16, Option<u16>)]) -> Set {
        Set {
            zones: zones.iter().enumerate().map(|(i, z)| ZoneView::new(i as u16 + 1, z)).collect(),
            channels: members
                .iter()
                .map(|&(n, z)| ChanView { zone: z, ..ChanView::new(n, 14_400_000 + n as u32 * 1250) })
                .collect(),
        }
    }

    /// CHAN-35: a 600-channel zone keeps its first 256 by number; 256 and 88 go to " 2" and " 3", settings copied,
    /// priority channels not; the counts end at 256 or less.
    #[test]
    fn splits_like_the_radios_update() {
        let mut members: Vec<(u16, Option<u16>)> = (1..=600).rev().map(|n| (n, Some(1))).collect();
        members.push((601, Some(0)));
        members.push((602, None));
        let mut s = set(&["Local", "Repeaters"], &members);
        s.zones[1].resume = "Carrier".into();
        s.zones[1].pri1 = Some(3);
        assert_eq!(over_cap(&s), [Over { number: 2, name: "Repeaters".into(), count: 600 }]);
        let r = split_full_zones(&s);
        assert!(over_cap(&r.set).is_empty());
        assert_eq!(counts(&r.set), [1, 256, 256, 88]);
        assert_eq!(r.set.zones[2].name, "Repeaters 2");
        assert_eq!((r.set.zones[3].name.as_str(), r.set.zones[3].number), ("Repeaters 3", 4));
        assert_eq!((r.set.zones[2].resume.as_str(), r.set.zones[2].pri1), ("Carrier", None));
        let zone_of = |n: u16| r.set.channels.iter().find(|c| c.number == n).unwrap().zone;
        assert_eq!((zone_of(1), zone_of(256), zone_of(257), zone_of(513), zone_of(602)), (Some(1), Some(1), Some(2), Some(3), None));
        assert_eq!(r.made, 2);
        assert!(r.notes[0].starts_with("Zone Repeaters had 600 channels"), "{:?}", r.notes);
        assert!(split_full_zones(&r.set).notes.is_empty(), "nothing left to split");
    }

    /// Names keep their number inside 16 characters; one the table has is skipped; no zone left: no zone.
    #[test]
    fn names_and_no_room() {
        assert_eq!(part_name("Exactly 16 chars", 2), "Exactly 16 cha 2");
        assert_eq!(part_name("Club", 12), "Club 12");
        let members: Vec<(u16, Option<u16>)> = (1..=300).map(|n| (n, Some(0))).collect();
        let s = set(&["Club", "Club 2"], &members);
        assert_eq!(split_full_zones(&s).set.zones[2].name, "Club 3");
        let names: Vec<String> = (1..=MAX_ZONES).map(|k| format!("Z{k}")).collect();
        let s = set(&names.iter().map(|n| n.as_str()).collect::<Vec<_>>(), &members);
        let r = split_full_zones(&s);
        assert_eq!((r.made, r.unzoned, r.set.zones.len()), (0, 44, MAX_ZONES));
        assert!(r.notes[0].contains("44 left with no zone"), "{:?}", r.notes);
    }

    /// Moving into a zone: refused past 256, a channel already there counted once; no zone always has room.
    #[test]
    fn room_for_a_move() {
        let members: Vec<(u16, Option<u16>)> = (1..=255).map(|n| (n, Some(0))).chain([(300, None), (301, None)]).collect();
        let s = set(&["Local"], &members);
        assert_eq!(room(&s, &[300], Some(0)), Ok(256));
        assert!(room(&s, &[300, 301], Some(0)).unwrap_err().contains("Zone 1 Local is full"));
        assert_eq!(room(&s, &[1, 300], Some(0)), Ok(256), "one already there");
        assert_eq!(room(&s, &[300, 301], None), Ok(0));
    }
}
