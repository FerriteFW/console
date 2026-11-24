//! Records and answers as the radio sends them. The radio is untrusted too: a damaged chip, another firmware
//! version, a cut answer. Every length goes through the code that turns them into views; nothing panics, a
//! settings or APRS record of a length this Console doesn't know is shown with a note and never written back, a
//! table read from the radio is never written back unchanged, and every record the radio's own link takes survives
//! Console's view of it unchanged (so an edit elsewhere never changes it).

use super::{guard, mutate, seeds, timed, Rng};
use crate::aprs_settings;
use crate::channels::{
    channel_from_record, channel_record, zone_from_record, zone_record, ChanView, ZoneView, CHANNEL_LEN, ZONE_LEN,
    ZONE_READ_LEN,
};
use crate::plan::{self, Set};
use crate::radioside::RadioSide;
use crate::settings::{self, read_extras, record_len, record_of, Extras};
use ferrite_app::chan::{Channel, ChannelStore, Name, NO_ZONE};
use ferrite_app::data::ZoneCfg;
use ferrite_app::settings::Settings;
use ferrite_app::slot::SlotCfg;
use ferrite_core::link::what;

fn extras() -> Extras {
    read_extras(&mut RadioSide::new())
}

/// A record of about `len` bytes: random, or `good` cut, grown or with bytes changed.
fn record_near(rng: &mut Rng, good: &[u8]) -> Vec<u8> {
    match rng.below(4) {
        0 => rng.some_bytes(2 * good.len() + 2),
        1 => good[..rng.below(good.len() + 1)].to_vec(),
        2 => {
            let mut r = good.to_vec();
            let k = 1 + rng.below(8);
            r.extend(rng.bytes(k));
            r
        }
        _ => {
            let mut r = good.to_vec();
            mutate(rng, &mut r);
            r
        }
    }
}

/// Where the record holds the fixed position (`Settings::fixed`, 1e-7 degree), found from `record_of`.
fn fixed_at() -> usize {
    let a = record_of(&Settings::DEFAULT);
    let mut s = Settings::DEFAULT;
    s.fixed = ferrite_app::data::Pos { lat: 0x1111_1111, lon: 0x2222_2222 };
    let b = record_of(&s);
    a.iter().zip(&b).position(|(x, y)| x != y).expect("the position is in the record")
}

/// The settings record of any length through the view, `set` and the plan: no panic; another length shows a note
/// and its plan writes nothing; nor does a plan from the radio's record to itself. (The fixed position is kept on
/// the globe: see the ignored test below.)
#[test]
fn settings_records_from_the_radio() {
    settings_records(false);
}

/// The same with the fixed position anywhere: ferrite's `screens::lists::grid` overflowed (`b'A' + ... as u8`) on a
/// position past the poles or the date line, which the settings view shows as a grid square (a panic in a debug
/// build). Fixed in ferrite (GPS-3.2, ferrite#149): the position is kept on the globe.
#[test]
fn settings_records_position_off_the_globe() {
    settings_records(true);
}

fn settings_records(wide: bool) {
    let ex = extras();
    let good = record_of(&Settings::DEFAULT);
    let at = fixed_at();
    timed("settings_records_from_the_radio", || {
        for seed in seeds(5) {
            let mut rng = Rng::new(seed);
            let mut rec = record_near(&mut rng, &good);
            if !wide && rec.len() >= at + 8 {
                let lat = rng.below(1_800_000_001) as i32 - 900_000_000;
                let lon = rng.below(3_600_000_000) as i64 - 1_800_000_000;
                rec[at..at + 4].copy_from_slice(&lat.to_le_bytes());
                rec[at + 4..at + 8].copy_from_slice(&(lon.min(1_799_999_999) as i32).to_le_bytes());
            }
            guard("settings_records_from_the_radio", seed, &rec, || {
                let v = settings::view(&rec, &ex);
                let known = rec.len() == record_len();
                assert_eq!(v.notes.is_empty(), known, "{:?}", v.notes);
                let _ = (settings::home_channel(&rec), settings::with_home(&rec, Some(3)));
                let _ = settings::extras_from_radio(&rec);
                // an edit of the first item that takes one
                // an edit of one item with choices, picked by the seed
                let items: Vec<_> = v.groups.iter().flat_map(|g| &g.items).filter(|i| i.choices.len() > 1).collect();
                let edit = items.get(rng.below(items.len())).and_then(|i| {
                    let c = i.choices.iter().find(|c| **c != i.value)?;
                    settings::set(&rec, &ex, &i.id, c).ok()
                });
                if let Some((want, wex)) = edit {
                    let p = settings::plan(&rec, &ex, &want, &wex);
                    if !known {
                        assert!(p.ops.is_empty() && !p.problems.is_empty(), "another length written: {p:?}");
                    }
                }
                let same = settings::plan(&rec, &ex, &rec, &ex);
                assert!(same.ops.is_empty(), "the radio's own record written back: {same:?}");
            });
        }
    });
}

