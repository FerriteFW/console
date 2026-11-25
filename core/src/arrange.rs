//! Arranging the channel table (console#55, console#104): renumbering every channel into continuous numbers,
//! inserting a channel between two others, and moving several channels together. A channel's number is its place on
//! the radio, so each of these is a renumbering (old number -> new), applied by [`apply`] with what names a channel
//! by number following it: the zones' priority channels and the home channel (CHAN-18). A zone's members follow by
//! themselves (each channel holds its own zone), and so do a channel's flags (scan skip) and position.
//!
//! The rule all of them share, as the table's single-channel move already does: a channel pushed out of a number moves
//! one along as far as the first free number, so a gap in the numbering stops the shift and nothing past it changes.
//! Every function here is pure: the table and its home channel in, the new table out (or why not), so the page can
//! show what would change before it changes anything, and each arrangement is one undo there.

use crate::channels::{ChanView, MAX_CHANNELS};
use crate::plan::Set;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// One channel's number changing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Move {
    pub from: u16,
    pub to: u16,
}

/// An arrangement: the table after it, its home channel, and which channels changed number (by old number).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Arranged {
    pub set: Set,
    pub home: Option<u16>,
    pub moved: Vec<Move>,
    /// The channel an insert added (its number), else None.
    pub added: Option<u16>,
}

/// The channels renumbered by `map` (old -> new; channels not in it keep theirs), and what names a channel by number
/// with them: the zones' priority channels and the home channel (CHAN-18). Refused when two channels would end on one
/// number or a number is outside 1-4000.
pub fn apply(set: &Set, home: Option<u16>, map: &BTreeMap<u16, u16>) -> Result<(Set, Option<u16>), String> {
    let to = |n: u16| map.get(&n).copied().unwrap_or(n);
    let mut out = set.clone();
    let mut seen = BTreeSet::new();
    for c in &mut out.channels {
        c.number = to(c.number);
        if !(1..=MAX_CHANNELS).contains(&c.number) {
            return Err(format!("channels are 1 to {MAX_CHANNELS}"));
        }
        if !seen.insert(c.number) {
            return Err(format!("two channels would be {}", c.number));
        }
    }
    out.channels.sort_by_key(|c| c.number);
    for z in &mut out.zones {
        z.pri1 = z.pri1.map(to);
        z.pri2 = z.pri2.map(to);
    }
    Ok((out, home.map(to)))
}

/// The channels a renumbering changes (old -> new), in old-number order.
pub fn moves(map: &BTreeMap<u16, u16>) -> Vec<Move> {
    map.iter().filter(|(a, b)| a != b).map(|(&from, &to)| Move { from, to }).collect()
}

fn arranged(
    set: &Set,
    home: Option<u16>,
    map: BTreeMap<u16, u16>,
    added: Option<ChanView>,
) -> Result<Arranged, String> {
    let (mut set, home) = apply(set, home, &map)?;
    let added = added.map(|c| {
        let n = c.number;
        let at = set.channels.partition_point(|x| x.number < n);
        set.channels.insert(at, c);
        n
    });
    Ok(Arranged { set, home, moved: moves(&map), added })
}

/// "5", or "5–9".
fn span(a: u16, b: u16) -> String {
    if a == b {
        a.to_string()
    } else {
        format!("{a}–{b}")
    }
}

