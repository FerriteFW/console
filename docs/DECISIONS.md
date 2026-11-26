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
- Since Oct 23, 2026 the cable runs at 230400 (ferrite decision 266): long transfers at 460800 lost bytes through a USB extension. 230400 is the safe rate for everything.
- Since Nov 16, 2026 Console keeps the cable at 115200 on Windows (the app and browsers): Windows and Console struggled above it. Backups there use fdumpz at 115200 too. Other platforms are unchanged.
- Since Nov 17, 2026 (ferrite decision 408) the cable runs at 115200 with no compression everywhere; Live View's High speed raises it to 230400 (and the backup's read). Users' cables lost bytes at 230400, and with compression a lost frame stalled the link until a resync. Bluetooth keeps compression.

- Nov 18, 2026 (Alex): Bluetooth at 115200 steps down to 9600 by itself when it loses data. At the edge of range the air resends, the module's small buffer (about 160 bytes) overruns, and long answers lose frames while short ones get through (a user's Windows log: every satellite list read stalled 7-9 s with gaps). Two losses (a missing frame, a resync or an unanswered request; one loss's own retries count once) within a minute: once any transfer has finished, Console asks the radio for 9600 and reconnects without the module's unlock, and the bar says "Bluetooth at 9600 (115200 was losing data)". Reconnects stay at 9600; a new Connect tries 115200 again. `src/lib/bleStep.ts`.
## Events and Live View (Oct 20, 2026)

- One subscription per session (LINK-46): Console ORs what each part wants. APRS pages want heard and messages while open.
- Bluetooth's Live View is the radio's compact updates (mask 4), decoded by ferrite's own `liveview::apply` in wasm.
- A lost update or a bad check asks for the whole state (SUBSCRIBE without renew). So does 12 s with no update.
- The cable keeps polling the text readback. Measured on the simulator: one readback is ~760 B. At 230400 the cable has room; the updates gain little there.
- `?liveview=events` uses the updates on the cable too; `?liveview=poll` polls on Bluetooth.
- Firmware without SUBSCRIBE (`unknown type`): polling, and the APRS pages say the firmware is too old.
- Disconnect ends the subscription first, so events don't run on into `term.py` or `flash.py`.

## Event Log and APRS

- The radio's event log is the Event Log here too (was Activity Log; renamed Oct 24, 2026, one name for one thing).
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
- Oct 30, 2026 (Alex): one codeplug file, `.ferrite`: a zip with `manifest.json` and each part as Console already writes it (`channels.json`, `settings.json`, `aprs.json`, `contacts.json`; a part may be missing). The zip is NeonPlug's own writer and reader (`src/lib/zip.ts`), no library. Save as… and Back up radio save it on every page; Open… loads every part into its page as unwritten changes. The per-page backup taken before a write stayed a single-part `-backup.json` (until Nov 25, 2026: kept in memory now, below). Spec: `docs/dev/codeplug-format.md` (docs repo).
- Nov 18, 2026 (Alex): channels and zones can be reordered. A channel's number is its place on the radio, so a move renumbers. Dragged by its handle in the table (or ↑ ↓ on the handle, or a used number typed in its panel), a channel takes the number it lands on, and the channels from there to its old place move one along, stopping at the first free number, so nothing past a gap changes. In a zone (drag, or ▲ ▼), the zone's own numbers are shared out again in the new order, and no channel outside the zone is renumbered. A zone dragged in the list (or ▲ ▼ by its name) moves the zones it passes one along, and its channels go with it. Priority channels and the home channel follow their channels. Each move is one undo, and the notice says what moved. A slot on the radio follows the number, not the channel, so the notice says so.
- Nov 25, 2026 (console#55, #104): more ways to arrange the channels, all on the same rule as a drag: a channel pushed out of its number moves one along as far as the first free number, so a gap stops the shift. **Show empty numbers** (per viewer, only with All zones and no search) shows the free numbers as rows, a run of more than five as one row, plus the one after the last channel; a drop there takes that number. **Insert channel above / below** (right-click a row, or its ⋯) adds a channel there, in the row's zone when it has room; refused with the reason when every number up to 4000 is used. **Move to…** (bulk bar, row menu, or dragging a ticked row) puts the ticked channels on continuous numbers from the one typed, in their order: moving up the table the ones in the way go down into the numbers the block left, moving down they close up behind it. **Renumber…** numbers every channel 1..n top to bottom, asked first with how many change. The number shuffling and the fix-ups (priority channels, home channel; zone members follow by themselves) are the core's (`core/src/arrange.rs`), and the existing drag and swap apply their maps through it too. The write plan stays a diff by number; it also names the channels that only changed number (`Plan.moves`), and the write dialog shows those as one "moved" line each.

## CHIRP CSV

- Location is the channel number (1-1000). A 0-based file moves up one.
- Comment carries the zone name.
- New channels get squelch Global. A merge keeps the fields CHIRP has no column for.
- WFM and digital modes are skipped.
- Nov 19, 2026: a merge keeps a channel's zone, no zone included, when the file names none: the CHIRP zone (Nov 16) is for channels the table doesn't have yet, and Replace. It had put the table's own unzoned channels in CHIRP, so an export and import was no longer a round trip with nothing to write (the e2e test had failed since).

## Channel library (Add channels)

- Ported from NeonPlug (Alex's app): fixed sets, airports and TAFL. Data and generators copied, small fixes.
- Fixed sets and airports are static files in `public/data/`. Airports load only when their tab opens.
- Licensed sites (Canada's TAFL, the US FCC's ULS) come from FerriteFW/data at data.ferritefw.dev, tiled by grid square (Oct 30, 2026).
  Only the tiles a place's circle touches are fetched. They stay in Cache Storage (web and desktop alike), keyed by the source's build date.
  A newer build is offered as "Update channel data", never fetched by itself.
  "Save for offline" in the tab's footer downloads a source's zip, checks its SHA-256, and keeps every tile.
- Each site's mode comes from the data: NFM or FM. Digital only is hidden unless asked for; unknown takes the tab's mode. Mobile frequencies are kept and marked.
- Entries become channels in the core (`library.rs`), not in the UI.
- Every channel goes through ferrite's own check. If ferrite refuses TX, it is retried as RX only and said so.
- A set takes the first run of free numbers that holds it all; else the gaps.
- Zones match by name, or a new one is made at the end.
- An entry the table already holds (same RX, TX, mode, zone) is skipped.
- Airband is AM and RX only. Names are "ICAO TYPE", with the MHz when an airport has two of a type.
- Licensed sites default to RX only. These are other licensees' channels.
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
- Ferrite images only (the "Ferrite terminal" mark), up to 1,012 KB (`APP_MAX`, ferrite decision 338: 948 KB before). Stock goes back from the Install page.
- The checks are `btf.py`'s, ported to `core/src/firmware.rs`. The core makes every frame, only from a checked file.
- The frames are hello, model, count, the blocks, end. Nothing else reaches the bootloader.
- REBOOT (LINK-24), then probes at 115200. No stock `PROGRAMBT9000U` nudge: Ferrite answers REBOOT.
- REBOOT `busy` (transmitting) is shown, and the session goes on.
- A failed block keeps the cable held. Resume probes again, no REBOOT. A reloaded page can resume from the cable.
- Tests: the bridge's fake bootloader (`tools/fakeboot.py`) on the simulator. Never a radio from the tests.
- Oct 20, 2026 (Alex): the Tauri desktop app is parked as is: it builds and runs, no more work on it. The web Console comes first. A phone app needs its own small-screen UI whatever wraps it; likely native (SwiftUI) on the Rust core, decided later. Keep the core free of web-only code.

## Install page

- Oct 22, 2026 (ferrite decision 261): its own page (`#install` alone, `#/install` in the sidebar). Connect, Back up, SSB, Install unlock in order; nothing writes until the backup is verified against the radio's flashcrc and saved.
- The backup is a plain 4 MB `.bin` named with the radio's ID, so `flash.py --backup` takes it too.
- Oct 22, 2026 (ferrite decision 263, replacing the calibration-CRC check): Back to stock tells the backup's radio by its MCU unique ID, not by calibration. Both of Alex's radios have byte-identical calibration sectors, and clear's backup was written into black. Ferrite's `START` answer now ends with the ID. Console knows the backup's ID from its file name (`rt950pro-backup-<ID>-<date>.bin`) or from this browser's record of the backup's SHA-256 (localStorage). A different ID is refused: nothing is written, the radio restarts. An unknown ID (a renamed file, another browser) is refused the same way until the owner types this radio's ID. The calibration CRC stays as a check against a damaged file.
- Save backup uses Chrome's save dialog when there is one (written once, read back, then Saved) and the download otherwise; a download isn't started twice (a second press said nothing visible and gave `name (1).bin`).
- The bundled release and reader are copied in by `npm run bundle-firmware`, never committed; the page uses them only when their SHA-256 matches the manifest.
- Oct 28, 2026: release signatures (UPD-15). Ferrite's CI signs each image with minisign (`X.btf.minisig`); the radio can't check it, so Console does, with Ferrite's public key (`core/src/signature.rs`). A signature that verifies shows "Signed by Ferrite:" and its trusted comment. One that doesn't is refused like a failed image check. No signature (someone's own `mkbtf.sh` build) is allowed and shown as "Not signed: not a Ferrite release". The bundle script puts a `.minisig` beside the image into the manifest.
- Back to stock writes only Ferrite's writable ranges (`layout::WRITABLE`), never calibration or the update area, and reads them back by CRC.
- Nov 1, 2026 (ferrite decision 338, BACKUP-12): Ferrite may use the MCU's top 64 KB, stock's marker sector (one word, UV85 or BJ90, the model name on stock's info page). The backup reads its first 16 bytes with the reader's `mdump 0x080F0000 16` and shows them ("Model marker"); a stock word goes in the file name (`...-UV85.bin`) and every read in this browser's record by the backup's SHA-256. Back to stock sends the stock image padded with 0xFF through 0x080F07FF (951 blocks instead of about 371: about a minute longer), the word put back when there is one; without one the page stays erased and stock shows its default model name. A reader without `mdump` leaves it unrecorded (assumed blank).
- Nov 24, 2026 (console#85): CHIRP round trips lose nothing silently. An RX-only channel is Duplex `off` with its TX frequency in Offset (as a split writes it), so a + or - shift or a split comes back; on import an `off` Offset above 10 MHz or within 10 MHz of RX is a TX frequency, a smaller one a shift left in the file (CHIRP keeps a turned-off channel's offset), taken as +. The TX frequency, not the shift, because the shift alone loses its direction; the one form not told apart is a split within 10 MHz of RX, which comes back as the same TX written as a shift. A signed Offset is the direction when Duplex is blank. Names keep leading spaces both ways (quoted on export; CHIRP's own reader keeps them, and the radio holds them), rather than stripping them in the core, which would rewrite channels already on radios. Skip and priority both export as S, said on the export; channels left out of an export are said by number.
- Nov 25, 2026 (Alex; ferrite decision 456, LINK-21.2, LINK-21.3; console#43, console#106): the read before each write stays in memory until Console closes (`src/lib/prewrite.ts`, the newest three per kind), never a file by itself; the write dialog offers Save this backup… (a `.ferrite`) and, once written, Put the radio back (the read loaded into its page, then that page's write). Saves go through `src/lib/download.ts`: the desktop app's dialog, else Chrome's and Edge's `showSaveFilePicker` opened from the click before any radio read (a cancel says "Not saved"), else a download worded "Saving NAME — check your browser's downloads", never "saved".
