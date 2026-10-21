//! Firmware Update: the `.btf` checks and the stock bootloader's protocol, ported from ferrite's `tools/btf.py` and
//! `tools/flash.py` (see `analysis/bootloader.md`).
//!
//! - [`check_file`] unpacks a `.btf`, runs `check_image` and says what the image is (`describe`), plus whether it is
//!   a Ferrite image (the "Ferrite terminal" mark). Console flashes Ferrite images only, below the stock marker
//!   sector (`APP_MAX`).
//! - [`Update`] holds a checked file and gives the frames to send, in order: hello, model, count, every 1 KB block,
//!   end. Nothing else: the bootloader only ever receives the image's own blocks, which it writes from 0x08003000
//!   up. No frame here can reach calibration, the SPI flash's update area or the option bytes.
//! - [`BootReader`] finds the bootloader's 9-byte replies in what the cable reads.

use serde::Serialize;

pub const APP_BASE: u32 = 0x0800_3000;
/// Our limit: stop below the stock marker sector at 0x080F0000.
pub const APP_MAX: usize = 948 * 1024;
/// The bootloader's own limit (for stock files; Console doesn't flash those).
pub const BOOT_MAX: usize = 0xFD000;
pub const MODEL_OFF: usize = 0x3E0;
/// 12 bytes; the bootloader compares exactly these.
pub const MODEL_TAG: &[u8; 12] = b"RT-950      ";
/// The bootloader compares the tag here too at every power-on ("Firmware Error!" when it differs).
pub const MODEL_OFF_BOOT: usize = 0x7E0;
pub const KEY_OFF: usize = 0x400;
pub const BLOCK: usize = 0x400;
pub const ENC_START: usize = 0x800;
/// Text only Ferrite images hold (its terminal's title).
pub const FERRITE_MARK: &[u8] = b"Ferrite terminal";

pub const CMD_HELLO: u8 = 0x0A;
pub const CMD_MODEL: u8 = 0x02;
pub const CMD_COUNT: u8 = 0x04;
pub const CMD_DATA: u8 = 0x03;
pub const CMD_END: u8 = 0x45;
pub const CMD_PROBE: u8 = 0x42;
pub const ACK: u8 = 0x06;
/// A garbled frame: the same frame is sent again.
pub const BAD_FRAME: u8 = 0xE1;

/// flash.py's results table.
pub fn result_text(r: u8) -> &'static str {
    match r {
        0x06 => "ok",
        0xE1 => "bad frame or length",
        0xE2 => "block out of order or too far",
        0xE3 => "flash write failed",
        0xE5 => "command not valid now",
        0xE6 => "model tag rejected",
        _ => "unknown answer",
    }
}

fn rot(v: u8, n: usize, left: bool) -> u8 {
    let n = (n % 8) as u32;
    if left {
        v.rotate_left(n)
    } else {
        v.rotate_right(n)
    }
}

/// The expanded key: 8 rows of 16; row r is the key with bytes 0-7 rotated left r bits, bytes 8-15 right r bits.
pub fn expand(key: &[u8; 16]) -> [u8; 128] {
    let mut out = [0u8; 128];
    for r in 0..8 {
        for i in 0..16 {
            out[r * 16 + i] = rot(key[i], r, i < 8);
        }
    }
    out
}

/// Encrypts or decrypts (the same operation) a whole BTF file; the last 1 KB block stays plain.
pub fn crypt(buf: &[u8], key: &[u8; 16]) -> Vec<u8> {
    let ks = expand(key);
    let mut out = buf.to_vec();
    let end = (out.len().div_ceil(BLOCK)).saturating_sub(1) * BLOCK;
    for (i, p) in out.iter_mut().enumerate().take(end).skip(ENC_START) {
        let k = ks[i % 128];
        if *p != 0x00 && *p != 0xFF && *p != k && *p != k ^ 0xFF {
            *p ^= k;
        }
    }
    out
}

