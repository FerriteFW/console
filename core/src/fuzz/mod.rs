//! Fuzz and property tests over what Console reads from outside: files people open (CHIRP CSVs, backups,
//! codeplug parts, flash copies, update files) and what the radio answers (records of every length, from a damaged
//! chip or another firmware version). Seeded and std-only, so a failure repeats: each case prints its seed and the
//! exact input before the panic goes on. They run in the normal `cargo test`; `FERRITE_FUZZ_SCALE=N` runs N times
//! the cases (a long run), `FERRITE_FUZZ_SEED=S` only seed S of each target.
//!
//! - [`chirp`]: CHIRP CSV files, real exports' quirks mutated byte by byte and field by field.
//! - [`backups`]: the channel, settings, APRS and preset backups; flash copies, `.ffw`, `.btf`.
//! - [`radio`]: records and answers as the radio sends them, of every length.
//! - [`plans`]: random edits through `set`, then `plan`, sent to ferrite's own link session.
//! - [`outside`]: the other parsers of outside text (library data, satellites, the reader's lines).

mod backups;
mod chirp;
mod outside;
mod plans;
mod radio;

use crate::channels::{tone_word, ChanView, Position, ZoneView, POWERS, RESUMES};
use crate::plan::Set;
use ferrite_app::slot::{MODES, STEPS};
use std::fmt::Debug;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};

/// xorshift64*: small, seeded, no dependency.
pub struct Rng(u64);

impl Rng {
    /// A generator for one case: `seed` spread over the state (never 0).
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_add(1).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// 0..n (0 when n is 0).
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
    pub fn chance(&mut self, pct: usize) -> bool {
        self.below(100) < pct
    }
    pub fn pick<'a, T: ?Sized>(&mut self, xs: &[&'a T]) -> &'a T {
        xs[self.below(xs.len())]
    }
    pub fn byte(&mut self) -> u8 {
        self.next() as u8
    }
    pub fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.byte()).collect()
    }
    /// 0..n random bytes.
    pub fn some_bytes(&mut self, n: usize) -> Vec<u8> {
        let k = self.below(n);
        self.bytes(k)
    }
    /// A byte that often breaks parsers: the ends, the middle, ASCII's specials.
    pub fn odd_byte(&mut self) -> u8 {
        *[
            0u8, 1, 0x7F, 0x80, 0xFE, 0xFF, b'"', b',', b'\n', b'\r', b'{', b'}', b'0', b'9', b'a', b' ', 0xEF, 0xBB,
            0xBF,
        ]
        .get(self.below(19))
        .unwrap_or(&0)
    }
}

/// How many cases a target runs: `n` times `FERRITE_FUZZ_SCALE` (default 1).
pub fn cases(n: u64) -> u64 {
    let scale: u64 = std::env::var("FERRITE_FUZZ_SCALE").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    n.saturating_mul(scale.max(1))
}

/// The seeds a target runs: 0..`cases(n)`, or only `FERRITE_FUZZ_SEED`.
pub fn seeds(n: u64) -> std::ops::Range<u64> {
    match std::env::var("FERRITE_FUZZ_SEED").ok().and_then(|s| s.parse::<u64>().ok()) {
        Some(s) => s..s + 1,
        None => 0..cases(n),
    }
}

/// Runs one case's checks; on a panic, prints the target, the seed and the exact input, then panics on.
pub fn guard<I: Debug + ?Sized>(target: &str, seed: u64, input: &I, f: impl FnOnce()) {
    if let Err(e) = catch_unwind(AssertUnwindSafe(f)) {
        eprintln!("fuzz {target}: failed at seed {seed} (FERRITE_FUZZ_SEED={seed} repeats it); the input:\n{input:?}");
        resume_unwind(e);
    }
}

/// Mutates `b` in place: 1-8 edits of bit flips, odd bytes, inserts, deletes, a copied or cut run, a truncation.
pub fn mutate(rng: &mut Rng, b: &mut Vec<u8>) {
    for _ in 0..1 + rng.below(8) {
        let n = b.len();
        match rng.below(9) {
            0 if n > 0 => {
                let i = rng.below(n);
                b[i] ^= 1 << rng.below(8);
            }
            1 if n > 0 => {
                let i = rng.below(n);
                b[i] = rng.odd_byte();
            }
            2 => {
                let i = rng.below(n + 1);
                let v = rng.odd_byte();
                b.insert(i, v);
            }
            3 if n > 0 => {
                b.remove(rng.below(n));
            }
            4 if n > 0 => {
                // a run copied elsewhere (a duplicated line, field or record)
                let (a, k) = (rng.below(n), 1 + rng.below(32));
                let run: Vec<u8> = b[a..(a + k).min(n)].to_vec();
                let at = rng.below(n + 1);
                b.splice(at..at, run);
            }
            5 if n > 0 => {
                let (a, k) = (rng.below(n), 1 + rng.below(32));
                b.drain(a..(a + k).min(n));
            }
            6 if n > 0 && rng.chance(30) => b.truncate(rng.below(n)),
            7 if n > 0 => {
                let i = rng.below(n);
                b[i] = rng.byte();
            }
            _ => {
                let i = rng.below(n + 1);
                let v = rng.byte();
                b.insert(i, v);
            }
        }
    }
}

/// `text` mutated as bytes, back to text (lossy: a file of broken UTF-8 reads as Console's file reader reads it).
pub fn mutate_text(rng: &mut Rng, text: &str) -> String {
    let mut b = text.as_bytes().to_vec();
    mutate(rng, &mut b);
    String::from_utf8_lossy(&b).into_owned()
}