/// Numbers `at`.. `at + k - 1` freed in `used` (the channel numbers in the way): with `down` the channels there move
/// to higher numbers, each one along as far as the first free number; else to lower numbers. Old -> new for the
/// channels that move; refused when the end of the range (1 or `max`) comes first.
pub fn make_room(used: &BTreeSet<u16>, at: u16, k: u16, max: u16, down: bool) -> Result<BTreeMap<u16, u16>, String> {
    let mut map = BTreeMap::new();
    if k == 0 {
        return Ok(map);
    }
    let last = at as u32 + k as u32 - 1;
    if at < 1 || last > max as u32 {
        return Err(format!("{} would need numbers {}: channels are 1 to {max}", plural(k), span(at, last as u16)));
    }
    if down {
        let mut next = last + 1; // the next number a pushed channel takes
        for &n in used.range(at..) {
            if (n as u32) < next {
                if next > max as u32 {
                    return Err(format!(
                        "no room: every number from {at} to {max} is used, so the channels there can't move along (renumber, or delete one past it, first)"
                    ));
                }
                map.insert(n, next as u16);
                next += 1;
            } else {
                break; // a gap: nothing past it moves
            }
        }
    } else {
        let mut next = at as i32 - 1;
        for &n in used.range(..=last as u16).rev() {
            if (n as i32) > next {
                if next < 1 {
                    return Err(format!(
                        "no room: every number from 1 to {last} is used, so the channels there can't move along (renumber first)"
                    ));
                }
                map.insert(n, next as u16);
                next -= 1;
            } else {
                break;
            }
        }
    }
    Ok(map)
}

fn plural(k: u16) -> String {
    if k == 1 {
        "1 channel".into()
    } else {
        format!("{k} channels")
    }
}

/// Every channel renumbered top to bottom into continuous numbers from `start` (1 closes every gap), in the order
/// they have now. Refused when they don't fit below 4000.
pub fn renumber(set: &Set, home: Option<u16>, start: u16) -> Result<Arranged, String> {
    let n = set.channels.len() as u32;
    if start < 1 || (n > 0 && start as u32 + n - 1 > MAX_CHANNELS as u32) {
        return Err(format!("{} from {start} would pass {MAX_CHANNELS}", plural(n as u16)));
    }
    let mut nums: Vec<u16> = set.channels.iter().map(|c| c.number).collect();
    nums.sort_unstable();
    let map = nums.iter().enumerate().map(|(i, &old)| (old, start + i as u16)).collect();
    arranged(set, home, map, None)
}

/// A new channel (`new`, its number ignored) at number `at`: when `at` is used, the channels from there move one
/// along to higher numbers as far as the first free number (the row's "Insert above": `at` is the row's number;
/// "below": the row's number + 1). Refused when every number from `at` to 4000 is used.
pub fn insert(set: &Set, home: Option<u16>, at: u16, new: &ChanView) -> Result<Arranged, String> {
    if !(1..=MAX_CHANNELS).contains(&at) {
        return Err(format!("channels are 1 to {MAX_CHANNELS}"));
    }
    let used: BTreeSet<u16> = set.channels.iter().map(|c| c.number).collect();
    let map = make_room(&used, at, 1, MAX_CHANNELS, true).map_err(|e| format!("Can't insert at {at}: {e}"))?;
    arranged(set, home, map, Some(ChanView { number: at, ..new.clone() }))
}

/// Channels `picked` (by number; ones not in the table are left out) moved together to continuous numbers from
/// `start`, in the order they have now. Their old numbers are freed first; the channels in the way move one along
/// as far as the first free number (which may be one the block left): to higher numbers when the block moves up the
/// table (`start` at or above its first channel), to lower numbers when it moves down, so the channels it passes
/// close up behind it as a list's rows would. An empty pick changes nothing.
pub fn move_block(set: &Set, home: Option<u16>, picked: &[u16], start: u16) -> Result<Arranged, String> {
    let have: BTreeSet<u16> = set.channels.iter().map(|c| c.number).collect();
    let block: Vec<u16> =
        picked.iter().copied().filter(|n| have.contains(n)).collect::<BTreeSet<_>>().into_iter().collect();
    let Some(&first) = block.first() else {
        return arranged(set, home, BTreeMap::new(), None);
    };
    let k = block.len() as u16;
    let mut others = have.clone();
    for n in &block {
        others.remove(n);
    }
    let down = start <= first; // the block moves up the table (or stays): the ones in the way go down it
    let mut map =
        make_room(&others, start, k, MAX_CHANNELS, down).map_err(|e| format!("Can't move them to {start}: {e}"))?;
    for (i, &n) in block.iter().enumerate() {
        map.insert(n, start + i as u16);
    }
    arranged(set, home, map, None)
}

