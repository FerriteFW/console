//! The other parsers of outside input: library entries (data.ferritefw.dev's tiles, as the page hands them in),
//! places and grid squares typed, satellites (`sats.json`, the radio's records, its clock), the reader's console
//! lines and its binary dump (`fdump`/`fdumpz`), the bootloader's replies, `.minisig` text. Nothing panics; what
//! the library adds is what the radio takes; a dump never holds more than it asked for.

use super::{guard, held_set, mutate, mutate_text, seeds, timed, Rng};
use crate::library::{self, Item};
use crate::plan;

/// A library entry as a tile might give it: real values and broken ones (NaN, negative, huge, odd modes and tones,
/// names past 16 characters or in other scripts).
fn item(rng: &mut Rng) -> Item {
    const RX: &[f64] = &[
        146.52,
        146.94,
        443.775,
        121.5,
        162.55,
        156.8,
        29.6,
        7.074,
        0.0,
        -1.0,
        1e9,
        f64::NAN,
        f64::INFINITY,
        1300.0,
        64.0,
        108.0,
        136.975,
    ];
    let rx = RX[rng.below(RX.len())];
    Item {
        name: rng
            .pick(&["VE7RPT", "Vancouver Approach", "Ch 16", "", "Café ✓ Ünïcode", "\"q\"", "a,b", "日本"])
            .to_string(),
        rx,
        tx: match rng.below(4) {
            0 => None,
            1 => Some(rx),
            2 => Some(rx + [0.6, -0.6, 5.0, -5.0, 100.0][rng.below(5)]),
            _ => Some([f64::NAN, -3.0, 2e9, 145.0][rng.below(4)]),
        },
        mode: rng.pick(&["FM", "NFM", "AM", "WFM", "USB", "", "fm", "DMR"]).to_string(),
        power: rng.chance(50).then(|| rng.pick(&["Low", "Mid", "High", "high", "5W", ""]).to_string()),
        rx_only: rng.chance(20),
        zone: rng.pick(&["", "Repeaters", "Air", "Marine", "A very long zone name indeed", "Ça"]).to_string(),
        tone: rng
            .chance(40)
            .then(|| rng.pick(&["100.0", "88.5", "D023N", "D754I", "off", "x", "0", "1000"]).to_string()),
        rx_tone: rng.chance(20).then(|| rng.pick(&["off", "67.0", "D023N", "?"]).to_string()),
        pos: rng.chance(30).then(|| crate::channels::Position::from_degrees(49.2, -123.1)).flatten(),
    }
}

/// Library entries into a table: nothing panics, and what is added (with the table) plans without problems: every
/// channel and zone the library adds is one the radio takes.
#[test]
fn library_add() {
    timed("library_add", || {
        for seed in seeds(250) {
            let mut rng = Rng::new(seed);
            let table = held_set(&mut rng, 3, 12);
            let items: Vec<Item> = (0..rng.below(20)).map(|_| item(&mut rng)).collect();
            let split = rng.chance(50);
            guard("library_add", seed, &items, || {
                let added = library::add(&items, &table, split);
                assert_eq!(added.channels.len() + added.skipped, items.len(), "{:?}", added.notes);
                let mut want = table.clone();
                want.zones.extend(added.zones.iter().cloned());
                want.channels.extend(added.channels.iter().cloned());
                want.channels.sort_by_key(|c| c.number);
                let p = plan::plan(&table, &want);
                assert!(p.problems.is_empty(), "{:?}", p.problems);
            });
        }
    });
}

/// Places and grid squares as typed (and as tiles carry them), the distance search over any coordinates, the
/// airport and organization names: no panic, and a grid square read back from a place is that place's.
#[test]
fn places_and_names() {
    timed("places_and_names", || {
        for seed in seeds(4000) {
            let mut rng = Rng::new(seed);
            let src = rng.pick(&[
                "FN25dk",
                "fn25",
                "CN89ld",
                "49.2827, -123.1207",
                "-33.9 151.2",
                "AA00aa",
                "RR99xx",
                "JJ",
                "90, 180",
                "-90,-180",
                "1e400, 0",
            ]);
            let text = if rng.chance(60) { mutate_text(&mut rng, src) } else { src.to_string() };
            let coords: Vec<f64> = (0..rng.below(10) * 2)
                .map(|_| [49.0, -123.0, f64::NAN, 1e308, -91.0, 181.0, 0.0][rng.below(7)])
                .collect();
            let khz = rng.next() as u32 % 2_000_000;
            guard("places_and_names", seed, &(&text, &coords), || {
                if let Some(p) = library::parse_place(&text) {
                    let g = library::grid_of(p);
                    if let Some(q) = library::grid_place(&g) {
                        assert_eq!(library::grid_of(q), g, "{text:?}");
                    }
                    let _ = library::near(p, rng.below(500) as f64, &coords, 5);
                    let _ = crate::channels::Position::parse(&text);
                }
                let _ = library::grid_place(&text);
                let _ = library::clean_name(&text);
                let _ = library::clean_zone_name(&text);
                let _ = library::airport_type(&text, khz);
                let _ = library::airport_name(&text, &text, khz, rng.chance(50));
                let _ = library::org_name(&text);
                let _ = library::org_groups(&[text.clone(), text.to_uppercase(), "x".into()], 2);
                let _ = library::tone_word(&text);
                let _ = crate::channels::parse_mhz(&text);
                let _ = crate::channels::parse_tone(&text);
                let _ = crate::chirp::zone_name_for(&text, &[]);
            });
        }
    });
}