/// BTF -> (image, key block). Trailing 0xFF block padding stays part of the image.
pub fn unpack(btf: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    if btf.len() < ENC_START {
        return Err(format!("the file is only {} bytes: too short to be a .btf", btf.len()));
    }
    let keyblock = btf[KEY_OFF..KEY_OFF + BLOCK].to_vec();
    let key: [u8; 16] = keyblock[..16].try_into().expect("16 bytes");
    let plain = crypt(btf, &key);
    let mut img = plain[..KEY_OFF].to_vec();
    img.extend_from_slice(&plain[ENC_START..]);
    Ok((img, keyblock))
}

/// Image -> BTF with the zero key, padded with 0xFF to whole blocks (btf.py's `pack` default; for tests).
pub fn pack(img: &[u8]) -> Vec<u8> {
    let mut raw = img[..KEY_OFF.min(img.len())].to_vec();
    raw.extend_from_slice(&[0u8; BLOCK]);
    if img.len() > KEY_OFF {
        raw.extend_from_slice(&img[KEY_OFF..]);
    }
    let pad = (BLOCK - raw.len() % BLOCK) % BLOCK;
    raw.extend(std::iter::repeat_n(0xFF, pad));
    crypt(&raw, &[0; 16])
}

fn word(img: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(img[at..at + 4].try_into().expect("4 bytes"))
}

/// Problems that would stop the bootloader starting the image, or hurt the radio. Empty: fine.
pub fn check_image(img: &[u8], limit: usize) -> Vec<String> {
    if img.len() < MODEL_OFF_BOOT + MODEL_TAG.len() {
        return vec![format!("image is only {} bytes", img.len())];
    }
    let mut errs = Vec::new();
    let (sp, reset) = (word(img, 0), word(img, 4));
    if sp & 0x2FFE_0000 != 0x2000_0000 {
        errs.push(format!("initial SP {sp:#010x} fails the bootloader's check (must be 0x2000xxxx-0x2001xxxx)"));
    }
    let r = reset & !1;
    if reset & 1 == 0 || r < APP_BASE || r as u64 >= APP_BASE as u64 + img.len() as u64 {
        errs.push(format!("reset vector {reset:#010x} is not a Thumb address inside the image"));
    }
    if &img[MODEL_OFF..MODEL_OFF + 12] != MODEL_TAG {
        errs.push(format!("no model tag \"RT-950\" at {MODEL_OFF:#x} (the updater sends it to the bootloader)"));
    }
    if &img[MODEL_OFF_BOOT..MODEL_OFF_BOOT + 12] != MODEL_TAG {
        errs.push(format!(
            "no model tag \"RT-950\" at {MODEL_OFF_BOOT:#x} (the bootloader checks it at power-on: \"Firmware Error!\")"
        ));
    }
    if img.len() > limit {
        errs.push(format!(
            "image is {} bytes; over {limit} would reach the stock marker sector at 0x080F0000",
            img.len()
        ));
    }
    errs
}

