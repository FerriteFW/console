//! Plans and diffs: random edits through the editors' own calls (`set`, the table's views), then `plan`; every plan
//! with no problems is sent as Console sends it to ferrite's own link session seeded with the base, and what the
//! radio then holds is what was wanted. A plan never carries a request the radio refuses.

use super::{guard, held_channel, held_set, held_zone, seeds, timed, Rng};
use crate::aprs_settings;
use crate::channels::{ChanView, Position, ZoneView, MAX_CHANNELS};
use crate::plan::{self, Op, Set};
use crate::presets::{self, PresetView};
use crate::radioside::RadioSide;
use crate::records::Reader;
use crate::settings::{self, read_extras, record_of, settings_of, Extras};
use ferrite_app::chan::ChannelStore;
use ferrite_app::settings::Settings;
use ferrite_core::link::{msg, what};

/// The ops as Console's `writeSession` sends them (src/lib/link.ts): `BEGIN`; a whole channel, zone or preset
/// record as `WRITE_MANY` (LINK-41), a channel delete as `WRITE_MANY` of length 0 (LINK-41.2), the rest as their
/// own requests; `END`. Every one must be taken.
fn send(r: &mut RadioSide, begin: &[u8], ops: &[Op]) {
    let (s, rest) = r.ask(msg::BEGIN, begin);
    assert_eq!(s, 0, "BEGIN: {}", crate::answers::status_text(s, &rest));
    for op in ops {
        for p in &op.payloads {
            let whole = op.kind == "write"
                && op.msg == msg::WRITE
                && op.payloads.len() == 1
                && [what::CHANNEL, what::ZONE, what::PRESET].contains(&p[0])
                && p[3..5] == [0, 0]
                && u16::from_le_bytes([p[5], p[6]]) as usize == p.len() - 7
                && p.len() - 7 <= 255;
            let (s, rest) = if whole {
                let mut b = vec![p[0], p[1], p[2], (p.len() - 7) as u8];
                b.extend_from_slice(&p[7..]);
                r.ask(msg::WRITE_MANY, &b)
            } else if op.msg == msg::DELETE && op.payloads.len() == 1 && p[0] == what::CHANNEL {
                r.ask(msg::WRITE_MANY, &[p[0], p[1], p[2], 0])
            } else {
                r.ask(op.msg, p)
            };
            assert_eq!(s, 0, "{} {} {}: {}", op.kind, op.what, op.number, crate::answers::status_text(s, &rest));
        }
    }
    assert_eq!(r.ask(msg::END, &[]).0, 0);
}

fn read(r: &mut RadioSide, w: u8) -> Vec<u8> {
    let mut rd = Reader::new(w, 0);
    while !rd.done() {
        let (s, rest) = r.ask(msg::READ, &rd.next_payload());
        assert_eq!(s, 0);
        assert!(rd.take(&rest));
    }
    rd.record
}