/// For the write dialog: the channels that only changed number between `base` (the radio's) and `want` (the table),
/// matched by their whole record but the number; each source and destination used once, in number order.
pub fn moved_channels(base: &Set, want: &Set) -> Vec<Move> {
    let key = |c: &ChanView| serde_json::to_string(&ChanView { number: 0, ..c.clone() }).unwrap_or_default();
    let b: BTreeMap<u16, &ChanView> = base.channels.iter().map(|c| (c.number, c)).collect();
    let w: BTreeMap<u16, &ChanView> = want.channels.iter().map(|c| (c.number, c)).collect();
    // Sources: the radio's channels whose number now holds something else (or nothing).
    let mut sources: BTreeMap<String, Vec<u16>> = BTreeMap::new();
    for (&n, c) in &b {
        if w.get(&n).is_none_or(|x| x != c) {
            sources.entry(key(c)).or_default().push(n);
        }
    }
    let mut out = Vec::new();
    for (&n, c) in &w {
        if b.get(&n).is_some_and(|x| x == c) {
            continue;
        }
        if let Some(list) = sources.get_mut(&key(c)) {
            if !list.is_empty() {
                out.push(Move { from: list.remove(0), to: n });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::ZoneView;

    fn ch(n: u16, zone: Option<u16>) -> ChanView {
        ChanView { zone, name: format!("C{n}"), ..ChanView::new(n, 14_400_000 + n as u32 * 1250) }
    }

    /// Channels `nums` (names "C<n>" so each can be followed), zone 1 holding the even ones, zone 2 the rest.
    fn set(nums: &[u16]) -> Set {
        Set {
            zones: vec![ZoneView::new(1, "Even"), ZoneView::new(2, "Odd")],
            channels: nums.iter().map(|&n| ch(n, Some(if n % 2 == 0 { 0 } else { 1 }))).collect(),
        }
    }

    /// Number -> name, to check where each channel went.
    fn names(s: &Set) -> Vec<(u16, String)> {
        s.channels.iter().map(|c| (c.number, c.name.clone())).collect()
    }

    fn zone_of(s: &Set, name: &str) -> Option<u16> {
        s.channels.iter().find(|c| c.name == name).unwrap().zone
    }

    fn number_of(s: &Set, name: &str) -> u16 {
        s.channels.iter().find(|c| c.name == name).unwrap().number
    }

    // ---- renumber ----

    /// Gaps closed in order; the home channel, both priority channels and every zone's members follow their channels.
    #[test]
    fn renumber_closes_gaps_and_references_follow() {
        let mut s = set(&[3, 7, 8, 20, 4000]);
        s.zones[0].pri1 = Some(8);
        s.zones[1].pri1 = Some(4000);
        s.zones[1].pri2 = Some(7);
        let r = renumber(&s, Some(20), 1).unwrap();
        assert_eq!(
            names(&r.set),
            [(1, "C3"), (2, "C7"), (3, "C8"), (4, "C20"), (5, "C4000")].map(|(n, s)| (n, s.into()))
        );
        assert_eq!(r.home, Some(4));
        assert_eq!((r.set.zones[0].pri1, r.set.zones[1].pri1, r.set.zones[1].pri2), (Some(3), Some(5), Some(2)));
        // Zones keep their members.
        for name in ["C3", "C7", "C8", "C20", "C4000"] {
            assert_eq!(zone_of(&r.set, name), zone_of(&s, name), "{name}");
        }
        assert_eq!(r.moved.len(), 5);
        assert_eq!(r.added, None);
    }

    /// Already continuous: nothing moves (the confirm says so); an empty table renumbers to itself.
    #[test]
    fn renumber_continuous_is_no_change() {
        let s = set(&[1, 2, 3]);
        let r = renumber(&s, Some(2), 1).unwrap();
        assert!(r.moved.is_empty());
        assert_eq!(r.set, s);
        assert!(renumber(&Set::default(), None, 1).unwrap().moved.is_empty());
    }

    /// From another start; one that can't fit is refused with the reason.
    #[test]
    fn renumber_from_a_start() {
        let s = set(&[5, 9]);
        let r = renumber(&s, None, 100).unwrap();
        assert_eq!(names(&r.set), [(100, "C5".to_string()), (101, "C9".to_string())]);
        assert!(renumber(&s, None, 4000).unwrap_err().contains("4000"));
        assert!(renumber(&s, None, 0).is_err());
    }

    // ---- insert ----

    /// Into a run: the channels from there move one along as far as the gap; the ones past it keep theirs.
    #[test]
    fn insert_shifts_as_far_as_the_gap() {
        let s = set(&[1, 2, 3, 4, 6, 7]);
        let r = insert(&s, Some(4), 2, &ChanView::new(0, 14_652_000)).unwrap();
        assert_eq!(r.added, Some(2));
        let got: Vec<u16> = r.set.channels.iter().map(|c| c.number).collect();
        assert_eq!(got, [1, 2, 3, 4, 5, 6, 7]);
        assert_eq!((number_of(&r.set, "C2"), number_of(&r.set, "C3"), number_of(&r.set, "C4")), (3, 4, 5));
        // Past the gap at 5: unchanged.
        assert_eq!((number_of(&r.set, "C6"), number_of(&r.set, "C7")), (6, 7));
        assert_eq!(r.home, Some(5));
        assert_eq!(r.moved, [Move { from: 2, to: 3 }, Move { from: 3, to: 4 }, Move { from: 4, to: 5 }]);
        assert_eq!(r.set.channels[1].rx, "146.52000");
    }

    /// Into a free number (a gap, or "below" the last channel): nothing else moves.
    #[test]
    fn insert_into_a_gap_moves_nothing() {
        let s = set(&[1, 2, 5]);
        let r = insert(&s, None, 3, &ChanView::new(0, 14_652_000)).unwrap();
        assert!(r.moved.is_empty());
        assert_eq!(r.set.channels.iter().map(|c| c.number).collect::<Vec<_>>(), [1, 2, 3, 5]);
        let r = insert(&s, None, 6, &ChanView::new(0, 14_652_000)).unwrap();
        assert_eq!(r.added, Some(6));
    }

    /// The priority channel follows its channel through an insert; one pointing past the shift stays.
    #[test]
    fn insert_priority_follows() {
        let mut s = set(&[10, 11, 12, 20]);
        s.zones[0].pri1 = Some(12);
        s.zones[0].pri2 = Some(20);
        let r = insert(&s, None, 10, &ChanView::new(0, 14_652_000)).unwrap();
        assert_eq!((r.set.zones[0].pri1, r.set.zones[0].pri2), (Some(13), Some(20)));
    }

    /// At the end of the 4000: refused with the reason when every number from there is used; fine when one is free.
    #[test]
    fn insert_at_the_end_refuses() {
        let s = set(&[3998, 3999, 4000]);
        let e = insert(&s, None, 3998, &ChanView::new(0, 14_652_000)).unwrap_err();
        assert!(e.contains("Can't insert at 3998") && e.contains("4000"), "{e}");
        assert!(insert(&s, None, 4001, &ChanView::new(0, 14_652_000)).is_err());
        assert!(insert(&s, None, 0, &ChanView::new(0, 14_652_000)).is_err());
        let s = set(&[3998, 4000]);
        let r = insert(&s, None, 3998, &ChanView::new(0, 14_652_000)).unwrap();
        assert_eq!(r.moved, [Move { from: 3998, to: 3999 }]);
    }

    /// The new channel takes the zone it was given.
    #[test]
    fn insert_keeps_the_given_zone() {
        let s = set(&[1, 2]);
        let r = insert(&s, None, 2, &ChanView { zone: Some(1), ..ChanView::new(0, 14_652_000) }).unwrap();
        assert_eq!(r.set.channels[1].zone, Some(1));
        assert_eq!(r.set.channels[1].number, 2);
    }

    // ---- move a block ----

    /// Up the table: the block lands from `start`, the channels it passes move down into the numbers it left.
    #[test]
    fn move_block_up() {
        let s = set(&[1, 2, 3, 4, 5, 6, 7, 8]);
        let r = move_block(&s, Some(2), &[6, 7], 2).unwrap();
        let order: Vec<&str> = r.set.channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(order, ["C1", "C6", "C7", "C2", "C3", "C4", "C5", "C8"]);
        assert_eq!(r.set.channels.iter().map(|c| c.number).collect::<Vec<_>>(), [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(r.home, Some(4)); // home was C2
        for c in &s.channels {
            assert_eq!(zone_of(&r.set, &c.name), c.zone);
        }
    }

    /// Down the table: the channels it passes move up into the numbers it left (a list's rows closing up).
    #[test]
    fn move_block_down() {
        let s = set(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        let r = move_block(&s, None, &[2, 3], 7).unwrap();
        let order: Vec<&str> = r.set.channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(order, ["C1", "C4", "C5", "C6", "C7", "C8", "C2", "C3", "C9", "C10"]);
        assert_eq!((number_of(&r.set, "C2"), number_of(&r.set, "C3")), (7, 8));
        assert_eq!((number_of(&r.set, "C9"), number_of(&r.set, "C10")), (9, 10));
    }

    /// A block spread out (2, 5, 9) gathers in its order; gaps past the shift stay as they were.
    #[test]
    fn move_block_scattered_and_gaps_kept() {
        let s = set(&[2, 5, 9, 20, 21, 23, 30]);
        let r = move_block(&s, None, &[30, 2, 23], 20).unwrap();
        // Up the table from 2? start 20 > 2: moves down, so 20 and 21 close up into lower free numbers.
        assert_eq!(number_of(&r.set, "C2"), 20);
        assert_eq!(number_of(&r.set, "C23"), 21);
        assert_eq!(number_of(&r.set, "C30"), 22);
        assert_eq!((number_of(&r.set, "C21"), number_of(&r.set, "C20")), (19, 18));
        // 5 and 9 were past the free 10-17: unchanged.
        assert_eq!((number_of(&r.set, "C5"), number_of(&r.set, "C9")), (5, 9));
        // Up into a gap: nothing in the way, nothing else moves.
        let r = move_block(&s, None, &[20, 21], 10).unwrap();
        assert_eq!(r.moved, [Move { from: 20, to: 10 }, Move { from: 21, to: 11 }]);
    }

    /// Into a range overlapping itself: one along down the table is a swap with the channel below it.
    #[test]
    fn move_block_overlapping_itself() {
        let s = set(&[4, 5, 6, 7, 8, 9]);
        let r = move_block(&s, None, &[5, 6, 7], 6).unwrap();
        let order: Vec<&str> = r.set.channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(order, ["C4", "C8", "C5", "C6", "C7", "C9"]);
        assert_eq!(r.set.channels.iter().map(|c| c.number).collect::<Vec<_>>(), [4, 5, 6, 7, 8, 9]);
        // One along up the table: the channel above goes below it.
        let r = move_block(&s, None, &[5, 6, 7], 4).unwrap();
        let order: Vec<&str> = r.set.channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(order, ["C5", "C6", "C7", "C4", "C8", "C9"]);
        // Onto where it is: nothing changes.
        let r = move_block(&s, None, &[5, 6, 7], 5).unwrap();
        assert!(r.moved.is_empty());
        assert_eq!(r.set, s);
    }

    /// Nothing picked (or only numbers the table hasn't): nothing changes.
    #[test]
    fn move_block_empty() {
        let s = set(&[1, 2]);
        let r = move_block(&s, Some(1), &[], 2).unwrap();
        assert!(r.moved.is_empty());
        assert_eq!((r.set, r.home), (s.clone(), Some(1)));
        assert!(move_block(&s, None, &[77], 1).unwrap().moved.is_empty());
    }

    /// Past the end: refused with the reason.
    #[test]
    fn move_block_refusals() {
        let s = set(&[1, 2, 3]);
        let e = move_block(&s, None, &[1, 2], 4000).unwrap_err();
        assert!(e.contains("4000–4001") && e.contains("1 to 4000"), "{e}");
        // The numbers a block leaves are always free on the side the others move to, so a move within 1-4000 always
        // fits: down to 3999 with 3999 and 4000 used, 3999 closes up into a lower number.
        let s = set(&[1, 3999, 4000]);
        let r = move_block(&s, None, &[1], 3999).unwrap();
        assert_eq!(
            (number_of(&r.set, "C1"), number_of(&r.set, "C3999"), number_of(&r.set, "C4000")),
            (3999, 3998, 4000)
        );
    }

    /// The priority channel and the home channel follow a block move, and every zone keeps its members.
    #[test]
    fn move_block_references_follow() {
        let mut s = set(&[1, 2, 3, 4, 5]);
        s.zones[0].pri1 = Some(4);
        s.zones[1].pri2 = Some(1);
        let r = move_block(&s, Some(5), &[4, 5], 1).unwrap();
        assert_eq!(number_of(&r.set, "C4"), 1);
        assert_eq!(r.set.zones[0].pri1, Some(1));
        assert_eq!(r.set.zones[1].pri2, Some(number_of(&r.set, "C1")));
        assert_eq!(r.home, Some(2));
        for c in &s.channels {
            assert_eq!(zone_of(&r.set, &c.name), c.zone);
        }
    }

    // ---- apply, make_room ----

    #[test]
    fn apply_refuses_collisions() {
        let s = set(&[1, 2]);
        assert!(apply(&s, None, &BTreeMap::from([(1, 2)])).unwrap_err().contains("two channels"));
        assert!(apply(&s, None, &BTreeMap::from([(1, 4001)])).is_err());
        let (t, h) = apply(&s, Some(1), &BTreeMap::from([(1, 2), (2, 1)])).unwrap();
        assert_eq!(names(&t), [(1, "C2".to_string()), (2, "C1".to_string())]);
        assert_eq!(h, Some(2));
    }

    #[test]
    fn make_room_both_ways() {
        let used: BTreeSet<u16> = [1, 2, 3, 5, 6].into();
        assert_eq!(make_room(&used, 2, 1, 10, true).unwrap(), BTreeMap::from([(2, 3), (3, 4)]));
        assert_eq!(make_room(&used, 6, 1, 10, false).unwrap(), BTreeMap::from([(6, 5), (5, 4)]));
        assert_eq!(make_room(&used, 4, 1, 10, true).unwrap(), BTreeMap::new());
        assert!(make_room(&[1, 2].into(), 1, 1, 2, true).is_err());
        assert!(make_room(&[1, 2].into(), 2, 1, 2, false).is_err());
    }

    // ---- the write dialog's moves ----

    /// A renumber's write: each channel that only changed number is one move; an edited one isn't.
    #[test]
    fn moved_channels_after_a_renumber() {
        let base = set(&[2, 4, 6]);
        let mut want = renumber(&base, None, 1).unwrap().set;
        assert_eq!(
            moved_channels(&base, &want),
            [Move { from: 2, to: 1 }, Move { from: 4, to: 2 }, Move { from: 6, to: 3 }]
        );
        want.channels[2].name = "Edited".into();
        assert_eq!(moved_channels(&base, &want).len(), 2);
        assert!(moved_channels(&base, &base).is_empty());
    }
}
