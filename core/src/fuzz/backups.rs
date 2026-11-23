//! Backups and restores: the channel backup (and its version 1), the settings and APRS backups (and the APRS
//! record's older lengths), the presets part, the codeplug's settings part; then the files of whole-chip work: the
//! layout copy (`.frlb`), the stock flash backup's check and restore plan, `.ffw` update files and `.btf` images.
//! Each saved file reads back to what was saved; mutated, it never panics, and what a restore lets through is
//! either valid or refused by the plan that would write it; nothing ever aims at calibration or the update area.

use super::{aprs_default, guard, held_presets, held_set, mutate, mutate_text, seeds, timed, Rng};
use crate::aprs_settings;
use crate::plan::{self, Set};
use crate::presets::{self, PresetView};
use crate::radioside::RadioSide;
use crate::settings::{self, read_extras, record_len, record_of, settings_of, Extras};
use ferrite_app::settings::Settings;
use ferrite_core::layout::{CALIBRATION, UPDATE_AREA};
use std::collections::BTreeMap;

const SAVED: &str = "2026-11-23T20:00:00Z";

fn radio() -> BTreeMap<String, String> {
    BTreeMap::from([("firmware".into(), "0.9.6".into()), ("callsign".into(), "VA7IF".into())])
}

/// A channel backup reads back as the set it was saved from, positions and all.
#[test]
fn channel_backup_round_trip() {
    timed("channel_backup_round_trip", || {
        for seed in seeds(1000) {
            let mut rng = Rng::new(seed);
            let set = held_set(&mut rng, 6, 40);
            guard("channel_backup_round_trip", seed, &set, || {
                let text = plan::backup(&set, SAVED, radio()).expect("a held set backs up");
                let (back, _) = plan::restore(&text).expect("own backup");
                assert_eq!(back, set);
            });
        }
    });
}

/// A version 1 channel backup (a one-byte zone, 255 none; 40 bytes) reads as the version 2 set it stands for.
#[test]
fn channel_backup_version_1_upgrades() {
    timed("channel_backup_version_1_upgrades", || {
        for seed in seeds(600) {
            let mut rng = Rng::new(seed);
            let mut set = held_set(&mut rng, 6, 20);
            for c in &mut set.channels {
                c.pos = None; // version 1 had none
            }
            let text = plan::backup(&set, SAVED, radio()).unwrap();
            let mut b: serde_json::Value = serde_json::from_str(&text).unwrap();
            b["version"] = 1.into();
            for c in b["channels"].as_array_mut().unwrap() {
                let r = plan::unhex(c["record"].as_str().unwrap()).unwrap();
                let zone = u16::from_le_bytes([r[2], r[3]]);
                let mut v1 = r[..2].to_vec();
                v1.push(if zone == ferrite_app::chan::NO_ZONE { 0xFF } else { zone as u8 });
                v1.extend_from_slice(&r[4..]);
                if rng.chance(30) {
                    v1.pop(); // 39 bytes: a writer from before the end tone byte
                }
                c["record"] = plan::hex(&v1).into();
            }
            let v1 = serde_json::to_string(&b).unwrap();
            guard("channel_backup_version_1_upgrades", seed, &v1, || {
                let (back, _) = plan::restore(&v1).expect("a version 1 file");
                assert_eq!(back.zones, set.zones);
                // a 39-byte record's end tone and tail are Global, as a radio from then had them
                for (a, b) in back.channels.iter().zip(&set.channels) {
                    assert_eq!(
                        crate::channels::ChanView { end_tone: b.end_tone.clone(), tail: b.tail.clone(), ..a.clone() },
                        *b
                    );
                }
                assert_eq!(back.channels.len(), set.channels.len());
            });
        }
    });
}

/// Mutated channel backups: never a panic; a refusal says why; what reads is checked by the plan that would write
/// it (its dry run on ferrite's link session), never sent unchecked.
#[test]
fn channel_backup_mutated() {
    let mut rng = Rng::new(0);
    let mut texts: Vec<String> =
        (0..4).map(|_| plan::backup(&held_set(&mut rng, 4, 12), SAVED, radio()).unwrap()).collect();
    // the codeplug's documented parts, version 2 and version 1
    texts.push(include_str!("../../tests/fixtures/codeplug/channels.json").into());
    texts.push(include_str!("../../tests/fixtures/codeplug-v1/channels.json").into());
    timed("channel_backup_mutated", || {
        for seed in seeds(3000) {
            let mut rng = Rng::new(seed);
            let src = &texts[rng.below(texts.len())];
            let text = if rng.chance(50) { mutate_text(&mut rng, src) } else { json_mutant(&mut rng, src) };
            guard("channel_backup_mutated", seed, &text, || match plan::restore(&text) {
                Err(e) => assert!(!e.is_empty()),
                Ok((set, _)) => {
                    let p = plan::plan(&Set::default(), &set);
                    if p.problems.is_empty() {
                        for c in &set.channels {
                            assert!(c.channel().is_ok(), "{c:?}");
                        }
                    }
                }
            });
        }
    });
}