const SO50: &str = r#"{"id":27607,"name":"SAUDISAT 1C (SO-50)","short":"SO-50","status":"active",
 "tle":["1 27607U 02058C   26304.82911449  .00000904  00000+0  12403-3 0  9995","2 27607  64.5527  66.1378 0068979 237.1936 122.2515 14.83296838284727"],
 "elements":{"epoch":"2026-10-31T19:53:55.491936","n":14.83296838,"e":0.00689796,"i":64.5527,"raan":66.1378,"w":237.1936,"m":122.2515,"bstar":0.00012402588,"ndot":9.04e-06,"nddot":0,"rev":28472},
 "transmitters":[{"desc":"Mode V/U FM Voice CTCSS 67.0 Hz","mode":"FM","up":[145850000,145850000],"down":[436795000,436795000],"tone":"67.0","invert":false,"arm_tone":"74.4"},
   {"desc":"Telemetry","mode":"FM","down":[437000000,437000000],"tone":null,"invert":false}]}"#;

fn sats_file(entries: &[String]) -> String {
    format!(
        r#"{{"format":"satellites-1","built":"2026-11-01T00:00:00Z","licence":"CC BY-SA 4.0","attribution":"x","newest_epoch":"","oldest_epoch":"","satellites":[{}]}}"#,
        entries.join(",")
    )
}

/// `sats.json` mutated (values in place, and bytes): parsed or refused, never a panic; each satellite it gives
/// reads back from its record; the radio's records, damaged, and its clock at any time give a map or a reason.
#[test]
fn satellites() {
    use crate::{satmap, sats};
    timed("satellites", || {
        for seed in seeds(300) {
            let mut rng = Rng::new(seed);
            let entries: Vec<String> = (0..1 + rng.below(3))
                .map(|_| if rng.chance(70) { super::backups::json_mutant(&mut rng, SO50) } else { SO50.to_string() })
                .collect();
            let mut json = sats_file(&entries);
            if rng.chance(20) {
                json = mutate_text(&mut rng, &json);
            }
            let now = match rng.below(4) {
                0 => rng.next() as u32,
                1 => u32::MAX - rng.below(100_000) as u32,
                _ => 1_793_000_000 + rng.below(86_400 * 30) as u32,
            };
            guard("satellites", seed, &(&json, now), || {
                let Ok(parsed) = sats::parse(&json) else { return };
                let recs: Vec<Vec<u8>> = parsed.sats.iter().map(|r| r.record.clone()).collect();
                for rec in &recs {
                    assert!(sats::held(rec).is_some(), "own record");
                    let mut bad = rec.clone();
                    mutate(&mut rng, &mut bad);
                    let _ = sats::held(&bad);
                    let _ = satmap::sat_map(&bad, now, Some((49.2, -123.1)));
                    let _ = satmap::sat_map(rec, now, Some((49.2, -123.1)));
                }
                let _ = satmap::next_passes(&recs, now, (49.2, -123.1));
                let _ = sats::refresh(&json, &recs);
            });
        }
    });
}

/// The reader's console lines (`flash`, `sys`, `flashcrc`, `mdump`) and backup file names: no panic.
#[test]
fn reader_lines() {
    use crate::install::*;
    const LINES: &[&str] = &[
        "flash: id EF4017 Winbond 8 MB",
        "uid 12345678 9abcdef0 11223344",
        "flashcrc 0x1234abcd 4194304",
        "080F0000: 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff",
        "RT950-12345-67890-ABCDE-FGHIJ-2026-11-23-stock-ABCD.bin",
    ];
    timed("reader_lines", || {
        for seed in seeds(4000) {
            let mut rng = Rng::new(seed);
            let src = LINES[rng.below(LINES.len())];
            let line = mutate_text(&mut rng, src);
            let block: String =
                (0..rng.below(6)).map(|_| mutate_text(&mut rng, LINES[3])).collect::<Vec<_>>().join("\n");
            guard("reader_lines", seed, &(&line, &block), || {
                let _ = parse_flash(&line);
                let _ = parse_uid(&line);
                let _ = parse_flashcrc(&line);
                let _ = parse_mdump(&line);
                let _ = parse_mdump(&block);
                let _ = parse_mdump_range(&block, 0x080F_0000, 16);
                let _ = parse_mdump_range(&block, ICONS_ADDR, ICONS_LEN);
                let _ = name_marker(&line);
                let _ = name_uid(&line);
                let _ = marker_word(line.as_bytes());
                let _ = backup_name(&line, &line, Some(line.as_bytes()));
                let _ = icons_plausible(line.as_bytes());
                let _ = check_id(Some(&line), &BackupId { uid: Some(line.clone()), confirmed: None });
            });
        }
    });
}

