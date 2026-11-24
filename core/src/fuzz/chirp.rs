//! CHIRP CSV import and export (beside `chirp_fuzz`'s generated files): real exports' quirks (CHIRP's own and
//! older columns, BOMs, LF or CRLF, quoted fields, blank rows, RepeaterBook's positions, the stock radio's list),
//! mutated byte by byte and field by field; channels as ferrite holds them, exported and read back; a big file.

use super::{guard, held_channel, mutate_text, seeds, timed, Rng};
use crate::channels::{ChanView, ZoneView};
use crate::chirp::{export, import, Import};
use crate::plan::check_channel;

/// Files as CHIRP, RepeaterBook and the stock radio's tools write them.
const SEEDS: &[&str] = &[
    // CHIRP (next) "Export to CSV": every column, from Location 0, CRLF.
    "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,RPT1CALL,RPT2CALL,DVCODE\r\n\
0,CALL,146.520000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,5.0W,,,,,\r\n\
1,North hill,146.940000,-,0.600000,Tone,100.0,88.5,023,NN,023,Tone->Tone,FM,5.00,,50W,Repeaters,,,,\r\n\
2,40m FT8,7.074000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,USB,0.01,,5.0W,,,,,\r\n\
3,80m net,3.750000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,LSB,0.10,,5.0W,,,,,\r\n\
4,Air,124.100000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,AM,8.33,S,5.0W,,,,,\r\n\
5,DCS rpt,443.500000,+,5.000000,DTCS,88.5,88.5,754,RN,754,Tone->Tone,NFM,12.50,P,1.5W,Repeaters,,,,\r\n\
6,Cross,446.000000,split,446.500000,Cross,67.0,88.5,023,NR,131,Tone->DTCS,FM,25.00,,4W,,,,,\r\n\
7,WX,162.550000,off,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,25.00,,Low,,,,,\r\n\
8,8176 USB,8.176000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,USB,1.00,,High,,,,,\r\n",
    // An older CHIRP: no RxDtcsCode or CrossMode, LF lines, a BOM, quoted fields, a blank row.
    "\u{feff}\"Location\",\"Name\",\"Frequency\",\"Duplex\",\"Offset\",\"Tone\",\"rToneFreq\",\"cToneFreq\",\"DtcsCode\",\"DtcsPolarity\",\"Mode\",\"TStep\",\"Skip\",\"Comment\"\n\
\"1\",\"Calling, 2 m\",\"146.520000\",\"\",\"0.000000\",\"\",\"88.5\",\"88.5\",\"023\",\"NN\",\"FM\",\"5.00\",\"\",\"\"\n\
\n\
\"2\",\"He said \"\"hi\"\"\",\"145.230000\",\"-\",\"0.600000\",\"TSQL\",\"88.5\",\"110.9\",\"023\",\"NN\",\"FM\",\"5.00\",\"\",\"Local\"\n\
,,,,,,,,,,,,,\n\
\"3\",\"DV\",\"145.375000\",\"\",\"0.000000\",\"\",\"88.5\",\"88.5\",\"023\",\"NN\",\"DV\",\"5.00\",\"\",\"\"\n",
    // RepeaterBook's CHIRP export with the sites' positions.
    "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,Mode,TStep,Skip,Comment,Latitude,Longitude\r\n\
0,VE7RPT,147.000000,+,0.600000,Tone,127.3,88.5,023,NN,FM,5.00,,Vancouver,49.2827,-123.1207\r\n\
1,VE7XYZ,443.775000,+,5.000000,Tone,100.0,88.5,023,NN,FM,5.00,,Burnaby,49.2488,-122.9805\r\n\
2,Nowhere,444.000000,+,5.000000,,88.5,88.5,023,NN,FM,5.00,,,0,0\r\n",
    // The stock radio's channel list.
    "Index,Name,RX MHz,TX MHz,Duplex,Offset,RX Tone,TX Tone,Bandwidth,Power,Mode,Scan,Zone\r\n\
1,Calling,146.52000,146.52000,,,OFF,OFF,Wide,High,FM,true,Local\r\n\
2,Repeater,146.94000,146.34000,,,OFF,100.0,Narrow,Low,FM,false,\r\n\
3,DCS,446.10000,446.10000,,,D023N,D754I,Wide,Mid,FM,true,Local\r\n",
];

/// The zones a table may hold when a file comes in (a Comment that names one puts the channel in it).
fn zones() -> Vec<ZoneView> {
    vec![ZoneView::new(1, "Local"), ZoneView::new(2, "Repeaters")]
}

