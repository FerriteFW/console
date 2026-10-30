//! The `.ferrite` codeplug's documented example (docs/dev/codeplug-format.md, in the docs repo): its parts are the
//! fixtures in `tests/fixtures/codeplug/`, which the doc shows and `tests/unit/codeplug.test.ts` zips and reads
//! back. These tests check each part is exactly what Console's own save writes for it, and reads back through the
//! part's own restore. `FERRITE_WRITE_CODEPLUG_EXAMPLE=1 cargo test -p ferrite-console-core codeplug_example`
//! writes the fixtures again (then review the diff and the doc).

use crate::aprs_settings;
use crate::channels::{ChanView, ZoneView};
use crate::plan::{self, Set};
use crate::radioside::RadioSide;
use crate::records::Reader;
use crate::settings::{self, read_extras, record_of};
use ferrite_app::settings::Settings;
use ferrite_core::link::{msg, what};
use std::collections::BTreeMap;
use std::path::PathBuf;

const SAVED: &str = "2026-10-30T21:12:00.000Z";

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codeplug")
}

fn radio() -> BTreeMap<String, String> {
    // No unique ID in a codeplug (the manifest's radio_fingerprint stands for it).
    [("connection", "Cable"), ("firmware", "0.8.2"), ("callsign", "VA7IF")]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Two zones and three channels: a simplex calling channel, a repeater with a tone, one with no zone.
fn set() -> Set {
    let mut z1 = ZoneView::new(1, "Local");
    z1.scan_all = true;
    let mut z2 = ZoneView::new(2, "Repeaters");
    z2.resume = "Carrier".into();
    z2.pri1 = Some(10);
    let mut a = ChanView::new(1, 14_652_000);
    a.name = "Calling 2 m".into();
    a.zone = Some(0);
    let mut b = ChanView::new(10, 14_694_000);
    b.name = "North hill".into();
    b.zone = Some(1);
    b.duplex = "-".into();
    b.offset = "0.6".into();
    b.tx_tone = "100.0".into();
    b.power = "Mid".into();
    let b = ChanView::of(&b.channel().unwrap());
    let mut c = ChanView::new(20, 44_600_000);
    c.name = "Calling 70 cm".into();
    c.skip = true;
    Set { zones: vec![z1, z2], channels: vec![a, b, c] }
}

fn aprs_record() -> Vec<u8> {
    let mut rs = RadioSide::new();
    let mut r = Reader::new(what::APRS, 0);
    while !r.done() {
        let (s, rest) = rs.ask(msg::READ, &r.next_payload());
        assert_eq!(s, 0);
        assert!(r.take(&rest));
    }
    r.record
}

/// The parts as Console writes them, by file name.
fn parts() -> Vec<(&'static str, String)> {
    let channels = plan::backup(&set(), SAVED, radio()).unwrap();
    let ex = read_extras(&mut RadioSide::new());
    let aprs = aprs_settings::backup(&record_of(&Settings::DEFAULT), &aprs_record(), &ex, SAVED, radio());
    // Console writes these two in TypeScript (codeplug.ts: JSON.stringify(.., null, 2)); the structs keep its key
    // order, so the fixtures are byte for byte what it writes (tests/unit/codeplug.test.ts checks that side).
    #[derive(serde::Serialize)]
    struct Contact {
        call: &'static str,
        name: &'static str,
    }
    #[derive(serde::Serialize)]
    struct Contacts {
        format: &'static str,
        version: u32,
        saved: &'static str,
        radio: BTreeMap<String, String>,
        contacts: Vec<Contact>,
    }
    let contacts = serde_json::to_string_pretty(&Contacts {
        format: "ferrite-console-contacts",
        version: 1,
        saved: SAVED,
        radio: radio(),
        contacts: vec![
            Contact { call: "VA7XYZ-9", name: "Sam mobile" },
            Contact { call: "VE7ABC", name: "Club station" },
        ],
    })
    .unwrap();
    #[derive(serde::Serialize)]
    struct Radio {
        callsign: &'static str,
        firmware: &'static str,
        build: &'static str,
    }
    #[derive(serde::Serialize)]
    struct Manifest {
        format: &'static str,
        version: u32,
        created: &'static str,
        console: &'static str,
        radio: Radio,
        radio_fingerprint: &'static str,
        parts: [&'static str; 3],
    }
    // Saved before Radio Settings was read: no settings part (a part may be missing).
    let manifest = serde_json::to_string_pretty(&Manifest {
        format: "ferrite-codeplug",
        version: 1,
        created: SAVED,
        console: "0.1.0",
        radio: Radio { callsign: "VA7IF", firmware: "0.8.2", build: "tx" },
        // SHA-256 of the UID bytes 10 32 54 76 98 ba dc fe 01 23 45 67, its first 8 hex digits.
        radio_fingerprint: "7f755785",
        parts: ["channels", "aprs", "contacts"],
    })
    .unwrap();
    vec![("manifest.json", manifest), ("channels.json", channels), ("aprs.json", aprs), ("contacts.json", contacts)]
}

#[test]
fn fixtures_are_what_console_writes() {
    let write = std::env::var("FERRITE_WRITE_CODEPLUG_EXAMPLE").is_ok();
    for (name, text) in parts() {
        let path = dir().join(name);
        if write {
            std::fs::create_dir_all(dir()).unwrap();
            std::fs::write(&path, &text).unwrap();
        }
        let on_disk = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(
            on_disk, text,
            "{name}: the fixture isn't what Console writes (FERRITE_WRITE_CODEPLUG_EXAMPLE=1 to write it again)"
        );
    }
}

/// Each part reads back through its own restore and saves again unchanged.
#[test]
fn parts_round_trip() {
    let read = |n: &str| std::fs::read_to_string(dir().join(n)).unwrap();
    let ch = read("channels.json");
    let (set, b) = plan::restore(&ch).unwrap();
    assert_eq!(plan::backup(&set, &b.saved, b.radio).unwrap(), ch);
    assert_eq!((set.zones.len(), set.channels.len()), (2, 3));

    let ap = read("aprs.json");
    let (rec, b) = aprs_settings::restore(&ap).unwrap();
    assert_eq!(aprs_settings::backup(&record_of(&Settings::DEFAULT), &rec, &b.extras, &b.saved, b.radio), ap);

    // The settings part (not in the example) round-trips the same way.
    let ex = read_extras(&mut RadioSide::new());
    let rec = record_of(&Settings::DEFAULT);
    let st = settings::backup(&rec, &ex, SAVED, radio());
    let (back, b) = settings::restore(&st).unwrap();
    assert_eq!(back, rec);
    assert_eq!(settings::backup(&back, &b.extras, &b.saved, b.radio), st);
}

/// The channel and zone record layouts the doc gives, byte by byte.
#[test]
fn record_layouts_as_documented() {
    let s = set();
    let (zones, chans) = s.parts().unwrap();
    let z = crate::channels::zone_record(zones[1].0.as_bytes(), &zones[1].1);
    assert_eq!(z.len(), 26);
    assert_eq!(&z[..9], b"Repeaters");
    assert_eq!(z[17], 1, "shown");
    assert_eq!(z[19], 11, "resume: carrier");
    assert_eq!(z[20], 255, "dwell: the radio's");
    assert_eq!(u16::from_le_bytes([z[22], z[23]]), 9, "priority 1: channel 10, 0-based");
    assert_eq!(u16::from_le_bytes([z[24], z[25]]), 0xFFFF, "priority 2: none");
    let c = crate::channels::channel_record(&chans[1]);
    assert_eq!(c.len(), 40);
    assert_eq!(u16::from_le_bytes([c[0], c[1]]), 9, "number, 0-based");
    assert_eq!(c[2], 1, "zone index");
    assert_eq!(u32::from_le_bytes(c[3..7].try_into().unwrap()), 14_694_000, "RX, 10 Hz");
    assert_eq!(&c[7..17], b"North hill");
    assert_eq!(u16::from_le_bytes([c[25], c[26]]), 0, "RX tone: none");
    assert_eq!(u16::from_le_bytes([c[27], c[28]]), 1000, "TX tone: 100.0 Hz in 0.1 Hz");
    assert_eq!(i32::from_le_bytes(c[29..33].try_into().unwrap()), -60_000, "offset, 10 Hz");
    assert_eq!(c[33], 1, "power: mid");
    assert_eq!(c[35], 10, "squelch: Global");
    let c3 = crate::channels::channel_record(&chans[2]);
    assert_eq!(c3[2], 255, "no zone");
    assert_eq!(c3[38], 1, "flags: skip");
}

/// The PIN lock never goes in a codeplug (Alex, Oct 30): no key naming it anywhere in settings.json, its menu
/// entries left out, its record fields cleared; opening one keeps the radio's own.
#[test]
fn no_pin_in_the_settings_part() {
    let mut s = Settings::DEFAULT;
    s.pin_mode = 2;
    s.pin_len = 4;
    s.pin = 1234;
    s.chan_only = true;
    let mut r = RadioSide::new();
    *r.app.settings_mut() = s;
    let ex = read_extras(&mut r);
    // The record as Console holds it, with the PIN lock's fields set (the link reads the PIN itself as zeros).
    let rec = record_of(&s);
    // The Node test (tests/unit/codeplug.test.ts) saves a whole codeplug from this record: kept as a fixture.
    let hex: String = rec.iter().map(|b| format!("{b:02x}")).collect();
    let path = dir().join("settings-with-pin.hex");
    if std::env::var("FERRITE_WRITE_CODEPLUG_EXAMPLE").is_ok() {
        std::fs::write(&path, &hex).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), hex, "settings-with-pin.hex (FERRITE_WRITE_CODEPLUG_EXAMPLE=1)");
    let part = settings::codeplug_part(&rec, &ex, SAVED, radio());
    fn keys(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(m) => m.iter().for_each(|(k, x)| {
                out.push(k.clone());
                keys(x, out);
            }),
            serde_json::Value::Array(a) => a.iter().for_each(|x| keys(x, out)),
            _ => {}
        }
    }
    let mut all = vec![];
    keys(&serde_json::from_str(&part).unwrap(), &mut all);
    assert!(all.len() > 50, "{all:?}");
    assert!(!all.iter().any(|k| k.to_lowercase().contains("pin") || k.starts_with("0 9 3 ")), "{all:?}");
    let (back, _) = settings::restore(&part).unwrap();
    let got = settings::settings_of(&back);
    assert_eq!((got.pin_mode, got.pin_len, got.pin, got.chan_only), (0, 0, 0, false));
    // Opened onto a radio: its own PIN lock kept.
    let kept = settings::settings_of(&settings::keep_pin(&back, &rec));
    assert_eq!((kept.pin_mode, kept.pin_len, kept.chan_only), (2, 4, true));
    assert_eq!(settings::keep_pin(&back, &rec), rec);
}