/// CRC-32 (zlib's), as btf.py's `describe` shows it.
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &x in data {
        c ^= x as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

/// btf.py's `describe`: size, SP, reset, tag, crc32.
pub fn describe(img: &[u8]) -> String {
    if img.len() < MODEL_OFF + 12 {
        return format!("{} bytes", img.len());
    }
    let tag = String::from_utf8_lossy(&img[MODEL_OFF..MODEL_OFF + 12]);
    format!(
        "{} bytes ({:.1} KB), SP {:#010x}, reset {:#010x}, tag '{}', crc32 {:08X}",
        img.len(),
        img.len() as f64 / 1024.0,
        word(img, 0),
        word(img, 4),
        tag,
        crc32(img)
    )
}

fn find(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// The version the image carries ("v0.1.0", ferrite-core's `VERSION`): the one `vN.N.N` in it. Its strings sit back
/// to back with no separator ("...Matchesv0.1.0No answer..."), so only what follows is checked. None when there is
/// none, or more than one different.
pub fn version(img: &[u8]) -> Option<String> {
    let digits = |from: usize| img[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let mut found: Option<String> = None;
    for i in 0..img.len() {
        if img[i] != b'v' {
            continue;
        }
        let mut at = i + 1;
        let mut ok = true;
        for part in 0..3 {
            let n = digits(at);
            if n == 0 || n > 3 {
                ok = false;
                break;
            }
            at += n;
            if part < 2 {
                if img.get(at) != Some(&b'.') {
                    ok = false;
                    break;
                }
                at += 1;
            }
        }
        if !ok || img.get(at).is_some_and(|b| *b == b'.' || b.is_ascii_digit()) {
            continue;
        }
        let v = String::from_utf8_lossy(&img[i..at]).into_owned();
        match &found {
            Some(f) if *f != v => return None,
            _ => found = Some(v),
        }
    }
    found
}

/// What the page shows about a picked file, and why it can't be flashed (`problems`; empty: it can).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Checked {
    pub file_len: usize,
    pub blocks: usize,
    pub image_len: usize,
    pub ferrite: bool,
    pub version: Option<String>,
    pub crc32: String,
    pub describe: String,
    pub problems: Vec<String>,
}

/// Unpacks and checks a `.btf` for Console's update: what `check_image` refuses, plus anything that is not a
/// Ferrite image (stock goes back with `flash.py`).
pub fn check_file(btf: &[u8]) -> Checked {
    let blocks = btf.len().div_ceil(BLOCK);
    let (img, mut problems) = match unpack(btf) {
        Ok((img, _)) => {
            let p = check_image(&img, APP_MAX);
            (img, p)
        }
        Err(e) => (Vec::new(), vec![e]),
    };
    let ferrite = find(&img, FERRITE_MARK);
    if !img.is_empty() && !ferrite {
        problems.push(
            "not a Ferrite image (no \"Ferrite terminal\" in it): Console only updates Ferrite; stock goes back with tools/flash.py"
                .into(),
        );
    }
    Checked {
        file_len: btf.len(),
        blocks,
        image_len: img.len(),
        ferrite,
        version: version(&img),
        crc32: format!("{:08X}", crc32(&img)),
        describe: if img.is_empty() { String::new() } else { describe(&img) },
        problems,
    }
}

/// CRC-16/XMODEM: poly 0x1021, init 0.
pub fn crc16(data: &[u8]) -> u16 {
    let mut c = 0u16;
    for &x in data {
        c ^= (x as u16) << 8;
        for _ in 0..8 {
            c = if c & 0x8000 != 0 { (c << 1) ^ 0x1021 } else { c << 1 };
        }
    }
    c
}

/// `AA cmd seq(2) len(2) data CRC16(cmd..data) 55`, big-endian.
pub fn frame(cmd: u8, seq: u16, data: &[u8]) -> Vec<u8> {
    let mut body = vec![cmd];
    body.extend_from_slice(&seq.to_be_bytes());
    body.extend_from_slice(&(data.len() as u16).to_be_bytes());
    body.extend_from_slice(data);
    let mut out = vec![0xAA];
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc16(&body).to_be_bytes());
    out.push(0x55);
    out
}

/// The probe the bootloader answers in its power-on window (06) and once inside update mode (E5).
pub fn probe() -> Vec<u8> {
    frame(CMD_PROBE, 0, &[])
}

/// One step of an update: the frame, its command, and what the page calls it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Step {
    pub cmd: u8,
    pub what: String,
    /// The image block's number (file block), for data steps.
    pub block: Option<usize>,
    /// Data steps get longer to answer (an erase may come first).
    pub timeout_ms: u32,
}

/// A checked file and the frames that flash it, as flash.py sends them.
pub struct Update {
    data: Vec<u8>,
    blocks: usize,
}

impl Update {
    /// None (with the reasons) unless `check_file` passes.
    pub fn new(btf: &[u8]) -> Result<Update, Vec<String>> {
        let c = check_file(btf);
        if !c.problems.is_empty() {
            return Err(c.problems);
        }
        Ok(Update { data: btf.to_vec(), blocks: c.blocks })
    }