/// An `fdump`/`fdumpz` frame: "FD", kind, 0, the address, the length, the bytes, a CRC-32 over all before it.
fn fd_frame(kind: u8, addr: u32, payload: &[u8]) -> Vec<u8> {
    let mut f = b"FD".to_vec();
    f.extend([kind, 0]);
    f.extend(addr.to_le_bytes());
    f.extend((payload.len() as u16).to_le_bytes());
    f.extend_from_slice(payload);
    let c = crate::firmware::crc32(&f);
    f.extend(c.to_le_bytes());
    f
}

/// The reader's binary dump, the host's side: good frames, damaged ones, repeats, frames from elsewhere, an empty
/// `fdumpz` frame, all in random pieces: no panic; `fdumpz` never holds more than the range, and a dump that ends
/// done holds exactly the range (`fdump` takes blocks past it as they come; its end frame refuses them).
#[test]
fn fdump_stream() {
    use crate::install::Fdump;
    timed("fdump_stream", || {
        for seed in seeds(1500) {
            let mut rng = Rng::new(seed);
            let z = rng.chance(50);
            let len = [4096u32, 8192, 16384, 40_000][rng.below(4)];
            let addr = 0x1_0000;
            let mut wire = b"FDS1 junk\r\nFDOK".to_vec();
            let mut at = 0u32;
            for _ in 0..rng.below(10) {
                let k = rng.below(4);
                let f = match (z, k) {
                    (_, 0) => fd_frame(if z { b'Z' } else { b'B' }, addr + at, &[]),
                    (_, 1) => fd_frame(b'E', addr + at, &rng.bytes(4)),
                    (false, _) => {
                        let n = if rng.chance(80) { 4096 } else { rng.below(5000) };
                        let f = fd_frame(b'B', addr + at, &rng.bytes(n));
                        at += n as u32;
                        f
                    }
                    (true, _) => {
                        let want = 16384.min(len.saturating_sub(at)) as usize;
                        let p = match rng.below(4) {
                            0 => vec![1],
                            1 => {
                                let mut p = vec![0];
                                p.extend(rng.bytes(want));
                                p
                            }
                            2 => {
                                let mut p = vec![4];
                                let k = 1 + rng.below(30);
                                p.extend(rng.bytes(k));
                                p
                            }
                            _ => {
                                let k = rng.below(40);
                                rng.bytes(k)
                            }
                        };
                        at += want as u32;
                        fd_frame(b'Z', addr + at - want as u32, &p)
                    }
                };
                let mut f = f;
                if rng.chance(10) {
                    mutate(&mut rng, &mut f);
                }
                wire.extend(f);
            }
            guard("fdump_stream", seed, &wire.len(), || {
                let mut d = if z { Fdump::new_z(addr, len) } else { Fdump::new(addr, len) };
                let _ = d.command(230_400);
                let mut i = 0;
                while i < wire.len() {
                    let k = 1 + rng.below(3000);
                    let end = (i + k).min(wire.len());
                    let step = d.feed(&wire[i..end]);
                    i = end;
                    assert!(!z || step.got <= len as usize, "{} bytes of {len}", step.got);
                    if step.inflate {
                        let src = d.take_inflate();
                        let n = if rng.chance(50) { 16384.min(len as usize) } else { src.len() };
                        let out = rng.bytes(n);
                        let s = d.inflated(&out);
                        assert!(s.got <= len as usize);
                        if s.done {
                            break;
                        }
                    }
                    if step.nak {
                        d.resume();
                    }
                    if step.done {
                        assert_eq!(d.take_data().len(), len as usize);
                        break;
                    }
                    if step.error.is_some() {
                        break;
                    }
                }
                let _ = d.timeout();
                if z {
                    assert!(d.take_data().len() <= len as usize);
                }
            });
        }
    });
}

/// The bootloader's replies and `.minisig` text: no panic.
#[test]
fn bootloader_and_signatures() {
    use crate::firmware::BootReader;
    const SIG: &str = include_str!("../../tests/fixtures/signed-test.btf.minisig");
    timed("bootloader_and_signatures", || {
        for seed in seeds(1500) {
            let mut rng = Rng::new(seed);
            let k = rng.below(64);
            let bytes = rng.bytes(k);
            let sig = mutate_text(&mut rng, SIG);
            guard("bootloader_and_signatures", seed, &(&bytes, &sig), || {
                let mut b = BootReader::new();
                let _ = b.feed(&bytes);
                let _ = b.feed(&crate::firmware::frame(rng.byte(), rng.next() as u16, &bytes));
                let _ = crate::signature::check(&bytes, &sig);
            });
        }
    });
}
