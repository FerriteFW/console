//! Range presets (MENU 0 1 4, SCAN-4, SCAN-24; LINK-21's `what::PRESET`): the record the link reads and writes, in
//! the field order of ferrite's `link.rs` (`preset_save`, and `apply`'s reader), the presets as the editor shows
//! them, and the write plan, checked first through ferrite's own link session ([`RadioSide`]).
//!
//! A preset's skipped frequencies (SCAN-10, up to 48) aren't in the preset's own record: the radio keeps them with the
//! preset it already holds at that index (`p.skips = old.skips`), and reads and writes them as a list of their own
//! (LINK-58, `what` 11). So the plan never shifts a kept preset to another
//! index: deletions go first (highest index first), then each kept preset is rewritten where it now is, then the new
//! ones are added after them; then the skip lists that differ from what the radio then holds. `origin` (the number it
//! was read as) is how the table says which preset is which.

use crate::answers::status_text;
use crate::channels::{mhz_text, parse_mhz, RESUMES};
use crate::plan::{hex, unhex, Change, Field, Op, Problem};
use crate::radioside::RadioSide;
use crate::records::{begin_payload, delete_payload, write_payloads};
use ferrite_app::data::RangePreset;
use ferrite_app::persist::{Persist, Sink, Source};
use ferrite_app::slot::{mode_narrow, MODES, PRESET_MODES, STEPS, STEP_12K5};
use ferrite_core::freq::mhz;
use ferrite_core::link::{msg, what, PRESET_SKIPS_MAX};
use ferrite_ui::text::Buf;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A preset record's length over the link: name (12), start and end (4 each), step, mode, narrow, resume.
pub const PRESET_LEN: usize = 24;
/// The most range presets the radio keeps (MENU 0 1 4).
pub const MAX_PRESETS: usize = 16;
/// The longest name (the radio's editor: "Up to 12 characters").
pub const NAME_LEN: usize = 12;
/// The backup part's format name (`.ferrite`'s presets.json).
pub const BACKUP_FORMAT: &str = "ferrite-console-presets";

/// Resume as the radio's preset editor words it (SCAN-24): 0 Global (MENU 0 1 2's rule), 1-10 s, carrier, stop.
pub fn resume_word(r: u8) -> String {
    match r {
        0 => "Global".into(),
        11 => "Carrier drop".into(),
        12 => "Stop on hit".into(),
        s => format!("After {s} s"),
    }
}

fn resume_words() -> Vec<String> {
    (0..RESUMES.len() as u8).map(resume_word).collect()
}

struct Bytes(Vec<u8>);

impl Sink for Bytes {
    fn put(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

struct Rd<'a> {
    b: &'a [u8],
    n: usize,
}

impl Source for Rd<'_> {
    fn take(&mut self, out: &mut [u8]) -> bool {
        match self.b.get(self.n..self.n + out.len()) {
            Some(s) => {
                out.copy_from_slice(s);
                self.n += out.len();
                true
            }
            None => false,
        }
    }
}

/// A preset's record, as the radio's `preset_save` writes it.
pub fn preset_record(p: &RangePreset) -> Vec<u8> {
    let mut s = Bytes(Vec::with_capacity(PRESET_LEN));
    let mut n = [0u8; NAME_LEN];
    let b = p.name.as_bytes();
    n[..b.len().min(NAME_LEN)].copy_from_slice(&b[..b.len().min(NAME_LEN)]);
    s.put(&n);
    p.start.save(&mut s);
    p.end.save(&mut s);
    p.step.save(&mut s);
    p.mode.save(&mut s);
    p.narrow.save(&mut s);
    p.resume.save(&mut s);
    s.0
}