/// The APRS record of any length, the same way.
#[test]
fn aprs_records_from_the_radio() {
    let ex = extras();
    let srec = record_of(&Settings::DEFAULT);
    let good = super::aprs_default();
    timed("aprs_records_from_the_radio", || {
        for seed in seeds(15) {
            let mut rng = Rng::new(seed);
            let rec = record_near(&mut rng, &good);
            let settings_rec = if rng.chance(30) { record_near(&mut rng, &srec) } else { srec.clone() };
            guard("aprs_records_from_the_radio", seed, &(&rec, &settings_rec), || {
                let v = aprs_settings::view(&settings_rec, &rec, &ex);
                let known = rec.len() == aprs_settings::RECORD_LEN;
                if !known {
                    assert!(!v.notes.is_empty(), "another length without a note");
                }
                let items: Vec<_> = v.items.iter().filter(|i| i.choices.len() > 1).collect();
                let edit = items.get(rng.below(items.len())).and_then(|i| {
                    let c = i.choices.iter().find(|c| **c != i.value)?;
                    aprs_settings::set(&settings_rec, &rec, &ex, &i.id, c).ok()
                });
                if let Some((want, wex)) = edit {
                    let p = aprs_settings::plan(&settings_rec, &rec, &ex, &want, &wex);
                    if !known {
                        assert!(p.ops.is_empty() && !p.problems.is_empty(), "another length written: {p:?}");
                    }
                }
                let same = aprs_settings::plan(&settings_rec, &rec, &ex, &rec, &ex);
                assert!(same.ops.is_empty(), "the radio's own record written back: {same:?}");
            });
        }
    });
}

/// A channel record with every field random: within each field's range (`wide` false), or anything a damaged
/// chip might hold (`wide`).
fn channel_bytes(rng: &mut Rng, zones: u16, wide: bool) -> Vec<u8> {
    let mut name = [0u8; 16];
    let n = rng.below(17);
    for (i, b) in name.iter_mut().enumerate().take(n) {
        *b = match (wide, rng.below(20)) {
            (true, 0) => rng.byte(),
            (true, _) => b' ' + rng.below(95) as u8,
            // what the radio's names hold (CHAN-31): letters, digits, space and its symbols
            (false, k) if k < 3 => {
                *rng.pick(&[&b' ', &b'-', &b'.', &b'/', &b'_', &b'#', &b'+', &b'&', &b'(', &b')', &b'\'', &b'!'])
            }
            (false, k) if k < 6 => b'0' + rng.below(10) as u8,
            (false, k) if k < 13 => b'a' + rng.below(26) as u8,
            (false, _) => b'A' + rng.below(26) as u8,
        };
        if (i == 0 || (!wide && i == n - 1)) && *b == b' ' {
            *b = b'A'; // the radio's names don't end in a space (a wide one may)
        }
    }
    let (rx_tones, tx_tones): (&[&u16], &[&u16]) = if wide {
        (
            &[&0, &885, &670, &(0x8000 | 0o23), &(0xC000 | 0o754), &0xFFFF, &1],
            &[&0, &1000, &2541, &(0x8000 | 0o131), &0x7FFF],
        )
    } else {
        (&[&0, &885, &670, &(0x8000 | 0o23), &(0xC000 | 0o754)], &[&0, &1000, &2541, &(0x8000 | 0o131)])
    };
    let w = |n: usize, extra: usize| n + if wide { extra } else { 0 };
    let cfg = SlotCfg {
        mode: rng.below(8) as u8,
        narrow: rng.chance(50),
        rx_tone: *rng.pick(rx_tones),
        tx_tone: *rng.pick(tx_tones),
        offset: *rng.pick(&[&0i32, &60_000, &-60_000, &500_000, &14_634_000, &-1, &i32::MAX]),
        power: rng.below(w(3, 1)) as u8,
        step: rng.below(16) as u8,
        squelch: rng.below(w(11, 1)) as u8,
        busy: rng.below(w(2, 1)) as u8,
        reverse: rng.chance(10),
        split: rng.chance(15),
    };
    let rx = *rng.pick(&[
        &14_652_000u32,
        &44_647_500,
        &12_410_000,
        &817_600,
        &16_255_000,
        &0,
        &u32::MAX,
        &10_110_000,
        &22_200_000,
    ]);
    let c = Channel {
        num: rng.below(if wide { 4100 } else { 4000 }) as u16,
        zone: if rng.chance(50) { NO_ZONE } else { rng.below(zones as usize + 2) as u16 },
        rx,
        name,
        cfg,
        flags: rng.byte(),
        tones: rng.byte(),
    };
    let mut r = channel_record(&c);
    if rng.chance(10) {
        r.pop(); // an older writer's 40 bytes
    }
    r
}

