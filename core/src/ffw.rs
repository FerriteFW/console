//! The update file, `.ffw` (ferrite decision 335; manual UPD-20 – UPD-24): one file per update, as ferrite's
//! `tools/ffw.py` packs it and `tools/flash.py` installs it.
//!
//! A zip, every entry stored: `manifest.json` first (format `ferrite-update-1`: the build ID, version, model, kind,
//! the SPI layout it needs, and every file with its size, SHA-256 and target), then `manifest.minisig` when signed
//! (the release key's minisign signature over the manifest's bytes), `firmware.btf` and the `spi/` parts.
//!
//! [`read`] checks it whole before anything is written: the signature against Ferrite's key (an unsigned file only
//! with the developer option), every file's size and SHA-256, each part's header (its format and this build's ID,
//! its CRC) and its target. A part aimed at calibration, the update area, the layout header or the migration mark,
//! or outside the layout 3 regions parts may use, is refused whatever the manifest says ([`target_problem`]).
//! [`write_plan`] gives the raw writes (LINK-59 – LINK-62) that put the parts on the radio once the MCU is flashed.

use crate::firmware::crc32;
use crate::migrate::Step;
use ferrite_core::layout::{CALIBRATION, DICTIONARY, FONTS, LANGUAGES, LAYOUT_HEADER, LAYOUT_VERSION, MIGRATE_MARK, SCREENS, TEXT_PACK, UPDATE_AREA};
use ferrite_core::link::{data, msg};
use ferrite_core::sha256::sha256;
use serde::{Deserialize, Serialize};
use std::ops::Range;

pub const FORMAT: &str = "ferrite-update-1";
/// The model tag the bootloader checks.
pub const MODEL: &str = "RT-950";
/// The most a `.btf` may be: the bootloader's image limit and the file's own key block.
pub const BTF_MAX: u64 = 0xFD000 + 0x400;
const PART_HEADER: usize = ferrite_core::part::HEADER;

/// Never written by a part, whatever a manifest says (UPD-24).
const FORBIDDEN: [(&str, Range<u32>); 4] =
    [("calibration", CALIBRATION), ("the update area", UPDATE_AREA), ("the layout header", LAYOUT_HEADER), ("the migration mark", MIGRATE_MARK)];
/// The layout 3 regions parts may go in.
const PART_REGIONS: [Range<u32>; 5] = [TEXT_PACK, DICTIONARY, LANGUAGES, SCREENS, FONTS];

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FileEntry {
    pub file: String,
    pub target: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub addr: Option<u32>,
    #[serde(default)]
    pub max: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub format: String,
    pub build: String,
    pub version: String,
    pub model: String,
    pub kind: String,
    pub layout: u16,
    pub files: Vec<FileEntry>,
}

/// An SPI part, checked: where it goes and its bytes (its header first).
#[derive(Debug, Clone)]
pub struct Part {
    pub file: String,
    pub addr: u32,
    pub data: Vec<u8>,
}

/// A checked update file.
#[derive(Debug)]
pub struct Ffw {
    pub manifest: Manifest,
    /// The release's trusted comment when signed with Ferrite's key; None for an unsigned file (the developer
    /// option).
    pub signed: Option<String>,
    pub btf: Vec<u8>,
    pub parts: Vec<Part>,
}

/// Why a part may not be written there (None: it may). Checked against fixed ranges, never the manifest's.
pub fn target_problem(name: &str, addr: u32, size: u64, max: u64) -> Option<String> {
    if size == 0 {
        return Some(format!("{name}: empty"));
    }
    if size > max {
        return Some(format!("{name}: {size} bytes, more than its {max}"));
    }
    let end = (addr as u64).saturating_add(size.max(max));
    for (what, r) in &FORBIDDEN {
        if (addr as u64) < r.end as u64 && end > r.start as u64 {
            return Some(format!("{name}: aimed at {what} (0x{addr:06X}-0x{:06X}): refused whatever the manifest says", end - 1));
        }
    }
    if !addr.is_multiple_of(data::SECTOR) {
        return Some(format!("{name}: 0x{addr:06X} is not on a 4 KB sector"));
    }
    if PART_REGIONS.iter().any(|r| addr >= r.start && end <= r.end as u64) {
        return None;
    }
    Some(format!("{name}: 0x{addr:06X}-0x{:06X} is outside the layout 3 regions parts may use", end - 1))
}

