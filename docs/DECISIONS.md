# Decisions

## Architecture

- The core is sans-I/O. Session logic (time-outs, retries, paging) is TypeScript around it.
- One code path serves the web build and the Tauri webview. The native side will only move bytes.
- Structures cross the wasm boundary as JSON. Fewer dependencies; the payloads are small.
- Record layouts come from ferrite-app by path. `channels.rs` saves and loads fields in `link.rs`'s order.
- Tests check the record bytes against ferrite's real link session.
- The demo radio and the pre-write check run ferrite's own radio side (`App` + `link::Session`) in memory.
  It costs wasm size (about 1.3 MB, 390 KB gzipped).
- The table edits views (MHz text, one-word tones). The diff and the write use the radio's records.

## Link

- Web Serial's chooser shows common USB-serial chips only (CH340, CP210x, FTDI, Prolific).
- Web Bluetooth filters on service FFE0, as ferrite's `tools/webble` does. FF31 is never asked for.
- Keypad presses are short or long. KEY down/up exist in `Link.key` for later.
- The faster cable rate is on by default. A refusal leaves 115200 and says so.
- The cable tops out at 460800 on the Mac's CH340. At 921600 the radio switches but never answers.

## Events and Live View (Oct 20, 2026)

- One subscription per session (LINK-46): Console ORs what each part wants. APRS pages want heard and messages while open.
- Bluetooth's Live View is the radio's compact updates (mask 4), decoded by ferrite's own `liveview::apply` in wasm.
- A lost update or a bad check asks for the whole state (SUBSCRIBE without renew). So does 12 s with no update.
- The cable keeps polling the text readback. Measured on the simulator: one readback is ~760 B. At 460800 the cable has room; the updates gain little there.
- `?liveview=events` uses the updates on the cable too; `?liveview=poll` polls on Bluetooth.
- Firmware without SUBSCRIBE (`unknown type`): polling, and the APRS pages say the firmware is too old.
- Disconnect ends the subscription first, so events don't run on into `term.py` or `flash.py`.

## Activity Log and APRS

- Times come from each record's age at the read (the radio's clock may have no date). Shown in local time.
- The APRS group sits in Tools: Messages, Heard stations, Map, APRS Settings. It grows there.
- MSG_SEND is the radio's own compose: it goes by the radio's TX rules. Console says whether it goes now or waits for APRS mode.
- The map is Leaflet 1.9.4 from unpkg with SRI hashes, loaded only on the map page. Tiles: OpenStreetMap, attributed. Tests block tile requests.
- APRS settings: the APRS record's MENU 0 5 items, found by which values follow the record. Changed with the menu's knob or `set`, checked by ferrite's link session, written backup-first like Radio Settings.

## Bridge and tests

- The bridge is a dev tool, not a transport. It shows only in `npm run dev` or with `?bridge`.
- It listens on 127.0.0.1 and refuses other origins.
- E2E tests drive the real UI and check the radio by reading it back. They run on the simulator by default.
- `--tcp-bt` bridges the simulator's Bluetooth side, paced like the BT513 (20-byte writes 25 ms apart, ~960 B/s back).
- The headless simulator hears no APRS. The bridge's test hook injects a heard-station event; another drops a Live View update. Simulator only.

## Channels

- Write order: zones, channel deletes, channel writes, trailing zone deletes. Stop at the first refusal. Always END.
- Then read back.
- Deleting a middle zone rewrites the zones after it. Correct, but more writes than needed.
- Backup files are Console's JSON with the link's record bytes. CHIRP CSV can't hold zones, end tones or flags.

## CHIRP CSV

- Location is the channel number (1-1000). A 0-based file moves up one.
- Comment carries the zone name.
- New channels get squelch Global. A merge keeps the fields CHIRP has no column for.
- WFM and digital modes are skipped.

## Channel library (Add channels)

- Ported from NeonPlug (Alex's app): fixed sets, airports and TAFL. Data and generators copied, small fixes.
- The data is static files in `public/data/`. Big files load only when their tab opens.
- Entries become channels in the core (`library.rs`), not in the UI.
- Every channel goes through ferrite's own check. If ferrite refuses TX, it is retried as RX only and said so.
- A set takes the first run of free numbers that holds it all; else the gaps.
- Zones match by name, or a new one is made at the end.
- An entry the table already holds (same RX, TX, mode, zone) is skipped.
- Airband is AM and RX only. Names are "ICAO TYPE", with the MHz when an airport has two of a type.
- TAFL defaults to RX only and NFM. These are other licensees' channels.
- Places: lat,lon, a grid square (centre, as ferrite's GPS-21), or the radio's `gps` / `get 0 6 9` answer.
- Distances in km (great circle).
- No repeaters yet: NeonPlug's list is RadioID's DMR list. No tones, no coordinates, mostly DMR only.

## After UV Studio

- The concept, page structure and naming follow F4HWN's UV Studio, in Ferrite's look.
- Sidebar groups: Viewer, Tools, Console. Not-yet sections carry "Soon".
- Connection flow: a status line, a "Ready to connect" panel, Connect and Disconnect.
- Live View: the screen with a keypad that can hide, a size option, keyboard controls with Shift for long presses.
- Oct 20, 2026 (Alex): a dark radio screen shows as a small "screen off" mark in Live View, not a grey cover. Console keys wake it and act at once (DISP-15.1), so there is no separate wake.

## Firmware Update

- Radios already on Ferrite only, over the cable. First installs need the whole-flash backup: `flash.py`.
- Ferrite images only (the "Ferrite terminal" mark), under 948 KB (`APP_MAX`). Stock goes back with `flash.py`.
- The checks are `btf.py`'s, ported to `core/src/firmware.rs`. The core makes every frame, only from a checked file.
- The frames are hello, model, count, the blocks, end. Nothing else reaches the bootloader.
- REBOOT (LINK-24), then probes at 115200. No stock `PROGRAMBT9000U` nudge: Ferrite answers REBOOT.
- REBOOT `busy` (transmitting) is shown, and the session goes on.
- A failed block keeps the cable held. Resume probes again, no REBOOT. A reloaded page can resume from the cable.
- Tests: the bridge's fake bootloader (`tools/fakeboot.py`) on the simulator. Never a radio from the tests.
- Oct 20, 2026 (Alex): the Tauri desktop app is parked as is: it builds and runs, no more work on it. The web Console comes first. A phone app needs its own small-screen UI whatever wraps it; likely native (SwiftUI) on the Rust core, decided later. Keep the core free of web-only code.