/// Every channel record the radio's link takes (each field in its range) reads into Console's view and back to the
/// very same channel, which ferrite takes again: an edit elsewhere in the table never changes a channel nobody
/// touched.
#[test]
fn channel_records_survive_the_view() {
    channel_records(false, 10_000);
}

/// The same with fields out of their ranges, which ferrite's link takes too: power 3, busy lockout 2, squelch 11,
/// tone words 0xFFFF, 0x7FFF or 1 (0.1 Hz), a name ending in a space. Console's view shows them as other values
/// (Low, on, Global ...) or refuses the row (a tone word it can't read), and a refused row stops every channel write
/// ("the radio's own set: ...") until it is fixed in the table. Which side should give: ferrite's link check, or
/// Console's view. Repeats with `cargo test -- --ignored channel_records_out_of_range`.
#[test]
#[ignore = "found: ferrite's link takes channel fields out of range (power 3, busy 2, squelch 11, tone 0xFFFF/1, trailing space); Console's view changes or refuses them"]
fn channel_records_out_of_range_survive_the_view() {
    channel_records(true, 3000);
}

fn channel_records(wide: bool, n: u64) {
    let zones: Vec<(Name, ZoneCfg)> =
        (0..3).map(|i| (Name::from(format!("Z{i}").as_bytes()), Default::default())).collect();
    let mut r = RadioSide::new();
    let mut taken = 0;
    timed("channel_records_survive_the_view", || {
        for seed in seeds(n) {
            let mut rng = Rng::new(seed);
            let rec = channel_bytes(&mut rng, 3, wide);
            guard("channel_records_survive_the_view", seed, &rec, || {
                let Some(c) = channel_from_record(&rec) else { return };
                r.seed(&zones, &[]);
                let (s, _) = r.write_one(what::CHANNEL, c.num, &rec);
                if s != 0 {
                    return;
                }
                taken += 1;
                let held = r.store.get(c.num).expect("taken");
                let v = ChanView::of(&held);
                assert_eq!(v.channel(), Ok(held), "{v:?}");
                assert_eq!(plan::check_channel(&v, 3), None);
                let (back, bad) = Set::from_records(&[], &[channel_record(&held)]);
                assert!(bad.is_empty());
                assert_eq!(back.channels, vec![v]);
            });
        }
    });
    assert!(taken > 100, "only {taken} records taken: the generator needs work");
}

/// A zone record: a name, flags, resume and dwell near their ranges; priority channels in range (or anything,
/// `wide`).
fn zone_bytes(rng: &mut Rng, wide: bool) -> Vec<u8> {
    let mut rec = rng.bytes(ZONE_LEN);
    let n = rng.below(17);
    for (i, b) in rec.iter_mut().enumerate().take(16) {
        *b = if i < n { b'A' + rng.below(26) as u8 } else { 0 };
    }
    for b in &mut rec[16..19] {
        *b = rng.below(2) as u8;
    }
    rec[19] = rng.below(15) as u8;
    if rng.chance(70) {
        rec[21] = 0;
    }
    if !wide {
        // priority channels: none (0xFFFF) or one of the radio's 4000
        for k in [22, 24] {
            let p = if rng.chance(50) { 0xFFFF } else { rng.below(4000) as u16 };
            rec[k..k + 2].copy_from_slice(&p.to_le_bytes());
        }
    }
    if rng.chance(30) {
        rec.extend([rng.byte(), 0]); // the read form: the channel count after
    }
    rec
}

/// Zone records the same way: the radio takes it, Console's view gives it back unchanged.
#[test]
fn zone_records_survive_the_view() {
    zone_records(false);
}

/// The same with priority channels past 4000: ferrite's link took them and Console's view then refused the zone
/// ("priority channel: 1 to 4000"), blocking every channel write. Since ferrite#148 the link refuses them (LINK-41.3),
/// so every zone the radio takes, Console's view gives back.
#[test]
fn zone_records_out_of_range_survive_the_view() {
    zone_records(true);
}

