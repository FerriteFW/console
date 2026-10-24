//! The Install page: a stock radio to Ferrite and back, from the browser (BACKUP-1, BACKUP-2, BACKUP-7, BACKUP-8,
//! BACKUP-9.3, INST-5, INST-10, INST-11; decision 261). Ported from ferrite's `tools/flash.py`, `tools/ssbpatch.py`
//! and `fw/tools/fdump_proto.py` / `backup.py` (the behaviour, not the layout).
//!
//! - The backup: the reader image ([`check_reader`]: ferrite's read-only `reader/`, decision 264, or the older
//!   hwtest one; same protocol) goes in through the bootloader; its console answers
//!   `sys` (the radio's ID), `flash` (the chip) and `fdump` ([`Fdump`]: 4 KB frames with a CRC each, resent on a
//!   NAK, a whole-range CRC at the end, at 500 kbaud); `flashcrc` is the radio's own CRC of the whole chip, which
//!   must agree. [`check_backup`] is flash.py's `check_backup` plus a CRC-32 per region.
//! - SSB: [`ssb_extract`] finds the Si473x patch in the owner's own stock `.BTF` as ssbpatch.py does;
//!   [`ferrite_update`] bundles it into the Ferrite image (64-byte `FERRSSB1` header, first 1 KB boundary after the
//!   image) and packs it again. Nothing of the patch is ever shipped.
//! - Back to stock: [`restore_plan`] gives the `STOCK_RESTORE` requests that write the backup into Ferrite's own
//!   writable ranges. Calibration (0x00F000-0x00FFFF) and the update area (0x300000 up) are left out by
//!   construction: the ranges are cut to ferrite's `layout::WRITABLE` and every request is checked again with
//!   [`never_written`], whatever the radio's answer says. Then [`stock_update`] flashes the stock `.BTF`.
//! - Which radio a backup is from (decision 263): the MCU's unique ID, as the reader's `sys` and Ferrite's `START`
//!   answer give it. The backup stays a raw flash image, so the ID travels in its file name ([`backup_name`],
//!   [`name_uid`]) and in the browser's own record; calibration alone can't tell two radios apart (it can be the
//!   factory's same data on both), so its CRC is only a check against a blank or damaged file.

use crate::firmware::{self, check_image, pack, unpack, Update, APP_BASE, APP_MAX, BOOT_MAX, FERRITE_MARK};
use ferrite_core::layout::{CALIBRATION, UPDATE_AREA, WRITABLE};
use ferrite_core::sha256::sha256;
use serde::Serialize;

pub const CAL: usize = CALIBRATION.start as usize;
pub const SECTOR: usize = 0x1000;
pub const UPDATE: usize = UPDATE_AREA.start as usize;
/// Text only a reader image holds (its help line for the binary dump: ferrite's reader and hwtest alike).
pub const READER_MARK: &[u8] = b"fdump <addr> <len>";
/// The link's `STOCK_RESTORE` (ferrite decision 261) and its ops.
pub const STOCK_RESTORE: u8 = 0x60;
pub const OP_START: u8 = 0;
pub const OP_ERASE: u8 = 1;
pub const OP_PROGRAM: u8 = 2;
pub const OP_CRC: u8 = 3;
pub const OP_FINISH: u8 = 4;
/// Bytes per `PROGRAM`: half a page, so an aligned chunk never crosses one.
pub const CHUNK: usize = 128;

/// SHA-256 as lowercase hex (the bundled release's checksum, UPD-15).
pub fn sha256_hex(b: &[u8]) -> String {
    hex(&sha256(b))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn find(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

// ---- the backup ----

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Region {
    pub name: String,
    pub start: u32,
    pub end: u32,
    pub crc32: String,
}

/// What a whole-chip backup is, and why it can't be used (`problems`; empty: fine).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BackupCheck {
    pub size: usize,
    pub sha256: String,
    pub crc32: String,
    pub cal_crc32: String,
    /// A stock phone or Bluetooth update waits at 0x300000 (INST-5): Ferrite can't be installed over it.
    pub pending_update: bool,
    /// BACKUP-1.3: a CRC-32 per region.
    pub regions: Vec<Region>,
    pub problems: Vec<String>,
}

/// The calibration sector's CRC-32 in a backup (the radio's `STOCK_RESTORE` names its own: the same radio).
pub fn cal_crc(b: &[u8]) -> Option<u32> {
    b.get(CAL..CAL + SECTOR).map(firmware::crc32)
}

/// A stock phone or Bluetooth update waits in the backup's update area.
pub fn pending_update(b: &[u8]) -> bool {
    matches!(b.get(UPDATE..UPDATE + 2), Some([0x5A, 0xA5]) | Some([0xA5, 0x5A]))
}

/// What makes a backup unusable for anything: its size, a blank calibration sector.
fn shape_problems(b: &[u8]) -> Vec<String> {
    let mut problems = Vec::new();
    if ![2 << 20, 4 << 20, 8 << 20].contains(&b.len()) {
        problems.push(format!("{} bytes: a whole-chip backup is 2, 4 or 8 MB", b.len()));
    }
    let cal = b.get(CAL..CAL + SECTOR).unwrap_or(&[]);
    if cal.len() < SECTOR || cal.iter().all(|&x| x == 0xFF) || cal.iter().all(|&x| x == 0) {
        problems.push("the calibration sector (0x00F000) is blank: not a backup of a working radio".into());
    }
    problems
}

/// flash.py's `check_backup`, plus the regions' CRCs: 2, 4 or 8 MB, calibration not blank, no pending update.
pub fn check_backup(b: &[u8]) -> BackupCheck {
    let mut problems = shape_problems(b);
    let pending = pending_update(b);
    if pending {
        problems.push(
            "a stock phone or Bluetooth update is waiting in the radio (0xA55A at 0x300000): the bootloader would flash it over Ferrite at the next power-on. Let stock finish or clear that update first, then take a new backup".into(),
        );
    }
    let mut regions = Vec::new();
    let mut add = |name: &str, s: usize, e: usize| {
        if e <= b.len() && s < e {
            regions.push(Region {
                name: name.into(),
                start: s as u32,
                end: e as u32,
                crc32: format!("{:08X}", firmware::crc32(&b[s..e])),
            });
        }
    };
    add("Stock settings", 0, CAL);
    add("Calibration", CAL, CAL + SECTOR);
    add("Stock data", CAL + SECTOR, 0x20_0000);
    add("Voice prompts", 0x20_0000, UPDATE);
    add("Update area", UPDATE, b.len());
    BackupCheck {
        size: b.len(),
        sha256: hex(&sha256(b)),
        crc32: format!("{:08X}", firmware::crc32(b)),
        cal_crc32: cal_crc(b).map(|c| format!("{c:08X}")).unwrap_or_default(),
        pending_update: pending,
        regions,
        problems,
    }
}

// ---- the reader image's console ----

/// `flash`: "flash id EF4016 (Winbond, 4096 KB) ..." -> (JEDEC ID, vendor, bytes).
pub fn parse_flash(line: &str) -> Option<(String, String, u32)> {
    let rest = &line[line.find("flash id ")? + 9..];
    let id = rest.get(..6)?;
    let rest = rest.get(6..)?.strip_prefix(" (")?;
    let (vendor, rest) = rest.split_once(", ")?;
    let kb: u32 = rest.split(' ').next()?.parse().ok()?;
    rest.split(' ').nth(1).filter(|u| u.starts_with("KB"))?;
    (id.chars().all(|c| c.is_ascii_hexdigit()) && kb > 0).then(|| (id.to_string(), vendor.to_string(), kb * 1024))
}

/// `sys`: "... uid 0123ABCD4567EF0189ABCDEF" -> the MCU's three ID words, lowest first.
pub fn parse_uid(line: &str) -> Option<[u32; 3]> {
    let rest = &line[line.find(" uid ")? + 5..];
    let h = rest.get(..24)?;
    let w = |i: usize| u32::from_str_radix(&h[8 * i..8 * i + 8], 16).ok();
    Some([w(0)?, w(1)?, w(2)?])
}

/// The ID as About shows it ("XXXXX XXXXX XXXXX XXXXX"), from the three words.
pub fn uid_text(w: [u32; 3]) -> String {
    let b: Vec<u8> = w.iter().flat_map(|x| x.to_le_bytes()).collect();
    crate::uid::text(&b).unwrap_or_default()
}

/// ferrite's base32 digits (`ferrite_core::uid`): what an ID is written in.
const UID_DIGITS: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// An ID as typed or written anywhere ("n0eq8 0r081...", "N0EQ80R081..."): its 20 digits, upper case, or None when
/// it isn't one.
pub fn uid_key(s: &str) -> Option<String> {
    let k: String = s.chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| c.to_ascii_uppercase()).collect();
    (k.len() == 20 && k.bytes().all(|c| UID_DIGITS.contains(&c))).then_some(k)
}

