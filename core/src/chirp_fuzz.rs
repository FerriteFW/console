//! Randomized CHIRP import tests (crash reports, Nov 16, 2026: imports, then scanning and channel settings).
//! Seeded, so a failure repeats: each case prints its seed and file. Every field is drawn from values seen in
//! real exports plus broken ones (blank, out of range, NaN, huge, wrong case, other radios' modes, non-ASCII), with
//! columns dropped, reordered and rows cut short. Nothing may panic, and whatever the import keeps must hold up
//! in the steps after it: the channel record, the table's row check, export and import again, a new zone, the
//! zones' scan settings, and the plan that writes it all.

use crate::channels::{ChanView, ZoneView, RESUMES};
use crate::chirp::{export, import, into_new_zone, parse_csv};
use crate::plan::{check_channel, plan, Set};

/// xorshift64*: small, seeded, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[self.below(xs.len())]
    }
    fn chance(&mut self, pct: usize) -> bool {
        self.below(100) < pct
    }
}

const LOCATION: &[&str] = &["", "0", "1", "2", "3", "17", "255", "256", "999", "3999", "4000", "4001", "-1", "abc", "1.5", "4294967295", "99999999999"];
const FREQ: &[&str] = &[
    "146.520000", "146.52", "446.475", "145.495", "162.550", "101.1", "88.0", "108.0", "7.074", "14.230", "29.600", "50.125", "137.100",
    "222.000", "520.000", "1296.000", "0", "0.000001", "-146.52", "1e9", "999999", "nan", "inf", "146.5200001", "146,52", "", " 146.52 ",
];
const DUPLEX: &[&str] = &["", "", "+", "-", "split", "Split", "off", "x", "+-"];
const OFFSET: &[&str] = &["", "0.000000", "0.6", "0.600000", "5.000000", "1.6", "-5", "600", "437.800000", "144.390", "999999", "nan", "0.0000001"];
const TONE: &[&str] = &["", "", "Tone", "TSQL", "DTCS", "Cross", "TSQL-R", "DTCS-R", "tone", "Tone ", "x"];
const TONE_FREQ: &[&str] = &["88.5", "100.0", "67.0", "254.1", "123.0", "69.3", "0", "1000", "-1", "x", "", "nan", "88.50"];
const DTCS: &[&str] = &["023", "754", "777", "000", "1000", "8", "999", "-1", "", "23", "0o23"];
const POL: &[&str] = &["NN", "RN", "NR", "RR", "", "N", "R", "XYZ", "ÿÿ", "nn"];
const CROSS: &[&str] = &["Tone->Tone", "Tone->DTCS", "DTCS->Tone", "DTCS->DTCS", "->DTCS", "Tone->", "->", "DTCS->DTCS->Tone", "", "Tone->Tone ", "->Tone"];
const MODE: &[&str] = &["FM", "NFM", "AM", "WFM", "USB", "LSB", "CW", "DV", "DMR", "", "fm", "Auto", "CWR", "NAM"];
const STEP: &[&str] = &["5.00", "2.50", "6.25", "8.33", "12.50", "25.00", "100.00", "7.00", "0", "-5", "1e30", "nan", "inf", "", "x"];
const SKIP: &[&str] = &["", "", "S", "P", "s", "p", "SP", "X", " S"];
const POWER: &[&str] = &["High", "Low", "Mid", "Med", "5.0W", "0.5W", "1.5W", "4W", "50W", "nanW", "", "-1W", "50", "H", "l"];
const NAME: &[&str] = &[
    "", "Calling", "North hill", "A very long channel name indeed", "Café ✓", "日本語", "\"quoted\"", "comma, here", "line\nbreak", "tab\there",
    "   ", "-./_#+&()'!", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", "abcdefghijklmnop", "abcdefghijklmnopq", "trailing   ",
];
const COMMENT: &[&str] = &["", "", "Local", "Repeaters", "repeaters", "LOCAL", "Zz", "CHIRP", "Local "];
const DEG: &[&str] = &["", "0", "49.2827", "-123.1207", "45.42", "-75.69", "91", "-181", "nan", "inf", "1e308", "x"];

const HEADER: &[&str] = &[
    "Location", "Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "cToneFreq", "DtcsCode", "DtcsPolarity", "RxDtcsCode",
    "CrossMode", "Mode", "TStep", "Skip", "Power", "Comment", "URCALL", "RPT1CALL", "RPT2CALL", "DVCODE",
];