/// A preset from its record, as the radio's `apply` reads one (its checks are the radio's: [`check`]). None if the
/// record is the wrong length or the name isn't text. The skip count isn't in the record: 0.
pub fn preset_from_record(rec: &[u8]) -> Option<RangePreset> {
    if rec.len() != PRESET_LEN {
        return None;
    }
    let mut r = Rd { b: rec, n: 0 };
    let mut name = [0u8; NAME_LEN];
    r.take(&mut name);
    let n = name.iter().position(|&b| b == 0).unwrap_or(NAME_LEN);
    if !name[..n].iter().all(|c| (0x20..0x7F).contains(c)) {
        return None;
    }
    let mut p = RangePreset {
        name: Buf::from(&name[..n]),
        start: 0,
        end: 0,
        step: 0,
        mode: 0,
        narrow: true,
        skips: 0,
        resume: 0,
    };
    p.start.load(&mut r);
    p.end.load(&mut r);
    p.step.load(&mut r);
    p.mode.load(&mut r);
    p.narrow.load(&mut r);
    p.resume.load(&mut r);
    Some(p)
}

/// One preset as the editor shows it: MHz as text, the step, mode and resume as the radio words them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetView {
    /// As the radio lists it, 1-16.
    pub number: u8,
    pub name: String,
    /// The range's start and end, MHz.
    pub low: String,
    pub high: String,
    pub step: String,
    pub mode: String,
    pub resume: String,
    /// The number it was read as (its skipped frequencies stay with it), None for one added here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<u8>,
    /// Its skipped frequencies (SCAN-10, LINK-58), 10 Hz, in the radio's order; empty for none (or not read).
    #[serde(default)]
    pub skips: Vec<u32>,
}

fn pick(list: &[String], v: &str, what: &str) -> Result<usize, String> {
    list.iter()
        .position(|x| x.eq_ignore_ascii_case(v.trim()))
        .ok_or_else(|| format!("{what}: one of {}", list.join(", ")))
}

fn step_words() -> Vec<String> {
    STEPS.iter().map(|s| s.1.to_string()).collect()
}

fn mode_words() -> Vec<String> {
    // A range preset: FM, NFM, AM or NAM (decision 447).
    PRESET_MODES.iter().map(|&m| MODES[m as usize].to_string()).collect()
}

impl PresetView {
    pub fn of(index: u8, p: &RangePreset) -> Self {
        let mut p = *p;
        p.fold_bw(); // VFO-20: FM with narrow from before reads as NFM
        PresetView {
            number: index.saturating_add(1),
            name: String::from_utf8_lossy(p.name.as_bytes()).into_owned(),
            low: mhz_text(p.start),
            high: mhz_text(p.end),
            step: STEPS.get(p.step as usize).map_or("12.5 kHz", |s| s.1).to_string(),
            mode: MODES.get(p.mode as usize).unwrap_or(&"FM").to_string(),
            resume: resume_word(p.resume.min(12)),
            origin: Some(index.saturating_add(1)),
            skips: Vec::new(),
        }
    }

    /// A new preset: 2 m's band, 12.5 kHz, NFM, Global (as the terminal's `preset` makes one).
    pub fn new(number: u8, name: &str) -> Self {
        let mut v = Self::of(
            number.saturating_sub(1),
            &RangePreset {
                name: Buf::new(),
                start: mhz(144),
                end: mhz(148),
                step: STEP_12K5,
                mode: 1,
                narrow: true,
                skips: 0,
                resume: 0,
            },
        );
        v.name = name.into();
        v.origin = None;
        v
    }