/// A JSON file's values changed where they are (numbers, strings, arrays), the structure kept: what a hand-edited
/// or half-written file looks like.
pub fn json_mutant(rng: &mut Rng, text: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) else { return text.to_string() };
    for _ in 0..1 + rng.below(4) {
        poke(rng, &mut v, 0);
    }
    serde_json::to_string(&v).unwrap()
}

fn poke(rng: &mut Rng, v: &mut serde_json::Value, depth: usize) {
    use serde_json::Value as V;
    match v {
        V::Object(m) if !m.is_empty() && (depth == 0 || rng.chance(80)) => {
            let k = m.keys().nth(rng.below(m.len())).unwrap().clone();
            if rng.chance(8) {
                m.remove(&k);
            } else {
                poke(rng, m.get_mut(&k).unwrap(), depth + 1);
            }
        }
        V::Array(a) if !a.is_empty() && rng.chance(85) => {
            let i = rng.below(a.len());
            match rng.below(10) {
                0 => {
                    a.remove(i);
                }
                1 => {
                    let x = a[i].clone();
                    a.insert(i, x);
                }
                _ => poke(rng, &mut a[i], depth + 1),
            }
        }
        V::String(s) => {
            *s = match rng.below(6) {
                0 => String::new(),
                1 if !s.is_empty() => {
                    let mut t = s.clone();
                    t.pop();
                    t
                }
                2 => format!("{s}0"),
                3 => s.to_ascii_uppercase(),
                4 => mutate_text(rng, s),
                _ => format!("{s}{s}"),
            }
        }
        V::Number(_) => {
            *v = match rng.below(6) {
                0 => V::from(0),
                1 => V::from(-1),
                2 => V::from(u16::MAX),
                3 => V::from(u64::MAX),
                4 => V::from(1.5),
                _ => V::from(rng.below(5000)),
            }
        }
        _ => {
            *v = match rng.below(5) {
                0 => V::Null,
                1 => V::from(true),
                2 => V::from("x"),
                3 => V::Array(Vec::new()),
                _ => V::from(7),
            }
        }
    }
}

/// A default radio's terminal-backed values (the settings no record carries), as Console reads them.
fn extras() -> Extras {
    read_extras(&mut RadioSide::new())
}

/// A settings record a radio could hold: the defaults with some fields changed, then as the link reads it.
fn settings_record(rng: &mut Rng) -> Vec<u8> {
    let mut s = Settings::DEFAULT;
    if rng.chance(50) {
        s.set_callsign(rng.pick(&[&b"n0call"[..], b"VA7IF", b"ve7abc-9"]));
    }
    s.theme = rng.below(4) as u8;
    s.key_beep = rng.chance(50);
    s.mic_gain = rng.below(10) as u8;
    s.home_ch = rng.chance(40).then(|| rng.below(4000) as u16);
    s.pin_len = if rng.chance(30) { 4 } else { 0 };
    s.pin = rng.below(10_000) as u32;
    let mut rec = record_of(&s);
    // and a few bytes as anything: the record is what the radio sends, Console's own knowing aside
    for _ in 0..rng.below(3) {
        let i = rng.below(rec.len());
        rec[i] = rng.byte();
    }
    rec
}