    pub fn blocks(&self) -> usize {
        self.blocks
    }

    /// hello, model, count, the blocks, end.
    pub fn steps(&self) -> usize {
        self.blocks + 4
    }

    pub fn step(&self, i: usize) -> Step {
        let (cmd, what, block, timeout_ms) = match i {
            0 => (CMD_HELLO, "hello".to_string(), None, 2000),
            1 => (CMD_MODEL, "model".to_string(), None, 2000),
            2 => (CMD_COUNT, "block count".to_string(), None, 2000),
            n if n < 3 + self.blocks => (CMD_DATA, format!("block {}", n - 3), Some(n - 3), 3000),
            _ => (CMD_END, "end".to_string(), None, 2000),
        };
        Step { cmd, what, block, timeout_ms }
    }

    /// The step's frame. The model is the 32 bytes at file offset 0x3E0; the count is blocks - 1 (Radtel's rule:
    /// the bootloader then leaves the plain last block alone); a block is 1 KB, the last padded with 0x00.
    pub fn frame(&self, i: usize) -> Vec<u8> {
        let s = self.step(i);
        match s.cmd {
            CMD_MODEL => frame(CMD_MODEL, 0, &self.data[MODEL_OFF..MODEL_OFF + 32]),
            CMD_COUNT => frame(CMD_COUNT, 0, &(self.blocks.saturating_sub(1).max(1) as u16).to_be_bytes()),
            CMD_DATA => {
                let n = s.block.expect("a data step");
                let mut blk = self.data[n * BLOCK..((n + 1) * BLOCK).min(self.data.len())].to_vec();
                blk.resize(BLOCK, 0);
                frame(CMD_DATA, n as u16, &blk)
            }
            c => frame(c, 0, &[]),
        }
    }
}

/// Finds the bootloader's replies, `AA cmd 00 result 00 00 crc crc 55`, in what the cable reads.
#[derive(Default)]
pub struct BootReader {
    buf: Vec<u8>,
}