    /// The radio's type, or the first field that doesn't parse or that the radio would refuse: the link's checks
    /// (`apply`'s) and the editor's SCAN-14 edges.
    pub fn preset(&self) -> Result<RangePreset, String> {
        let name = self.name.trim_end();
        if name.len() > NAME_LEN || !name.bytes().all(|c| (0x20..0x7F).contains(&c)) {
            return Err(format!("name: up to {NAME_LEN} letters, digits and symbols"));
        }
        let start = parse_mhz(&self.low).ok_or("start: MHz, e.g. 144.0")?;
        let end = parse_mhz(&self.high).ok_or("end: MHz, e.g. 148.0")?;
        if !(mhz(18)..=mhz(1300)).contains(&start) || end <= start || end > mhz(1300) {
            return Err("start and end: 18 to 1300 MHz, end above start".into());
        }
        // SCAN-14: the band relay's edges; the radio's editor refuses a range across one.
        if let Some(e) = [18, 64].into_iter().find(|&e| start < mhz(e) && end > mhz(e)) {
            return Err(format!("can't span {e} MHz: one side only"));
        }
        let step = pick(&step_words(), &self.step, "step")? as u8;
        let mode = PRESET_MODES[pick(&mode_words(), &self.mode, "mode")?];
        let resume = pick(&resume_words(), &self.resume, "resume")? as u8;
        Ok(RangePreset {
            name: Buf::from(name.as_bytes()),
            start,
            end,
            step,
            mode,
            narrow: mode_narrow(mode),
            skips: 0,
            resume,
        })
    }

    /// As the radio would hold it (MHz to five decimals, words as the radio spells them), keeping number and origin.
    pub fn normal(&self) -> Result<PresetView, String> {
        let p = self.preset()?;
        Ok(PresetView {
            number: self.number,
            origin: self.origin,
            skips: self.skips.clone(),
            ..PresetView::of(self.number.saturating_sub(1), &p)
        })
    }
}

/// The editor's lists.
pub fn choices() -> serde_json::Value {
    serde_json::json!({
        "steps": step_words(),
        "modes": mode_words(),
        "resumes": resume_words(),
        "max": MAX_PRESETS,
        "nameLen": NAME_LEN,
        "skipsMax": PRESET_SKIPS_MAX,
    })
}

/// Records as read (index order) to presets, and the ones that didn't parse.
pub fn from_records(recs: &[Vec<u8>]) -> (Vec<PresetView>, Vec<String>) {
    let mut out = Vec::new();
    let mut bad = Vec::new();
    for (i, r) in recs.iter().enumerate() {
        match preset_from_record(r) {
            Some(p) => out.push(PresetView::of(out.len().min(u8::MAX as usize) as u8, &p)),
            None => bad.push(format!("range preset {}: a record of {} bytes didn't parse", i + 1, r.len())),
        }
    }
    (out, bad)
}

fn reason(s: u8, rest: &[u8]) -> String {
    status_text(s, rest).trim_start_matches("invalid: ").to_string()
}

/// One preset's problem as the radio would see it (its fields, then ferrite's own link checks), or None.
pub fn check(v: &PresetView) -> Option<String> {
    let p = match v.preset() {
        Ok(p) => p,
        Err(e) => return Some(e),
    };
    let mut r = RadioSide::new();
    let (s, rest) = r.write_one(what::PRESET, 0, &preset_record(&p));
    if s != 0 {
        return Some(reason(s, &rest));
    }
    if v.skips.is_empty() {
        return None;
    }
    if v.skips.len() > PRESET_SKIPS_MAX {
        return Some(format!("skipped frequencies: {PRESET_SKIPS_MAX} at most"));
    }
    let (s, rest) = r.write_one(what::PRESET_SKIPS, 0, &crate::lists::preset_skips_record(&v.skips));
    (s != 0).then(|| format!("skipped frequencies: {}", reason(s, &rest)))
}

/// A skipped frequency typed in MHz ("146.52"), as 10 Hz; None if it isn't one.
pub fn parse_skip(text: &str) -> Option<u32> {
    parse_mhz(text)
}

/// A skip list as the diff shows it: the frequencies in MHz, the first few.
fn skips_text(f: &[u32]) -> String {
    if f.is_empty() {
        return "none".into();
    }
    let mut t: Vec<String> = f.iter().take(4).map(|&x| mhz_text(x)).collect();
    if f.len() > 4 {
        t.push(format!("… ({} in all)", f.len()));
    }
    t.join(", ")
}

/// The views as the diff compares them (the number and origin aside).
fn shown(v: &PresetView) -> PresetView {
    PresetView { number: 0, origin: None, ..v.clone() }
}

