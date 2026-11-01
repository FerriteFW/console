//! Moving a radio's data from one SPI flash layout to the next during an update (LINK-59 – LINK-62, UPD-16,
//! decisions 333 and 336; manual Appendix G, "Layouts and the update"). Console reads the old layout's regions over
//! `DATA_READ` and keeps them on the PC ([`Copy`], saved as a file before anything is written), translates them here
//! ([`translate`]: layout 2 to 3 is the only one so far), and writes the new layout region by region over
//! `DATA_WRITE` ([`write_plan`]), the sector that held the old header last and the header stamp after it, so an
//! interruption at any point loses nothing: started again, Console begins from its copy. The radio makes that so
//! (decision 339): before the first raw write it puts a migration mark down and this layout's header, a restart
//! before the stamp finds the mark and waits for Console (`HELLO` says the chip is 255, half moved), and the stamp
//! only clears the mark, once everything before it is written.
//!
//! The records are the firmware's own (ferrite-store's `records`, `logs`, `scratch` and `store`), so a channel, a
//! zone or a ring record is judged and rebuilt here exactly as the radio judges and builds it.

use crate::firmware;
use ferrite_core::layout::{
    APRS, CHANNELS, CONTACTS, EVENT_LOG, HEARD, LAYOUT_VERSION, MESSAGES, PRESETS, SCRATCH_RING, SETTINGS,
    SSB_PATCH, TRIMS, V2_HEADER, WAYPOINTS, ZONES,
};
use ferrite_core::link::{data, msg};
use ferrite_store::logs::{self, PER, REC};
use ferrite_store::records::{self, CH_LEN, CH_ZONE_HI, CH_ZONE_LO, ZONE_LEN, ZONES_PER_SECTOR};
use ferrite_store::scratch::FOOTER_AT;
use ferrite_store::{crc16, SECTOR};
use serde::Serialize;
use std::collections::BTreeMap;
use std::ops::Range;

/// CRC-32/ISO-HDLC, as `DATA_READ`'s `CRC` answers it and the layout header holds it.
pub use crate::firmware::crc32;

/// What to back up from a layout 2 chip, (start, length): its data (the old header to the end of the heard list)
/// and its scratch ring, whose pending rewrite the translation finishes in the copy (LINK-62's step 2).
pub const V2_REGIONS: [(u32, u32); 2] = [(0x02_C000, 0x6_1000), (0x1E_0000, 0x2_0000)];

/// Layout 2's map (the firmware before layout 3; Appendix G's table).
mod v2 {
    use std::ops::Range;
    pub const SETTINGS: Range<u32> = 0x02_D000..0x02_F000;
    pub const CHANNELS: Range<u32> = 0x02_F000..0x03_F000;
    pub const ZONES: Range<u32> = 0x03_F000..0x04_1000;
    pub const PRESETS: Range<u32> = 0x04_1000..0x04_2000;
    pub const APRS: Range<u32> = 0x04_3000..0x04_5000;
    pub const MESSAGES: Range<u32> = 0x04_5000..0x04_B000;
    pub const EVENT_LOG: Range<u32> = 0x04_B000..0x06_B000;
    pub const SSB_PATCH: Range<u32> = 0x06_B000..0x06_F000;
    pub const TRIMS: Range<u32> = 0x06_F000..0x07_0000;
    pub const WAYPOINTS: Range<u32> = 0x07_0000..0x07_4000;
    pub const CONTACTS: Range<u32> = 0x07_4000..0x07_6000;
    pub const HEARD: Range<u32> = 0x08_5000..0x08_D000;
    pub const SCRATCH_RING: Range<u32> = 0x1E_0000..0x20_0000;
    /// The data sectors a scratch copy may stand for (the settings to the heard list).
    pub const DATA: Range<u32> = 0x02_D000..0x08_D000;
    /// A channel record's format then (byte 60), and its "no zone" (byte 18).
    pub const CH_VERSION: u8 = 1;
    pub const NO_ZONE: u8 = 255;
    /// Zones then: 0-253.
    pub const MAX_ZONES: u16 = 254;
}

/// What to back up for a chip on `chip_layout` before an update moves it (None: no translation from it).
pub fn backup_regions(chip_layout: u8) -> Option<Vec<(u32, u32)>> {
    (chip_layout == 2).then(|| V2_REGIONS.to_vec())
}

const FILE_MAGIC: &[u8; 4] = b"FRLB";
const FILE_VERSION: u16 = 1;

/// The old layout's data as read from the radio and kept on the PC (LINK-62's step 2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Copy {
    /// The layout the data is in (2).
    pub layout: u8,
    /// The radio's unique ID (INFO's 12 bytes, LINK-35.1), when known: which radio the copy is from.
    pub uid: Option<[u8; 12]>,
    /// Each region read: its start and its bytes.
    pub regions: Vec<(u32, Vec<u8>)>,
}

