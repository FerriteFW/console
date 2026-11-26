# Radio journey

Console driven as a user drives it, against a real radio. A second program checks each step on the radio itself.

- **Run:** `npm run build:dev && npm run radio`. Local only, never in CI.
- **Radio:** `FERRITE_RADIO=black` by default, from `~/.config/ferrite/radios.toml`. It needs `cable = true` and a Bluetooth ID.
- **Cable:** the one plugged in, or `FERRITE_RADIO_SERIAL`.
- **One stage:** `npm run radio -- tests/radio/30-channels.spec.ts`.

## How it drives Console

- **Playwright, by role and name.** It clicks the buttons and fields a user sees, in Chromium.
- **Bridge on the cable.** The cable goes through the development bridge (`tools/bridge.py`). The bridge moves only bytes and the baud rate.
- **Why not Web Serial:**
  - Chrome's port chooser can't be automated.
  - The CH340 has no serial number, so Chrome doesn't remember a grant.
- **Why not the desktop app:** macOS's WKWebView has no WebDriver.

## The radio's own answer

- **What `oracle.py` is:** a second session on the radio's Bluetooth. It runs alongside Console, which holds the cable.
- **What it reuses:** `ferrite/tools/ferrite_link.py`.
- **What it does:** it reads and presses keys only. It never writes and never keys.
- **Why it matters:** each write is checked on the radio itself (records, `get` lines, the screen), not only by Console's read-back.

## Stages, in order

| Stage | Console does | The radio is checked for |
|---|---|---|
| setup | | Its build is the one radios.toml names; a snapshot of its numbers and settings |
| 10 connect | Connect, Live View, a key | Same firmware, build and screen; the key moved it; no pending data move |
| 20 settings | Read, flip Key beep, write, flip back | `get 0 7 5 1` says each value; the record ends byte for byte as it began |
| 30 channels | Read, + Add channel, rename, delete, each written | The record's name and RX after each write; gone after the delete |
| 40 library, zones | FRS from the library into a new zone; then those 22 and the zone deleted | 22 more channels in one more zone, FRS 1 on 462.5625; then the numbers as they began |
| 50 backup | Back up everything; open it again | The file holds every part and the radio's channel numbers; nothing to write |
| 60 stock * | Back to stock: the radio's backup and stock's firmware | (The radio runs stock: no Bluetooth check) |
| 70 install * | Install: back up the whole radio, save it, install Ferrite | Console connected to Ferrite as usual |
| 80 update ** | Firmware Update with a local image | The radio answers with that build; it lost nothing |
| 85 restore * | The stage-50 backup opened and written: settings, then channels | The radio answers over Bluetooth again; its channels are back |
| 90 end | | Firmware, channel, zone and preset numbers, and settings as at the start |

- Each stage that changes the radio puts it back, even when it fails. A failure stops the run.
- `*`: `FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1` only.
- `**`: `FERRITE_RADIO_FLASH=1` only.
- The flashing stages never run on the simulator.

## Without a radio

`FERRITE_RADIO=sim npm run radio`: a headless simulator, checked over its Bluetooth side. Use it to try the stages' scripts. The flashing stages skip.

## A run with the flashing stages

1. **Image:** in `../ferrite`, `tools/mkbtf.sh tx-bench` makes `target/ferrite-txbench.ffw`. `FERRITE_RADIO_IMAGE` names another.
2. **Backup's radio ID:** in radios.toml, add `uid = "..."` to the radio's block. It's the ID About shows on the radio the backup came from, checked by hand.
   - Console asks for it when it can't tell a backup's radio (decision 263).
   - The stage types it only when the radio on the cable shows the same ID.
3. **Stock firmware:** `FERRITE_RADIO_STOCK_BTF`, else `firmware/stock/RT_950Pro_V0.29_OEM.BTF`.
4. **Run:** `FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1 npm run radio`. About 40 minutes, most of it the whole-radio backup and the flashes.
5. **Afterwards:**
   - Install leaves the installed image on the radio.
   - Its whole-radio backup (`.fbin`) and the stage-50 `.ferrite` stay in `test-results/radio-run/`.
   - Keep them private, like every radio backup.

## Not yet

- **The 0.9.7 fallback:** the Live View theme guess for a radio that doesn't send `theme=`. It needs a radio on 0.9.7.
- **Finish the update** (a data move): only Alex moves a radio's data, by hand. The connect stage stops when a move is pending.