fn fields(a: &PresetView, b: &PresetView) -> Vec<Field> {
    let pairs = [
        ("name", &a.name, &b.name),
        ("low", &a.low, &b.low),
        ("high", &a.high, &b.high),
        ("step", &a.step, &b.step),
        ("mode", &a.mode, &b.mode),
        ("resume", &a.resume, &b.resume),
    ];
    pairs
        .into_iter()
        .filter(|(_, x, y)| x != y)
        .map(|(f, x, y)| Field { field: f.into(), from: x.clone(), to: y.clone() })
        .collect()
}

/// What a presets write does: the diff, `BEGIN`'s payload, the requests, and what ferrite's link session refuses.
#[derive(Clone, Debug, Serialize)]
pub struct Plan {
    pub changes: Vec<Change>,
    pub begin: Vec<u8>,
    pub ops: Vec<Op>,
    pub problems: Vec<Problem>,
    /// LINK-58: the skip lists to write after the ops, `(index, record)` for `WRITE_MANY` of `what` 11 (an empty
    /// record clears one): each preset whose list differs from what the radio holds with it then.
    pub skips: Vec<(u16, Vec<u8>)>,
}

fn problem(n: u8, e: String) -> Problem {
    Problem { what: "preset".into(), number: n as u16, error: e }
}

/// The plan from `base` (the radio's presets, read just now) to `want` (the table): presets gone deleted, highest
/// index first; then each kept one written where it now is when it changed (or moved down); then the new ones
/// added in order; then (LINK-58) each skip list that differs from the one the radio holds with that preset (a kept one's as read, a new one's none). Run through ferrite's link session
/// seeded with `base` first: its refusals are problems.
pub fn plan(base: &[PresetView], want: &[PresetView]) -> Plan {
    let mut problems = Vec::new();
    let mut changes = Vec::new();
    let mut ops = Vec::new();
    let parse = |vs: &[PresetView], whose: &str, problems: &mut Vec<Problem>| -> Vec<RangePreset> {
        vs.iter()
            .filter_map(|v| v.preset().map_err(|e| problems.push(problem(v.number, format!("{whose}{e}")))).ok())
            .collect()
    };
    let bp = parse(base, "the radio's own preset: ", &mut problems);
    let wp = parse(want, "", &mut problems);
    if want.len() > MAX_PRESETS {
        problems.push(problem(0, format!("at most {MAX_PRESETS} range presets")));
    }
    let empty = |problems: Vec<Problem>| Plan {
        changes: Vec::new(),
        begin: begin_payload(0),
        ops: Vec::new(),
        problems,
        skips: Vec::new(),
    };
    if !problems.is_empty() {
        return empty(problems);
    }
    // Which base each wanted one is (by origin); a kept one keeps its order (the table never reorders).
    let mut kept: Vec<u8> = Vec::new();
    for v in want {
        if let Some(o) = v.origin {
            if o == 0 || o as usize > base.len() || kept.contains(&o) {
                problems.push(problem(v.number, format!("reads as preset {o}, which the radio doesn't have")));
            } else if kept.last().is_some_and(|&l| o < l) {
                problems.push(problem(v.number, "presets keep their order".into()));
            } else {
                kept.push(o);
            }
        }
    }
    if want.iter().skip_while(|v| v.origin.is_some()).any(|v| v.origin.is_some()) {
        problems.push(problem(0, "new presets go after the ones read".into()));
    }
    if !problems.is_empty() {
        return empty(problems);
    }
    for i in (0..base.len()).rev() {
        let o = i as u8 + 1;
        if kept.contains(&o) {
            continue;
        }
        changes.push(Change {
            what: "preset",
            number: o as u16,
            kind: "deleted",
            name: base[i].name.clone(),
            fields: Vec::new(),
        });
        ops.push(Op {
            kind: "delete",
            what: "preset",
            number: o as u16,
            msg: msg::DELETE,
            payloads: vec![delete_payload(what::PRESET, i as u16)],
        });
    }
    let mut skip_writes = Vec::new();
    for (i, (v, p)) in want.iter().zip(&wp).enumerate() {
        let old = v.origin.map(|o| (o, &bp[o as usize - 1], &base[o as usize - 1]));
        // The list the radio holds with this preset once the records are written: a kept one's, a new one's none.
        let held: &[u32] = old.map_or(&[], |(_, _, ov)| &ov.skips);
        let skip_field = (v.skips != held).then(|| {
            skip_writes.push((i as u16, crate::lists::preset_skips_record(&v.skips)));
            Field { field: "skipped".into(), from: skips_text(held), to: skips_text(&v.skips) }
        });
        if let Some((o, op, ov)) = old {
            if op == p && o as usize == i + 1 && skip_field.is_none() {
                continue;
            }
            let mut fs = fields(&shown(&PresetView::of(0, op)), &shown(&PresetView::of(0, p)));
            fs.extend(skip_field);
            if !fs.is_empty() {
                changes.push(Change {
                    what: "preset",
                    number: v.number as u16,
                    kind: "changed",
                    name: v.name.clone(),
                    fields: fs,
                });
            } else if op != p {
                changes.push(Change {
                    what: "preset",
                    number: v.number as u16,
                    kind: "changed",
                    name: ov.name.clone(),
                    fields: Vec::new(),
                });
            }
            if op == p {
                continue; // only moved down by a deletion: the radio already holds it there
            }
        } else {
            changes.push(Change {
                what: "preset",
                number: v.number as u16,
                kind: "added",
                name: v.name.clone(),
                fields: skip_field.into_iter().collect(),
            });
        }
        ops.push(Op {
            kind: "write",
            what: "preset",
            number: v.number as u16,
            msg: msg::WRITE,
            payloads: write_payloads(what::PRESET, i as u16, &preset_record(p)),
        });
    }
    let held: Vec<Vec<u32>> = base.iter().map(|v| v.skips.clone()).collect();
    problems.extend(dry_run(&bp, &held, &ops, &wp, &skip_writes));
    Plan { changes, begin: begin_payload(ops.len() as u16), ops, problems, skips: skip_writes }
}