/// A table after random edits: channels changed, added, deleted, moved between zones; zones added, deleted,
/// renamed, their scan settings changed; now and then something the radio refuses (a zone that isn't there, a
/// zone out of order).
fn edited(rng: &mut Rng, base: &Set) -> Set {
    let mut w = base.clone();
    for _ in 0..1 + rng.below(6) {
        let nz = w.zones.len() as u16;
        match rng.below(12) {
            0 | 1 if !w.channels.is_empty() => {
                let i = rng.below(w.channels.len());
                let n = w.channels[i].number;
                w.channels[i] = held_channel(rng, n, nz);
            }
            2 if !w.channels.is_empty() => {
                w.channels.remove(rng.below(w.channels.len()));
            }
            3 | 4 => {
                let n = 1 + rng.below(MAX_CHANNELS as usize) as u16;
                if !w.channels.iter().any(|c| c.number == n) {
                    w.channels.push(held_channel(rng, n, nz));
                }
            }
            5 if !w.channels.is_empty() => {
                let i = rng.below(w.channels.len());
                w.channels[i].zone = (nz > 0 && rng.chance(70)).then(|| rng.below(nz as usize) as u16);
            }
            6 if !w.channels.is_empty() => {
                let i = rng.below(w.channels.len());
                w.channels[i].pos = if rng.chance(30) { None } else { Position::from_degrees(49.28, -123.12) };
            }
            7 => w.zones.push(held_zone(rng, nz)),
            8 if nz > 0 => {
                // the last zone deleted, its channels to no zone (or left pointing at it: refused)
                w.zones.pop();
                if rng.chance(90) {
                    for c in &mut w.channels {
                        if c.zone == Some(nz - 1) {
                            c.zone = None;
                        }
                    }
                }
            }
            9 if nz > 0 => {
                let i = rng.below(nz as usize);
                let mut z = held_zone(rng, i as u16);
                z.name = rng.pick(&["Renamed", "", "a very long zone name", "Ça"]).to_string();
                w.zones[i] = z;
            }
            10 if nz > 1 && rng.chance(20) => {
                w.zones.swap(0, 1); // numbered out of order
            }
            _ if nz > 0 => {
                let i = rng.below(nz as usize);
                w.zones[i] = held_zone(rng, i as u16);
            }
            _ => {}
        }
    }
    w.channels.sort_by_key(|c| c.number);
    w
}

/// Random table edits, planned: a plan without problems, sent to the radio, leaves it holding the table; the
/// positions it lists are those that changed.
#[test]
fn channel_plans_apply() {
    let mut clean = 0;
    timed("channel_plans_apply", || {
        for seed in seeds(600) {
            let mut rng = Rng::new(seed);
            let base = held_set(&mut rng, 5, 30);
            let want = edited(&mut rng, &base);
            guard("channel_plans_apply", seed, &(&base, &want), || {
                let p = plan::plan(&base, &want);
                let mut moved: Vec<u16> = want
                    .channels
                    .iter()
                    .filter(|c| base.channels.iter().find(|b| b.number == c.number).and_then(|b| b.pos) != c.pos)
                    .map(|c| c.number)
                    .collect();
                moved.sort();
                if !p.problems.is_empty() {
                    return;
                }
                clean += 1;
                let mut got = p.positions.clone();
                got.sort();
                assert_eq!(got, moved, "positions");
                let (bz, bc) = base.parts().unwrap();
                let (wz, wc) = want.parts().unwrap();
                let mut r = RadioSide::new();
                r.seed(&bz, &bc);
                send(&mut r, &p.begin, &p.ops);
                let zones = r.store.zones.borrow().clone();
                assert_eq!(zones.len(), wz.len());
                for ((an, ac), (bn, bc)) in zones.iter().zip(&wz) {
                    assert!(an.as_bytes() == bn.as_bytes() && ac == bc, "a zone differs");
                }
                for c in &wc {
                    assert_eq!(r.store.get(c.num).as_ref(), Some(c));
                }
                assert_eq!(r.store.count() as usize, wc.len());
                // and nothing more to do
                let (again, _) = Set::from_records(
                    &zones.iter().map(|(n, c)| crate::channels::zone_record(n.as_bytes(), c)).collect::<Vec<_>>(),
                    &wc.iter().map(crate::channels::channel_record).collect::<Vec<_>>(),
                );
                let strip = |s: &Set| Set {
                    channels: s.channels.iter().map(|c| ChanView { pos: None, ..c.clone() }).collect(),
                    ..s.clone()
                };
                assert!(plan::plan(&again, &strip(&want)).ops.is_empty());
            });
        }
    });
    assert!(clean > 150, "only {clean} plans without problems: the edits need work");
}