fn le16(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

fn le32(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

impl Copy {
    /// The copy as a file: "FRLB", format version (u16), layout (u8), whether the ID follows (u8), the ID (12 bytes,
    /// zeros without one), the region count (u16), each region's start, length and CRC-32 (u32 each) then its
    /// bytes, and last the CRC-32 of everything before it. Little-endian.
    pub fn to_file(&self) -> Vec<u8> {
        let mut f = Vec::with_capacity(32 + self.regions.iter().map(|r| r.1.len() + 12).sum::<usize>());
        f.extend_from_slice(FILE_MAGIC);
        f.extend(FILE_VERSION.to_le_bytes());
        f.push(self.layout);
        f.push(self.uid.is_some() as u8);
        f.extend(self.uid.unwrap_or([0; 12]));
        f.extend((self.regions.len() as u16).to_le_bytes());
        for (start, b) in &self.regions {
            f.extend(start.to_le_bytes());
            f.extend((b.len() as u32).to_le_bytes());
            f.extend(crc32(b).to_le_bytes());
            f.extend_from_slice(b);
        }
        let c = crc32(&f);
        f.extend(c.to_le_bytes());
        f
    }

    /// A copy back from its file, or why not.
    pub fn from_file(f: &[u8]) -> Result<Copy, String> {
        const BAD: &str = "This isn't a Ferrite Console data backup (a layout copy).";
        if f.len() < 4 || &f[..4] != FILE_MAGIC {
            return Err(BAD.into());
        }
        if f.len() < 26 {
            return Err("The data backup is cut short.".into());
        }
        let v = le16(f, 4);
        if v > FILE_VERSION {
            return Err(format!("The data backup is a newer format (version {v}) than this Console reads: update Ferrite Console."));
        }
        let body = &f[..f.len() - 4];
        if crc32(body) != le32(f, f.len() - 4) {
            return Err("The data backup is damaged (its check doesn't match). Use another copy, or read the radio again.".into());
        }
        let layout = f[6];
        let uid = (f[7] != 0).then(|| f[8..20].try_into().unwrap_or([0; 12]));
        let n = le16(f, 20) as usize;
        let mut at = 22;
        let mut regions = Vec::with_capacity(n);
        for i in 0..n {
            if at + 12 > body.len() {
                return Err("The data backup is cut short.".into());
            }
            let (start, len, crc) = (le32(body, at), le32(body, at + 4) as usize, le32(body, at + 8));
            at += 12;
            let Some(b) = body.get(at..at + len) else { return Err("The data backup is cut short.".into()) };
            if crc32(b) != crc {
                return Err(format!("The data backup's region {} (at {start:#08x}) is damaged.", i + 1));
            }
            regions.push((start, b.to_vec()));
            at += len;
        }
        if at != body.len() {
            return Err(BAD.into());
        }
        Ok(Copy { layout, uid, regions })
    }

    /// `len` bytes at chip address `addr`, when one region holds them all.
    pub fn read(&self, addr: u32, len: usize) -> Option<&[u8]> {
        self.regions.iter().find_map(|(s, b)| {
            let off = addr.checked_sub(*s)? as usize;
            b.get(off..off.checked_add(len)?)
        })
    }
}

/// One region of the new layout: its bytes, a whole number of sectors, erased then programmed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Region {
    pub name: String,
    pub start: u32,
    pub data: Vec<u8>,
}

/// What the translation found and did, for the owner (counts after it).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub channels: u32,
    /// Zones after it (the new ones from a split included).
    pub zones: u32,
    /// Each zone over 256 channels (CHAN-35) and how many new zones took the rest.
    pub zones_split: Vec<(String, u32)>,
    /// Channels left with no zone because no zone number was free for them.
    pub channels_unzoned_by_split: u32,
    pub heard: u32,
    pub messages: u32,
    pub events: u32,
    pub waypoints: u32,
    pub contacts: u32,
    /// Layout 2's pending scratch rewrites finished in the copy first (sectors).
    pub scratch_applied: u32,
}

/// The new layout's regions, in the order they are written (LINK-62's step 4), and what was done.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Translated {
    pub regions: Vec<Region>,
    pub notes: Vec<String>,
    pub summary: Summary,
}

/// The working copy of layout 2's data: chip addresses to bytes, erased (0xFF) where the copy has nothing.
struct Chip {
    low: Vec<u8>,
    scratch: Vec<u8>,
}

const LOW: Range<u32> = V2_HEADER.start..v2::HEARD.end;

impl Chip {
    fn at(&self, addr: u32, len: usize) -> &[u8] {
        if LOW.contains(&addr) {
            let o = (addr - LOW.start) as usize;
            &self.low[o..o + len]
        } else {
            let o = (addr - v2::SCRATCH_RING.start) as usize;
            &self.scratch[o..o + len]
        }
    }

    fn range(&self, r: &Range<u32>) -> &[u8] {
        self.at(r.start, (r.end - r.start) as usize)
    }

    fn put(&mut self, addr: u32, b: &[u8]) {
        let o = (addr - LOW.start) as usize;
        self.low[o..o + b.len()].copy_from_slice(b);
    }
}

fn len(r: &Range<u32>) -> usize {
    (r.end - r.start) as usize
}

/// Channel slot `n`'s offset in a channel region (63 a sector, as layout 3's: the same in both).
fn ch_off(n: u32) -> usize {
    (n / records::CH_PER_SECTOR * SECTOR + n % records::CH_PER_SECTOR * CH_LEN as u32) as usize
}

fn zone_off(z: u32) -> usize {
    (z / ZONES_PER_SECTOR * SECTOR + z % ZONES_PER_SECTOR * ZONE_LEN as u32) as usize
}

/// A layout 2 channel record (version 1) that holds a channel: an RX frequency, its CRC, version 1, a zone 0-253 or
/// none.
fn v1_held(b: &[u8; CH_LEN]) -> bool {
    le32(b, 0) != 0xFFFF_FFFF
        && crc16(&b[..62]) == le16(b, 62)
        && b[60] == v2::CH_VERSION
        && (b[CH_ZONE_LO] < v2::MAX_ZONES as u8 || b[CH_ZONE_LO] == v2::NO_ZONE)
}

/// A channel record with its zone set (version 2: the low byte at 18, the high byte at 61) and its CRC again.
fn with_zone(b: &mut [u8; CH_LEN], zone: u16) {
    b[CH_ZONE_LO] = zone as u8;
    b[CH_ZONE_HI] = (zone >> 8) as u8;
    b[60] = records::CH_VERSION;
    let c = crc16(&b[..62]);
    b[62..64].copy_from_slice(&c.to_le_bytes());
}

const MAGIC_REC: [u8; 2] = [0xE7, 0x01];

/// A ring record held at `slot` of a ring of `cap` whose CRC covers bytes 0-9 and 11 to `body_end`
/// (ferrite-store `logs::Ring`).
fn ring_held(b: &[u8], slot: u32, cap: u32, body_end: usize) -> Option<u32> {
    let seq = le32(b, 0);
    let mut t = Vec::with_capacity(body_end);
    t.extend_from_slice(&b[..10]);
    t.extend_from_slice(&b[11..body_end]);
    (seq % cap == slot && b[8..10] == MAGIC_REC && crc16(&t) == le16(b, 126)).then_some(seq)
}

/// A ring's records moved to a ring of another size: each held record to slot seq % the new capacity, its bytes
/// unchanged; records from before the old ring's window (an older lap) are left behind. The count moved.
fn move_ring(from: &[u8], body_end: usize, to: &mut [u8]) -> u32 {
    let (old_cap, new_cap) = ((from.len() as u32 / SECTOR) * PER, (to.len() as u32 / SECTOR) * PER);
    let at = |slot: u32| (slot / PER * SECTOR + slot % PER * REC) as usize;
    let held: Vec<(u32, usize)> = (0..old_cap)
        .filter_map(|slot| ring_held(&from[at(slot)..at(slot) + REC as usize], slot, old_cap, body_end).map(|s| (s, at(slot))))
        .collect();
    let Some(newest) = held.iter().map(|h| h.0).max() else { return 0 };
    let mut n = 0;
    for (seq, o) in held {
        if newest - seq >= old_cap {
            continue;
        }
        let d = at(seq % new_cap);
        to[d..d + REC as usize].copy_from_slice(&from[o..o + REC as usize]);
        n += 1;
    }
    n
}

