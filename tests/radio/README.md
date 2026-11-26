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
| 90 end | | Firmware, channel, zone and preset numbers, and settings as at the start |

Each stage that changes the radio puts it back, even when it fails. A failure stops the run.

## Not yet

- **Zones**, and **Add from library** (a fixed set).
- **Update:** install a local tx-bench `.ffw` from the Firmware page. It flashes, so it runs only when asked.
- **Install from stock:** Back to stock from the radio's backup, then Install. It flashes twice, so it runs only when asked.
- **Finish the update** (a data move): only Alex moves a radio's data, by hand. The connect stage stops when a move is pending.