/// The ID grouped as About shows it.
fn uid_grouped(key: &str) -> String {
    (0..4).map(|i| &key[5 * i..5 * i + 5]).collect::<Vec<_>>().join(" ")
}

/// The backup's file name: `rt950pro-backup-<ID>-<YYYYMMDD>.bin`, the ID's 20 digits (decision 263).
pub fn backup_name(uid: &str, date: &str) -> String {
    format!("rt950pro-backup-{}-{date}.bin", uid_key(uid).unwrap_or_else(|| "unknown-id".into()))
}

/// The radio ID a backup's file name carries ([`backup_name`]), grouped, or None (a renamed file).
pub fn name_uid(name: &str) -> Option<String> {
    let at = name.find("rt950pro-backup-")? + 16;
    uid_key(name.get(at..at + 20)?).map(|k| uid_grouped(&k))
}

/// `flashcrc`: "flash crc32 1A2B3C4D over 4096 KB, 52 s" -> (crc, bytes).
pub fn parse_flashcrc(line: &str) -> Option<(u32, u32)> {
    let rest = &line[line.find("flash crc32 ")? + 12..];
    let crc = u32::from_str_radix(rest.get(..8)?, 16).ok()?;
    let kb: u32 = rest.get(8..)?.strip_prefix(" over ")?.split(' ').next()?.parse().ok()?;
    Some((crc, kb * 1024))
}

// ---- fdump: hwtest's binary dump (src/core/fdump.h; fdump_proto.py), and fdumpz (BACKUP-9.6) ----

pub const FD_ACK: u8 = 0x06;
pub const FD_NAK: u8 = 0x15;
pub const FD_CAN: u8 = 0x18;
const FD_HDR: usize = 10;
const FD_BLOCK: usize = 4096;
const FD_TRIES: usize = 10;
/// `fdumpz`'s chunk (ferrite's `reader::ZCHUNK`): 16 KB of the range per frame, coded.
pub const FD_ZCHUNK: usize = 16384;
/// `fdumpz`'s rate (ferrite decision 265): the one safe rate for long transfers over the cable.
pub const FDUMPZ_BAUD: u32 = 230_400;
/// The help line only the Rust reader holds: it has `fdumpz`.
pub const READER_Z_MARK: &[u8] = b"fdumpz <addr> <len>";
const Z_RAW: u8 = 0;
const Z_ERASED: u8 = 1;
const Z_DEFLATE: u8 = 4;

/// What [`Fdump::feed`] asks of the caller.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct FdStep {
    /// Bytes to write now (an ACK).
    pub send: Vec<u8>,
    /// A bad or lost frame: wait ~20 ms, drop what came meanwhile ([`Fdump::resume`]), then send a NAK.
    pub nak: bool,
    /// `fdumpz`: a DEFLATE chunk waits ([`Fdump::take_inflate`]); inflate it (raw DEFLATE) and hand the result to
    /// [`Fdump::inflated`], which ACKs it.
    pub inflate: bool,
    pub done: bool,
    pub error: Option<String>,
    /// Bytes of the range received so far (decoded: the chip's bytes, not the cable's).
    pub got: usize,
}

/// The host's side of one `fdump` or `fdumpz`, sans I/O: `FDS1` until `FDOK`, then each frame checked and answered.
pub struct Fdump {
    addr: u32,
    len: u32,
    z: bool,
    data: Vec<u8>,
    buf: Vec<u8>,
    /// `fdumpz`: the DEFLATE bytes of the chunk being inflated by the caller, and the bytes it must give.
    inflate: Option<(Vec<u8>, usize)>,
    synced: bool,
    skipping: bool,
    finished: bool,
    pub naks: usize,
    pub dups: usize,
    pub radio_resends: u32,
    /// Bytes that crossed the cable in good frames.
    pub wire: usize,
}

fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

impl Fdump {
    pub fn new(addr: u32, len: u32) -> Self {
        Fdump {
            addr,
            len,
            z: false,
            data: Vec::with_capacity(len as usize),
            buf: Vec::new(),
            inflate: None,
            synced: false,
            skipping: false,
            finished: false,
            naks: 0,
            dups: 0,
            radio_resends: 0,
            wire: 0,
        }
    }

    /// `fdumpz` (the Rust reader, BACKUP-9.6): 16 KB chunks coded as raw, erased or raw DEFLATE.
    pub fn new_z(addr: u32, len: u32) -> Self {
        Fdump { z: true, ..Fdump::new(addr, len) }
    }

    /// The console command (at 115200); the radio answers "fdump ... ready" and switches to `baud`.
    pub fn command(&self, baud: u32) -> String {
        let name = if self.z { "fdumpz" } else { "fdump" };
        format!("{name} 0x{:X} 0x{:X} {baud}\r", self.addr, self.len)
    }

    pub fn synced(&self) -> bool {
        self.synced
    }

    pub fn take_data(&mut self) -> Vec<u8> {
        core::mem::take(&mut self.data)
    }

    /// The DEFLATE bytes a step's `inflate` asks for (empty when none wait).
    pub fn take_inflate(&mut self) -> Vec<u8> {
        self.inflate.as_mut().map(|(b, _)| core::mem::take(b)).unwrap_or_default()
    }

    /// After a NAK's pause: what came meanwhile is dropped.
    pub fn resume(&mut self) {
        self.buf.clear();
        self.skipping = false;
    }

    /// How long a frame begun in what has come so far may still take, in ms from when it began (0: none begun):
    /// its bytes at `baud` plus 0.3 s, and 0.3 s for the header (fdump_proto.py's `_next_zframe`). A frame short of
    /// bytes (lost on the cable) is asked again after this instead of after the radio's own 2 s.
    pub fn frame_budget_ms(&self, baud: u32) -> u32 {
        if !self.synced || self.skipping || self.finished || self.inflate.is_some() {
            return 0;
        }
        let Some(i) = self.buf.windows(2).position(|w| w == b"FD") else { return 0 };
        let b = &self.buf[i..];
        if b.len() < FD_HDR {
            return 300 + 300 + (FD_HDR as u32 * 10_000) / baud.max(1);
        }
        let n = u16::from_le_bytes([b[8], b[9]]) as u32;
        600 + ((FD_HDR as u32 + n + 4) * 10_000) / baud.max(1)
    }