/// The zone record `b` renamed `name` (cut to 16 bytes, 0-padded), its CRC again.
fn renamed(b: &[u8; ZONE_LEN], name: &[u8]) -> [u8; ZONE_LEN] {
    let mut r = *b;
    r[..16].fill(0);
    let n = name.len().min(16);
    r[..n].copy_from_slice(&name[..n]);
    let c = crc16(&r[..30]);
    r[30..32].copy_from_slice(&c.to_le_bytes());
    r
}

fn zone_name(b: &[u8; ZONE_LEN]) -> String {
    let n = b[..16].iter().position(|&c| c == 0).unwrap_or(16);
    String::from_utf8_lossy(&b[..n]).into_owned()
}

/// Layout 2's own recovery (scratch.rs `recover`): each scratch sector with a valid footer has its content put over
/// its target sector, in ring order. How many.
fn recover(c: &mut Chip) -> u32 {
    let mut n = 0;
    for s in v2::SCRATCH_RING.step_by(SECTOR as usize) {
        let foot = c.at(s + FOOTER_AT, 14).to_vec();
        let target = le32(&foot, 4);
        let valid = le32(&foot, 0) == 0x5243_5346
            && le16(&foot, 12) == crc16(&foot[..12])
            && target.is_multiple_of(SECTOR)
            && v2::DATA.contains(&target)
            && crc32(c.at(s, FOOTER_AT as usize)) == le32(&foot, 8);
        if valid {
            let content = c.at(s, FOOTER_AT as usize).to_vec();
            if c.at(target, FOOTER_AT as usize) != content.as_slice() {
                c.put(target, &content);
                n += 1;
            }
        }
    }
    n
}