fn zone_records(wide: bool) {
    timed("zone_records_survive_the_view", || {
        let mut r = RadioSide::new();
        let mut taken = 0;
        for seed in seeds(5000) {
            let mut rng = Rng::new(seed);
            let rec = zone_bytes(&mut rng, wide);
            guard("zone_records_survive_the_view", seed, &rec, || {
                let Some((name, cfg)) = zone_from_record(&rec) else { return };
                r.seed(&[], &[]);
                // ferrite LINK-41.3 (ferrite#148): a priority channel past the radio's 4000 (0xFFFF is none) is refused
                let pri = |k: usize| u16::from_le_bytes([rec[k], rec[k + 1]]);
                let past = [22, 24].iter().any(|&k| pri(k) != 0xFFFF && pri(k) >= 4000);
                let took = r.write_one(what::ZONE, 0, &rec).0 == 0;
                assert!(!(past && took), "a priority channel past 4000 was taken");
                if !took {
                    return;
                }
                taken += 1;
                let held = r.store.zones.borrow()[0];
                assert_eq!(zone_record(held.0.as_bytes(), &held.1), zone_record(name.as_bytes(), &cfg));
                let v = ZoneView::of(0, held.0.as_bytes(), &held.1);
                let (n2, c2) = v.zone().expect("a zone the radio took");
                assert_eq!(zone_record(n2.as_bytes(), &c2), zone_record(held.0.as_bytes(), &held.1), "{v:?}");
            });
        }
        // random priority words are mostly past 4000 and refused now; in range, most are taken
        assert!(taken > if wide { 5 } else { 100 }, "only {taken} zone records taken");
    });
}

/// Tables read from records of every length and content: no panic; a record that doesn't parse is named; and the
/// plan from the table to itself writes nothing (the radio's own records are never written back unchanged).
#[test]
fn tables_from_the_radio_never_written_back() {
    let mut planned = 0;
    timed("tables_from_the_radio_never_written_back", || {
        for seed in seeds(3000) {
            let mut rng = Rng::new(seed);
            let nz = rng.below(5);
            let zs: Vec<Vec<u8>> = (0..nz)
                .map(|_| match rng.below(8) {
                    0 => {
                        let n = *rng.pick(&[&ZONE_LEN, &ZONE_READ_LEN, &0, &(ZONE_LEN - 1), &64]);
                        rng.bytes(n)
                    }
                    _ => {
                        let wide = rng.chance(10);
                        zone_bytes(&mut rng, wide)
                    }
                })
                .collect();
            let cs: Vec<Vec<u8>> = (0..rng.below(12))
                .map(|_| match rng.below(8) {
                    0 => rng.some_bytes(2 * CHANNEL_LEN),
                    _ => {
                        let wide = rng.chance(20);
                        channel_bytes(&mut rng, nz as u16, wide)
                    }
                })
                .collect();
            guard("tables_from_the_radio_never_written_back", seed, &(&zs, &cs), || {
                let (set, bad) = Set::from_records(&zs, &cs);
                if set.parts().is_ok() {
                    planned += 1;
                }
                assert_eq!(set.zones.len() + set.channels.len() + bad.len(), zs.len() + cs.len());
                let p = plan::plan(&set, &set);
                assert!(p.ops.is_empty(), "{:?}", p.ops);
                let _ = crate::zonecap::over_cap(&set);
                let _ = crate::chirp::export(&set.channels, &set.zones);
            });
        }
    });
    assert!(planned > 300, "only {planned} tables planned past their parts");
}

/// Presets, quick messages, waypoints, DTMF memories, skip lists, positions: records of every length; whatever
/// reads is never written back unchanged.
#[test]
fn list_records_from_the_radio() {
    use crate::lists::*;
    use crate::presets;
    timed("list_records_from_the_radio", || {
        for seed in seeds(3000) {
            let mut rng = Rng::new(seed);
            let n = rng.below(40);
            let recs: Vec<Vec<u8>> = (0..n)
                .map(|_| {
                    let len = if rng.chance(60) { presets::PRESET_LEN } else { rng.below(64) };
                    rng.bytes(len)
                })
                .collect();
            guard("list_records_from_the_radio", seed, &recs, || {
                let (ps, bad) = presets::from_records(&recs);
                assert_eq!(ps.len() + bad.len(), recs.len());
                let p = presets::plan(&ps, &ps);
                assert!(p.ops.is_empty(), "{:?}", p.ops);
                let wps: Vec<Waypoint> = recs.iter().filter_map(|r| waypoint_from_record(r)).collect();
                assert!(waypoint_writes(&wps, &wps).is_empty());
                for r in &recs {
                    let _ = (quick_from_record(r), dtmf_from_record(r), preset_skips_from_record(r));
                    let _ = crate::channels::position_from_record(r);
                    let _ = parse_many(r);
                    if let Some(w) = waypoint_from_record(r) {
                        let _ = check_waypoint(&w);
                        assert_eq!(waypoint_from_record(&waypoint_record(Some(&w))).map(|x| x.lat), Some(w.lat));
                    }
                    if let Some(m) = dtmf_from_record(r) {
                        let _ = check_dtmf(&m);
                    }
                    if let Some(q) = quick_from_record(r) {
                        let _ = check_quick(&q);
                    }
                }
            });
        }
    });
}