/// The ops through ferrite's own radio side seeded with the radio's presets (and their skip lists, `held`): every
/// refusal in ferrite's words, then whether it ends up holding what the table wants. A preset `WRITE` goes as a
/// one-record `WRITE_MANY`, as Console sends them; the skip lists after the session.
fn dry_run(
    base: &[RangePreset],
    held: &[Vec<u32>],
    ops: &[Op],
    want: &[RangePreset],
    skips: &[(u16, Vec<u8>)],
) -> Vec<Problem> {
    let mut r = RadioSide::new();
    r.seed_presets(base);
    for (i, l) in held.iter().enumerate().filter(|(_, l)| !l.is_empty()) {
        r.write_one(what::PRESET_SKIPS, i as u16, &crate::lists::preset_skips_record(l));
    }
    let mut out = Vec::new();
    let (s, rest) = r.ask(msg::BEGIN, &begin_payload(ops.len() as u16));
    if s != 0 {
        out.push(Problem { what: "set".into(), number: 0, error: status_text(s, &rest) });
    }
    for op in ops {
        let p = &op.payloads[0];
        let (s, rest) = if op.msg == msg::WRITE {
            r.write_one(what::PRESET, u16::from_le_bytes([p[1], p[2]]), &p[7..])
        } else {
            r.ask(op.msg, p)
        };
        if s != 0 {
            out.push(problem(op.number as u8, reason(s, &rest)));
            break;
        }
    }
    r.ask(msg::END, &[]);
    for (i, rec) in skips {
        if !out.is_empty() {
            break;
        }
        let (s, rest) = r.write_one(what::PRESET_SKIPS, *i, rec);
        if s != 0 {
            out.push(problem(*i as u8 + 1, format!("skipped frequencies: {}", reason(s, &rest))));
        }
    }
    if out.is_empty() {
        let got: Vec<RangePreset> = r.store.presets.borrow().iter().map(|p| RangePreset { skips: 0, ..*p }).collect();
        let want: Vec<RangePreset> = want.iter().map(|p| RangePreset { skips: 0, ..*p }).collect();
        if got != want {
            out.push(problem(0, "the radio would not end up with the presets as the table has them".into()));
        }
    }
    out
}