/// Many channels into one zone: the plan orders its writes so no zone passes 256 on the way (CHAN-35), or names
/// the zone that would.
#[test]
fn channel_plans_zone_cap() {
    timed("channel_plans_zone_cap", || {
        for seed in seeds(12) {
            let mut rng = Rng::new(seed);
            let zones: Vec<ZoneView> = (0..2).map(|i| ZoneView::new(i + 1, ["A", "B"][i as usize])).collect();
            let n = 200 + rng.below(120);
            let base = Set {
                zones: zones.clone(),
                channels: (0..n)
                    .map(|k| ChanView {
                        zone: Some((k % 2) as u16),
                        ..ChanView::new(1 + k as u16, 14_652_000 + 125 * k as u32)
                    })
                    .collect(),
            };
            let mut want = base.clone();
            for c in &mut want.channels {
                if rng.chance(60) {
                    c.zone = Some(1 - c.zone.unwrap());
                }
            }
            guard("channel_plans_zone_cap", seed, &n, || {
                let p = plan::plan(&base, &want);
                let over = crate::zonecap::over_cap(&want);
                assert_eq!(over.is_empty(), p.problems.is_empty(), "{:?}", p.problems);
                if p.problems.is_empty() {
                    let (bz, bc) = base.parts().unwrap();
                    let mut r = RadioSide::new();
                    r.seed(&bz, &bc);
                    send(&mut r, &p.begin, &p.ops);
                    for c in &want.parts().unwrap().1 {
                        assert_eq!(r.store.get(c.num).as_ref(), Some(c));
                    }
                }
            });
        }
    });
}

/// A default radio's terminal-backed values.
fn extras() -> Extras {
    read_extras(&mut RadioSide::new())
}

/// One random edit through `set`: an item with choices to another choice, or a text field to a value of its
/// hint's kind (or not). The new record and values, or None when the editor refused it.
fn settings_edit(rng: &mut Rng, rec: &[u8], ex: &Extras) -> Option<(Vec<u8>, Extras)> {
    let v = settings::view(rec, ex);
    let items: Vec<_> = v.groups.iter().flat_map(|g| &g.items).filter(|i| i.kind != settings::Kind::Readonly).collect();
    let i = items.get(rng.below(items.len()))?;
    let value = if i.choices.len() > 1 {
        i.choices[rng.below(i.choices.len())].clone()
    } else {
        rng.pick(&["VA7IF", "N0CALL-9", "", "12", "146.52", "Hello there", "x|y", "0", "999999"]).to_string()
    };
    settings::set(rec, ex, &i.id, &value).ok()
}

/// Settings: random edits through `set`, planned; a plan without problems, sent, leaves the radio holding the
/// record and the terminal-backed values wanted.
#[test]
fn settings_plans_apply() {
    let ex0 = extras();
    timed("settings_plans_apply", || {
        for seed in seeds(2) {
            let mut rng = Rng::new(seed);
            let base = record_of(&Settings::DEFAULT);
            let (mut want, mut wex) = (base.clone(), ex0.clone());
            for _ in 0..1 + rng.below(4) {
                if let Some((w, e)) = settings_edit(&mut rng, &want, &wex) {
                    (want, wex) = (w, e);
                }
            }
            guard("settings_plans_apply", seed, &(&want, &wex), || {
                let p = settings::plan(&base, &ex0, &want, &wex);
                if !p.problems.is_empty() {
                    return;
                }
                let mut r = RadioSide::new();
                *r.app.settings_mut() = settings_of(&base);
                send(&mut r, &p.begin, &p.ops);
                assert_eq!(read(&mut r, what::SETTINGS), want);
                let back = read_extras(&mut r);
                for (k, v) in wex.iter().filter(|(k, _)| !k.starts_with("0 5 ")) {
                    assert_eq!(back.get(k), Some(v), "{k}");
                }
            });
        }
    });
}