/// A settings backup reads back as its record and its terminal-backed values (MENU 0 5's are the APRS backup's);
/// the codeplug part as the record without the PIN lock, which opening it over a radio's record puts back.
#[test]
fn settings_backup_round_trip() {
    let ex = extras();
    timed("settings_backup_round_trip", || {
        for seed in seeds(6) {
            let mut rng = Rng::new(seed);
            let rec = settings_record(&mut rng);
            guard("settings_backup_round_trip", seed, &rec, || {
                let (back, b) = settings::restore(&settings::backup(&rec, &ex, SAVED, radio())).expect("own backup");
                assert_eq!(back, rec);
                let own: Extras =
                    ex.iter().filter(|(k, _)| !k.starts_with("0 5 ")).map(|(k, v)| (k.clone(), v.clone())).collect();
                assert_eq!(b.extras, own);
                let (cp, _) = settings::restore(&settings::codeplug_part(&rec, &ex, SAVED, radio())).expect("own part");
                assert_eq!(cp, settings::without_pin(&rec));
                let mine = record_of(&Settings { pin: 1234, pin_len: 4, ..Settings::DEFAULT });
                let opened = settings::keep_pin(&cp, &mine);
                let (o, m) = (settings_of(&opened), settings_of(&mine));
                assert_eq!((o.pin_mode, o.pin, o.pin_len, o.chan_only), (m.pin_mode, m.pin, m.pin_len, m.chan_only));
            });
        }
    });
}

/// Mutated settings backups: never a panic; a record of a length this Console doesn't know is refused by the plan.
#[test]
fn settings_backup_mutated() {
    let ex = extras();
    let mut rng = Rng::new(0);
    let texts: Vec<String> =
        (0..3).map(|_| settings::backup(&settings_record(&mut rng), &ex, SAVED, radio())).collect();
    let base = record_of(&Settings::DEFAULT);
    timed("settings_backup_mutated", || {
        for seed in seeds(400) {
            let mut rng = Rng::new(seed);
            let src = &texts[rng.below(texts.len())];
            let text = if rng.chance(50) { mutate_text(&mut rng, src) } else { json_mutant(&mut rng, src) };
            guard("settings_backup_mutated", seed, &text, || match settings::restore(&text) {
                Err(e) => assert!(!e.is_empty()),
                Ok((rec, b)) if rec.len() != record_len() => {
                    let p = settings::plan(&base, &ex, &rec, &b.extras);
                    assert!(p.ops.is_empty() && !p.problems.is_empty(), "{p:?}");
                }
                Ok(_) => {}
            });
        }
    });
}

/// An APRS backup reads back as its record; one from an older Console (the record ending before auto reply, the
/// text rate or message retries) reads as the whole record with those at their defaults.
#[test]
fn aprs_backup_round_trip_and_older_lengths() {
    let ex = extras();
    let dflt = aprs_default();
    assert_eq!(dflt.len(), aprs_settings::RECORD_LEN);
    timed("aprs_backup_round_trip_and_older_lengths", || {
        for seed in seeds(15) {
            let mut rng = Rng::new(seed);
            let mut rec = dflt.clone();
            for _ in 0..rng.below(4) {
                let i = rng.below(rec.len());
                rec[i] = rng.byte();
            }
            guard("aprs_backup_round_trip_and_older_lengths", seed, &rec, || {
                let text = aprs_settings::backup(&[], &rec, &ex, SAVED, radio());
                let (back, _) = aprs_settings::restore(&text).expect("own backup");
                assert_eq!(back, rec);
                use ferrite_app::link::{APRS_REPLY_AT, APRS_RETRIES_AT, APRS_TEXT_AT};
                for cut in [APRS_REPLY_AT, APRS_TEXT_AT, APRS_RETRIES_AT] {
                    let old = text.replace(&plan::hex(&rec), &plan::hex(&rec[..cut]));
                    let (back, _) = aprs_settings::restore(&old).expect("an older backup");
                    assert_eq!(back.len(), aprs_settings::RECORD_LEN, "cut at {cut}");
                    assert_eq!(back[..cut], rec[..cut], "cut at {cut}");
                    assert_eq!(back[cut..], dflt[cut..], "cut at {cut}: the defaults past it");
                }
            });
        }
    });
}

/// Mutated APRS backups: never a panic; a record of a length this Console doesn't know is refused by the plan.
#[test]
fn aprs_backup_mutated() {
    let ex = extras();
    let dflt = aprs_default();
    let texts = [
        aprs_settings::backup(&[], &dflt, &ex, SAVED, radio()),
        include_str!("../../tests/fixtures/codeplug/aprs.json").into(),
    ];
    timed("aprs_backup_mutated", || {
        for seed in seeds(300) {
            let mut rng = Rng::new(seed);
            let text = &texts[rng.below(2)];
            let t = if rng.chance(50) { mutate_text(&mut rng, text) } else { json_mutant(&mut rng, text) };
            guard("aprs_backup_mutated", seed, &t, || match aprs_settings::restore(&t) {
                Err(e) => assert!(!e.is_empty()),
                Ok((rec, b)) if rec.len() != aprs_settings::RECORD_LEN => {
                    let p = aprs_settings::plan(&[], &dflt, &ex, &rec, &b.extras);
                    assert!(p.ops.is_empty() && !p.problems.is_empty(), "{p:?}");
                }
                Ok(_) => {}
            });
        }
    });
}