/// The presets part (`.ferrite`'s presets.json): the records as the radio's bytes (hex), the views beside them for
/// reading. A restore reads the records only.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub saved: String,
    #[serde(default)]
    pub radio: BTreeMap<String, String>,
    pub presets: Vec<BackupPreset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupPreset {
    pub number: u8,
    pub name: String,
    pub low: String,
    pub high: String,
    pub step: String,
    pub mode: String,
    pub resume: String,
    /// The record as the link carries it, hex.
    pub record: String,
    /// Its skipped frequencies (SCAN-10, LINK-58), MHz; left out when none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skips: Vec<String>,
}

/// The presets as presets.json's text, or the first one that doesn't parse.
pub fn backup(list: &[PresetView], saved: &str, radio: BTreeMap<String, String>) -> Result<String, Problem> {
    let mut presets = Vec::new();
    for (i, v) in list.iter().enumerate() {
        let p = v.preset().map_err(|e| problem(v.number, e))?;
        let n = PresetView::of(i as u8, &p);
        presets.push(BackupPreset {
            number: n.number,
            name: n.name,
            low: n.low,
            high: n.high,
            step: n.step,
            mode: n.mode,
            resume: n.resume,
            record: hex(&preset_record(&p)),
            skips: v.skips.iter().map(|&f| mhz_text(f)).collect(),
        });
    }
    let b = Backup { format: BACKUP_FORMAT.into(), version: 1, saved: saved.into(), radio, presets };
    Ok(serde_json::to_string_pretty(&b).unwrap_or_default())
}