    fn bad(&mut self) -> FdStep {
        self.naks += 1;
        self.buf.clear();
        self.skipping = true;
        self.inflate = None;
        if self.naks > FD_TRIES * (self.len as usize / FD_BLOCK + 1) {
            return FdStep { error: Some("too many bad frames".into()), got: self.data.len(), ..Default::default() };
        }
        FdStep { nak: true, got: self.data.len(), ..Default::default() }
    }

    /// Nothing arrived in time: a NAK, as for a bad frame.
    pub fn timeout(&mut self) -> FdStep {
        self.bad()
    }

    /// The caller's inflated DEFLATE chunk (empty when it didn't inflate): ACKed when it is the chunk's whole
    /// length, then what came meanwhile is read on.
    pub fn inflated(&mut self, out: &[u8]) -> FdStep {
        let mut step = FdStep { got: self.data.len(), ..Default::default() };
        let Some((_, want)) = self.inflate.take() else { return step };
        if out.len() != want {
            step.error = Some(format!("chunk at {:06X} doesn't decode", self.addr as usize + self.data.len()));
            return step;
        }
        self.data.extend_from_slice(out);
        step.send.push(FD_ACK);
        self.parse(step)
    }

    pub fn feed(&mut self, bytes: &[u8]) -> FdStep {
        let step = FdStep { got: self.data.len(), ..Default::default() };
        if self.skipping || self.finished {
            return step;
        }
        self.buf.extend_from_slice(bytes);
        if self.inflate.is_some() {
            return step;
        }
        if !self.synced {
            match self.buf.windows(4).position(|w| w == b"FDOK") {
                Some(i) => {
                    self.synced = true;
                    self.buf.drain(..i + 4);
                }
                None => {
                    let keep = self.buf.len().saturating_sub(3);
                    self.buf.drain(..keep);
                    return step;
                }
            }
        }
        self.parse(step)
    }

    fn parse(&mut self, mut step: FdStep) -> FdStep {
        let (data_kind, most) = if self.z { (b'Z', FD_ZCHUNK + 1) } else { (b'B', FD_BLOCK) };
        loop {
            let Some(i) = self.buf.windows(2).position(|w| w == b"FD") else {
                let keep = if self.buf.last() == Some(&b'F') { self.buf.len() - 1 } else { self.buf.len() };
                self.buf.drain(..keep);
                return step;
            };
            self.buf.drain(..i);
            if self.buf.len() < FD_HDR {
                return step;
            }
            let (kind, zero) = (self.buf[2], self.buf[3]);
            let a = le32(&self.buf[4..8]);
            let n = u16::from_le_bytes([self.buf[8], self.buf[9]]) as usize;
            if !(kind == data_kind || kind == b'E') || zero != 0 || n > most {
                return self.bad();
            }
            if self.buf.len() < FD_HDR + n + 4 {
                return step;
            }
            let body = &self.buf[..FD_HDR + n];
            if firmware::crc32(body) != le32(&self.buf[FD_HDR + n..]) {
                return self.bad();
            }
            let payload = self.buf[FD_HDR..FD_HDR + n].to_vec();
            self.buf.drain(..FD_HDR + n + 4);
            self.wire += FD_HDR + n + 4;
            if kind == data_kind {
                let here = self.addr + self.data.len() as u32;
                if a < here {
                    self.dups += 1; // our ACK was lost: the radio sent it again
                    step.send.push(FD_ACK);
                    continue;
                }
                if a != here {
                    step.error = Some(format!("block at {a:06X}, expected {here:06X}"));
                    return step;
                }
                if !self.z {
                    self.data.extend_from_slice(&payload);
                    step.send.push(FD_ACK);
                    step.got = self.data.len();
                    continue;
                }
                let want = FD_ZCHUNK.min(self.len as usize - self.data.len());
                let chunk = match (payload.first(), payload.len() - 1) {
                    (Some(&Z_ERASED), 0) => Some(vec![0xFF; want]),
                    (Some(&Z_RAW), k) if k == want => Some(payload[1..].to_vec()),
                    (Some(&Z_DEFLATE), k) if k > 0 => {
                        self.inflate = Some((payload[1..].to_vec(), want));
                        step.inflate = true;
                        return step;
                    }
                    _ => None,
                };
                let Some(chunk) = chunk else {
                    step.error = Some(format!("chunk at {a:06X} doesn't decode"));
                    return step;
                };
                self.data.extend_from_slice(&chunk);
                step.send.push(FD_ACK);
                step.got = self.data.len();
                continue;
            }
            step.send.push(FD_ACK);
            if payload.len() < 16 {
                step.error = Some("short end frame".into());
                return step;
            }
            let (start, total, crc) = (le32(&payload), le32(&payload[4..]), le32(&payload[8..]));
            self.radio_resends = le32(&payload[12..]);
            self.finished = true;
            if (start, total) != (self.addr, self.len) || self.data.len() != self.len as usize {
                step.error = Some(format!("end frame for {start:06X}+{total:X}, have {} bytes", self.data.len()));
            } else if firmware::crc32(&self.data) != crc {
                step.error =
                    Some(format!("whole-range CRC {:08X} vs the radio's {crc:08X}", firmware::crc32(&self.data)));
            } else {
                step.done = true;
            }
            return step;
        }
    }
}

// ---- images ----

/// What the page shows about an image it will flash, and why it can't (`problems`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ImageCheck {
    pub blocks: usize,
    pub image_len: usize,
    pub version: Option<String>,
    pub crc32: String,
    pub sha256: String,
    pub problems: Vec<String>,
}

fn image_check(btf: &[u8], limit: usize, want: impl Fn(&[u8]) -> Option<String>) -> (ImageCheck, Vec<u8>) {
    let (img, mut problems) = match unpack(btf) {
        Ok((img, _)) => {
            let p = check_image(&img, limit);
            (img, p)
        }
        Err(e) => (Vec::new(), vec![e]),
    };
    if !img.is_empty() {
        if let Some(p) = want(&img) {
            problems.push(p);
        }
    }
    let c = ImageCheck {
        blocks: btf.len().div_ceil(firmware::BLOCK),
        image_len: img.len(),
        version: firmware::version(&img),
        crc32: format!("{:08X}", firmware::crc32(&img)),
        sha256: hex(&sha256(btf)),
        problems,
    };
    (c, img)
}

/// A reader image (ferrite's or hwtest's): its own mark, never Ferrite, below the stock marker sector.
pub fn check_reader(btf: &[u8]) -> ImageCheck {
    image_check(btf, APP_MAX, |img| {
        (!find(img, READER_MARK) || find(img, FERRITE_MARK))
            .then(|| "not the reader image (no fdump command in it)".into())
    })
    .0
}

/// Whether a reader image speaks `fdumpz` (the Rust reader, BACKUP-9.6; hwtest's doesn't): its help line.
pub fn reader_has_fdumpz(btf: &[u8]) -> bool {
    unpack(btf).map(|(img, _)| find(&img, READER_Z_MARK)).unwrap_or(false)
}

/// A stock `.BTF` for the way back: the bootloader's own limit, and not Ferrite or the reader.
pub fn check_stock(btf: &[u8]) -> ImageCheck {
    image_check(btf, BOOT_MAX, |img| {
        if find(img, FERRITE_MARK) {
            Some("this is a Ferrite image, not stock firmware".into())
        } else if find(img, READER_MARK) {
            Some("this is the reader image, not stock firmware".into())
        } else {
            None
        }
    })
    .0
}