/// Answers and events of every length and content (`HELLO`, `INFO`, `SLOT`, text chunks, the heard list, messages,
/// events, the state record and its events, the log, the clock, satellites, Live View, receive audio, the UI
/// readback's text): parsed without a panic.
#[test]
fn answers_from_the_radio() {
    use crate::{answers, aprs, audio, log, sats, state, ui, uid};
    timed("answers_from_the_radio", || {
        let mut lv = crate::liveview::Client::new();
        let mut prev: Option<Vec<u8>> = None;
        for seed in seeds(20_000) {
            let mut rng = Rng::new(seed);
            let n = *rng.pick(&[&0usize, &1, &2, &5, &12, &40, &120, &250]);
            let mut b = rng.some_bytes(n + 1);
            if rng.chance(30) && !b.is_empty() {
                b[0] = rng.below(8) as u8; // small counts and kinds
            }
            guard("answers_from_the_radio", seed, &b, || {
                let _ = answers::Hello::parse(&b);
                let _ = answers::Info::parse(&b);
                let _ = answers::TextChunk::parse(&b);
                let _ = answers::Slot::parse(&b);
                let _ = aprs::parse_heard(&b);
                let _ = aprs::parse_msgs(&b);
                let _ = aprs::parse_event(&b);
                let _ = state::parse(&b);
                if let Some(m) = state::merge(prev.as_deref(), &b) {
                    let _ = state::parse(&m);
                    prev = Some(m);
                }
                let _ = log::parse_page(&b);
                let _ = sats::clock_of(&b);
                let _ = sats::info_of(&b);
                let _ = sats::held(&b);
                let _ = audio::decode(&b);
                let _ = uid::text(&b);
                let _ = lv.apply(&b);
                let _ = lv.text();
                let _ = ui::parse(&String::from_utf8_lossy(&b));
            });
        }
    });
}

/// The link session's receive side: frames of random types and payloads (and compressed ones, LINK-13), damage
/// and noise between them, fed in random pieces: no panic, and only whole frames come out.
#[test]
fn session_feed() {
    use crate::session::Session;
    use ferrite_core::link::{build, MAX_WIRE};
    timed("session_feed", || {
        for seed in seeds(3000) {
            let mut rng = Rng::new(seed);
            let mut wire = Vec::new();
            for _ in 0..rng.below(12) {
                let k = rng.below(120);
                let mut payload = rng.bytes(k);
                let ty = match rng.below(4) {
                    0 => 0x7D | 0x80, // compressed answer: inner type, count, then the coded bytes
                    1 => rng.byte() & 0x7F,
                    _ => rng.byte() | 0x80,
                };
                if ty == 0xFD && payload.len() >= 2 {
                    payload[1] = rng.below(3) as u8;
                }
                let mut out = vec![0u8; MAX_WIRE + 1];
                if let Some(n) = build(ty, rng.byte(), &payload, &mut out) {
                    let mut f = out[..n].to_vec();
                    if rng.chance(10) {
                        mutate(&mut rng, &mut f);
                    }
                    wire.extend(f);
                }
                if rng.chance(10) {
                    let k = rng.below(20);
                    wire.extend(rng.bytes(k));
                }
            }
            guard("session_feed", seed, &wire, || {
                let mut s = Session::new();
                s.set_lz(rng.chance(50));
                let mut at = 0;
                while at < wire.len() {
                    let k = 1 + rng.below(64);
                    let end = (at + k).min(wire.len());
                    for a in s.feed(&wire[at..end]) {
                        let _ = (a.ty, a.seq, a.status, a.rest.len());
                    }
                    at = end;
                }
            });
        }
    });
}