/// Layout 2's data (its copy) as layout 3's regions (Appendix G, "Layout 2 to 3"), in the order they are written.
pub fn translate(copy: &Copy) -> Result<Translated, String> {
    if copy.layout != 2 {
        return Err(format!("Console can't move data from layout {} to layout {LAYOUT_VERSION}.", copy.layout));
    }
    let low = copy.read(LOW.start, len(&LOW)).ok_or("The data backup doesn't hold layout 2's data (0x02C000 to 0x08CFFF).")?;
    let mut notes = Vec::new();
    let scratch = match copy.read(v2::SCRATCH_RING.start, len(&v2::SCRATCH_RING)) {
        Some(s) => s.to_vec(),
        None => {
            notes.push("The data backup has no copy of layout 2's scratch ring: a change the radio was making when it was switched off can't be finished.".into());
            vec![0xFF; len(&v2::SCRATCH_RING)]
        }
    };
    let mut c = Chip { low: low.to_vec(), scratch };
    let mut sum = Summary { scratch_applied: recover(&mut c), ..Summary::default() };
    if sum.scratch_applied > 0 {
        notes.push(format!(
            "A change the radio was saving when it was last switched off was finished first ({} {}).",
            sum.scratch_applied,
            if sum.scratch_applied == 1 { "sector" } else { "sectors" }
        ));
    }

    // Channels: each held record to version 2, at its own number.
    let ch_slots = (len(&v2::CHANNELS) as u32 / SECTOR) * records::CH_PER_SECTOR;
    let mut chans: BTreeMap<u32, [u8; CH_LEN]> = BTreeMap::new();
    for n in 0..ch_slots {
        let b: [u8; CH_LEN] = c.at(v2::CHANNELS.start + ch_off(n) as u32, CH_LEN).try_into().unwrap_or([0xFF; CH_LEN]);
        if v1_held(&b) {
            chans.insert(n, b);
        }
    }
    const NONE: u16 = ferrite_app::chan::NO_ZONE;
    let mut zone_of: BTreeMap<u32, u16> =
        chans.iter().map(|(&n, b)| (n, if b[CH_ZONE_LO] == v2::NO_ZONE { NONE } else { b[CH_ZONE_LO] as u16 })).collect();

    // Zones: those held, at their own numbers.
    let mut zones: BTreeMap<u16, [u8; ZONE_LEN]> = BTreeMap::new();
    for z in 0..v2::MAX_ZONES {
        let b: [u8; ZONE_LEN] = c.at(v2::ZONES.start + zone_off(z as u32) as u32, ZONE_LEN).try_into().unwrap_or([0xFF; ZONE_LEN]);
        if records::zone_decode(&b).is_some() {
            zones.insert(z, b);
        }
    }
    // CHAN-35: a zone over 256 keeps its first 256 by number; the rest go 256 at a time to new zones after the last.
    let cap = ferrite_app::chan::ZONE_CAP as usize;
    let mut next = zones.keys().next_back().map_or(0, |&z| z + 1);
    let held: Vec<u16> = zones.keys().copied().collect();
    for z in held {
        let members: Vec<u32> = zone_of.iter().filter(|(_, &zz)| zz == z).map(|(&n, _)| n).collect();
        if members.len() <= cap {
            continue;
        }
        let base_rec = zones[&z];
        let base = zone_name(&base_rec);
        let mut made = 0u32;
        let mut unzoned = 0u32;
        let mut made_names = Vec::new();
        for (k, part) in members[cap..].chunks(cap).enumerate() {
            let target = if next < records::MAX_ZONES {
                let suffix = format!(" {}", k + 2);
                let keep = base.len().min(16 - suffix.len());
                let mut cut = keep;
                while !base.is_char_boundary(cut) {
                    cut -= 1;
                }
                let name = format!("{}{suffix}", &base[..cut]);
                zones.insert(next, renamed(&base_rec, name.as_bytes()));
                made_names.push(name);
                made += 1;
                next += 1;
                next - 1
            } else {
                unzoned += part.len() as u32;
                NONE
            };
            for n in part {
                zone_of.insert(*n, target);
            }
        }
        let moved = members.len() - cap;
        let mut note = format!("Zone {base} had {} channels: {moved} moved", members.len());
        match made {
            0 => {}
            1 => note += &format!(" to a new zone, {}", made_names[0]),
            _ => note += &format!(" to new zones {}", made_names.join(", ")),
        }
        if unzoned > 0 {
            let sep = if made > 0 { "; " } else { " " };
            note += &format!("{sep}{unzoned} to no zone (all {} zone numbers are in use)", records::MAX_ZONES);
        }
        note += " (256 at most, CHAN-35).";
        notes.push(note);
        sum.zones_split.push((base, made));
        sum.channels_unzoned_by_split += unzoned;
    }
    if sum.channels_unzoned_by_split > 0 {
        notes.push(format!("{} channels have no zone now.", sum.channels_unzoned_by_split));
    }
    // Each held zone's channel count (CHAN-36).
    for (z, b) in zones.iter_mut() {
        let n = zone_of.values().filter(|&&zz| zz == *z).count() as u16;
        records::set_zone_count(b, n);
    }

    let fresh = |r: &Range<u32>| vec![0xFFu8; len(r)];
    let mut ch = fresh(&CHANNELS);
    for (n, b) in &chans {
        let mut b = *b;
        let z = zone_of[n];
        with_zone(&mut b, if z >= records::MAX_ZONES { NONE } else { z });
        ch[ch_off(*n)..ch_off(*n) + CH_LEN].copy_from_slice(&b);
    }
    sum.channels = chans.len() as u32;
    let mut zs = fresh(&ZONES);
    for (z, b) in &zones {
        let o = zone_off(*z as u32);
        zs[o..o + ZONE_LEN].copy_from_slice(b);
    }
    sum.zones = zones.keys().next_back().map_or(0, |&z| z as u32 + 1);

    let copied = |to: &Range<u32>, from: &Range<u32>| {
        let mut d = fresh(to);
        d[..len(from)].copy_from_slice(c.range(from));
        d
    };
    let mut aprs = fresh(&APRS);
    aprs[..len(&v2::APRS)].copy_from_slice(c.range(&v2::APRS));
    let mut heard = fresh(&HEARD);
    sum.heard = move_ring(c.range(&v2::HEARD), logs::HEARD_END, &mut heard);
    let mut msgs = fresh(&MESSAGES);
    sum.messages = move_ring(c.range(&v2::MESSAGES), logs::MSG_END, &mut msgs);
    let events = copied(&EVENT_LOG, &v2::EVENT_LOG);
    sum.events = (0..(len(&v2::EVENT_LOG) as u32 / SECTOR) * PER)
        .filter(|&slot| {
            let o = (slot / PER * SECTOR + slot % PER * REC) as usize;
            ring_held(&events[o..o + REC as usize], slot, (len(&EVENT_LOG) as u32 / SECTOR) * PER, logs::EVENT_END).is_some()
        })
        .count() as u32;
    let wps = copied(&WAYPOINTS, &v2::WAYPOINTS);
    let recs = |d: &[u8], f: &dyn Fn(&[u8; 32]) -> bool| {
        d.chunks(SECTOR as usize)
            .flat_map(|s| s[..(logs::WP_PER * logs::WP_LEN) as usize].chunks(32))
            .filter(|r| f(&(*r).try_into().unwrap_or([0xFF; 32])))
            .count() as u32
    };
    sum.waypoints = recs(&wps, &|r| logs::wp_decode(r).is_some());
    let contacts = copied(&CONTACTS, &v2::CONTACTS);
    sum.contacts = recs(&contacts, &|r| r != &[0xFF; 32] && crc16(&r[..30]) == le16(r, 30));

    // Layout 3's channel sector that holds layout 2's header goes last of all (LINK-62).
    let hs = (V2_HEADER.start - CHANNELS.start) as usize;
    let regions = vec![
        Region { name: "Settings and slots".into(), start: SETTINGS.start, data: copied(&SETTINGS, &v2::SETTINGS) },
        Region { name: "User trims".into(), start: TRIMS.start, data: copied(&TRIMS, &v2::TRIMS) },
        Region { name: "Range presets and DTMF memories".into(), start: PRESETS.start, data: copied(&PRESETS, &v2::PRESETS) },
        Region { name: "SSB patch".into(), start: SSB_PATCH.start, data: copied(&SSB_PATCH, &v2::SSB_PATCH) },
        Region { name: "Channels".into(), start: CHANNELS.start, data: ch[..hs].to_vec() },
        Region { name: "Channels".into(), start: V2_HEADER.end, data: ch[hs + SECTOR as usize..].to_vec() },
        Region { name: "Zones".into(), start: ZONES.start, data: zs },
        Region { name: "APRS settings and quick messages".into(), start: APRS.start, data: aprs },
        Region { name: "APRS contacts".into(), start: CONTACTS.start, data: contacts },
        Region { name: "APRS heard list".into(), start: HEARD.start, data: heard },
        Region { name: "APRS messages".into(), start: MESSAGES.start, data: msgs },
        Region { name: "GPS waypoints".into(), start: WAYPOINTS.start, data: wps },
        Region { name: "Event log".into(), start: EVENT_LOG.start, data: events },
        Region { name: "Scratch ring".into(), start: SCRATCH_RING.start, data: fresh(&SCRATCH_RING) },
        Region {
            name: "Channels (sector 28, held the old header)".into(),
            start: V2_HEADER.start,
            data: ch[hs..hs + SECTOR as usize].to_vec(),
        },
    ];
    Ok(Translated { regions, notes, summary: sum })
}

/// One `DATA_WRITE` or `DATA_READ` of the write.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Step {
    /// "erase", "program", "crc" or "stamp".
    pub kind: &'static str,
    /// `DATA_WRITE` or `DATA_READ`.
    pub msg: u8,
    pub addr: u32,
    pub len: u32,
    /// The request's payload, the op byte first.
    pub payload: Vec<u8>,
    /// A `crc`'s expected answer: the CRC-32 of the region's bytes.
    pub expect: Option<u32>,
    /// The region it belongs to (its name).
    pub region: String,
}

/// The write (LINK-62's steps 4 and 5): each region's sectors erased, its bytes that aren't erased programmed 64 at
/// a time (never across a 256-byte page), the region read back by CRC; the header stamped last. Never the layout
/// header or the migration mark (the radio's own, refused: decision 339).
pub fn write_plan(t: &Translated) -> Vec<Step> {
    let mut out = Vec::new();
    for r in &t.regions {
        let end = r.start + r.data.len() as u32;
        for s in (r.start..end).step_by(SECTOR as usize) {
            let mut p = vec![data::ERASE];
            p.extend(s.to_le_bytes());
            out.push(Step { kind: "erase", msg: msg::DATA_WRITE, addr: s, len: SECTOR, payload: p, expect: None, region: r.name.clone() });
        }
        for (i, piece) in r.data.chunks(data::PROGRAM_MAX).enumerate() {
            if piece.iter().all(|&b| b == 0xFF) {
                continue;
            }
            let a = r.start + (i * data::PROGRAM_MAX) as u32;
            let mut p = vec![data::PROGRAM];
            p.extend(a.to_le_bytes());
            p.extend_from_slice(piece);
            out.push(Step { kind: "program", msg: msg::DATA_WRITE, addr: a, len: piece.len() as u32, payload: p, expect: None, region: r.name.clone() });
        }
        let mut p = vec![data::CRC];
        p.extend(r.start.to_le_bytes());
        p.extend((r.data.len() as u32).to_le_bytes());
        out.push(Step {
            kind: "crc",
            msg: msg::DATA_READ,
            addr: r.start,
            len: r.data.len() as u32,
            payload: p,
            expect: Some(crc32(&r.data)),
            region: r.name.clone(),
        });
    }
    let mut p = vec![data::STAMP];
    p.extend(LAYOUT_VERSION.to_le_bytes());
    out.push(Step { kind: "stamp", msg: msg::DATA_WRITE, addr: 0, len: 0, payload: p, expect: None, region: "Layout header".into() });
    out
}