/// APRS settings the same way: the record and MENU 0 5's terminal-backed values (sent as `CMD` lines after the
/// write, as Console sends them).
#[test]
fn aprs_plans_apply() {
    let ex0 = extras();
    let srec = record_of(&Settings::DEFAULT);
    let base = super::aprs_default();
    timed("aprs_plans_apply", || {
        for seed in seeds(4) {
            let mut rng = Rng::new(seed);
            let (mut want, mut wex) = (base.clone(), ex0.clone());
            for _ in 0..1 + rng.below(4) {
                let v = aprs_settings::view(&srec, &want, &wex);
                let items: Vec<_> = v.items.iter().filter(|i| i.kind != settings::Kind::Readonly).collect();
                let Some(i) = items.get(rng.below(items.len())) else { continue };
                let value = if i.choices.len() > 1 {
                    i.choices[rng.below(i.choices.len())].clone()
                } else {
                    rng.pick(&["VE7*", "*", "N0CALL-9", "Back soon", "WIDE1-1", "", "x|y", "5"]).to_string()
                };
                if let Ok((w, e)) = aprs_settings::set(&srec, &want, &wex, &i.id, &value) {
                    (want, wex) = (w, e);
                }
            }
            guard("aprs_plans_apply", seed, &(&want, &wex), || {
                let p = aprs_settings::plan(&srec, &base, &ex0, &want, &wex);
                if !p.problems.is_empty() {
                    return;
                }
                let mut r = RadioSide::new();
                if !p.ops.is_empty() {
                    send(&mut r, &p.begin, &p.ops);
                }
                for c in &p.cmds {
                    let (s, rest) = r.ask(msg::CMD, c.as_bytes());
                    assert_eq!(s, 0, "{c}: {}", crate::answers::status_text(s, &rest));
                }
                assert_eq!(read(&mut r, what::APRS), want);
                let v = aprs_settings::view(&srec, &read(&mut r, what::APRS), &read_extras(&mut r));
                let w = aprs_settings::view(&srec, &want, &wex);
                assert_eq!(v.items, w.items, "the radio shows what was wanted");
            });
        }
    });
}

/// Range presets: random edits (changed, added, deleted, moved, skips), planned; a plan without problems, sent,
/// leaves the radio holding the list.
#[test]
fn preset_plans_apply() {
    let mut clean = 0;
    timed("preset_plans_apply", || {
        for seed in seeds(400) {
            let mut rng = Rng::new(seed);
            let base: Vec<PresetView> = super::held_presets(&mut rng)
                .into_iter()
                .enumerate()
                .map(|(i, v)| PresetView { origin: Some(i as u8 + 1), skips: Vec::new(), ..v })
                .collect();
            let mut want = base.clone();
            for _ in 0..1 + rng.below(4) {
                match rng.below(5) {
                    0 if !want.is_empty() => {
                        want.remove(rng.below(want.len()));
                    }
                    1 if want.len() < presets::MAX_PRESETS => {
                        let mut v = PresetView::new(want.len() as u8 + 1, "New");
                        v.low = rng.pick(&["430", "144", "17", "1299"]).into();
                        v.high = rng.pick(&["440", "148", "65", "1300.5"]).into();
                        want.push(v);
                    }
                    2 if !want.is_empty() => {
                        let i = rng.below(want.len());
                        want[i].name = rng.pick(&["x", "", "abcdefghijklm", "Ça"]).into();
                    }
                    3 if !want.is_empty() => {
                        let i = rng.below(want.len());
                        want[i].skips = (0..rng.below(4)).map(|k| 14_652_000 + 2500 * k as u32).collect();
                    }
                    _ if want.len() > 1 => {
                        let (a, b) = (rng.below(want.len()), rng.below(want.len()));
                        want.swap(a, b);
                    }
                    _ => {}
                }
            }
            for (i, v) in want.iter_mut().enumerate() {
                v.number = i as u8 + 1;
            }
            guard("preset_plans_apply", seed, &(&base, &want), || {
                let p = presets::plan(&base, &want);
                if !p.problems.is_empty() {
                    return;
                }
                clean += 1;
                let mut r = RadioSide::new();
                r.seed_presets(&base.iter().map(|v| v.preset().unwrap()).collect::<Vec<_>>());
                send(&mut r, &p.begin, &p.ops);
                for (i, rec) in &p.skips {
                    let mut b = vec![what::PRESET_SKIPS];
                    b.extend(i.to_le_bytes());
                    b.push(rec.len() as u8);
                    b.extend_from_slice(rec);
                    assert_eq!(r.ask(msg::WRITE_MANY, &b).0, 0);
                }
                let held = r.store.presets.borrow().clone();
                let got: Vec<PresetView> = held.iter().enumerate().map(|(i, p)| PresetView::of(i as u8, p)).collect();
                let norm: Vec<PresetView> = want
                    .iter()
                    .map(|v| PresetView { origin: Some(v.number), skips: Vec::new(), ..v.normal().unwrap() })
                    .collect();
                assert_eq!(got, norm);
                let skips = r.store.preset_skips.borrow().clone();
                for (k, v) in want.iter().enumerate() {
                    assert_eq!(skips[k], v.skips, "preset {}'s skips", k + 1);
                }
            });
        }
    });
    assert!(clean > 100, "only {clean} preset plans without problems");
}

