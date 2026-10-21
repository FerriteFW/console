# Ferrite Console

The companion app for Ferrite on the Radtel RT-950 Pro: live view, remote keys, channel programming.
Private until the licence is chosen.

## Layout

- `core/`: the Rust core. Link sessions, answers, the UI readback, keys, channel records, the write plan, CHIRP CSV, the channel library. It reuses ferrite's own code by path (`../ferrite`).
- `wasm/`: the core for the browser, built into `src/core-wasm/` by `npm run wasm`.
- `src/`: the Svelte 5 UI (Vite).
- `public/data/`: the channel library's data. See [tools/library/README.md](tools/library/README.md).
- `tools/bridge.py`: the dev bridge. A local WebSocket to a serial port or the simulator.
- `tests/e2e/`: Playwright end-to-end tests.
- `src-tauri/`: the Tauri 2 desktop shell.

## Setup

- Node 20+, npm, Rust via rustup (`rust-toolchain.toml` pins it).
- `cargo install wasm-bindgen-cli --version 0.2.129 --locked`
- The ferrite checkout next to this one (`../ferrite`), and git access to `infamy/udigimodes`.
- `npm install`, then `npx playwright install chromium` once for the e2e tests.

## Run

```sh
npm run dev                                    # http://localhost:1420 in Chrome
npm run build                                  # the web build in dist/
npm run tauri dev                              # the desktop app
npm run tauri build -- --debug --bundles app   # Ferrite Console.app
```

- `?demo` connects the demo radio. `?demo&press=MENU,DOWN` presses keys. `?theme=light` picks the theme.
- `?bridge` shows the Bridge button outside `npm run dev`.

## Test

```sh
npm test            # the core's Rust tests
npm run e2e         # build, then the e2e tests on a headless simulator through the bridge
npm run e2e:run     # the same without the build
```

- On the radio: `FERRITE_E2E_SERIAL=/dev/cu.usbserial-114220 FERRITE_E2E_CHANNEL=999 npm run e2e`.
  The write tests rename that channel and put it back. Keep the backups from `test-results/shots/`.
- The library's write test is skipped on a radio (it adds 22 channels).
- On the Xeon, from `rt950pro/`: `rsync -az --delete --exclude target/ --exclude node_modules/ --exclude test-results/ ferrite-console ferrite infamy@192.168.7.162:code/rt950pro/`.
  Then there: `cd ~/code/rt950pro/ferrite-console && PATH=$HOME/.cargo/bin:$PATH npm run e2e` (~45 s).
- Screenshots land in `test-results/shots/`. `FERRITE_E2E_VERBOSE=1` shows the simulator and bridge.
- The manual radio checklist: [docs/TESTING.md](docs/TESTING.md).

## What works

- Connect over the cable (Web Serial), Bluetooth (Web Bluetooth) or the demo radio.
- PIN prompt when the radio's Bluetooth PIN lock is on.
- Cable at 460800 or 230400 baud; back to 115200 on disconnect.
- Radio panel: firmware, build, callsign, unique ID.
- Live View: the radio's screen from the UI readback, at 1x, 1.5x or 2x.
- Remote keys: the drawn keypad, the knob, the keyboard. Never PTT.
- Channels & Zones: read, edit in place, write with a backup and a diff first.
- Every edit is checked by ferrite's own code. Changed rows amber, new rows green.
- CHIRP CSV import and export.
- Backup files: save, load, restore.
- Add channels: fixed sets (FRS, GMRS, MURS, PMR446, marine, weather, BC resource roads, calling).
- Add channels: airports near a place (AM, RX only), place typed or from the radio's GPS or fixed position.
- Add channels: Canadian licensed sites (TAFL) near a place, grouped by licensee.
- Radio Settings: every menu setting by its number and name; write with a backup and a diff first.
- Terminal: the radio's command line, with history; `key`, `txtest` and `xb start` refused.
- Light and dark themes.

## Not done yet

- Repeaters in Add channels. NeonPlug's list is DMR only, with no tones or coordinates (the tab says why).
- The pixel mirror (SCREEN) and receive audio over the cable.
- Native transports in the desktop app (it runs the demo radio).
- Activity Log, Firmware Update.
- APRS settings in Radio Settings (the link doesn't carry the APRS record yet).
- Range presets and the settings record in the table.
- Channel positions, drag to reorder, a virtual table for 1,000 rows.

## More

- [docs/DECISIONS.md](docs/DECISIONS.md): design decisions.
- [docs/TESTING.md](docs/TESTING.md): manual checks on the radio.
- [tools/library/README.md](tools/library/README.md): where the library's data comes from.