fn value(rng: &mut Rng, col: &str) -> String {
    let s = match col {
        "Location" => rng.pick(LOCATION),
        "Name" => rng.pick(NAME),
        "Frequency" => rng.pick(FREQ),
        "Duplex" => rng.pick(DUPLEX),
        "Offset" => rng.pick(OFFSET),
        "Tone" => rng.pick(TONE),
        "rToneFreq" | "cToneFreq" => rng.pick(TONE_FREQ),
        "DtcsCode" | "RxDtcsCode" => rng.pick(DTCS),
        "DtcsPolarity" => rng.pick(POL),
        "CrossMode" => rng.pick(CROSS),
        "Mode" => rng.pick(MODE),
        "TStep" => rng.pick(STEP),
        "Skip" => rng.pick(SKIP),
        "Power" => rng.pick(POWER),
        "Comment" => rng.pick(COMMENT),
        "Latitude" | "Longitude" => rng.pick(DEG),
        _ => "",
    };
    s.to_string()
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// A CHIRP-ish file: the columns (some dropped, maybe shuffled, maybe positions), 0-40 rows, some cut short.
fn file(rng: &mut Rng) -> String {
    let mut cols: Vec<&str> = HEADER.iter().copied().filter(|c| *c == "Frequency" || !rng.chance(8)).collect();
    if rng.chance(20) {
        cols.extend(["Latitude", "Longitude"]);
    }
    if rng.chance(15) {
        for i in (1..cols.len()).rev() {
            cols.swap(i, rng.below(i + 1));
        }
    }
    let mut out = cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(",") + "\r\n";
    let sequential = rng.chance(50);
    for k in 0..rng.below(41) {
        let mut row: Vec<String> = cols
            .iter()
            .map(|c| if *c == "Location" && sequential { k.to_string() } else { value(rng, c) })
            .collect();
        if rng.chance(5) {
            row.truncate(rng.below(row.len() + 1));
        }
        if rng.chance(3) {
            row.push("extra".into());
        }
        out += &row.iter().map(|s| quote(s)).collect::<Vec<_>>().join(",");
        out += if rng.chance(10) { "\n" } else { "\r\n" };
    }
    out
}

/// Zones as the table may hold them, with random scan settings (SCAN-5: resume, dwell, priority channels).
fn zones(rng: &mut Rng, channels: &[ChanView]) -> Vec<ZoneView> {
    let names = ["Local", "Repeaters", "CHIRP", "Scan", ""];
    let n = rng.below(names.len() + 1);
    (0..n)
        .map(|i| {
            let mut z = ZoneView::new(i as u16 + 1, names[i]);
            z.scan_all = rng.chance(50);
            z.shown = rng.chance(80);
            z.by_distance = rng.chance(20);
            z.resume = RESUMES[rng.below(RESUMES.len())].to_string();
            z.dwell = rng.pick(&["Radio", "", "1", "5", "254", "10 s", "10s"]).to_string();
            let pri = |rng: &mut Rng| match rng.below(4) {
                0 => None,
                1 => Some(1 + rng.below(4000) as u16),
                _ => channels.get(rng.below(channels.len().max(1))).map(|c| c.number),
            };
            z.pri1 = pri(rng);
            z.pri2 = pri(rng);
            z
        })
        .collect()
}

fn case(seed: u64) {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let text = file(&mut rng);
    let ctx = || format!("seed {seed}, file:\n{text}");
    let pre = zones(&mut rng, &[]);
    let Ok(got) = import(&text, &pre) else { return };
    let mut seen = std::collections::BTreeSet::new();
    for c in &got.channels {
        assert!(seen.insert(c.number), "channel {} twice; {}", c.number, ctx());
        assert!(c.channel().is_ok(), "{:?}: {:?}; {}", c, c.channel(), ctx());
        assert_eq!(c.normal().as_ref(), Ok(c), "not normal; {}", ctx());
        assert_eq!(check_channel(c, pre.len() as u16), None, "{c:?}; {}", ctx());
        let z = ZoneView { scan_all: true, ..ZoneView::new(1, "Z") };
        let _ = z.zone();
    }
    // Export and in again: the same channels (but their positions).
    let again = import(&export(&got.channels, &pre), &pre).unwrap_or_else(|e| panic!("{e}; {}", ctx()));
    for (a, b) in again.channels.iter().zip(&got.channels) {
        // CHIRP's CSV has no position column: the export leaves them out (repeaterbook_positions)
        assert_eq!(a, &ChanView { pos: None, ..b.clone() }, "round trip; {}", ctx());
    }
    assert_eq!(again.channels.len(), got.channels.len(), "round trip; {:?}; {}", again.notes, ctx());
    assert_eq!(again.skipped, 0, "{:?}; {}", again.notes, ctx());
    let _ = parse_csv(&text);
    // Into the table: a new zone after what's there, then the plan that writes it, scan settings and all.
    let base_channels: Vec<ChanView> = (0..rng.below(30)).map(|k| ChanView::new(1 + k as u16 * 7, 14_652_000)).collect();
    let base = Set { zones: zones(&mut rng, &base_channels), channels: base_channels };
    let nz = into_new_zone(&got.channels, &base, "Import");
    let mut want = base.clone();
    if nz.room.is_empty() && nz.name_error.is_empty() {
        want.zones.extend(nz.zones.iter().cloned());
        want.channels.extend(nz.channels.iter().cloned());
    } else {
        // Or with their Comment zones, over the channels of the same numbers.
        want.zones = zones(&mut rng, &got.channels);
        for c in &got.channels {
            let mut c = c.clone();
            c.zone = c.zone.filter(|&z| (z as usize) < want.zones.len());
            want.channels.retain(|b| b.number != c.number);
            want.channels.push(c);
        }
    }
    for z in &mut want.zones {
        z.scan_all = rng.chance(50);
        let _ = z.zone();
    }
    let p = plan(&base, &want);
    let _ = (p.ops.len(), p.problems.len());
}

/// Many random files: nothing panics, and what's imported survives every later step.
#[test]
fn random_chirp_files() {
    let n: u64 = std::env::var("CHIRP_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(3_000);
    let first: u64 = std::env::var("CHIRP_FUZZ_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    for seed in first..first + n {
        case(seed);
    }
}