/// The presets part reads back as the presets saved; mutated, never a panic, and what it lets through is valid or
/// refused by the plan.
#[test]
fn presets_backup_round_trip_and_mutated() {
    timed("presets_backup_round_trip_and_mutated", || {
        for seed in seeds(800) {
            let mut rng = Rng::new(seed);
            let list = held_presets(&mut rng);
            let text = presets::backup(&list, SAVED, radio()).expect("held presets");
            let (back, _) = presets::restore(&text).expect("own backup");
            let want: Vec<PresetView> = list.iter().map(|v| PresetView { origin: None, ..v.clone() }).collect();
            assert_eq!(back, want, "seed {seed}");
            let text = if rng.chance(20) {
                include_str!("../../tests/fixtures/codeplug/presets.json").to_string()
            } else {
                text
            };
            let t = if rng.chance(50) { mutate_text(&mut rng, &text) } else { json_mutant(&mut rng, &text) };
            guard("presets_backup_mutated", seed, &t, || match presets::restore(&t) {
                Err(e) => assert!(!e.is_empty()),
                Ok((vs, _)) => {
                    let p = presets::plan(&[], &vs);
                    if p.problems.is_empty() {
                        assert!(vs.iter().all(|v| v.preset().is_ok()));
                    }
                }
            });
        }
    });
}

/// Whether an address range touches calibration or the update area (never written: CLAUDE.md, BACKUP-7, UPD-24).
fn forbidden(addr: u32, len: u32) -> bool {
    let end = addr as u64 + len.max(1) as u64;
    [CALIBRATION, UPDATE_AREA].iter().any(|r| (addr as u64) < r.end as u64 && end > r.start as u64)
}

/// The layout copy (`.frlb`): a file reads back as the copy; mutated, it never panics and anything that still reads
/// translates or refuses with a reason, and its write plan never aims at calibration or the update area.
#[test]
fn layout_copy_file() {
    use crate::migrate::{translate, write_plan, Copy, V2_REGIONS};
    timed("layout_copy_file", || {
        for seed in seeds(12) {
            let mut rng = Rng::new(seed);
            let keep: Vec<(u32, u32)> = V2_REGIONS.iter().copied().filter(|_| rng.chance(80)).collect();
            let regions = keep
                .into_iter()
                .map(|(s, n)| {
                    let n = if rng.chance(50) { n as usize } else { rng.below(4096) };
                    let mut b = vec![0xFF; n];
                    for _ in 0..rng.below(64) {
                        if n > 0 {
                            let i = rng.below(n);
                            b[i] = rng.byte();
                        }
                    }
                    (s, b)
                })
                .collect();
            let copy = Copy { layout: 2, uid: rng.chance(50).then_some([7; 12]), regions };
            let f = copy.to_file();
            assert_eq!(Copy::from_file(&f).as_ref(), Ok(&copy), "seed {seed}");
            let mut g = f.clone();
            mutate(&mut rng, &mut g);
            guard("layout_copy_file", seed, &g, || {
                for c in [Copy::from_file(&g).ok(), Some(copy.clone())].into_iter().flatten() {
                    if let Ok(t) = translate(&c) {
                        for s in write_plan(&t) {
                            assert!(!forbidden(s.addr, s.len.max(1)), "{s:?}");
                        }
                    }
                }
            });
        }
    });
}