/// presets.json back to presets (from the records; numbered in order, none read from a radio) and the file, or why
/// not.
pub fn restore(text: &str) -> Result<(Vec<PresetView>, Backup), String> {
    let b: Backup = serde_json::from_str(text).map_err(|e| format!("not a presets file: {e}"))?;
    if b.format != BACKUP_FORMAT {
        return Err(format!("not a presets file (format {:?})", b.format));
    }
    if b.version != 1 {
        return Err(format!("presets version {} is newer than this Console reads", b.version));
    }
    if b.presets.len() > MAX_PRESETS {
        return Err(format!("{} range presets: the radio keeps {MAX_PRESETS}", b.presets.len()));
    }
    let mut out = Vec::new();
    for (i, x) in b.presets.iter().enumerate() {
        let rec = unhex(&x.record).ok_or_else(|| format!("preset {}: its record isn't hex", i + 1))?;
        let p = preset_from_record(&rec).ok_or_else(|| format!("preset {}: its record didn't parse", i + 1))?;
        let mut v = PresetView::of(i as u8, &p);
        v.origin = None;
        v.skips = x
            .skips
            .iter()
            .map(|t| parse_mhz(t).ok_or_else(|| format!("preset {}: skipped frequency {t:?} isn't MHz", i + 1)))
            .collect::<Result<_, _>>()?;
        out.push(v);
    }
    Ok((out, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// More records than the radio keeps (a damaged chip's count, found by fuzz::radio): read without an overflow
    /// past 255, each one parsed or named.
    #[test]
    fn many_records_read() {
        let rec = preset_record(&PresetView::new(1, "x").preset().unwrap());
        let (ps, bad) = from_records(&vec![rec; 300]);
        assert_eq!((ps.len(), bad.len()), (300, 0));
        assert_eq!(ps[299].number, 255);
    }

    fn v(n: u8, name: &str, low: &str, high: &str) -> PresetView {
        PresetView {
            number: n,
            name: name.into(),
            low: low.into(),
            high: high.into(),
            origin: Some(n),
            ..PresetView::new(n, name)
        }
    }

    /// The record is ferrite's own: what the radio side stores from it reads back the same through `READ_MANY`.
    #[test]
    fn record_round_trip_through_the_radio() {
        let p = v(1, "Airband", "118", "137").preset().unwrap();
        let mut r = RadioSide::new();
        let (s, why) = r.write_one(what::PRESET, 0, &preset_record(&p));
        assert_eq!(s, 0, "{why:?}");
        let back = r.read_one(what::PRESET, 0).unwrap();
        assert_eq!(back, preset_record(&p));
        assert!(preset_from_record(&back) == Some(p));
    }

    /// The radio's checks: the range, its order, SCAN-14's relay edges, the name; the words as the radio's.
    #[test]
    fn checks_are_the_radios() {
        assert_eq!(check(&v(1, "2 m", "144", "148")), None);
        assert!(check(&v(1, "x", "148", "144")).unwrap().contains("end above start"));
        assert!(check(&v(1, "x", "10", "14")).unwrap().contains("18 to 1300"));
        assert_eq!(check(&v(1, "x", "50", "70")).unwrap(), "can't span 64 MHz: one side only");
        assert!(check(&v(1, "Thirteen char", "144", "148")).unwrap().starts_with("name:"));
        assert!(check(&PresetView { step: "3 kHz".into(), ..v(1, "x", "144", "148") }).unwrap().starts_with("step:"));
        let n =
            PresetView { mode: "am".into(), resume: "after 5 s".into(), ..v(1, "x", "118", "137.0") }.normal().unwrap();
        assert_eq!((n.mode.as_str(), n.resume.as_str(), n.high.as_str()), ("AM", "After 5 s", "137.00000"));
        // NAM (narrow AM, ferrite decision 447): offered, stored as 7 with the narrow filter, read back by name.
        assert_eq!(mode_words(), ["FM", "NFM", "AM", "NAM"]);
        assert_eq!(choices()["modes"], serde_json::json!(["FM", "NFM", "AM", "NAM"]));
        let p = PresetView { mode: "nam".into(), ..v(1, "Air", "118", "137") }.preset().unwrap();
        assert_eq!((p.mode, p.narrow), (ferrite_app::slot::NAM, true));
        assert_eq!(PresetView::of(0, &p).mode, "NAM");
        let p = PresetView { mode: "AM".into(), ..v(1, "Air", "118", "137") }.preset().unwrap();
        assert_eq!((p.mode, p.narrow), (2, false));
        assert!(check(&PresetView { mode: "WFM".into(), ..v(1, "x", "88", "108") }).unwrap().starts_with("mode:"));
        assert_eq!(resume_words().first().map(String::as_str), Some("Global"));
        assert_eq!(resume_words().last().map(String::as_str), Some("Stop on hit"));
    }

    /// A deletion goes first and a kept preset is never moved to another's index (its skips stay with it); new
    /// ones go after; the dry run agrees.
    #[test]
    fn plan_deletes_first_and_keeps_skips_with_their_preset() {
        let base = vec![v(1, "2 m", "144", "148"), v(2, "70 cm", "430", "450"), v(3, "Air", "118", "137")];
        let mut want = vec![base[0].clone(), PresetView { number: 2, ..base[2].clone() }, PresetView::new(3, "Marine")];
        want[2].low = "156".into();
        want[2].high = "162.025".into();
        let p = plan(&base, &want);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        let kinds: Vec<_> = p.ops.iter().map(|o| (o.kind, o.number)).collect();
        assert_eq!(kinds, [("delete", 2), ("write", 3)], "Air only moved down: not rewritten");
        assert_eq!(p.changes.iter().map(|c| c.kind).collect::<Vec<_>>(), ["deleted", "added"]);
        // An edit to a kept one: written at its index, the diff naming the field.
        let mut want = base.clone();
        want[1].high = "440".into();
        let p = plan(&base, &want);
        assert_eq!(p.ops.len(), 1);
        assert_eq!(
            p.changes[0].fields,
            [Field { field: "high".into(), from: "450.00000".into(), to: "440.00000".into() }]
        );
        // Refused as the radio refuses: a range across 64 MHz.
        let mut bad = base.clone();
        bad[0].low = "50".into();
        bad[0].high = "70".into();
        assert!(plan(&base, &bad).problems[0].error.contains("64 MHz"));
        assert!(plan(&base, &base).ops.is_empty());
    }

    /// LINK-58: a kept preset's changed skip list is written after the records at its new index, the diff naming
    /// it; a new preset's list goes too; a moved-down preset with its list as held writes nothing; a frequency
    /// outside the range is refused as the radio refuses it.
    #[test]
    fn plan_writes_skip_lists_after_the_presets() {
        let mut base = vec![v(1, "2 m", "144", "148"), v(2, "70 cm", "430", "450"), v(3, "Air", "118", "137")];
        base[1].skips = vec![43_200_000, 44_600_000];
        base[2].skips = vec![12_150_000];
        // 2 m deleted: 70 cm (now 1) gets one more skip, Air (now 2) keeps its list; a new one with a skip.
        let mut want = vec![
            PresetView { number: 1, ..base[1].clone() },
            PresetView { number: 2, ..base[2].clone() },
            PresetView::new(3, "Marine"),
        ];
        want[0].skips.push(44_000_000);
        (want[2].low, want[2].high) = ("156".into(), "162.025".into());
        want[2].skips = vec![15_680_000];
        let p = plan(&base, &want);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.skips.iter().map(|s| s.0).collect::<Vec<_>>(), [0, 2]);
        assert_eq!(
            crate::lists::preset_skips_from_record(&p.skips[0].1),
            Some(vec![43_200_000, 44_600_000, 44_000_000])
        );
        let ch = p.changes.iter().find(|c| c.number == 1 && c.kind == "changed").unwrap();
        assert_eq!(
            ch.fields,
            [Field {
                field: "skipped".into(),
                from: "432.00000, 446.00000".into(),
                to: "432.00000, 446.00000, 440.00000".into()
            }]
        );
        assert_eq!(p.changes.iter().find(|c| c.kind == "added").unwrap().fields[0].to, "156.80000");
        // Outside its range: the radio's reason.
        let mut bad = base.clone();
        bad[0].skips = vec![14_000_000];
        assert!(plan(&base, &bad).problems[0].error.contains("skipped frequencies"));
        assert!(check(&bad[0]).unwrap().starts_with("skipped frequencies"));
        assert_eq!(check(&base[1]), None);
        assert!(plan(&base, &base).skips.is_empty() && plan(&base, &base).changes.is_empty());
        // In the backup, as MHz.
        let text = backup(&want, "2026-10-30T00:00:00Z", BTreeMap::new()).unwrap();
        assert!(text.contains("\"440.00000\""), "{text}");
        assert_eq!(
            restore(&text).unwrap().0.iter().map(|p| p.skips.clone()).collect::<Vec<_>>(),
            want.iter().map(|p| p.skips.clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn backup_round_trip() {
        let list = vec![
            v(1, "2 m", "144", "148"),
            PresetView { mode: "AM".into(), step: "25 kHz".into(), ..v(2, "Air", "118", "137") },
        ];
        let text = backup(&list, "2026-10-30T00:00:00Z", BTreeMap::new()).unwrap();
        let (back, b) = restore(&text).unwrap();
        assert_eq!(b.presets.len(), 2);
        let norm = |l: &[PresetView]| l.iter().map(|p| shown(&p.normal().unwrap())).collect::<Vec<_>>();
        assert_eq!(norm(&back), norm(&list));
        assert!(back.iter().all(|p| p.origin.is_none()));
        assert!(restore("{\"format\":\"x\"}").is_err());
    }
}