/// Waypoints (LINK-55): the writes from any list to any other, applied to the radio, give the new list.
#[test]
fn waypoint_writes_apply() {
    use crate::lists::{waypoint_from_record, waypoint_writes, Waypoint, WAYPOINT_MAX};
    let wp = |rng: &mut Rng| Waypoint {
        name: rng.pick(&["Home", "Hill", "Car", "Camp", "Trailhead"]).into(),
        lat: rng.below(1_000_000) as i32 + 490_000_000,
        lon: -(rng.below(1_000_000) as i32) - 1_230_000_000,
        source: rng.pick(&["marked", "aprs", "link", "grid"]).into(),
    };
    timed("waypoint_writes_apply", || {
        for seed in seeds(1500) {
            let mut rng = Rng::new(seed);
            let old: Vec<Waypoint> = (0..rng.below(12)).map(|_| wp(&mut rng)).collect();
            let mut new = old.clone();
            for _ in 0..rng.below(5) {
                match rng.below(4) {
                    0 if !new.is_empty() => {
                        new.remove(rng.below(new.len()));
                    }
                    1 if new.len() < WAYPOINT_MAX as usize => new.insert(0, wp(&mut rng)),
                    2 if !new.is_empty() => {
                        let i = rng.below(new.len());
                        new[i] = wp(&mut rng);
                    }
                    _ => {}
                }
            }
            guard("waypoint_writes_apply", seed, &(&old, &new), || {
                let mut r = RadioSide::new();
                // the old list, oldest added first (each add is the newest), one to a frame
                for w in old.iter().rev() {
                    let rec = crate::lists::waypoint_record(Some(w));
                    let mut b = vec![what::WAYPOINT];
                    b.extend(crate::lists::WAYPOINT_ADD.to_le_bytes());
                    b.push(rec.len() as u8);
                    b.extend(rec);
                    assert_eq!(r.ask(msg::WRITE_MANY, &b).0, 0);
                }
                let writes = waypoint_writes(&old, &new);
                if old == new {
                    assert!(writes.is_empty());
                }
                for (i, rec) in writes {
                    let mut b = vec![what::WAYPOINT];
                    b.extend(i.to_le_bytes());
                    b.push(rec.len() as u8);
                    b.extend(rec);
                    let (s, rest) = r.ask(msg::WRITE_MANY, &b);
                    assert_eq!(s, 0, "write at {i}: {}", crate::answers::status_text(s, &rest));
                }
                let got: Vec<Waypoint> = (0..new.len() as u16 + 1)
                    .filter_map(|i| r.read_one(what::WAYPOINT, i).ok())
                    .filter_map(|x| waypoint_from_record(&x))
                    .collect();
                assert_eq!(got, new);
            });
        }
    });
}