/// The zip's entries, in order: name and bytes. Only stored entries (the format's), each checked by its CRC.
pub fn unzip(b: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let u16_at = |i: usize| b.get(i..i + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize);
    let u32_at = |i: usize| b.get(i..i + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize);
    let bad = || "not a .ffw file (not a zip, or a damaged one)".to_string();
    // The end of the central directory: its signature within the last 64 KB + 22 bytes.
    let eocd = (0..b.len().saturating_sub(21)).rev().take(65_557).find(|&i| u32_at(i) == Some(0x0605_4b50)).ok_or_else(bad)?;
    let (n, mut at) = (u16_at(eocd + 10).ok_or_else(bad)?, u32_at(eocd + 16).ok_or_else(bad)?);
    let mut out = Vec::new();
    for _ in 0..n {
        if u32_at(at) != Some(0x0201_4b50) {
            return Err(bad());
        }
        let method = u16_at(at + 10).ok_or_else(bad)?;
        let crc = u32_at(at + 16).ok_or_else(bad)? as u32;
        let (csize, usize_) = (u32_at(at + 20).ok_or_else(bad)?, u32_at(at + 24).ok_or_else(bad)?);
        let (nl, xl, cl) = (u16_at(at + 28).ok_or_else(bad)?, u16_at(at + 30).ok_or_else(bad)?, u16_at(at + 32).ok_or_else(bad)?);
        let local = u32_at(at + 42).ok_or_else(bad)?;
        let name = String::from_utf8(b.get(at + 46..at + 46 + nl).ok_or_else(bad)?.to_vec()).map_err(|_| bad())?;
        at += 46 + nl + xl + cl;
        if method != 0 || csize != usize_ {
            return Err(format!("{name}: compressed: a .ffw's entries are stored"));
        }
        if u32_at(local) != Some(0x0403_4b50) {
            return Err(bad());
        }
        let start = local + 30 + u16_at(local + 26).ok_or_else(bad)? + u16_at(local + 28).ok_or_else(bad)?;
        let d = b.get(start..start + csize).ok_or_else(bad)?;
        if crc32(d) != crc {
            return Err(format!("{name}: damaged (its zip CRC)"));
        }
        out.push((name, d.to_vec()));
    }
    Ok(out)
}

/// A stored zip of `entries` (the tests', and `tools`): what `tools/ffw.py` writes.
pub fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let (mut out, mut cd) = (Vec::new(), Vec::new());
    for (name, d) in entries {
        let (crc, n, off) = (crc32(d), d.len() as u32, out.len() as u32);
        let common = |v: &mut Vec<u8>| {
            v.extend(20u16.to_le_bytes()); // version needed
            v.extend([0, 0, 0, 0]); // flags, method (stored)
            v.extend([0, 0, 0x21, 0x5C]); // time, date (2026-01-01)
            v.extend(crc.to_le_bytes());
            v.extend(n.to_le_bytes());
            v.extend(n.to_le_bytes());
            v.extend((name.len() as u16).to_le_bytes());
            v.extend(0u16.to_le_bytes());
        };
        out.extend(0x0403_4b50u32.to_le_bytes());
        common(&mut out);
        out.extend(name.as_bytes());
        out.extend_from_slice(d);
        cd.extend(0x0201_4b50u32.to_le_bytes());
        cd.extend(20u16.to_le_bytes());
        common(&mut cd);
        cd.extend([0u8; 10]); // comment length, disk, internal and external attributes
        cd.extend(off.to_le_bytes());
        cd.extend(name.as_bytes());
    }
    let (at, len) = (out.len() as u32, cd.len() as u32);
    out.extend(cd);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0u8; 4]);
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend(len.to_le_bytes());
    out.extend(at.to_le_bytes());
    out.extend([0u8; 2]);
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Checks a `.ffw` with Ferrite's release key ([`read_with`]).
pub fn read(b: &[u8], dev_unsigned: bool) -> Result<Ffw, Vec<String>> {
    read_with(crate::signature::FERRITE_PUBLIC_KEY, b, dev_unsigned)
}

