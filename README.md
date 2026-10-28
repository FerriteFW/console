# Ferrite Console

The companion app for Ferrite on the [Radtel RT-950 Pro](https://www.radtels.com/products/radtel-rt-950-pro-27mhz-tx-rx-10w-walkie-talkie-am-fm-usb-lsb-cw-receive-gps-aprs-wireless-bluetooth-phone-programming-noaa-two-way-radio?ref=FERRITEFW&variant=44669996794064) (affiliate link: buying through it supports Ferrite, at no extra cost to you): live view, remote keys, channel programming.
[PolyForm Noncommercial 1.0.0](LICENSE.md), copyright 2026 Alex Harvey: free for any noncommercial use.

## Layout

- `core/`: the Rust core. Link sessions, answers, the UI readback, keys, channel records, the write plan, CHIRP CSV, the channel library. It reuses ferrite's own code by path (`../ferrite`).
- `wasm/`: the core for the browser, built into `src/core-wasm/` by `npm run wasm`.
- `src/`: the Svelte 5 UI (Vite).
- `public/data/`: the channel library's data. See [tools/library/README.md](tools/library/README.md).
- `tools/bridge.py`: the dev bridge. A local WebSocket to a serial port or the simulator (its cable or its Bluetooth side).
- `tools/fakeboot.py`: a fake stock bootloader the bridge runs after REBOOT, for testing Firmware Update on the simulator.
- `tests/e2e/`: Playwright end-to-end tests.
- `src-tauri/`: the Tauri 2 desktop shell. Native cable and Bluetooth; the protocol stays in the webview.

## Setup

- Node 20+, npm, Rust via rustup (`rust-toolchain.toml` pins it).
- `cargo install wasm-bindgen-cli --version 0.2.129 --locked`
- The ferrite checkout next to this one (`../ferrite`), and git access to `infamy/udigimodes`.
- The desktop app on Linux also needs `libdbus-1-dev` and `libudev-dev` (Bluetooth, USB names).
- `npm install`, then `npx playwright install chromium` once for the e2e tests.

## Run

```sh
npm run dev                                    # http://localhost:1420 in Chrome
npm run build                                  # the web build in dist/
npm run tauri dev                              # the desktop app
npm run tauri build                            # the .app and a .dmg in target/release/bundle/
```

- `?demo` connects the demo radio. `?demo&press=MENU,DOWN` presses keys. `?theme=light` picks the theme.
- The demo radio, the Bridge button and the readback harness are developer tools: in `npm run dev` and `npm run build:dev` (the e2e tests' build), never in a release build (`npm run build`, the desktop app).

## Test

```sh
npm test            # the core's Rust tests
npm run e2e         # build, then the e2e tests on a headless simulator through the bridge
npm run e2e:run     # the same without the build
```

- On the radio: `FERRITE_E2E_SERIAL=/dev/cu.usbserial-114220 FERRITE_E2E_CHANNEL=999 npm run e2e`.
  The write tests rename that channel and put it back. Keep the backups from `test-results/shots/`.
- The library's write test is skipped on a radio (it adds 22 channels).
- The CHIRP import tests (`chirp.spec.ts`) run on a radio too: each adds its own zone, then deletes it and its channels.
- On the simulator the tests run in parallel: each worker has its own simulator and bridge. The radio runs one at a time.
- On the Xeon: `npm run e2e:xeon` copies this checkout there, builds and runs it (~16 s of tests). Sync `ferrite/` first.
  `npm run e2e:xeon -- --dir code/rt950pro/other-dir` uses another checkout there (next to `ferrite/`).
- Screenshots land in `test-results/shots/`. `FERRITE_E2E_VERBOSE=1` shows the simulator and bridge.
- The manual radio checklist: [docs/TESTING.md](docs/TESTING.md).

## What works

- Connect over the cable (Web Serial), Bluetooth (Web Bluetooth) or the demo radio.
- The desktop app connects natively: the cable through `serialport`, Bluetooth through `btleplug`.
- The desktop app picks the port or radio in its own list. Radios show by device ID.
- PIN prompt when the radio's Bluetooth PIN lock is on.
- Cable at 230400 baud (115200 if the radio keeps its rate); back to 115200 on disconnect.
- Radio panel: firmware, build, callsign, unique ID.
- Live View: the radio's screen at 1x, 1.5x or 2x. The cable polls the UI readback; Bluetooth takes the radio's compact updates.
- Remote keys: the drawn keypad, the knob, the keyboard. Never PTT.
- Channels & Zones: read, edit in place, write with a backup and a diff first.
- Every edit is checked by ferrite's own code. Changed rows amber, new rows green.
- CHIRP CSV import and export. An import goes in as new channels in a new zone (the default when its numbers clash), by number, or replacing every channel.
- Backup files: save, load, restore.
- Add channels: fixed sets (FRS, GMRS, MURS, PMR446, marine, weather, BC resource roads, calling).
- Add channels: airports near a place (AM, RX only), place typed or from the radio's GPS or fixed position.
- Add channels: Canadian licensed sites (TAFL) near a place, grouped by licensee.
- Radio Settings: every menu setting by its number and name; write with a backup and a diff first.
- The model is the radio's own menu, found by running ferrite's App; a core test fails when the radio gains a setting Console doesn't show.
- Settings no record carries (Watch, Battery Save, the message sound, MENU 0 5's symbol, comment, ambiguity, Mic-E, telemetry, TX delay and level): read with the radio's `dump`, written as its `set` lines.
- Activity Log: the radio's event log with local times, a source filter, CSV export, positions to the map.
- APRS (Tools): messages by station with compose, heard stations with distances, a map, APRS settings.
- Heard stations and messages update live while an APRS page is open.
- Terminal: the radio's command line, with history; `key`, `txtest` and `xb start` refused.
- Firmware Update: a Ferrite `.btf` into a radio already on Ferrite, over the cable.
- Install (`#install` shows it alone): back up the whole flash, save it, SSB from your stock `.BTF`, install Ferrite. Back to stock writes the backup back and flashes the stock `.BTF`.
- `npm run bundle-firmware` copies the release and the reader image into `public/firmware/` (not committed).
- Light and dark themes.

## Not done yet

- Repeaters in Add channels. NeonPlug's list is DMR only, with no tones or coordinates (the tab says why).
- The pixel mirror (SCREEN) and receive audio over the cable.
- Signed and notarised desktop builds. Windows and Linux builds aren't tried yet.
- Range presets and the settings record in the table.
- Channel positions, drag to reorder, a virtual table for 1,000 rows.

## More

- [docs/DECISIONS.md](docs/DECISIONS.md): design decisions.
- [docs/TESTING.md](docs/TESTING.md): manual checks on the radio.
- [tools/library/README.md](tools/library/README.md): where the library's data comes from.