/// Times a target, so the report can say what each costs (`cargo test -- --nocapture` shows it).
pub fn timed(target: &str, f: impl FnOnce()) {
    let t = std::time::Instant::now();
    f();
    eprintln!("fuzz {target}: {:.2} s", t.elapsed().as_secs_f64());
}

/// A channel as ferrite's types hold it: every mode and step, tones, shifts, flags, in one of `zones` or none.
/// (The radio's link may still refuse it: [`crate::plan::check_channel`].)
pub fn held_channel(rng: &mut Rng, number: u16, zones: u16) -> ChanView {
    const RX: &[u32] = &[
        14_652_000, 14_694_000, 44_350_000, 44_647_500, 12_410_000, 16_255_000, 817_600, 707_400, 375_000, 10_110_000,
        5_012_500, 22_200_000,
    ];
    let mut v = ChanView::new(number, RX[rng.below(RX.len())] + 125 * rng.below(8) as u32);
    v.name = rng.pick(&["", "CALL", "North hill", "40m FT8", "a-b.c/d_e#f+g&(", "0123456789abcdef"]).to_string();
    v.mode = MODES[rng.below(MODES.len())].into();
    v.step = STEPS[rng.below(STEPS.len())].1.into();
    v.power = POWERS[rng.below(POWERS.len())].into();
    let tone = |rng: &mut Rng| match rng.below(4) {
        0 => 0,
        1 => [670u16, 885, 1000, 1273, 2541][rng.below(5)],
        2 => 0x8000 | [0o23u16, 0o754, 0o131][rng.below(3)],
        _ => 0xC000 | 0o23,
    };
    v.tx_tone = tone_word(tone(rng));
    v.rx_tone = tone_word(tone(rng));
    match rng.below(5) {
        0 => (v.duplex, v.offset) = ("+".into(), "0.60000".into()),
        1 => (v.duplex, v.offset) = ("-".into(), "5.00000".into()),
        2 => (v.duplex, v.offset) = ("split".into(), "146.34000".into()),
        _ => {}
    }
    v.skip = rng.chance(20);
    v.priority = !v.skip && rng.chance(10);
    v.rx_only = rng.chance(10);
    v.zone = (zones > 0 && rng.chance(50)).then(|| rng.below(zones as usize) as u16);
    if rng.chance(30) {
        v.pos =
            Position::from_degrees(rng.below(18_000) as f64 / 100.0 - 90.0, rng.below(36_000) as f64 / 100.0 - 180.0);
    }
    v.normal().unwrap_or_else(|e| panic!("{v:?}: {e}"))
}

/// A zone as the radio holds it (number `index + 1`), its scan settings random.
pub fn held_zone(rng: &mut Rng, index: u16) -> ZoneView {
    let mut z =
        ZoneView::new(index + 1, rng.pick(&["Local", "Repeaters", "Air", "Marine", "HF", "0123456789abcdef", "Z"]));
    z.scan_all = rng.chance(50);
    z.shown = rng.chance(80);
    z.by_distance = rng.chance(20);
    z.resume = RESUMES[rng.below(RESUMES.len())].to_string();
    z.dwell = rng.pick(&["Radio", "1", "5", "254"]).to_string();
    z.pri1 = rng.chance(30).then(|| 1 + rng.below(4000) as u16);
    z.pri2 = rng.chance(30).then(|| 1 + rng.below(4000) as u16);
    z
}

/// A set the radio could hold: up to `zones` zones, up to `chans` channels at distinct numbers, each one the link
/// takes.
pub fn held_set(rng: &mut Rng, zones: usize, chans: usize) -> Set {
    let nz = rng.below(zones + 1);
    let zs: Vec<ZoneView> = (0..nz).map(|i| held_zone(rng, i as u16)).collect();
    let mut nums: Vec<u16> = (0..rng.below(chans + 1)).map(|_| 1 + rng.below(4000) as u16).collect();
    nums.sort();
    nums.dedup();
    let channels = nums
        .into_iter()
        .map(|n| held_channel(rng, n, nz as u16))
        .filter(|c| crate::plan::check_channel(c, nz as u16).is_none())
        .collect();
    Set { zones: zs, channels }
}

/// A default radio's APRS record, read over the link.
pub fn aprs_default() -> Vec<u8> {
    let mut rs = crate::radioside::RadioSide::new();
    let mut r = crate::records::Reader::new(ferrite_core::link::what::APRS, 0);
    while !r.done() {
        let (s, rest) = rs.ask(ferrite_core::link::msg::READ, &r.next_payload());
        assert_eq!(s, 0);
        assert!(r.take(&rest));
    }
    r.record
}

/// Range presets the radio could hold (up to its 16), with skipped frequencies.
pub fn held_presets(rng: &mut Rng) -> Vec<crate::presets::PresetView> {
    const RANGES: &[(&str, &str)] =
        &[("144", "148"), ("430", "440"), ("118", "137"), ("18", "30"), ("64", "108"), ("156", "163")];
    let n = rng.below(crate::presets::MAX_PRESETS + 1);
    (0..n)
        .map(|i| {
            let mut v = crate::presets::PresetView::new(i as u8 + 1, rng.pick(&["", "2 m", "Air", "abcdefghijkl"]));
            let r = RANGES[rng.below(RANGES.len())];
            (v.low, v.high) = (r.0.into(), r.1.into());
            v.mode = rng.pick(&["FM", "NFM", "AM"]).into();
            v.step = ferrite_app::slot::STEPS[rng.below(ferrite_app::slot::STEPS.len())].1.into();
            v.skips = (0..rng.below(3)).map(|k| 14_652_000 + k as u32 * 2500).collect();
            v.normal().unwrap()
        })
        .collect()
}