/// The stock flash backup: any file is checked without a panic; a restore plan, whatever the backup and whatever
/// ranges the radio's `START` names, never erases or programs calibration or the update area.
#[test]
fn stock_backup_and_restore_plan() {
    use crate::install::{check_backup, parse_start, restore_plan, BackupId, RestoreStart};
    timed("stock_backup_and_restore_plan", || {
        for seed in seeds(10) {
            let mut rng = Rng::new(seed);
            let chip = [0x40_0000usize, 0x80_0000, 0x1000, 0][rng.below(4)];
            let mut b = vec![0xFF; if rng.chance(80) { chip } else { rng.below(0x2_0000) }];
            for _ in 0..rng.below(200) {
                if !b.is_empty() {
                    let i = rng.below(b.len());
                    b[i] = rng.byte();
                }
            }
            let mut ranges: Vec<(u32, u32)> = (0..rng.below(5))
                .map(|_| {
                    let a = rng.next() as u32 % 0x90_0000;
                    (a, a.saturating_add(rng.next() as u32 % 0x40_0000))
                })
                .collect();
            if rng.chance(50) {
                ranges.push((0, u32::MAX));
            }
            let mut start = vec![0u8];
            start.extend((b.len() as u32).to_le_bytes());
            let k = 4 + rng.below(40);
            start.extend(rng.bytes(k));
            guard("stock_backup_and_restore_plan", seed, &(b.len(), &ranges), || {
                let _ = check_backup(&b);
                let _ = parse_start(&start);
                let _ = parse_start(&start[1..]);
                let cal =
                    crate::firmware::crc32(b.get(CALIBRATION.start as usize..CALIBRATION.end as usize).unwrap_or(&[]));
                let rs = RestoreStart {
                    chip: b.len() as u32,
                    cal_crc32: cal,
                    ranges: ranges.clone(),
                    uid: Some("A".into()),
                };
                let p = restore_plan(&b, &rs, &BackupId { uid: Some("A".into()), confirmed: None });
                for op in &p.ops {
                    assert!(!forbidden(op.addr, op.len), "{op:?}");
                }
            });
        }
    });
}

/// `.ffw` update files: mutated bytes, and manifests changed then zipped again (unsigned, the developer option):
/// never a panic, and any file that reads has a write plan that never aims at calibration or the update area.
#[test]
fn ffw_files() {
    use crate::ffw::{read_with, unzip, write_plan, zip};
    const GOOD: &[u8] = include_bytes!("../../tests/fixtures/ffw/good.ffw");
    const PUB: &str = include_str!("../../tests/fixtures/ffw/test.pub");
    let key = PUB.lines().nth(1).unwrap();
    let entries = unzip(GOOD).unwrap();
    timed("ffw_files", || {
        for seed in seeds(1500) {
            let mut rng = Rng::new(seed);
            let file = if rng.chance(40) {
                let mut g = GOOD.to_vec();
                mutate(&mut rng, &mut g);
                g
            } else {
                let mut e = entries.clone();
                e.retain(|x| x.0 != "manifest.minisig" || rng.chance(20));
                let m = String::from_utf8_lossy(&e[0].1).into_owned();
                e[0].1 = super::backups::json_mutant(&mut rng, &m).into_bytes();
                let v: Vec<(&str, &[u8])> = e.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
                zip(&v)
            };
            guard("ffw_files", seed, &file, || {
                for dev in [false, true] {
                    if let Ok(f) = read_with(key, &file, dev) {
                        let steps = write_plan(&f.parts).expect("a file that reads plans");
                        for s in steps.iter().filter(|s| s.kind != "stamp" && s.kind != "part") {
                            assert!(!forbidden(s.addr, s.len.max(1)), "{s:?}");
                        }
                    }
                }
            });
        }
    });
}

/// `.btf` images: packed then damaged, or random: the checks never panic, and an update is planned only from a
/// file whose check found no problems.
#[test]
fn btf_images() {
    use crate::firmware::{check_file, pack, unpack, Update};
    timed("btf_images", || {
        for seed in seeds(100) {
            let mut rng = Rng::new(seed);
            let n = [0usize, 1, 0x400, 0x800, 0x3000, 0x1_0000][rng.below(6)] + rng.below(0x400);
            let mut img = rng.bytes(n);
            if img.len() > crate::firmware::MODEL_OFF + 12 && rng.chance(70) {
                let at = crate::firmware::MODEL_OFF;
                img[at..at + 12].copy_from_slice(crate::firmware::MODEL_TAG);
            }
            let mut btf = pack(&img);
            if rng.chance(70) {
                mutate(&mut rng, &mut btf);
            }
            guard("btf_images", seed, &btf.len(), || {
                let c = check_file(&btf);
                let _ = unpack(&btf);
                if let Ok(u) = Update::new(&btf) {
                    let _ = (u.blocks(), u.steps());
                    for i in 0..u.steps().min(8) {
                        let _ = (u.step(i), u.frame(i));
                    }
                    let _ = c;
                }
            });
        }
    });
}