/// Everything an installer checks before writing anything (UPD-21, UPD-24); the problems, one each, if any.
pub fn read_with(key: &str, b: &[u8], dev_unsigned: bool) -> Result<Ffw, Vec<String>> {
    let entries = unzip(b).map_err(|e| vec![e])?;
    if entries.first().map(|e| e.0.as_str()) != Some("manifest.json") {
        return Err(vec!["not a .ffw file: its first entry must be manifest.json".into()]);
    }
    let get = |n: &str| entries.iter().find(|e| e.0 == n).map(|e| &e.1);
    let mbytes = &entries[0].1;
    let m: Manifest = serde_json::from_slice(mbytes).map_err(|e| vec![format!("manifest.json doesn't read ({e})")])?;
    if m.format != FORMAT {
        return Err(vec![format!("format {:?}: this Console reads {FORMAT}", m.format)]);
    }
    let mut problems = Vec::new();
    let mut signed = None;
    match get("manifest.minisig") {
        None if !dev_unsigned => problems.push(
            "unsigned: only a release signed with Ferrite's key installs; a local build needs the developer option (Allow unsigned files)".into(),
        ),
        None => {}
        Some(sig) => match std::str::from_utf8(sig).map_err(|_| "manifest.minisig isn't text".to_string()).and_then(|s| crate::signature::verify_with(key, mbytes, s)) {
            Ok(c) => signed = Some(c),
            Err(e) => problems.push(format!("signature: {e}")),
        },
    }
    if m.model != MODEL {
        problems.push(format!("for model {:?}, not this radio ({MODEL})", m.model));
    }
    if m.layout != LAYOUT_VERSION {
        problems.push(format!("needs SPI layout {}, this Console moves data to layout {LAYOUT_VERSION}", m.layout));
    }
    let (mut btf, mut parts) = (None, Vec::new());
    let mut listed = vec!["manifest.json", "manifest.minisig"];
    for f in &m.files {
        listed.push(&f.file);
        let Some(d) = get(&f.file) else {
            problems.push(format!("{}: in the manifest, not in the file", f.file));
            continue;
        };
        if d.len() as u64 != f.size || hex(&sha256(d)) != f.sha256.to_ascii_lowercase() {
            problems.push(format!("{}: its size or SHA-256 doesn't match the manifest: a changed or damaged file", f.file));
            continue;
        }
        match f.target.as_str() {
            "mcu" if f.file == "firmware.btf" && f.size <= BTF_MAX && f.size <= f.max => btf = Some(d.clone()),
            "mcu" => problems.push(format!("{}: not an MCU image the bootloader takes", f.file)),
            "spi" => {
                let Some(addr) = f.addr else {
                    problems.push(format!("{}: no address", f.file));
                    continue;
                };
                if let Some(p) = target_problem(&f.file, addr, f.size, f.max) {
                    problems.push(p);
                    continue;
                }
                match header_problem(d, &m.build) {
                    Some(p) => problems.push(format!("{}: {p}", f.file)),
                    None => parts.push(Part { file: f.file.clone(), addr, data: d.clone() }),
                }
            }
            t => problems.push(format!("{}: unknown target {t:?}", f.file)),
        }
    }
    if btf.is_none() && !problems.iter().any(|p| p.starts_with("firmware.btf")) {
        problems.push("no firmware.btf in the manifest".into());
    }
    let extra: Vec<_> = entries.iter().map(|e| e.0.as_str()).filter(|n| !listed.contains(n)).collect();
    if !extra.is_empty() {
        problems.push(format!("files the manifest doesn't list: {}", extra.join(", ")));
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(Ffw { manifest: m, signed, btf: btf.unwrap_or_default(), parts })
}

/// A part's header against its build (ferrite-core `part`): format, the build ID, the length and the body's CRC.
fn header_problem(d: &[u8], build: &str) -> Option<String> {
    if d.len() <= PART_HEADER {
        return Some("too short for a part".into());
    }
    let le32 = |i: usize| u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
    let id = &d[8..24];
    let n = id.iter().position(|&c| c == 0).unwrap_or(16);
    if u16::from_le_bytes([d[4], d[5]]) != ferrite_core::part::FORMAT || &id[..n] != build.as_bytes() || id[n..].iter().any(|&c| c != 0) {
        return Some(format!("its header doesn't name this build ({build})"));
    }
    if le32(24) as usize != d.len() - PART_HEADER || le32(28) != crc32(&d[PART_HEADER..]) {
        return Some("its header's length or CRC doesn't match".into());
    }
    None
}

/// The raw writes that put the parts on the radio (UPD-21; LINK-60 – LINK-62): each part's sectors erased, its
/// bytes that aren't erased programmed 64 at a time, the part read back by CRC; the layout stamped last, on which the
/// radio restarts. Every target is checked again here.
pub fn write_plan(parts: &[Part]) -> Result<Vec<Step>, String> {
    let mut out = Vec::new();
    for (k, p) in parts.iter().enumerate() {
        if let Some(e) = target_problem(&p.file, p.addr, p.data.len() as u64, p.data.len() as u64) {
            return Err(e);
        }
        // UPD-16.2: the radio's Updating page shows "Part 2 of 4" (firmware before it answers `bad argument`)
        let pl = vec![data::PART, k as u8 + 1, parts.len() as u8];
        out.push(Step { kind: "part", msg: msg::DATA_WRITE, addr: p.addr, len: 0, payload: pl, expect: None, region: p.file.clone() });
        let end = p.addr + p.data.len() as u32;
        for s in (p.addr..end).step_by(data::SECTOR as usize) {
            let mut pl = vec![data::ERASE];
            pl.extend(s.to_le_bytes());
            out.push(Step { kind: "erase", msg: msg::DATA_WRITE, addr: s, len: data::SECTOR, payload: pl, expect: None, region: p.file.clone() });
        }
        for (i, piece) in p.data.chunks(data::PROGRAM_MAX).enumerate() {
            if piece.iter().all(|&b| b == 0xFF) {
                continue;
            }
            let a = p.addr + (i * data::PROGRAM_MAX) as u32;
            let mut pl = vec![data::PROGRAM];
            pl.extend(a.to_le_bytes());
            pl.extend_from_slice(piece);
            out.push(Step { kind: "program", msg: msg::DATA_WRITE, addr: a, len: piece.len() as u32, payload: pl, expect: None, region: p.file.clone() });
        }
        let mut pl = vec![data::CRC];
        pl.extend(p.addr.to_le_bytes());
        pl.extend((p.data.len() as u32).to_le_bytes());
        out.push(Step { kind: "crc", msg: msg::DATA_READ, addr: p.addr, len: p.data.len() as u32, payload: pl, expect: Some(crc32(&p.data)), region: p.file.clone() });
    }
    let mut pl = vec![data::STAMP];
    pl.extend(LAYOUT_VERSION.to_le_bytes());
    out.push(Step { kind: "stamp", msg: msg::DATA_WRITE, addr: 0, len: 0, payload: pl, expect: None, region: "Layout header".into() });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // tests/fixtures/ffw/: a throwaway key's public key and three files it signed (tools/ffw.py pack, minisign -S
    // over the manifest, ffw.py add-sig): a good one, one with a part aimed at calibration, one at the update area.
    const GOOD: &[u8] = include_bytes!("../tests/fixtures/ffw/good.ffw");
    const CAL: &[u8] = include_bytes!("../tests/fixtures/ffw/calibration.ffw");
    const UPD: &[u8] = include_bytes!("../tests/fixtures/ffw/update-area.ffw");
    const PUB: &str = include_str!("../tests/fixtures/ffw/test.pub");

    fn key() -> &'static str {
        PUB.lines().nth(1).unwrap()
    }

    fn entries(b: &[u8]) -> Vec<(String, Vec<u8>)> {
        unzip(b).unwrap()
    }

    fn rezip(e: &[(String, Vec<u8>)]) -> Vec<u8> {
        let v: Vec<(&str, &[u8])> = e.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
        zip(&v)
    }

    /// UPD-21: a file signed with the key installs: its image and its parts, in the manifest's order.
    #[test]
    fn a_signed_file_reads() {
        let f = read_with(key(), GOOD, false).unwrap();
        assert!(f.signed.is_some());
        assert_eq!(f.btf.len(), f.manifest.files[0].size as usize);
        assert_eq!(f.parts.iter().map(|p| (p.file.as_str(), p.addr)).collect::<Vec<_>>(), [("spi/text-en.bin", 0x09_0000), ("spi/logo.bin", 0x24_0000)]);
        let plan = write_plan(&f.parts).unwrap();
        assert_eq!(plan.last().unwrap().kind, "stamp");
        let marks: Vec<_> = plan.iter().filter(|s| s.kind == "part").map(|s| s.payload.clone()).collect();
        let n = f.parts.len() as u8;
        assert_eq!(marks, (1..=n).map(|i| vec![data::PART, i, n]).collect::<Vec<_>>(), "UPD-16.2: one mark before each part");
        assert!(plan.iter().all(|s| s.kind != "program" || s.addr / 256 == (s.addr + s.len - 1) / 256), "never across a page");
        // Our zip writer and ffw.py's agree: the same entries, read back the same.
        assert!(read_with(key(), &rezip(&entries(GOOD)), false).is_ok());
    }

    /// UPD-21: unsigned, only with the developer option; another key's signature never.
    #[test]
    fn unsigned_needs_the_developer_option() {
        let e: Vec<_> = entries(GOOD).into_iter().filter(|e| e.0 != "manifest.minisig").collect();
        let b = rezip(&e);
        let p = read_with(key(), &b, false).unwrap_err();
        assert!(p[0].contains("unsigned"), "{p:?}");
        let f = read_with(key(), &b, true).unwrap();
        assert!(f.signed.is_none());
        let p = read(GOOD, true).unwrap_err();
        assert!(p.iter().any(|x| x.contains("another key")), "Ferrite's key refuses a test key's signature: {p:?}");
    }

    /// UPD-21: a changed byte anywhere: the hash (or the signature over the manifest) refuses it.
    #[test]
    fn a_changed_byte_is_refused() {
        let mut e = entries(GOOD);
        let i = e.iter().position(|x| x.0 == "firmware.btf").unwrap();
        e[i].1[300] ^= 1;
        let p = read_with(key(), &rezip(&e), false).unwrap_err();
        assert!(p.iter().any(|x| x.contains("SHA-256")), "{p:?}");
        let mut e = entries(GOOD);
        e[0].1 = String::from_utf8(e[0].1.clone()).unwrap().replace("\"0.9.0\"", "\"0.9.1\"").into_bytes();
        let p = read_with(key(), &rezip(&e), false).unwrap_err();
        assert!(p.iter().any(|x| x.contains("signature")), "{p:?}");
        let mut z = GOOD.to_vec();
        let at = z.len() / 2;
        z[at] ^= 0x10;
        assert!(read_with(key(), &z, false).is_err(), "a damaged zip");
    }

    /// UPD-24: parts aimed at calibration or the update area are refused even when signed; the writer refuses them
    /// too whatever it is handed.
    #[test]
    fn protected_targets_are_refused_even_signed() {
        let p = read_with(key(), CAL, false).unwrap_err();
        assert!(p.iter().any(|x| x.contains("calibration")), "{p:?}");
        let p = read_with(key(), UPD, false).unwrap_err();
        assert!(p.iter().any(|x| x.contains("update area")), "{p:?}");
        for (a, max) in [(0x00_F000, 4096), (0x30_0000, 4096), (0x2F_F000, 8192), (0, 4096), (0xE000, 4096), (0x01_0000, 4096), (0x09_0800, 4096)] {
            assert!(target_problem("x", a, 100, max).is_some(), "0x{a:06X}");
            assert!(write_plan(&[Part { file: "x".into(), addr: a, data: vec![0; 100] }]).is_err(), "0x{a:06X}");
        }
        assert_eq!(target_problem("x", 0x09_0000, 100, 0x1_0000), None);
        // A manifest's max of u64::MAX (found by fuzz::backups::ffw_files): refused, never an overflow (it wrapped
        // to an end below the start in a release build, inside every region).
        assert!(target_problem("x", 0x09_0000, 100, u64::MAX).is_some());
        assert_eq!(target_problem("x", 0x24_8000, 3000, 0x8000), None);
    }
}
