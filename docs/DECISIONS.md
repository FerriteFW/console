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

## Bridge and tests

- The bridge is a dev tool, not a transport. It shows only in `npm run dev` or with `?bridge`.
- It listens on 127.0.0.1 and refuses other origins.
- E2E tests drive the real UI and check the radio by reading it back. They run on the simulator by default.

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