impl BootReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }

    /// Bytes read; the complete replies as (cmd, result).
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<(u8, u8)> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let Some(i) = self.buf.iter().position(|&b| b == 0xAA) else {
                self.buf.clear();
                break;
            };
            self.buf.drain(..i);
            if self.buf.len() < 9 {
                break;
            }
            let f = &self.buf[..9];
            if f[8] == 0x55 && crc16(&f[1..6]) == u16::from_be_bytes([f[6], f[7]]) {
                out.push((f[1], f[3]));
                self.buf.drain(..9);
            } else {
                self.buf.drain(..1);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small image that passes: vectors, both tags, the Ferrite mark and a version.
    fn image(len: usize) -> Vec<u8> {
        let mut img: Vec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
        img[0..4].copy_from_slice(&0x2001_8000u32.to_le_bytes());
        img[4..8].copy_from_slice(&(APP_BASE + 0x201).to_le_bytes());
        img[MODEL_OFF..MODEL_OFF + 12].copy_from_slice(MODEL_TAG);
        img[MODEL_OFF_BOOT..MODEL_OFF_BOOT + 12].copy_from_slice(MODEL_TAG);
        img[0x900..0x900 + FERRITE_MARK.len()].copy_from_slice(FERRITE_MARK);
        img[0xA00..0xA08].copy_from_slice(b"\0v1.2.3\0");
        img
    }

    /// btf.py's selftest: the V0.27 key's second expanded row.
    #[test]
    fn key_expansion_matches_btf_py() {
        let k: [u8; 16] =
            [0x7e, 0x80, 0x7b, 0x17, 0x61, 0xa4, 0xeb, 0xc6, 0xfc, 0x3a, 0x8d, 0xd3, 0x37, 0x52, 0xf3, 0x05];
        let row: [u8; 16] =
            [0xfc, 0x01, 0xf6, 0x2e, 0xc2, 0x49, 0xd7, 0x8d, 0x7e, 0x1d, 0xc6, 0xe9, 0x9b, 0x29, 0xf9, 0x82];
        assert_eq!(expand(&k)[16..32], row);
    }

    #[test]
    fn crypt_is_its_own_inverse_and_leaves_the_last_block() {
        let k = [0x5Au8; 16];
        let buf: Vec<u8> = (0..5000).map(|i| (i * 13) as u8).collect();
        let once = crypt(&buf, &k);
        assert_ne!(once, buf);
        assert_eq!(crypt(&once, &k), buf);
        let last = (5000usize.div_ceil(BLOCK) - 1) * BLOCK;
        assert_eq!(once[last..], buf[last..], "the last block stays plain");
        assert_eq!(once[..ENC_START], buf[..ENC_START], "vectors and key block plain");
    }

    #[test]
    fn round_trip_with_the_zero_key() {
        let img = image(5000);
        let btf = pack(&img);
        assert_eq!(btf.len() % BLOCK, 0);
        assert_eq!(&btf[KEY_OFF..ENC_START], &[0u8; BLOCK][..]);
        let (back, kb) = unpack(&btf).unwrap();
        assert_eq!(kb, vec![0u8; BLOCK]);
        assert_eq!(&back[..img.len()], &img[..]);
        assert!(back[img.len()..].iter().all(|&b| b == 0xFF));
        assert!(check_image(&img, APP_MAX).is_empty());
    }

    #[test]
    fn check_image_refuses_what_btf_py_refuses() {
        assert!(!check_image(&image(5000)[..0x100], APP_MAX).is_empty());
        assert!(!check_image(&[0u8; 0x400], APP_MAX).is_empty());
        let mut bad = image(5000);
        bad[0..4].copy_from_slice(&0x1000_0000u32.to_le_bytes());
        assert!(check_image(&bad, APP_MAX)[0].contains("initial SP"));
        let mut bad = image(5000);
        bad[4..8].copy_from_slice(&(APP_BASE + 0x200).to_le_bytes());
        assert!(check_image(&bad, APP_MAX)[0].contains("Thumb"));
        let mut bad = image(5000);
        bad[4..8].copy_from_slice(&(APP_BASE + 0x10_0001).to_le_bytes());
        assert!(check_image(&bad, APP_MAX)[0].contains("Thumb"));
        let mut bad = image(5000);
        bad[MODEL_OFF] = b'X';
        assert!(check_image(&bad, APP_MAX)[0].contains("0x3e0"));
        let mut bad = image(5000);
        bad[MODEL_OFF_BOOT] = b'X';
        assert!(check_image(&bad, APP_MAX)[0].contains("Firmware Error"));
        assert!(check_image(&image(APP_MAX + 1), APP_MAX)[0].contains("marker sector"));
    }

    #[test]
    fn check_file_describes_and_refuses() {
        let c = check_file(&pack(&image(5000)));
        assert!(c.problems.is_empty(), "{:?}", c.problems);
        assert!(c.ferrite);
        assert_eq!(c.version.as_deref(), Some("v1.2.3"));
        assert_eq!(c.blocks, 6);
        assert_eq!(c.image_len, 5 * BLOCK);
        assert!(c
            .describe
            .starts_with("5120 bytes (5.0 KB), SP 0x20018000, reset 0x08003201, tag 'RT-950      ', crc32 "));

        let mut stock = image(5000);
        stock[0x900] = b'X';
        let c = check_file(&pack(&stock));
        assert!(!c.ferrite);
        assert!(c.problems[0].contains("not a Ferrite image"));

        assert!(check_file(b"hello").problems[0].contains("too short"));
        assert!(!check_file(&[0xFFu8; 4096]).problems.is_empty());
        assert!(Update::new(&[0xFFu8; 4096]).is_err());
    }

    #[test]
    fn version_needs_one_clean_match() {
        assert_eq!(version(b"..v0.1.0No answer"), Some("v0.1.0".into()));
        assert_eq!(version(b"Matchesv0.1.0No"), Some("v0.1.0".into()), "strings back to back");
        assert_eq!(version(b"v0.1.0 v0.1.0"), Some("v0.1.0".into()));
        assert_eq!(version(b"v0.1.0 v0.2.0"), None, "two different");
        assert_eq!(version(b"v1.2.3.4"), None);
        assert_eq!(version(b"v1.2"), None);
    }

    #[test]
    fn crcs() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc16(b"123456789"), 0x31C3);
        // The probe, as analysis/bootloader.md writes it.
        assert_eq!(probe(), [0xAA, 0x42, 0, 0, 0, 0, 0x55, 0xEB, 0x55]);
    }

    #[test]
    fn update_frames_follow_flash_py() {
        let btf = pack(&image(5000));
        let u = Update::new(&btf).unwrap();
        assert_eq!(u.blocks(), 6);
        assert_eq!(u.steps(), 10);
        assert_eq!(u.frame(0), frame(CMD_HELLO, 0, &[]));
        assert_eq!(u.frame(1), frame(CMD_MODEL, 0, &btf[0x3E0..0x400]));
        assert_eq!(&u.frame(1)[6..18], MODEL_TAG);
        assert_eq!(u.frame(2), frame(CMD_COUNT, 0, &[0, 5]), "blocks - 1");
        for n in 0..6 {
            let f = u.frame(3 + n);
            assert_eq!(u.step(3 + n).block, Some(n));
            assert_eq!(f, frame(CMD_DATA, n as u16, &btf[n * BLOCK..(n + 1) * BLOCK]));
            assert_eq!(f.len(), 1024 + 9);
        }
        assert_eq!(u.frame(9), frame(CMD_END, 0, &[]));
        assert_eq!(u.step(9).what, "end");
        // Every frame is one of the five commands: nothing else ever goes to the bootloader.
        for i in 0..u.steps() {
            assert!([CMD_HELLO, CMD_MODEL, CMD_COUNT, CMD_DATA, CMD_END].contains(&u.frame(i)[1]));
        }
    }

    #[test]
    fn a_short_last_block_is_padded_with_zeros() {
        let mut btf = pack(&image(5000));
        btf.truncate(btf.len() - 100);
        let u = Update::new(&btf).unwrap();
        let f = u.frame(3 + 5);
        assert_eq!(&f[6 + 924..6 + 1024], &[0u8; 100][..]);
    }

    #[test]
    fn boot_reader_finds_replies_in_noise() {
        let reply = |cmd: u8, r: u8| {
            let body = [cmd, 0, r, 0, 0];
            let c = crc16(&body).to_be_bytes();
            vec![0xAA, cmd, 0, r, 0, 0, c[0], c[1], 0x55]
        };
        // flash.py's example: the probe answered 06 in the boot window.
        assert_eq!(reply(0x42, 6), [0xAA, 0x42, 0, 6, 0, 0, 0xE7, 0x4B, 0x55]);
        let mut r = BootReader::new();
        let mut stream = b"\x00garbage\xAA\x01".to_vec();
        stream.extend(reply(0x42, 6));
        stream.extend(reply(0x03, 0xE3));
        let half = stream.len() - 4;
        assert_eq!(r.feed(&stream[..half]), vec![(0x42, 6)]);
        assert_eq!(r.feed(&stream[half..]), vec![(0x03, 0xE3)]);
        assert_eq!(result_text(0xE3), "flash write failed");
    }

    /// A real build, when ferrite's target/ has one: it passes, it is Ferrite, its version shows.
    #[test]
    fn a_real_ferrite_build_passes_when_present() {
        for name in ["ferrite-tx.btf", "ferrite.btf"] {
            let path = format!("{}/../../ferrite/target/{name}", env!("CARGO_MANIFEST_DIR"));
            let Ok(btf) = std::fs::read(&path) else { continue };
            let c = check_file(&btf);
            assert!(c.problems.is_empty(), "{name}: {:?}", c.problems);
            assert!(c.ferrite && c.version.is_some(), "{name}: {c:?}");
        }
    }
}