/// The CRC-32 of a sector of erased flash, to skip reading blank sectors (a `DATA_READ` `CRC` first).
pub fn erased_crc(len: usize) -> u32 {
    firmware::crc32(&vec![0xFF; len])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_app::chan::{Channel, ChannelStore, NO_ZONE};
    use ferrite_app::data::{AprsCfg, Contact, Data, Event, NoData, Op, Pos, Src, Station, Sym, Waypoint, WpSrc, ZoneCfg};
    use ferrite_app::screens::alert::AlertInfo;
    use ferrite_app::settings::Settings;
    use ferrite_app::slot::DEFAULT_CFG;
    use ferrite_app::App;
    use ferrite_store::io::Flash;
    use ferrite_store::logs::Ring;
    use ferrite_store::sim::SimFlash;
    use ferrite_store::store::{header_bytes, Job, Mounted};
    use ferrite_store::{block, FlashStore};
    use ferrite_ui::text::Buf;

    type Store = FlashStore<SimFlash, NoData>;

    fn chan(n: u16, zone: u16) -> Channel {
        let mut c = Channel { num: n, zone, rx: 14_400_000 + n as u32 * 125, name: [0; 16], cfg: DEFAULT_CFG, flags: 0, tones: 0 };
        c.set_name(format!("CH {n}").as_bytes());
        c
    }

    /// A channel as layout 2 stored it: the firmware's encoder, then version 1 (one zone byte, 61 spare).
    fn v1(c: &Channel) -> [u8; CH_LEN] {
        let mut b = records::ch_encode(c, &[0xFF; CH_LEN]);
        b[CH_ZONE_LO] = if c.zone == NO_ZONE { 255 } else { c.zone as u8 };
        b[CH_ZONE_HI] = 0xFF;
        b[60] = 1;
        let crc = crc16(&b[..62]);
        b[62..64].copy_from_slice(&crc.to_le_bytes());
        b
    }

    fn v2_header() -> [u8; 20] {
        let mut h = header_bytes();
        h[4..6].copy_from_slice(&2u16.to_le_bytes());
        let c = crc32(&h[..16]);
        h[16..20].copy_from_slice(&c.to_le_bytes());
        h
    }

    fn station(i: u32) -> Station {
        Station {
            call: Buf::from(format!("VA7H{i}").as_bytes()),
            sym: Sym::Home,
            pos: Some(Pos { lat: 490_000_000 + i as i32, lon: -1_230_000_000 }),
            ago_s: 0,
            via: Buf::new(),
            course: None,
            alt_m: None,
            times: 1,
            comment: Buf::from(format!("row {i}").as_bytes()),
            msg: Buf::new(),
            msg_min: None,
            fx25: None,
            device: None,
        }
    }

    struct Built {
        copy: Copy,
        /// The channels as they should read after it (the scratch edit in).
        chans: Vec<Channel>,
        settings: Settings,
        aprs: AprsCfg,
    }

    /// A layout 2 chip as a radio leaves it: settings, APRS settings, waypoints and contacts as a real store wrote
    /// them; 1,000 channels (a zone of 300, some in no zone); zones; trims and the SSB patch; heard and message
    /// rings that have wrapped; events; and a rewrite of channel sector 0 left pending in the scratch ring.
    fn build() -> Built {
        // The parts a store writes itself, written by one (on layout 3's map) and moved to layout 2's places.
        let src = Store::mount(SimFlash::new(), NoData);
        let set = Box::leak(Box::new(Settings::DEFAULT));
        let mut app = App::new(set, Box::leak(Box::new(AlertInfo::NONE)));
        app.settings_mut().set_callsign(b"VA7MIG");
        app.settings_mut().setup_done = true;
        assert!(src.save(&app));
        let settings = *app.settings();
        let aprs = AprsCfg { ssid: 9, ..AprsCfg::DEFAULT };
        src.request(Op::AprsCfg(aprs));
        assert!(block(src.run(Job::AprsSave)));
        for i in 0..5 {
            assert!(src.add_waypoint(&Waypoint { name: Buf::from(format!("WP{i}").as_bytes()), pos: Pos { lat: i * 1000, lon: -i * 1000 }, src: WpSrc::Marked }));
        }
        for call in ["VE7ABC", "VA7XYZ-9", "VE7AAA"] {
            assert!(src.request(Op::SaveContact(Contact { call: Buf::from(call.as_bytes()), name: Buf::from(b"Friend".as_slice()) })));
        }
        let mem = src.into_parts().0.mem;
        let s3 = |a: u32, n: u32| mem[SimFlash::at(a)..SimFlash::at(a) + n as usize].to_vec();

        // The rest on layout 2's map, with the firmware's own rings.
        let f = Flash::new(SimFlash::new());
        let heard = Ring::new(v2::HEARD.start, v2::HEARD.end, logs::HEARD_END);
        let msgs = Ring::new(v2::MESSAGES.start, v2::MESSAGES.end, logs::MSG_END);
        let events = Ring::new(v2::EVENT_LOG.start, v2::EVENT_LOG.end, logs::EVENT_END);
        for i in 0..300 {
            let mut r = logs::heard_rec(&logs::heard_job(&station(i)), 1_800_000_000 + i, true);
            block(heard.append(&f, &mut r)).unwrap();
        }
        for i in 0..200 {
            let txt = Buf::from(format!("message {i}").as_bytes());
            let mut r = logs::msg_rec(true, &Buf::from(b"VE7ABC".as_slice()), &txt, &Buf::new(), 1_800_000_000 + i, true);
            block(msgs.append(&f, &mut r)).unwrap();
        }
        for i in 0..50u32 {
            let e = Event { src: Src::Dtmf, ago_s: 0, freq: 14_652_000, slot: 0, unread: true, id: i, x: 0, y: 0, pos: None, name: Buf::new(), text: Buf::from(format!("event {i}").as_bytes()) };
            let mut r = logs::event_rec(&logs::event_job(&e), 1_800_000_000 + i, true);
            block(events.append(&f, &mut r)).unwrap();
        }
        let mut chip = f.into_inner().mem;
        let mut put = |a: u32, b: &[u8]| {
            let o = SimFlash::at(a);
            chip[o..o + b.len()].copy_from_slice(b);
        };
        put(V2_HEADER.start, &v2_header());
        put(v2::SETTINGS.start, &s3(SETTINGS.start, 0x2000));
        put(v2::APRS.start, &s3(APRS.start, 0x2000));
        put(v2::WAYPOINTS.start, &s3(WAYPOINTS.start, 0x4000));
        put(v2::CONTACTS.start, &s3(CONTACTS.start, 0x2000));
        put(v2::TRIMS.start, &[0x5A; 64]);
        put(v2::SSB_PATCH.start, &(0..15_896u32).map(|i| (i * 7) as u8).collect::<Vec<_>>());
        put(v2::PRESETS.start, &[0x42; 224]);
        // Zones 0-3 (zone 2 "Repeaters" gets 300 channels), zone 4 deleted (an empty record), zone 5 "Last".
        let names = ["Local", "Simplex", "Repeaters", "Air", "", "Last"];
        for (z, n) in names.iter().enumerate() {
            if n.is_empty() {
                continue;
            }
            let mut b = records::zone_encode(n.as_bytes(), &ZoneCfg { pri: [Some(5), None], ..records::NEW_ZONE }, 0);
            b[24..26].fill(0xFF); // layout 2 had no count
            let c = crc16(&b[..30]);
            b[30..32].copy_from_slice(&c.to_le_bytes());
            put(v2::ZONES.start + zone_off(z as u32) as u32, &b);
        }
        let mut chans = Vec::new();
        for n in 0..1000u16 {
            let zone = match n {
                0..=99 => 0,
                100..=199 => 1,
                200..=499 => 2,
                500..=549 => 3,
                550..=559 => 5,
                _ => NO_ZONE,
            };
            let c = chan(n, zone);
            put(v2::CHANNELS.start + ch_off(n as u32) as u32, &v1(&c));
            chans.push(c);
        }
        // A rewrite of channel sector 0 cut after its footer: channel 5 renamed in the scratch copy only.
        let target = v2::CHANNELS.start;
        let mut content = chip[SimFlash::at(target)..SimFlash::at(target) + FOOTER_AT as usize].to_vec();
        chans[5].set_name(b"EDITED");
        content[ch_off(5)..ch_off(5) + CH_LEN].copy_from_slice(&v1(&chans[5]));
        let mut scratch = vec![0xFFu8; len(&v2::SCRATCH_RING)];
        let s = 3 * SECTOR as usize;
        scratch[s..s + content.len()].copy_from_slice(&content);
        let mut foot = Vec::new();
        foot.extend(0x5243_5346u32.to_le_bytes());
        foot.extend(target.to_le_bytes());
        foot.extend(crc32(&content).to_le_bytes());
        let c = crc16(&foot);
        foot.extend(c.to_le_bytes());
        scratch[s + FOOTER_AT as usize..s + FOOTER_AT as usize + 14].copy_from_slice(&foot);
        // A half-filled scratch sector with no footer: left alone.
        scratch[5 * SECTOR as usize..5 * SECTOR as usize + 100].fill(0x11);
        let low = chip[SimFlash::at(LOW.start)..SimFlash::at(LOW.start) + len(&LOW)].to_vec();
        let copy = Copy { layout: 2, uid: Some([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), regions: vec![(V2_REGIONS[0].0, low), (V2_REGIONS[1].0, scratch)] };
        Built { copy, chans, settings, aprs }
    }

    /// The translation written as the plan writes it and stamped, on the simulated chip.
    fn written(t: &Translated) -> SimFlash {
        let mut f = SimFlash::new();
        for r in &t.regions {
            for (i, &b) in r.data.iter().enumerate() {
                f.mem[SimFlash::at(r.start + i as u32)] = b;
            }
        }
        let h = header_bytes();
        f.mem[..h.len()].copy_from_slice(&h);
        f
    }

    /// LINK-62, UPD-16, CHAN-35, CHAN-36: a realistic layout 2 chip, translated, written and stamped, mounts on the
    /// firmware's own store with everything as it was: the pending scratch rewrite finished, the 300-channel zone
    /// split 256 + 44, every count right, the rings, settings and lists there, the scratch ring empty.
    #[test]
    fn layout_2_chip_mounts_as_layout_3() {
        let b = build();
        let t = translate(&b.copy).unwrap();
        assert_eq!(t.summary.scratch_applied, 1);
        assert_eq!(t.summary.zones_split, vec![("Repeaters".to_string(), 1)]);
        assert_eq!((t.summary.channels, t.summary.zones, t.summary.channels_unzoned_by_split), (1000, 7, 0));
        assert!(t.notes.iter().any(|n| n.contains("Zone Repeaters had 300 channels: 44 moved to a new zone, Repeaters 2 (256 at most, CHAN-35).")), "{:?}", t.notes);
        let st = Store::mount(written(&t), NoData);
        assert_eq!(st.mounted(), Mounted::Ok);
        // (The store's own check marks the deleted zone 4's empty record as wanting a count: the firmware's.)
        for c in &b.chans {
            let want = if (456..500).contains(&c.num) { Channel { zone: 6, ..*c } } else { *c };
            assert_eq!(st.get(c.num), Some(want), "channel {}", c.num);
        }
        assert_eq!(st.get(5).unwrap().name(), b"EDITED", "the scratch copy's edit");
        assert_eq!(st.count(), 1000);
        assert_eq!(st.zones(), 7);
        assert_eq!((st.zone_len(2), st.zone_len(6), st.zone_len(0), st.zone_len(5)), (256, 44, 100, 10));
        assert_eq!(st.zone_name(6).unwrap().as_bytes(), b"Repeaters 2");
        assert!(st.zone_name(4).is_none_or(|n| n.as_bytes().is_empty()), "a deleted zone stays an empty, unnamed one");
        assert_eq!(st.zone_cfg(6).pri, [Some(5), None], "the new zone is a copy of its record");
        for z in [0u16, 1, 2, 3, 5, 6] {
            let mut r = [0u8; ZONE_LEN];
            r.copy_from_slice(&written(&t).mem[SimFlash::at(records::zone_addr(z))..][..ZONE_LEN]);
            assert_eq!(records::zone_count(&r), Some(st.zone_len(z)), "zone {z}'s record count");
        }
        let mut s = Settings::DEFAULT;
        assert!(st.load_settings(&mut s));
        assert_eq!(s.callsign, b.settings.callsign);
        assert_eq!(st.aprs_cfg().ssid, b.aprs.ssid);
        // Rings: heard 300 rows into 248 slots (62..299 held), messages 200 into 186, events 50.
        assert_eq!(st.heard_stored(), 238);
        assert_eq!(t.summary.heard, 238);
        let mut first = None;
        st.heard_rows(1, &mut |s, _| first = Some(s.call));
        assert_eq!(first.unwrap().as_bytes(), b"VA7H299");
        assert_eq!(st.messages(), t.summary.messages as u16);
        assert!(st.messages() >= 155 && st.messages() <= 186, "{}", st.messages());
        assert_eq!(st.message(0).unwrap().text.as_bytes(), b"message 199");
        assert_eq!((st.events(), t.summary.events), (50, 50));
        assert_eq!(st.event(0).unwrap().text.as_bytes(), b"event 49");
        assert_eq!((st.waypoints(), t.summary.waypoints), (5, 5));
        assert_eq!((st.contacts(), t.summary.contacts), (3, 3));
        assert_eq!(st.contact(0).unwrap().call.as_bytes(), b"VA7XYZ-9", "callsign order kept");
        let f = st.into_parts().0;
        assert!(f.mem[SimFlash::at(SCRATCH_RING.start)..SimFlash::at(SCRATCH_RING.start) + len(&SCRATCH_RING)].iter().all(|&x| x == 0xFF));
        assert_eq!(f.mem[SimFlash::at(SSB_PATCH.start) + 7], 49, "the SSB patch copied");
        assert_eq!(f.mem[SimFlash::at(TRIMS.start)], 0x5A, "the trims copied");
    }

    /// LINK-62: started again from the PC's copy, the translation is the same bytes.
    #[test]
    fn translation_is_repeatable() {
        let b = build();
        let a = translate(&b.copy).unwrap();
        let file = b.copy.to_file();
        let again = translate(&Copy::from_file(&file).unwrap()).unwrap();
        assert_eq!(a, again);
    }

    /// The copy's file round trips; a damaged, cut or foreign one is refused with words.
    #[test]
    fn copy_file_round_trip_and_refusals() {
        let c = Copy { layout: 2, uid: None, regions: vec![(0x02_C000, vec![1, 2, 3]), (0x1E_0000, vec![0xFF; 10])] };
        let f = c.to_file();
        assert_eq!(Copy::from_file(&f).unwrap(), c);
        assert_eq!(c.read(0x02_C001, 2), Some(&[2u8, 3][..]));
        assert_eq!(c.read(0x02_C002, 2), None);
        let mut bad = f.clone();
        bad[30] ^= 1;
        assert!(Copy::from_file(&bad).unwrap_err().contains("damaged"));
        assert!(Copy::from_file(&f[..f.len() - 1]).is_err());
        assert!(Copy::from_file(b"PK\x03\x04 whatever").unwrap_err().contains("isn't"));
        assert!(translate(&Copy { layout: 1, ..c.clone() }).is_err());
        assert!(translate(&c).unwrap_err().contains("0x02C000"));
        assert_eq!(backup_regions(2), Some(V2_REGIONS.to_vec()));
        assert_eq!(backup_regions(3), None);
    }

    /// LINK-60, LINK-62, SAFE-5: the plan never reaches calibration or the update area; programs stay inside a page;
    /// every region is checked by CRC; the old header's sector comes after every other region and the stamp last.
    #[test]
    fn write_plan_order_and_ranges() {
        let t = translate(&build().copy).unwrap();
        let p = write_plan(&t);
        for s in &p {
            match s.kind {
                "erase" => assert!(s.addr % SECTOR == 0 && ferrite_core::layout::writable(s.addr, SECTOR)),
                "program" => {
                    assert!(s.len as usize <= data::PROGRAM_MAX && s.addr / 256 == (s.addr + s.len - 1) / 256);
                    assert!(data::allowed(s.addr, s.len) && ferrite_core::layout::writable(s.addr, s.len));
                    assert_eq!(s.payload.len(), 5 + s.len as usize);
                }
                "crc" => assert!(data::allowed(s.addr, s.len) && s.expect.is_some()),
                "stamp" => assert_eq!(s.payload, [2, 3, 0]),
                k => panic!("{k}"),
            }
        }
        assert_eq!(p.last().unwrap().kind, "stamp");
        // Decision 339: the layout header and the migration mark are the radio's own
        use ferrite_core::layout::{LAYOUT_HEADER, MIGRATE_MARK};
        assert!(p.iter().filter(|s| s.kind != "stamp").all(|s| !LAYOUT_HEADER.contains(&s.addr) && !MIGRATE_MARK.contains(&s.addr)));
        let first_hdr = p.iter().position(|s| s.kind != "stamp" && (V2_HEADER.start..V2_HEADER.end).contains(&s.addr)).unwrap();
        assert!(p[..first_hdr].iter().all(|s| !(V2_HEADER.start..V2_HEADER.end).contains(&s.addr)));
        assert!(p[first_hdr..p.len() - 1].iter().all(|s| (V2_HEADER.start..V2_HEADER.end).contains(&s.addr)));
        assert_eq!(p.iter().filter(|s| s.kind == "crc").count(), t.regions.len());
        // The regions cover their layout 3 areas once each, the header's sector by itself.
        let total: usize = t.regions.iter().map(|r| r.data.len()).sum();
        let want = [SETTINGS, TRIMS, PRESETS, SSB_PATCH, CHANNELS, ZONES, APRS, CONTACTS, HEARD, MESSAGES, WAYPOINTS, EVENT_LOG, SCRATCH_RING].iter().map(len).sum::<usize>();
        assert_eq!(total, want);
        assert_eq!(erased_crc(4096), crc32(&[0xFF; 4096]));
    }

    /// CHAN-35's split into several new zones, the long name cut to fit its number; a copy without the scratch
    /// ring still translates, and says so. (Running out of zone numbers can't happen from layout 2: its 254 zones
    /// and 1,000 channels need at most 4 more.)
    #[test]
    fn split_into_several_zones() {
        let mut low = vec![0xFFu8; len(&LOW)];
        let mut put = |a: u32, b: &[u8]| {
            let o = (a - LOW.start) as usize;
            low[o..o + b.len()].copy_from_slice(b);
        };
        put(V2_HEADER.start, &v2_header());
        // Zone 253 (the last layout 2 had) holds all 1,000 channels: 256 stay, 3 new zones take 256, 256 and 232.
        let name = b"A very long name";
        let z = records::zone_encode(name, &records::NEW_ZONE, 0xFFFF);
        put(v2::ZONES.start + zone_off(253) as u32, &z);
        for n in 0..1000u16 {
            put(v2::CHANNELS.start + ch_off(n as u32) as u32, &v1(&chan(n, 253)));
        }
        let t = translate(&Copy { layout: 2, uid: None, regions: vec![(LOW.start, low)] }).unwrap();
        assert_eq!(t.summary.zones_split, vec![("A very long name".to_string(), 3)]);
        assert_eq!(t.summary.zones, 257);
        let st = Store::mount(written(&t), NoData);
        assert_eq!(st.zone_name(254).unwrap().as_bytes(), b"A very long na 2");
        assert_eq!(st.zone_name(256).unwrap().as_bytes(), b"A very long na 4");
        assert_eq!((st.zone_len(253), st.zone_len(254), st.zone_len(256)), (256, 256, 232));
        let f = written(&t);
        for z in 253..257u16 {
            let mut r = [0u8; ZONE_LEN];
            r.copy_from_slice(&f.mem[SimFlash::at(records::zone_addr(z))..][..ZONE_LEN]);
            assert_eq!(records::zone_count(&r), Some(st.zone_len(z)), "zone {z}'s record count");
        }
        assert!(t.notes.iter().any(|n| n.contains("no copy of layout 2's scratch ring")));
    }

    /// The plan's step as the radio's link hands it to the store (LINK-60).
    fn as_write(s: &Step) -> Option<ferrite_app::data::DataWrite> {
        use ferrite_app::data::DataWrite;
        Some(match s.kind {
            "erase" => DataWrite::Erase(s.addr),
            "program" => {
                let mut bytes = [0xFF; data::PROGRAM_MAX];
                bytes[..s.len as usize].copy_from_slice(&s.payload[5..]);
                DataWrite::Program { addr: s.addr, len: s.len as u8, bytes }
            }
            "stamp" => DataWrite::Stamp,
            _ => return None,
        })
    }

    /// The radio's Storage task: the queued writes done.
    fn drain(st: &Store) {
        while let Some(j) = st.next_job() {
            block(st.run(j));
        }
    }

    /// Steps `from..to` of the plan sent as Console sends them to a radio (its store queuing writes as on the radio:
    /// `busy` sent again once the Storage task has had its turn; each region's CRC read back once nothing is
    /// queued), stopping right after step `to - 1`'s answer: what is still queued then is lost (a reset).
    fn send(st: &Store, plan: &[Step], to: usize) {
        for s in &plan[..to] {
            send_one(st, s);
        }
    }

    fn send_one(st: &Store, s: &Step) {
        st.set_deferred(true);
        match as_write(s) {
            Some(w) => {
                let mut tries = 0;
                while !st.data_write(w) {
                    drain(st);
                    tries += 1;
                    assert!(tries < 3, "{} at {:#x}: busy", s.kind, s.addr);
                }
            }
            None => {
                while st.busy() {
                    drain(st); // LINK-59: `busy` until the writes before it are done
                }
                assert_eq!(st.data_crc(s.addr, s.len), s.expect, "{}", s.region);
            }
        }
    }

    /// Decision 339, LINK-62: the real plan for a realistic layout 2 chip, with a reset right after every step's
    /// answer (what the radio had queued then never written; after the last step that is the stamp, as on clear on
    /// Nov 1, 2026): every mount waits for Console (layout 2, or half moved) or holds everything, never formats; and
    /// Finish the update started again from Console's copy always ends on layout 3 with all the data.
    #[test]
    fn a_reset_after_any_step_loses_nothing() {
        use ferrite_core::layout::LAYOUT_MOVING;
        let b = build();
        let mut chip = SimFlash::new();
        let low = &b.copy.regions[0].1;
        chip.mem[SimFlash::at(V2_REGIONS[0].0)..][..low.len()].copy_from_slice(low);
        let t = translate(&b.copy).unwrap();
        let plan = write_plan(&t);
        let want = Store::mount(written(&t), NoData);
        let want_ch: Vec<_> = (0..1000).map(|n| want.get(n)).collect();
        let n = plan.len();
        assert!(n > 1500, "{n} steps");
        let live = Store::mount(chip, NoData);
        assert_eq!(live.mounted(), Mounted::Update(2));
        for k in 0..=n {
            if k > 0 {
                send_one(&live, &plan[k - 1]);
            }
            // The reset: the flash as it is now; what is still queued is gone with the RAM.
            let st = Store::mount(live.nor().clone(), NoData);
            let m = st.mounted();
            assert!(m == Mounted::Update(2) || m == Mounted::Update(LAYOUT_MOVING), "reset after step {k} of {n}: {m:?}");
            // Started again from the copy (after every one of the first and last steps, every 64th between).
            if k < 8 || k + 8 > n || k % 64 == 0 {
                send(&st, &plan, n);
                drain(&st);
                let st = Store::mount(st.into_parts().0, NoData);
                assert_eq!(st.mounted(), Mounted::Ok, "reset after step {k}: finished again");
                assert_eq!(st.count(), 1000);
                assert!((0..1000).all(|c| st.get(c) == want_ch[c as usize]), "reset after step {k}: the channels");
            }
        }
    }

    /// The simulator's layout 2 chip for Console's end-to-end test of Finish the update (`tests/e2e/fixtures/
    /// layout2-chip.bin`: [`build`]'s chip from 0x02C000 to 0x08CFFF; the simulated chip holds no layout 2 scratch
    /// ring, so the pending rewrite isn't in it). `FERRITE_WRITE_MIGRATE_FIXTURE=1` writes it again.
    #[test]
    fn e2e_fixture_is_the_built_chip() {
        let b = build();
        let low = &b.copy.regions[0].1;
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/e2e/fixtures/layout2-chip.bin");
        if std::env::var("FERRITE_WRITE_MIGRATE_FIXTURE").is_ok() {
            std::fs::write(&path, low).unwrap();
        }
        let on_disk = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(on_disk == *low, "the e2e fixture isn't the built chip (FERRITE_WRITE_MIGRATE_FIXTURE=1 to write it again)");
        assert_eq!((V2_REGIONS[0].0, on_disk.len()), (0x02_C000, 0x6_1000));
    }
}