/// The reader's update: the file as it is.
pub fn reader_update(btf: &[u8]) -> Result<Update, Vec<String>> {
    let c = check_reader(btf);
    if c.problems.is_empty() {
        Ok(Update::raw(btf.to_vec()))
    } else {
        Err(c.problems)
    }
}

/// The stock `.BTF`'s update: the file as it is, as Radtel's updater and flash.py send it (BACKUP-8).
pub fn stock_update(btf: &[u8]) -> Result<Update, Vec<String>> {
    let c = check_stock(btf);
    if c.problems.is_empty() {
        Ok(Update::raw(btf.to_vec()))
    } else {
        Err(c.problems)
    }
}

// ---- SSB (ssbpatch.py) ----

const REC: usize = 8;
/// Shorter runs aren't the patch (the known one is ~2,000 records).
const MIN_RECORDS: usize = 500;

/// (offset, records) of the longest run of Si473x patch records (0x15 starts a block, 0x16 continues it), 8-byte
/// aligned within the run: ssbpatch.py's `find`.
pub fn ssb_find(img: &[u8]) -> (usize, usize) {
    let mut best = (0, 0);
    for phase in 0..REC {
        let (mut start, mut n): (Option<usize>, usize) = (None, 0);
        let mut off = phase;
        while off + REC <= img.len() {
            let ok = (img[off] == 0x15 || img[off] == 0x16) && (n > 0 || img[off] == 0x15);
            if ok {
                if start.is_none() {
                    (start, n) = (Some(off), 0);
                }
                n += 1;
            } else {
                if let Some(s) = start {
                    if n > best.1 {
                        best = (s, n);
                    }
                }
                (start, n) = (None, 0);
            }
            off += REC;
        }
        if let Some(s) = start {
            if n > best.1 {
                best = (s, n);
            }
        }
    }
    best
}

/// What the page shows about the owner's SSB patch.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SsbFound {
    pub len: usize,
    pub records: usize,
    pub sha256: String,
    /// The patch stock V0.18-V0.29 carry; an unknown one is stored only after the radio asks (INST-12).
    pub known: bool,
}

/// The patch from a stock `.BTF` (or an unpacked image when `is_btf` is false), or None: ssbpatch.py's `extract`.
pub fn ssb_extract(data: &[u8], is_btf: bool) -> Option<Vec<u8>> {
    let img = if is_btf { unpack(data).ok()?.0 } else { data.to_vec() };
    let (off, n) = ssb_find(&img);
    (n >= MIN_RECORDS).then(|| img[off..off + n * REC].to_vec())
}

pub fn ssb_describe(patch: &[u8]) -> SsbFound {
    let sha = sha256(patch);
    SsbFound {
        len: patch.len(),
        records: patch.len() / REC,
        sha256: hex(&sha),
        known: sha == ferrite_core::ssb::KNOWN_SHA256,
    }
}

/// The image with the patch appended at the next 1 KB boundary after its last non-0xFF byte (INST-11), and where:
/// ssbpatch.py's `bundle`.
pub fn ssb_bundle(img: &[u8], patch: &[u8]) -> (Vec<u8>, usize) {
    let end = img.iter().rposition(|&b| b != 0xFF).map_or(0, |i| i + 1);
    let at = end.div_ceil(1024) * 1024;
    let mut head = Vec::with_capacity(ferrite_core::ssb::HEADER);
    head.extend_from_slice(&ferrite_core::ssb::BUNDLE_MAGIC);
    head.extend_from_slice(&(patch.len() as u32).to_le_bytes());
    head.extend_from_slice(&((patch.len() / REC) as u32).to_le_bytes());
    head.extend_from_slice(&0u32.to_le_bytes());
    head.extend_from_slice(&sha256(patch));
    head.resize(ferrite_core::ssb::HEADER, 0);
    let mut out = img[..end].to_vec();
    out.resize(at, 0xFF);
    out.extend_from_slice(&head);
    out.extend_from_slice(patch);
    (out, at)
}

/// The Ferrite image to install: checked as Firmware Update checks it, then with the owner's SSB patch bundled and
/// packed again (flash.py `--ssb-from`), or the file as it is without one.
pub fn ferrite_update(btf: &[u8], patch: Option<&[u8]>) -> Result<(Update, Option<u32>), Vec<String>> {
    let c = firmware::check_file(btf);
    if !c.problems.is_empty() {
        return Err(c.problems);
    }
    let Some(patch) = patch else { return Ok((Update::raw(btf.to_vec()), None)) };
    let img = unpack(btf).map_err(|e| vec![e])?.0;
    let (img, at) = ssb_bundle(&img, patch);
    if img.len() > APP_MAX {
        return Err(vec!["the image and the SSB patch together don't fit below the stock marker sector".into()]);
    }
    Ok((Update::raw(pack(&img)), Some(APP_BASE + at as u32)))
}

// ---- back to stock (STOCK_RESTORE) ----

/// Whether any of `len` bytes at `addr` is calibration or the update area: never written by Console.
pub fn never_written(addr: u32, len: u32) -> bool {
    let end = addr as u64 + len as u64;
    let hit = |r: &core::ops::Range<u32>| (addr as u64) < r.end as u64 && (r.start as u64) < end;
    hit(&CALIBRATION) || hit(&UPDATE_AREA) || end > u32::MAX as u64
}

/// The radio's `START` answer: chip size, calibration CRC-32, its ranges, then the MCU's unique ID (decision 263;
/// None from a Ferrite before it).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RestoreStart {
    pub chip: u32,
    pub cal_crc32: u32,
    pub ranges: Vec<(u32, u32)>,
    /// As About shows it ("XXXXX XXXXX XXXXX XXXXX").
    pub uid: Option<String>,
}

pub fn parse_start(rest: &[u8]) -> Option<RestoreStart> {
    if rest.len() < 9 || rest.len() < 9 + 8 * rest[8] as usize {
        return None;
    }
    let n = rest[8] as usize;
    let ranges = (0..n).map(|i| (le32(&rest[9 + 8 * i..]), le32(&rest[13 + 8 * i..]))).collect();
    let uid = rest.get(9 + 8 * n..9 + 8 * n + 12).and_then(crate::uid::text);
    Some(RestoreStart { chip: le32(rest), cal_crc32: le32(&rest[4..]), ranges, uid })
}

/// What Console knows of the backup's radio (decision 263).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BackupId {
    /// The ID the backup was taken from: its file name's, or this browser's record of its SHA-256.
    pub uid: Option<String>,
    /// The radio's ID as the owner typed it, when Console doesn't know the backup's.
    pub confirmed: Option<String>,
}

/// One `STOCK_RESTORE` request of the plan.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RestoreOp {
    /// "erase", "program", "crc".
    pub kind: &'static str,
    pub addr: u32,
    pub len: u32,
    pub payload: Vec<u8>,
    /// A `crc`'s expected answer (the backup's).
    pub expect: Option<u32>,
}

/// The plan, and how much of the chip it covers.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RestorePlan {
    pub ops: Vec<RestoreOp>,
    pub ranges: Vec<(u32, u32)>,
    pub bytes: u32,
    pub problems: Vec<String>,
    /// Console doesn't know which radio the backup is from: the owner types this radio's ID (this) to go on.
    pub confirm_uid: Option<String>,
}

fn op(kind: &'static str, code: u8, addr: u32, len: u32, data: &[u8], expect: Option<u32>) -> RestoreOp {
    let mut payload = vec![code];
    payload.extend_from_slice(&addr.to_le_bytes());
    if kind == "crc" {
        payload.extend_from_slice(&len.to_le_bytes());
    }
    payload.extend_from_slice(data);
    RestoreOp { kind, addr, len, payload, expect }
}