/// What an import gives must hold: each channel valid for ferrite and in normal form, no number twice; and the
/// export of it reads back the same (positions aside: CHIRP's CSV has none).
fn check(got: &Import, zones: &[ZoneView]) {
    let mut seen = std::collections::BTreeSet::new();
    for c in &got.channels {
        assert!(seen.insert(c.number), "channel {} twice", c.number);
        assert!(c.channel().is_ok(), "{c:?}: {:?}", c.channel());
        assert_eq!(c.normal().as_ref(), Ok(c), "not in normal form");
        assert_eq!(check_channel(c, zones.len() as u16), None, "{c:?}");
    }
    let again = import(&export(&got.channels, zones), zones).unwrap_or_else(|e| panic!("own export refused: {e}"));
    assert_eq!(again.skipped, 0, "{:?}", again.notes);
    let want: Vec<ChanView> = got.channels.iter().map(|c| ChanView { pos: None, ..c.clone() }).collect();
    assert_eq!(again.channels, want, "export and import again");
}

/// Mutated real files (bytes): nothing panics; what's imported holds up; a refusal says why.
#[test]
fn chirp_mutated_bytes() {
    let zs = zones();
    timed("chirp_mutated_bytes", || {
        for seed in seeds(3000) {
            let mut rng = Rng::new(seed);
            let src = SEEDS[rng.below(SEEDS.len())];
            let text = mutate_text(&mut rng, src);
            guard("chirp_mutated_bytes", seed, &text, || match import(&text, &zs) {
                Ok(got) => check(&got, &zs),
                Err(e) => assert!(!e.is_empty()),
            });
        }
    });
}

/// Mutated real files (fields): columns dropped, duplicated, renamed in other cases; rows doubled, cut, blank;
/// line ends mixed; a BOM or not.
#[test]
fn chirp_mutated_fields() {
    let zs = zones();
    timed("chirp_mutated_fields", || {
        for seed in seeds(2000) {
            let mut rng = Rng::new(seed);
            let src = SEEDS[rng.below(SEEDS.len())];
            let text = field_mutant(&mut rng, src);
            guard("chirp_mutated_fields", seed, &text, || match import(&text, &zs) {
                Ok(got) => check(&got, &zs),
                Err(e) => assert!(!e.is_empty()),
            });
        }
    });
}

fn field_mutant(rng: &mut Rng, text: &str) -> String {
    let rows = crate::chirp::parse_csv(text);
    let mut rows: Vec<Vec<String>> = rows;
    for _ in 0..1 + rng.below(4) {
        let width = rows.first().map_or(0, |r| r.len());
        match rng.below(9) {
            0 if width > 0 => {
                let c = rng.below(width);
                for r in &mut rows {
                    if c < r.len() {
                        r.remove(c);
                    }
                }
            }
            1 if width > 0 => {
                let (a, b) = (rng.below(width), rng.below(width));
                for r in &mut rows {
                    if a < r.len() && b < r.len() {
                        r.swap(a, b);
                    }
                }
            }
            2 if width > 0 => {
                let c = rng.below(width);
                rows[0][c] = match rng.below(3) {
                    0 => rows[0][c].to_ascii_uppercase(),
                    1 => format!(" {} ", rows[0][c]),
                    _ => rows[0][(c + 1) % width].clone(), // two columns of one name
                };
            }
            3 if rows.len() > 1 => {
                let i = 1 + rng.below(rows.len() - 1);
                let r = rows[i].clone();
                rows.insert(i, r);
            }
            4 if rows.len() > 1 => {
                let i = 1 + rng.below(rows.len() - 1);
                let k = rng.below(rows[i].len() + 1);
                rows[i].truncate(k);
            }
            5 => {
                let i = rng.below(rows.len() + 1);
                rows.insert(i, vec![String::new(); rng.below(width + 1)]);
            }
            6 if rows.len() > 1 && width > 0 => {
                let (i, c) = (1 + rng.below(rows.len() - 1), rng.below(width));
                let v = rng.pick(&[
                    "",
                    "USB",
                    "LSB",
                    "CW",
                    "usb",
                    "Lsb",
                    "DIG",
                    "0.01",
                    "-0",
                    "1e3",
                    "\u{a0}146.52",
                    "\"",
                    ",",
                ]);
                if let Some(f) = rows[i].get_mut(c) {
                    *f = v.to_string();
                }
            }
            7 if rows.len() > 1 => {
                rows.remove(1 + rng.below(rows.len() - 1));
            }
            _ => {
                let i = 1 + rng.below(rows.len().max(1));
                rows.insert(i.min(rows.len()), vec!["extra".into(); width + 2]);
            }
        }
    }
    let field = |s: &String| if rng_safe(s) { s.clone() } else { format!("\"{}\"", s.replace('"', "\"\"")) };
    let lines: Vec<String> = rows.iter().map(|r| r.iter().map(field).collect::<Vec<_>>().join(",")).collect();
    let eol = if rng.chance(50) { "\r\n" } else { "\n" };
    let bom = if rng.chance(20) { "\u{feff}" } else { "" };
    let end = if rng.chance(50) { eol } else { "" };
    format!("{bom}{}{end}", lines.join(eol))
}

