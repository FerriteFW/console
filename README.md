# Ferrite Console

The web and app companion for Ferrite on the Radtel RT-950 Pro: live view, remote keys, channel programming.
Private until the licence is chosen.

Phase 1: connect over the programming cable or the radio's Bluetooth, see the radio's screen (drawn from the UI
readback) beside a drawn keypad, and press keys and turn the knob from the computer. Remote keys never transmit.

Phase 2: channel programming. Read the radio's channels and zones into a table, edit them, and write them back
(a backup file and a diff first); CHIRP CSV in and out; backup files saved and restored.

## Layout

| Path | What |
| --- | --- |
| `core/` | The Rust core (`ferrite-console-core`): link sessions (sans I/O), answers (`HELLO`, `INFO`, `SLOT`, text), the UI readback parser, key codes, the unique ID's text, record payloads, channel and zone records (`channels.rs`), the write plan and backup files (`plan.rs`), CHIRP CSV (`chirp.rs`), ferrite's radio side in memory (`radioside.rs`), a demo radio. It reuses ferrite's own code by path, never a copy: `ferrite-core` (the frame codec, message and status numbers, the key map, the unique ID's base32) and `ferrite-app` (the `Channel`, `SlotCfg` and `ZoneCfg` types, their byte layouts in `persist.rs`, the tone and step tables, and the radio's own link session `link::Session` with its checks). |
| `wasm/` | The core for the browser (wasm-bindgen). Built into `src/core-wasm/` (not in git) by `npm run wasm`. |
| `src/` | The Svelte 5 UI (Vite). `lib/link.ts` is the session logic (mirrors `ferrite/tools/ferrite_link.py`), `lib/transport/` the byte pipes (Web Serial, Web Bluetooth, demo, native stub), `lib/components/` the screen, keypad and panels. |
| `tools/bridge.py` | The development bridge: the link's bytes over a local WebSocket to a serial port or the simulator (below). |
| `tests/e2e/` | The end-to-end tests (Playwright, Chromium) through the bridge. |
| `src-tauri/` | The Tauri 2 desktop shell: the same UI. Native transports are stubbed (see below). |

It needs the ferrite checkout next to it (`../ferrite`): the core builds against ferrite-core, and the UI uses
ferrite's fonts (`ferrite/fonts`) and logo (`ferrite/assets/logo`) from there.

## Setup

- Node 20 or later, and npm.
- Rust through rustup: `rust-toolchain.toml` pins 1.99 with the `wasm32-unknown-unknown` target (rustup fetches it).
- wasm-bindgen's CLI at the version `wasm/Cargo.toml` pins:
  `cargo install wasm-bindgen-cli --version 0.2.129 --locked`
- git access to `infamy/udigimodes` (ferrite-core pulls it; `.cargo/config.toml` lets git's credential helper fetch).

```sh
npm install
```

## Run it

```sh
npm run dev          # builds the core to wasm, then Vite on http://localhost:1420: open it in Chrome
npm run build        # the web build in dist/ (any static host over https; Web Serial and Bluetooth need https or localhost)
npm test             # the core's Rust tests (cargo test -p ferrite-console-core)
```

`http://localhost:1420/?demo` connects the demo radio at once (no hardware: the core's `DemoRadio` answers HELLO,
INFO, UI and keys from memory). `?demo&press=MENU,DOWN,HASH:long` then presses keys; `?theme=light` picks the theme.

### The bridge and the end-to-end tests

A browser opens a serial port only after a person picks it, so scripts can't drive Console against the radio. The
development bridge (`tools/bridge.py`, Python 3, standard library; pyserial for `--serial`) relays the link's raw
bytes between a local WebSocket (`ws://127.0.0.1:8765`, 127.0.0.1 only, pages from localhost only, one client at a
time) and the radio's cable or the simulator's TCP cable. Console shows a **Bridge** connect button in `npm run dev`
or with `?bridge` in the URL (`?bridge=ws://127.0.0.1:PORT` for another port); normal users never see it. Binary
frames are the bytes; text frames are JSON: the bridge says `{"bridge":1,"target":"serial"|"tcp","name":...,"baud":115200}`
first, and Console's BAUD switch (LINK-11) sends `{"baud":460800}`, which the bridge applies to the serial port
(after the bytes before it are out) and answers `{"baud":460800,"ok":true}` (`"ignored":true` on TCP).

```sh
# the simulator (from ../ferrite), its cable on TCP 7300, and the bridge in front of it
../ferrite/target/debug/ferrite-sim --term-headless 3600 --term-tcp 7300   # cargo build -p ferrite-sim first
python3 tools/bridge.py --tcp 127.0.0.1:7300
# or the radio's cable (close term.py and anything else holding it)
../.venv/bin/python tools/bridge.py --serial /dev/cu.usbserial-114220      # ls /dev/cu.usbserial-* for the name
npm run dev    # then http://localhost:1420 > Bridge  (or a build: http://localhost:4173/?bridge)
```

`-v` logs every byte. The cable tops out at 460800 on the Mac with the CH340 cable: at 921600 the radio switches but
never answers, so Console's ladder stays 460800, 230400, 115200.

End-to-end tests (`tests/e2e/`, Playwright with its Chromium: `npx playwright install chromium` once):

```sh
npm run e2e        # builds, then runs them against a headless simulator through the bridge (both started for the run)
npm run e2e:run    # the same without the build (dist/ must be current)
npx playwright show-report                     # the HTML report; failures keep a screenshot and a trace
```

Tests, one per flow: connect (Radio panel, Live View shows home), keys (MENU opens a screen, BACK returns home),
disconnect (BAUD 115200 and the port switched before closing), channels read (counts match INFO), edit and write
(a backup downloads first and holds the old name; the diff shows exactly that channel's name old to new; written and
read back by Console), read back (the radio holds the new name; then it is put back and checked), CHIRP (export,
import that file by merge, Write shows nothing to write). Step screenshots, the backups and the CSV land in
`test-results/shots/` (`FERRITE_E2E_OUT=dir` for another folder); `FERRITE_E2E_VERBOSE=1` shows the simulator's and
bridge's output.

Against the radio (the clear one or black, over the cable). **The write tests change the radio**: they rename one
channel and put it back (also when a test fails), and each write downloads a backup first. Name a scratch channel:

```sh
FERRITE_E2E_SERIAL=/dev/cu.usbserial-114220 FERRITE_E2E_CHANNEL=999 npm run e2e
```

`FERRITE_E2E_SERIAL` makes the run start the bridge with `--serial` (the `radio` project, longer time-outs); or
start a bridge yourself and pass `FERRITE_E2E_BRIDGE=ws://127.0.0.1:8765` (then `FERRITE_E2E_SERIAL` only picks the
radio's time-outs and the channel rule). `FERRITE_E2E_CHANNEL` is the channel's number as the radio shows it and is
required on the radio; on the simulator the last channel is used. Keep the backups from `test-results/shots/` until
the channel is checked on the radio.

### Desktop app (Tauri 2)

```sh
npm run tauri dev                          # the app window, with Vite's live reload
npm run tauri build -- --debug --bundles app   # target/debug/bundle/macos/Ferrite Console.app
cargo check -p ferrite-console-app         # just the shell's Rust
```

The Tauri CLI comes with `npm install` (`@tauri-apps/cli`); `cargo install tauri-cli` works too (`cargo tauri ...`).

Native transports are not in yet: the macOS and Linux webviews have no Web Serial or Web Bluetooth, so the shell
will move the bytes (serial through `serialport`, BLE through `btleplug`, FFE0/FFE1 only) behind the
`transport_open` / `transport_write` / `transport_close` commands in `src-tauri/src/lib.rs`, which answer "not
implemented yet" for now. The desktop app runs the demo radio meanwhile. iOS and Android go on the same base later.

## What works

- Connect: cable (Web Serial, CH340 and other common USB-serial chips, 115200 8N1), Bluetooth (Web Bluetooth,
  service FFE0, characteristic FFE1, 20-byte writes 25 ms apart; FF31 is never asked for), or the demo radio.
- The session as `ferrite_link.py` runs it: Ctrl-C, 300 ms, 0x00 to take the cable; a 0x00 sync before a request
  after 5 s quiet; one request at a time; time-outs 2 s on the cable, 6 s on Bluetooth; HELLO, INFO and UI sent
  once more after a resync if nothing came back (never KEY, CMD, MORE or a write); `busy` asked again for 3 s;
  text answers paged with MORE; a long press holds the link 800 ms.
- PIN: when HELLO says the radio's PIN lock is on (Bluetooth, LINK-30), the bar asks for it and sends AUTH.
- The cable's rate (LINK-11, LINK-13.3): after INFO, BAUD 460800, else 230400; a HELLO that doesn't come back at the
  new rate puts the port back at 115200, waits out the radio's own fall-back and HELLOs there.
- Radio panel: firmware, build (receive / tx / tx+dry, bench), callsign, unique ID (20 base32 digits in groups of
  five, as About and `ferrite_link.py info` show it; click to copy), what it holds, the link and its rate.
- Live View: the UI readback polled while connected (cable: a readback, then 150 ms; Bluetooth: back to back, about
  one a second), drawn as a 240 x 320 portrait screen: status bar, home's cards (the active one large, with the
  frequency, chips and S-meter), list rows with the selection, help, toasts, popups, the quick menu, the hint bar,
  and any other line the screen sends as text. Size 1x, 1.5x or 2x; pause (Live); keypad on or off.
- Keys: the drawn RT-950 Pro front (OK/MENU, A·B·C, the arrows, BACK, V/M, 0-9, *, #, SIDE1, SIDE2, the knob).
  Click = short press; hold 0.75 s = long press (sent at the threshold); Shift-click = long. The knob: click its
  left or right half, or scroll on it or on the screen. Keyboard: digits, Enter/M, Esc/Backspace, arrows, S, V,
  Q, W, `,` `.` for * #, `[` `]` for the knob, Shift for long. There is no PTT: the core has no name for one.
- Light and dark themes (the radio's own dark and daylight palettes).

## Stubbed or later

- The pixel mirror (SCREEN, LINK-18): `PixelScreen.svelte` draws RGB565 rectangles; nothing feeds it until the
  firmware sends SCREEN. The Screen option shows it as "soon".
- Receive audio over the cable (LINK-13.1): a place in the Live View, nothing plays yet.
- Native transports in the desktop app (above).
- Sidebar sections marked "Soon": Activity Log, Radio Settings, Terminal, Firmware Update.
- Channels & Zones: range presets and the settings record (the link reads and writes them too; not in the table
  yet); channel positions (CHAN-2: not in the link's channel record, so a write keeps the radio's); RepeaterBook
  import; drag to reorder; the table draws every row (fine for a few hundred; 1,000 rows are slow to scroll).
- Deleting a zone in the middle rewrites the zones after it (names and settings move up one) and moves their
  channels: correct, but more writes than a radio-side "delete zone" would need. Only trailing zones are deleted
  over the link.

## Channels & Zones (phase 2)

- **Read from radio**: `INFO` for the counts, then every zone (`READ` what 3, index 0..zones) and channels by
  number (`READ` what 2, 0..999, `not found` skipped) until INFO's channel count is found, each in 200-byte parts.
  The Live View's polling pauses meanwhile. Records are decoded in the core with ferrite's own types.
- **The table**: Channels (number, name, RX, duplex, offset or split TX, mode, TX and RX tone, power, step, squelch,
  zone, skip, priority, APRS, RX only, hidden, busy lockout, reverse, end tone, tail) and Zones (name, channel
  count, scan all, shown, by distance, resume, dwell, priority channels). Cells edit in place; each change is
  normalised by the core and checked by ferrite's own link code (a red `!` with ferrite's words, e.g. "rx:
  0.15-64 MHz (HF), 64-630 or 756-1300 MHz"). Changed rows amber, new ones green. Filter by zone, find by name, MHz
  or number; renumber by editing #; add and delete channels and zones; Undo edits.
- **Write to radio...**: (1) reads the radio afresh and downloads it as a backup file
  (`ferrite-CALL-YYYYMMDD-HHMMSS-backup.json`); (2) the core plans the write against that read and runs the whole
  plan through ferrite's own link session (`radioside.rs`: ferrite-app's `App` and `link::Session` over an
  in-memory store seeded with the radio's set), so every refusal shows before anything is sent and the write
  button stays off until there are none; (3) the diff: added, changed (each field, old to new), deleted; and a note
  if the radio changed since the table was read; (4) on confirm one write session: `BEGIN` n, zone writes (new
  zones are the next index), channel deletes, channel writes, trailing zone deletes last first, `END` (always
  sent); it stops at the first refusal; (5) reads back and says whether the radio now holds the table.
- **CHIRP CSV**: Import (merge by number, or replace every channel; notes for lines changed or skipped) and Export,
  CHIRP's generic CSV columns. Mapping (`core/src/chirp.rs`): Location = the channel number as the radio shows it
  (1-1000; a file starting at 0 is moved up one); Duplex `off` = RX only, `split` = Offset holds the TX frequency;
  Tone/rToneFreq/cToneFreq/DtcsCode/DtcsPolarity/RxDtcsCode/CrossMode to and from the RX and TX tone words (every
  pair round-trips; `TSQL-R`/`DTCS-R` import without tones); Skip `S` skip, `P` priority; Power High/Mid/Low (watts:
  4 W up High, 1.5 W up Mid); Comment = the zone's name; modes FM, NFM, AM, USB, LSB, CW (others skipped); TStep to
  the radio's step if it has it (else 12.5 kHz). New channels get squelch Global; a merge keeps what CHIRP can't hold (squelch, busy lockout, reverse, APRS,
  hidden, end tone, tail) from the channel it replaces, so an export imported back changes nothing. Each imported channel is
  checked by ferrite's code; refused ones are skipped with the reason.
- **Backup**: Back up radio (a fresh read to a file), Save table (the table, same format), Load file (a backup into
  the table; Write then shows the diff back to it and asks: that is the restore). The file is Console's JSON
  (`"format": "ferrite-console-channels"`, version 1): each record as the link's bytes in hex, with the number and
  name beside it for reading; the radio's firmware, callsign and unique ID when known.
- **Demo radio**: its records are ferrite's own (`READ`/`WRITE`/`DELETE`/`BEGIN`/`END` go to `radioside.rs`),
  seeded with 22 channels in 5 zones (`demo::demo_set`), so the whole flow, checks included, runs with no radio.
- **Cable rate on the way out**: Disconnect sends `BAUD 115200` (port switched, a `HELLO` there) before closing,
  and a page closed while connected sends the `BAUD` alone (best effort, LINK-11's fall-back does the rest), so
  `tools/flash.py` and the terminal find the radio at 115200.

Tests (`npm test`): the channel and zone records against ferrite's real link session (read out byte for byte, written
in through its `apply`, refusals with its reasons), views and tone words, the write plan (order, diff fields, zone
removal, ferrite's refusals in the dry run, backup round trip), CHIRP (every column, a round trip, every tone pair),
and the demo radio's records read back over the wire.

## After UV Studio

The overall concept, page structure and naming follow F4HWN's UV Studio (a browser tool over Web Serial, no
install), in Ferrite's own look:
- The sidebar groups sections as UV Studio does: **Viewer** (its "UV Viewer": Live View, Activity Log, after its
  Live Viewer and RF Log), **Tools** (its "UV Tools": channels, settings, terminal, firmware update) and
  **Console** (its "UV Studio": About).
- The connection flow: a status line ("Disconnected", then "Connected: ..."), a "Ready to connect" panel on the
  screen until connected, Connect buttons, and Disconnect (its Detach).
- Live View is its Live Viewer: the screen with a virtual keypad beside it that can be hidden (its Keypad toggle),
  a display size option (its pixel size), and a Keyboard Controls panel with Shift for long presses as UV Studio
  does.
- Not-yet sections carry a small tag ("Soon", where UV Studio tags "Labs only").

## Manual test (Chrome, for Alex)

Start `npm run dev` and open `http://localhost:1420` in Chrome. Close `term.py` or anything else holding the cable.

Cable:
1. Connect > Cable; pick the CH340 port. The bar goes "Connected: Cable (CH340)" and then shows the rate:
   expect "460800 baud" (or 230400; "115200 baud (the radio kept its rate)" if the firmware refuses BAUD).
2. The Radio panel: firmware, build (the clear radio: tx; black on tx-bench: tx+dry, bench), callsign, unique ID
   matching About on the radio (MENU 0 9 9) and `ferrite_link.py PORT info`.
3. The screen matches the radio's home: slots, frequencies, the active slot's frame, the hint bar. Readback time in
   the Display panel (expect well under 200 ms at 460800).
4. Click MENU: the radio opens quick settings and the screen follows within a moment. ▲▼ move the selection; BACK
   returns. Hold MENU 0.75 s (or Shift-click): advanced settings. Hold #: key lock (padlock in the bar); hold # again.
5. The knob: click its right half, then scroll on the screen: the frequency steps on the radio and here.
6. Keyboard: 0-9, Enter, Esc, arrows, S (slot changes), V (V/M), [ ] (knob).
7. Unplug the cable: the bar says it was unplugged and returns to Disconnected. Plug back, Connect again.
8. Disconnect, wait 10 s (the link lets the cable go), then `term.py` opens the terminal as usual.

Bluetooth (the radio's Bluetooth on: MENU 0 9 2 1):
1. Connect > Bluetooth; the chooser lists "walkie-talkie" (the radio being tested: check the right one is on).
2. With a PIN lock on (MENU 0 9 3 1), the bar asks for the PIN; a wrong one says so; the right one connects.
3. The Radio panel fills; the screen updates about once a second (readback ~1000 ms in the Display panel).
4. Keys and the knob as on the cable; expect a second or so before the screen shows the change.
5. Walk out of range or turn Bluetooth off on the radio: the bar says Bluetooth disconnected.
6. Cable and Bluetooth at once (two tabs): both run (LINK-28).

Also: Light/Dark in the bar; Size 1x/2x; Keypad off; Live off stops the readbacks (the screen freezes) and keys
still work.

Channels & Zones on the clear radio over the cable (460800). Nothing is written until step 6, and step 6 saves a
backup first. Keep the downloaded backups until done.
1. Connect > Cable (expect 460800). Channels & Zones > Read from radio. The bar counts zones, then channels;
   expect a few seconds. Count and names match the radio's channel list (V/M) and zones (◀▶ on home).
2. Back up radio: a `ferrite-CALL-...-backup.json` lands in Downloads. Open it: one record per zone and channel.
3. Spot-check five channels against the radio's editor: RX, offset or split, mode, both tones (a DCS one too),
   power, step, squelch, zone, skip, end tone and tail.
4. Edit: rename one channel, change one's TX tone to `D023N`, set one to RX only. Type `700` as an RX frequency:
   the row shows ferrite's refusal; put it back. Rows changed go amber.
5. Write to radio...: a second backup downloads first, then the diff lists exactly your three changes with old and
   new values, and no problems. Cancel: nothing changed on the radio.
6. Write again and confirm. The radio shows its progress screen and closes it; Console says it read back and the
   radio holds the table. Check the three channels on the radio itself.
7. Restore: Load file... > the backup from step 2. Write to radio...: the diff shows the three changes going back.
   Confirm; check on the radio that they are back.
8. CHIRP: Export, open the CSV in CHIRP (File > Import from file into a generic CSV) or a spreadsheet; tones and
   offsets look right. Import that CSV back (merge): the notes are empty and Write shows nothing to write.
9. Zones: + Zone, name it, add one channel to it, Write (zone written first, then the channel). Then delete that
   zone (its channel goes to no zone), Write: the channel write, then the zone delete. Check ◀▶ on the radio.
10. During a write press BACK on the radio's progress screen: Console stops with "cancelled on the radio (BACK)",
    re-reads, and Write shows what is left.
11. Disconnect, then within a few seconds run `tools/flash.py`'s port check or `term.py`: the radio answers at
    115200 without a power cycle. Also close the tab while connected and check the same.
12. Bluetooth (MENU 0 9 2 1): Read works but is slow (one round trip per record; time it and note it); a small write works the
    same way.

## Decisions made here

- The core is sans-I/O and the session logic (time-outs, retries, paging) lives in TypeScript around it, so one
  code path serves the web build and the Tauri app's webview; the native side will only move bytes.
- Structures cross the wasm boundary as JSON (no serde-wasm-bindgen): fewer dependencies, the payloads are small.
- A demo radio in the core (`core/src/demo.rs`) for trying the UI without a radio and for the core's end-to-end test.
- Web Serial's chooser is filtered to common USB-serial vendor IDs (CH340, CP210x, FTDI, Prolific).
- Web Bluetooth filters on service FFE0, as ferrite's `tools/webble` does.
- Keypad presses are short or long only (KEY short/long); KEY down/up are in `Link.key` for later (holds such as
  SIDE1 monitor while held).
- The cable's faster rate is on by default; a refusal or no answer leaves the link at 115200 and says so.
- The bridge is a development tool, not a transport for users: it shows only in `npm run dev` or with `?bridge`,
  listens on 127.0.0.1 and refuses pages from other origins, so a web page can't reach the radio through it.
- End-to-end tests drive the real UI (buttons, the table, downloads, file inputs) in Playwright, not Console's
  internals, and check the radio's side by reading it back; they run on the simulator by default.
- Phase 2: the record layouts come from ferrite-app by path (its types and `Persist` impls); the field order of a
  link record is `link.rs`'s `channel_save`/`zone_save`, which are private there, so `channels.rs` calls the same
  `save`/`load` in the same order and the tests check the bytes against ferrite's real link session.
- The demo radio and the pre-write check run ferrite's own radio side (`App` + `link::Session`) in memory, rather
  than a Console copy of its checks; it costs wasm size (the core is about 1.2 MB, 350 KB gzipped).
- The table edits views (frequencies as MHz text, tones as the terminal's one-word form, TERM-35.2), converted by
  the core both ways; the diff and the write work on the radio's records.
- Write order: zones, channel deletes, channel writes, trailing zone deletes. A write stops at the first refusal
  and always ends the session (`END`); then Console reads back.
- Backup files are Console's own JSON with the link's record bytes (exact, version-tied as LINK-21 says), not CHIRP
  CSV (which can't hold zones, end tones or flags).
- CHIRP: Location is the radio's channel number (1-1000), a 0-based file moved up one; Comment carries the zone
  name; new channels get squelch Global, merged ones keep the fields CHIRP has no column for; WFM and digital modes are skipped.

## Radio Settings

- Read, edit, write the settings record (`READ`/`WRITE` what 1); groups, numbers, names and values as MENU 0 shows them.
- All from ferrite's own App in the core (`core/src/settings.rs`): choices by turning the knob on the menu row, changes by its `set`.
- Read only, "changes only on the radio": LINK-5's (region, Extend TX, PIN, cable port, KISS port), found by a dry write.
- Not shown: what isn't in this record (APRS's own record isn't on the link yet; Watch, Battery Save, Dry TX); each group lists them.
- Write: backup file, diff, ferrite's dry run, write, read back. Load file + Write restores.
- Tests: `core` (record against ferrite's session, set, diff, write and read back); e2e `settings.spec.ts` (Key beep, Beep volume, restore).