/// Why the backup can't go into the radio whose ID is `radio_uid` (decision 263), and the ID to confirm when
/// Console doesn't know the backup's. Console asks this before `START` with `INFO`'s ID (nothing stops), and the
/// plan asks it again with the `START` answer's.
pub fn check_id(radio_uid: Option<&str>, id: &BackupId) -> (Vec<String>, Option<String>) {
    let Some(here) = radio_uid.and_then(uid_key) else {
        return (
            vec!["This Ferrite doesn't say which radio it is. Update it (Firmware Update), then start Back to stock again.".into()],
            None,
        );
    };
    let shown = uid_grouped(&here);
    match id.uid.as_deref().map(|u| uid_key(u).unwrap_or_default()) {
        Some(b) if b == here => (vec![], None),
        Some(b) if !b.is_empty() => (
            vec![format!(
                "This backup is from another radio (ID {}). This radio's ID is {shown}. Writing it would replace this radio's settings and channels with the other radio's. Use this radio's own backup.",
                uid_grouped(&b)
            )],
            None,
        ),
        _ if id.confirmed.as_deref().and_then(uid_key).as_deref() == Some(here.as_str()) => (vec![], None),
        _ => (
            vec![format!(
                "Console can't tell which radio this backup is from (its file name was changed, or it was saved in another browser). A backup from another radio overwrites this radio's settings and channels. If this file is this radio's backup, type this radio's ID ({shown}) below, then start Back to stock again."
            )],
            Some(shown),
        ),
    }
}

/// What to write back (BACKUP-7): the backup inside the ranges the radio named, cut to ferrite's own
/// `layout::WRITABLE`, whole sectors only, never calibration or the update area. Each sector is erased, then its
/// bytes that aren't 0xFF are programmed 128 at a time; each range is read back by CRC. Refused when the backup is
/// another radio's by its ID, or Console doesn't know its ID and the owner hasn't typed this radio's (decision 263),
/// or its calibration differs from the radio's (a damaged file), or it doesn't match the chip.
pub fn restore_plan(backup: &[u8], radio: &RestoreStart, id: &BackupId) -> RestorePlan {
    let (mut problems, confirm_uid) = check_id(radio.uid.as_deref(), id);
    problems.extend(shape_problems(backup)); // a pending update doesn't matter: the update area is never written
    if backup.len() != radio.chip as usize {
        problems.push(format!("the backup is {} KB, the radio's chip {} KB", backup.len() / 1024, radio.chip / 1024));
    }
    if cal_crc(backup) != Some(radio.cal_crc32) {
        problems.push(
            "the backup's calibration sector doesn't match this radio's: the file is damaged, or it isn't this radio's backup".into(),
        );
    }
    let mut ranges = Vec::new();
    for &(s, e) in &radio.ranges {
        for w in &WRITABLE {
            let (s, e) = (s.max(w.start), e.min(w.end));
            let s = s.div_ceil(SECTOR as u32) * SECTOR as u32;
            let e = e / SECTOR as u32 * SECTOR as u32;
            if s < e && (e as usize) <= backup.len() {
                ranges.push((s, e));
            }
        }
    }
    ranges.sort();
    ranges.dedup();
    let mut ops = Vec::new();
    let mut bytes = 0;
    for &(s, e) in &ranges {
        for sec in (s..e).step_by(SECTOR) {
            if never_written(sec, SECTOR as u32) {
                continue; // can't happen after the cut to WRITABLE; checked again regardless
            }
            ops.push(op("erase", OP_ERASE, sec, SECTOR as u32, &[], None));
            for at in (sec..sec + SECTOR as u32).step_by(CHUNK) {
                let d = &backup[at as usize..at as usize + CHUNK];
                if d.iter().any(|&b| b != 0xFF) {
                    ops.push(op("program", OP_PROGRAM, at, CHUNK as u32, d, None));
                }
            }
            bytes += SECTOR as u32;
        }
        ops.push(op("crc", OP_CRC, s, e - s, &[], Some(firmware::crc32(&backup[s as usize..e as usize]))));
    }
    if ranges.is_empty() {
        problems.push("the radio named nothing Console may restore".into());
    }
    RestorePlan { ops, ranges, bytes, problems, confirm_uid }
}