fn rng_safe(s: &str) -> bool {
    !s.contains([',', '"', '\n', '\r'])
}

/// Channels the radio takes over the link, exported and imported again: all of them, as they were.
#[test]
fn chirp_held_channels_round_trip() {
    let zs = zones();
    timed("chirp_held_channels_round_trip", || {
        for seed in seeds(2000) {
            let mut rng = Rng::new(seed);
            let n = 1 + rng.below(12);
            let mut chans: Vec<ChanView> =
                (0..n).map(|k| held_channel(&mut rng, 1 + k as u16 * 3, zs.len() as u16)).collect();
            chans.retain(|c| check_channel(c, zs.len() as u16).is_none());
            let text = export(&chans, &zs);
            // CHIRP's Duplex `off` (TX disabled) has no shift beside it: an RX-only channel's stored shift isn't in
            // the file (a format limit; the radio doesn't transmit on it).
            let want: Vec<ChanView> = chans
                .iter()
                .map(|c| ChanView { pos: None, ..c.clone() })
                .map(|c| if c.rx_only { ChanView { duplex: String::new(), offset: String::new(), ..c } } else { c })
                .collect();
            guard("chirp_held_channels_round_trip", seed, &text, || {
                let got = import(&text, &zs).expect("own export");
                assert_eq!(got.skipped, 0, "{:?}", got.notes);
                assert_eq!(got.channels, want);
            });
        }
    });
}

/// console#50: a channel the radio stores in USB, LSB or CW (saved on the radio in HF mode) exports, but the import
/// refuses it ("mode or step out of range"): ferrite's link WRITE takes FM, NFM, AM and WFM only
/// (`slot::slot_mode_ok`), so Console can't write it back either. Ferrite's link decides; Console then follows.
#[test]
#[ignore = "found: console#50: ferrite's link refuses USB/LSB/CW channels the radio stores; their CHIRP export won't import"]
fn chirp_ssb_channels_round_trip() {
    let zs = zones();
    for seed in seeds(50) {
        let mut rng = Rng::new(seed);
        let mut v = held_channel(&mut rng, 1, 0);
        v.mode = ["USB", "LSB", "CW"][rng.below(3)].into();
        v.rx = "8.17600".into();
        v.step = "1 kHz".into();
        let v = ChanView { pos: None, ..v.normal().unwrap() };
        let text = export(std::slice::from_ref(&v), &zs);
        guard("chirp_ssb_channels_round_trip", seed, &text, || {
            let got = import(&text, &zs).expect("own export");
            assert_eq!(got.channels, vec![v.clone()], "{:?}", got.notes);
        });
    }
}

/// A big file (a RepeaterBook country, CHIRP's biggest radios): every location past the radio's 4000 is
/// skipped with a note, the rest come in.
#[test]
fn chirp_big_file() {
    let zs = zones();
    timed("chirp_big_file", || {
        let mut text = String::from(SEEDS[0].lines().next().unwrap());
        text.push_str("\r\n");
        for k in 0..6000u32 {
            text.push_str(&format!(
                "{k},R{k},{}.{:06},+,0.600000,Tone,100.0,88.5,023,NN,023,Tone->Tone,FM,5.00,,High,Local,,,,\r\n",
                144 + k % 4,
                (k * 5000) % 1_000_000
            ));
        }
        let got = import(&text, &zs).unwrap();
        assert_eq!(got.channels.len(), crate::channels::MAX_CHANNELS as usize);
        assert_eq!(got.skipped, 6000 - crate::channels::MAX_CHANNELS as usize);
        assert_eq!(got.notes.len(), got.skipped);
    });
}