pub fn restore_payload(code: u8) -> Vec<u8> {
    vec![code]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmware::{MODEL_OFF, MODEL_OFF_BOOT, MODEL_TAG};

    fn rng(seed: &mut u64) -> u8 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed as u8
    }

    /// A 4 MB backup of a working radio: noise, calibration not blank, no pending update.
    fn backup() -> Vec<u8> {
        let mut s = 0x1234_5678_9ABC_DEF1u64;
        let mut b: Vec<u8> = (0..4 << 20).map(|_| rng(&mut s)).collect();
        b[UPDATE..UPDATE + 2].copy_from_slice(&[0xFF, 0xFF]);
        b[0x2D000..0x2D400].fill(0xFF); // some erased chunks the plan skips
        b
    }

    fn image(len: usize, mark: &[u8]) -> Vec<u8> {
        let mut img: Vec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
        img[0..4].copy_from_slice(&0x2001_8000u32.to_le_bytes());
        img[4..8].copy_from_slice(&(APP_BASE + 0x201).to_le_bytes());
        img[MODEL_OFF..MODEL_OFF + 12].copy_from_slice(MODEL_TAG);
        img[MODEL_OFF_BOOT..MODEL_OFF_BOOT + 12].copy_from_slice(MODEL_TAG);
        img[0x900..0x900 + mark.len()].copy_from_slice(mark);
        img
    }

    /// BACKUP-1, BACKUP-1.3, INST-5: flash.py's backup checks, and a CRC per region.
    #[test]
    fn backup_checks() {
        let b = backup();
        let c = check_backup(&b);
        assert!(c.problems.is_empty(), "{:?}", c.problems);
        assert_eq!(c.regions.len(), 5);
        assert_eq!(c.regions[1].start, 0xF000);
        assert_eq!(c.cal_crc32, format!("{:08X}", firmware::crc32(&b[0xF000..0x10000])));
        let mut p = b.clone();
        p[UPDATE..UPDATE + 2].copy_from_slice(&[0x5A, 0xA5]);
        let c = check_backup(&p);
        assert!(c.pending_update && c.problems.len() == 1, "{:?}", c.problems);
        let mut blank = b.clone();
        blank[CAL..CAL + SECTOR].fill(0xFF);
        assert!(check_backup(&blank).problems[0].contains("calibration"));
        assert!(check_backup(&b[..3 << 20]).problems[0].contains("2, 4 or 8 MB"));
    }

    #[test]
    fn console_lines() {
        assert_eq!(
            parse_flash("flash id 5E4016 (Zbit, 4096 KB) status 00 uid 0011223344556677  cal sector sum 00012345"),
            Some(("5E4016".into(), "Zbit".into(), 4 << 20))
        );
        assert_eq!(parse_flash("flash id 5E4016 (Zbit, 0 KB)"), None);
        let sys = "v0.9  FreeRTOS 11  clock HEXT 8 MHz  reset cause 00  flash 1024 KB  uid 3F2A91C07D44012389ABCDEF";
        assert_eq!(parse_uid(sys), Some([0x3F2A_91C0, 0x7D44_0123, 0x89AB_CDEF]));
        assert_eq!(uid_text([0x3F2A_91C0, 0x7D44_0123, 0x89AB_CDEF]).len(), 23);
        assert_eq!(parse_flashcrc("flash crc32 1A2B3C4D over 4096 KB, 52 s"), Some((0x1A2B_3C4D, 4 << 20)));
        assert_eq!(parse_flashcrc("flash crc32 nope"), None);
    }

    /// fdump_proto.py's vectors: the header and a block's CRC (tests/host/test_fdump.c checks the same on the C side).
    fn fd_frame(kind: u8, addr: u32, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![b'F', b'D', kind, 0];
        f.extend_from_slice(&addr.to_le_bytes());
        f.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        f.extend_from_slice(payload);
        let c = firmware::crc32(&f);
        f.extend_from_slice(&c.to_le_bytes());
        f
    }

    #[test]
    fn fdump_vectors() {
        let f = fd_frame(b'B', 0xF000, &(0..4096).map(|i| i as u8).collect::<Vec<_>>());
        assert_eq!(&f[..10], &[0x46, 0x44, 0x42, 0, 0, 0xF0, 0, 0, 0, 0x10]);
        assert_eq!(le32(&f[f.len() - 4..]), 0xCA90_4D9B);
    }

    /// The radio's side for the tests: frames in order, each (re)sent until ACKed, with faults.
    fn run_fdump(
        flash: &[u8],
        addr: u32,
        len: u32,
        fault: impl Fn(usize, &mut Vec<u8>),
    ) -> (Result<Vec<u8>, String>, Fdump) {
        let mut fd = Fdump::new(addr, len);
        let mut s = fd.feed(b"fdump ready\r\nFD");
        assert!(!fd.synced() && s.send.is_empty());
        s = fd.feed(b"OK");
        assert!(fd.synced(), "{s:?}");
        let mut frames: Vec<Vec<u8>> = (0..len as usize)
            .step_by(4096)
            .map(|o| {
                let n = 4096.min(len as usize - o);
                fd_frame(b'B', addr + o as u32, &flash[addr as usize + o..addr as usize + o + n])
            })
            .collect();
        let mut end = vec![];
        for x in [addr, len, firmware::crc32(&flash[addr as usize..(addr + len) as usize]), 0] {
            end.extend_from_slice(&x.to_le_bytes());
        }
        frames.push(fd_frame(b'E', addr, &end));
        let (mut i, mut tries) = (0, 0);
        while i < frames.len() {
            tries += 1;
            assert!(tries < 10 * frames.len(), "no progress");
            let mut f = frames[i].clone();
            fault(tries, &mut f);
            let mut s = FdStep::default();
            for piece in f.chunks(700) {
                s = fd.feed(piece);
                if s.nak || s.error.is_some() || !s.send.is_empty() {
                    break;
                }
            }
            if let Some(e) = s.error {
                return (Err(e), fd);
            }
            if s.done {
                return (Ok(fd.take_data()), fd);
            }
            if s.nak || s.send.is_empty() {
                if s.send.is_empty() && !s.nak {
                    s = fd.timeout(); // nothing whole arrived
                }
                fd.resume();
                continue; // resent
            }
            if tries % 7 == 3 {
                continue; // the ACK lost on the way: the same frame again (a repeat)
            }
            i += 1;
        }
        (Err("no end".into()), fd)
    }

    /// fdump_proto.py's selftest cases: clean, corrupted, cut and repeated frames all give the exact bytes.
    #[test]
    fn fdump_recovers_from_faults() {
        let mut s = 7u64;
        let flash: Vec<u8> = (0..64 * 1024).map(|_| rng(&mut s)).collect();
        let (addr, len) = (0x2000u32, (64 * 1024 - 0x2000 - 123) as u32);
        let want = &flash[addr as usize..(addr + len) as usize];
        let (d, fd) = run_fdump(&flash, addr, len, |_, _| {});
        assert_eq!(d.unwrap(), want);
        assert!(fd.dups > 0, "repeats seen and dropped");
        let (d, fd) = run_fdump(&flash, addr, len, |t, f| {
            if t % 3 == 0 {
                let k = f.len() / 2;
                f[k] ^= 0x40;
            }
        });
        assert_eq!(d.unwrap(), want);
        assert!(fd.naks > 0);
        let (d, _) = run_fdump(&flash, addr, len, |t, f| {
            if t % 4 == 1 && f.len() > 200 {
                f.drain(50..150);
            }
        });
        assert_eq!(d.unwrap(), want);
    }

    #[test]
    fn fdump_refuses_a_wrong_whole_crc() {
        let mut fd = Fdump::new(0, 16);
        fd.feed(b"FDOK");
        assert_eq!(fd.feed(&fd_frame(b'B', 0, &[1; 16])).send, vec![FD_ACK]);
        let mut end = vec![];
        for x in [0u32, 16, 0xDEAD_BEEF, 0] {
            end.extend_from_slice(&x.to_le_bytes());
        }
        let s = fd.feed(&fd_frame(b'E', 0, &end));
        assert!(s.error.unwrap().contains("whole-range CRC"));
        let mut fd = Fdump::new(0, 8192);
        fd.feed(b"FDOK");
        assert!(fd.feed(&fd_frame(b'B', 4096, &[1; 16])).error.unwrap().contains("expected"));
    }

    /// BACKUP-9.6: fdumpz's chunks (erased, raw, DEFLATE handed out and back), a spoiled frame NAKed, a repeat
    /// ACKed and dropped, the whole-range CRC over the decoded bytes; `got` counts the chip's bytes.
    #[test]
    fn fdumpz_decodes_chunks() {
        let len = 2 * FD_ZCHUNK + 100;
        let mut flash = vec![0xFFu8; len];
        let mut s = 3u64;
        for b in &mut flash[FD_ZCHUNK..] {
            *b = rng(&mut s);
        }
        let mut fd = Fdump::new_z(0x1000, len as u32);
        assert_eq!(fd.command(FDUMPZ_BAUD), format!("fdumpz 0x1000 0x{len:X} 230400\r"));
        fd.feed(b"FDOK");
        assert_eq!(fd.frame_budget_ms(230_400), 0);
        let s = fd.feed(&fd_frame(b'Z', 0x1000, &[Z_ERASED]));
        assert_eq!((s.send.clone(), s.got), (vec![FD_ACK], FD_ZCHUNK));
        // A repeat (our ACK lost): ACKed, not kept.
        assert_eq!(fd.feed(&fd_frame(b'Z', 0x1000, &[Z_ERASED])).send, vec![FD_ACK]);
        assert_eq!(fd.dups, 1);
        let mut raw = vec![Z_RAW];
        raw.extend_from_slice(&flash[FD_ZCHUNK..2 * FD_ZCHUNK]);
        let mut bad = fd_frame(b'Z', 0x1000 + FD_ZCHUNK as u32, &raw);
        // Half a frame: its budget is its bytes at the rate plus 0.6 s.
        fd.feed(&bad[..100]);
        assert_eq!(fd.frame_budget_ms(230_400), 600 + ((10 + FD_ZCHUNK as u32 + 1 + 4) * 10_000) / 230_400);
        bad[500] ^= 1;
        assert!(fd.feed(&bad[100..]).nak);
        fd.resume();
        bad[500] ^= 1;
        assert_eq!(fd.feed(&bad).got, 2 * FD_ZCHUNK);
        // The last chunk, as DEFLATE: the bytes go out to be inflated, the result comes back.
        let s = fd.feed(&fd_frame(b'Z', 0x1000 + 2 * FD_ZCHUNK as u32, &[Z_DEFLATE, 0xAA, 0xBB]));
        assert!(s.inflate && s.send.is_empty());
        assert_eq!(fd.take_inflate(), vec![0xAA, 0xBB]);
        assert!(fd.inflated(&[0; 99]).error.unwrap().contains("doesn't decode"));
        let mut end = vec![];
        for x in [0x1000u32, len as u32, firmware::crc32(&flash), 2] {
            end.extend_from_slice(&x.to_le_bytes());
        }
        let mut fd2 = Fdump::new_z(0, 100);
        fd2.feed(b"FDOK");
        assert!(fd2.feed(&fd_frame(b'Z', 0, &[Z_RAW, 1, 2])).error.unwrap().contains("doesn't decode"));
        assert!(fd2.feed(&fd_frame(b'B', 0, &[1; 100])).nak, "fdump's frames aren't fdumpz's");
        // The run again to the end: the inflated chunk ACKed, then the end frame's CRC over the decoded data.
        let mut fd = Fdump::new_z(0x1000, len as u32);
        fd.feed(b"FDOK");
        fd.feed(&fd_frame(b'Z', 0x1000, &[Z_ERASED]));
        fd.feed(&fd_frame(b'Z', 0x1000 + FD_ZCHUNK as u32, &raw));
        assert!(fd.feed(&fd_frame(b'Z', 0x1000 + 2 * FD_ZCHUNK as u32, &[Z_DEFLATE, 9])).inflate);
        assert_eq!(fd.inflated(&flash[2 * FD_ZCHUNK..]).send, vec![FD_ACK]);
        let s = fd.feed(&fd_frame(b'E', 0x1000, &end));
        assert!(s.done, "{s:?}");
        assert_eq!(fd.radio_resends, 2);
        assert_eq!(fd.take_data(), flash);
    }

    /// The images the page flashes: the reader, a stock file, Ferrite; each refused as the others.
    #[test]
    fn image_kinds() {
        let reader = pack(&image(20_000, READER_MARK));
        let stock = pack(&image(40_000, b"V0.29"));
        let fer = pack(&image(30_000, FERRITE_MARK));
        assert!(check_reader(&reader).problems.is_empty());
        assert!(!reader_has_fdumpz(&reader));
        assert!(reader_has_fdumpz(&pack(&image(20_000, b"fdump <addr> <len> [baud]\r\nfdumpz <addr> <len> [baud]"))));
        assert!(!check_reader(&stock).problems.is_empty());
        assert!(!check_reader(&fer).problems.is_empty());
        assert!(check_stock(&stock).problems.is_empty());
        assert!(!check_stock(&fer).problems.is_empty());
        assert!(!check_stock(&reader).problems.is_empty());
        assert_eq!(stock_update(&stock).unwrap().data(), &stock[..], "stock goes as it is");
        assert!(ferrite_update(&stock, None).is_err());
        assert_eq!(ferrite_update(&fer, None).unwrap().0.data(), &fer[..]);
    }

    /// A stock-like image with a patch run in it (synthetic: no Radtel bytes), as the fixture made with ssbpatch.py.
    fn synthetic_stock() -> (Vec<u8>, Vec<u8>) {
        let mut img = image(120_000, b"V0.29");
        let mut s = 99u64;
        let mut patch = Vec::new();
        for r in 0..1200 {
            patch.push(if r % 100 == 0 { 0x15 } else { 0x16 });
            for _ in 0..7 {
                patch.push(rng(&mut s));
            }
        }
        img[0x5003..0x5003 + patch.len()].copy_from_slice(&patch);
        img[0x2000..0x2000 + 80].copy_from_slice(&[0x15; 80]); // a short run: not it
        (img, patch)
    }

    /// INST-10, INST-11: the patch found as ssbpatch.py finds it (the fixture's hashes are ssbpatch.py's own output
    /// for tests/fixtures/ssb-synthetic.bin), and bundled at the next 1 KB boundary with its header.
    #[test]
    fn ssb_matches_ssbpatch_py() {
        let (img, patch) = synthetic_stock();
        let fixture = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ssb-synthetic.bin")).unwrap();
        assert_eq!(fixture, img, "the fixture is this synthetic image");
        let got = ssb_extract(&pack(&img), true).unwrap();
        assert_eq!(got, patch);
        assert_eq!(ssb_extract(&img, false).unwrap(), patch);
        let exp: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ssb-synthetic.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(ssb_describe(&got).sha256, exp["patch_sha256"]);
        assert!(!ssb_describe(&got).known);
        let fer = image(30_000, FERRITE_MARK);
        let (bundled, at) = ssb_bundle(&fer, &got);
        assert_eq!(at, exp["bundle_at"].as_u64().unwrap() as usize);
        assert_eq!(hex(&sha256(&bundled)), exp["bundle_sha256"]);
        let h: [u8; 64] = bundled[at..at + 64].try_into().unwrap();
        assert!(ferrite_core::ssb::bundle(&h).is_some(), "ferrite's own header check takes it");
        let (u, addr) = ferrite_update(&pack(&fer), Some(&got)).unwrap();
        assert_eq!(addr, Some(APP_BASE + at as u32));
        assert_eq!(unpack(u.data()).unwrap().0[..bundled.len()], bundled[..]);
        assert!(ssb_extract(&pack(&image(50_000, b"x")), true).is_none(), "no patch in it");
    }

    /// Writes tests/fixtures/ssb-synthetic.bin (`cargo test -- --ignored write_ssb_fixture`); ssbpatch.py then gives
    /// the .json beside it (core/tests/fixtures/README.md).
    #[test]
    #[ignore]
    fn write_ssb_fixture() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(format!("{dir}/ssb-synthetic.bin"), synthetic_stock().0).unwrap();
    }

    /// The owner's real stock file, when this machine has one (never in the repo): the known patch.
    #[test]
    fn a_real_stock_file_gives_the_known_patch_when_present() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../firmware/stock/RT_950Pro_V0.29_OEM.BTF");
        let Ok(btf) = std::fs::read(path) else { return };
        let p = ssb_extract(&btf, true).expect("a patch");
        assert!(ssb_describe(&p).known);
        assert!(check_stock(&btf).problems.is_empty(), "{:?}", check_stock(&btf).problems);
    }

    /// The readers (ferrite's `tools/mkbtf.sh reader`, or another build of it named by FERRITE_READER_BTF, and the
    /// hwtest one in ../fw) and a Ferrite build, when this machine has them: each passes as what it is.
    #[test]
    fn real_reader_and_ferrite_builds_pass_when_present() {
        let ferrite_reader = std::env::var("FERRITE_READER_BTF")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../ferrite/target/ferrite-reader.btf").into());
        for path in [ferrite_reader.as_str(), concat!(env!("CARGO_MANIFEST_DIR"), "/../../fw/build/target/hwtest.btf")] {
            if let Ok(b) = std::fs::read(path) {
                assert!(check_reader(&b).problems.is_empty(), "{path}: {:?}", check_reader(&b).problems);
                assert!(!check_stock(&b).problems.is_empty());
                assert!(reader_update(&b).is_ok());
            }
        }
        if let Ok(b) = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../ferrite/target/ferrite-tx.btf")) {
            assert!(!check_reader(&b).problems.is_empty());
            let (u, at) = ferrite_update(&b, Some(&[0x15; 8 * 600])).unwrap();
            assert!(at.is_some() && unpack(u.data()).unwrap().0.len() <= APP_MAX);
        }
    }

    fn writable_start() -> RestoreStart {
        RestoreStart {
            chip: 4 << 20,
            cal_crc32: cal_crc(&backup()).unwrap(),
            ranges: WRITABLE.iter().map(|r| (r.start, r.end)).collect(),
            uid: Some(HERE.into()),
        }
    }

    const HERE: &str = "N0EQ8 0R081 H4T84 MXM3G";
    const OTHER: &str = "7K2PD 9X0AA H4T84 QW3ZB";

    fn mine() -> BackupId {
        BackupId { uid: Some(HERE.into()), confirmed: None }
    }

    fn touched(p: &RestorePlan) -> Vec<(u32, u32)> {
        p.ops.iter().filter(|o| o.kind != "crc").map(|o| (o.addr, o.addr + o.len)).collect()
    }

    /// BACKUP-7, SAFE-1, SAFE-2: no request of the plan ever erases or programs calibration (0x00F000-0x00FFFF) or
    /// the update area (0x300000 up), even when the radio's answer names the whole chip; everything written is inside
    /// ferrite's own writable ranges, and the payloads say exactly what the ops say.
    #[test]
    fn restore_never_writes_calibration_or_the_update_area() {
        let b = backup();
        let mut hostile = writable_start();
        hostile.ranges = vec![(0, 4 << 20), (0xF000, 0x10000), (0x300000, 0x400000), (0x0, 0xFFFF_FFFF)];
        for start in [writable_start(), hostile] {
            let p = restore_plan(&b, &start, &mine());
            assert!(p.problems.is_empty(), "{:?}", p.problems);
            assert!(!p.ops.is_empty());
            for (s, e) in touched(&p) {
                assert!(!never_written(s, e - s), "{s:#x}..{e:#x}");
                assert!(e <= CALIBRATION.start || s >= CALIBRATION.end);
                assert!(e <= UPDATE_AREA.start);
                assert!(WRITABLE.iter().any(|w| s >= w.start && e <= w.end), "{s:#x} outside WRITABLE");
            }
            for o in &p.ops {
                assert_eq!(
                    o.payload[0],
                    match o.kind {
                        "erase" => OP_ERASE,
                        "program" => OP_PROGRAM,
                        _ => OP_CRC,
                    }
                );
                assert_eq!(le32(&o.payload[1..]), o.addr, "the payload's address is the op's");
                if o.kind == "program" {
                    assert_eq!(o.payload.len(), 5 + CHUNK);
                    assert_eq!(&o.payload[5..], &b[o.addr as usize..o.addr as usize + CHUNK]);
                    assert!(o.addr % 256 + CHUNK as u32 <= 256, "within one page");
                }
            }
            let bytes: u32 = WRITABLE.iter().map(|r| r.end - r.start).sum();
            assert_eq!(p.bytes, bytes, "the writable ranges, whole");
            assert!(p.ops.iter().any(|o| o.kind == "program" && o.addr == 0x2D400), "after the erased chunks");
            assert!(
                !p.ops.iter().any(|o| o.kind == "program" && o.addr == 0x2D000),
                "an erased chunk isn't programmed"
            );
        }
        // A sweep over every sector-sized range the radio could name: the same.
        let base = writable_start();
        for a in (0..0x40_0000u32).step_by(0x1000) {
            let mut s = base.clone();
            s.ranges = vec![(a, a + 0x1000)];
            for (x, y) in touched(&restore_plan(&b, &s, &mine())) {
                assert!(!never_written(x, y - x), "{x:#x}");
            }
        }
    }

    /// BACKUP-7: a damaged backup (its calibration differs from the radio's) or the wrong size is refused; the
    /// START answer parses with and without the ID (decision 263).
    #[test]
    fn restore_needs_this_radios_backup() {
        let b = backup();
        let mut s = writable_start();
        s.cal_crc32 ^= 1;
        assert!(restore_plan(&b, &s, &mine()).problems.iter().any(|p| p.contains("calibration sector doesn't match")));
        let mut s = writable_start();
        s.chip = 8 << 20;
        assert!(restore_plan(&b, &s, &mine()).problems.iter().any(|p| p.contains("chip")));
        let mut answer = vec![0, 0, 0x40, 0, 1, 2, 3, 4, 1];
        answer.extend_from_slice(&0x2C000u32.to_le_bytes());
        answer.extend_from_slice(&0x76000u32.to_le_bytes());
        let old = RestoreStart { chip: 4 << 20, cal_crc32: 0x0403_0201, ranges: vec![(0x2C000, 0x76000)], uid: None };
        assert_eq!(parse_start(&answer), Some(old.clone()), "an older Ferrite: no ID");
        assert_eq!(parse_start(&answer[..12]), None);
        let w = [0x3F2A_91C0u32, 0x7D44_0123, 0x89AB_CDEF];
        answer.extend(w.iter().flat_map(|x| x.to_le_bytes()));
        assert_eq!(parse_start(&answer), Some(RestoreStart { uid: Some(uid_text(w)), ..old }));
    }

    /// BACKUP-7 (decision 263): two radios with byte-identical calibration are told apart by the MCU ID. Another
    /// radio's backup is refused; this radio's passes; a backup whose ID Console doesn't know needs this radio's ID
    /// typed; a Ferrite that doesn't send its ID is refused.
    #[test]
    fn restore_tells_radios_apart_by_their_id() {
        let b = backup();
        let s = writable_start(); // the same calibration as the backup's, whichever radio it is from
        let other = restore_plan(&b, &s, &BackupId { uid: Some(OTHER.into()), confirmed: Some(HERE.into()) });
        assert!(other.problems.iter().any(|p| p.contains("from another radio (ID 7K2PD")), "{:?}", other.problems);
        assert_eq!(other.confirm_uid, None, "known to be another radio's: no confirming it away");
        let p = restore_plan(&b, &s, &BackupId { uid: Some("n0eq80r081h4t84mxm3g".into()), confirmed: None });
        assert!(p.problems.is_empty() && !p.ops.is_empty(), "{:?}", p.problems);

        let unknown = restore_plan(&b, &s, &BackupId::default());
        assert!(unknown.problems.iter().any(|p| p.contains("can't tell which radio")), "{:?}", unknown.problems);
        assert_eq!(unknown.confirm_uid.as_deref(), Some(HERE));
        let typo = restore_plan(&b, &s, &BackupId { uid: None, confirmed: Some("N0EQ8 0R081 H4T84 MXM3H".into()) });
        assert_eq!(typo.confirm_uid.as_deref(), Some(HERE));
        let typed = restore_plan(&b, &s, &BackupId { uid: None, confirmed: Some("n0eq8-0r081-h4t84-mxm3g".into()) });
        assert!(typed.problems.is_empty(), "{:?}", typed.problems);

        let old = RestoreStart { uid: None, ..s };
        assert!(restore_plan(&b, &old, &mine()).problems.iter().any(|p| p.contains("doesn't say which radio")));
    }

    /// Decision 263: the file name carries the ID; a renamed file doesn't.
    #[test]
    fn backup_names_carry_the_id() {
        let n = backup_name(HERE, "20261022");
        assert_eq!(n, "rt950pro-backup-N0EQ80R081H4T84MXM3G-20261022.bin");
        assert_eq!(name_uid(&n).as_deref(), Some(HERE));
        assert_eq!(name_uid("rt950pro-backup-N0EQ80R081H4T84MXM3G-20261022 (1).bin").as_deref(), Some(HERE));
        assert_eq!(backup_name("", "20261022"), "rt950pro-backup-unknown-id-20261022.bin");
        assert_eq!(name_uid("rt950pro-backup-unknown-id-20261022.bin"), None);
        assert_eq!(name_uid("flash.bin"), None);
        assert_eq!(name_uid("rt950pro-backup-N0EQ80R081H4T84MXM3U-1.bin"), None, "U isn't a digit");
        assert_eq!(uid_key(&uid_text([0x3F2A_91C0, 0x7D44_0123, 0x89AB_CDEF])).map(|k| k.len()), Some(20));
    }
}
