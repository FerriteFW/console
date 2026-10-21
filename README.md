# Ferrite Console

The web and app companion for Ferrite on the Radtel RT-950 Pro: live view, remote keys, channel programming.
Private until the licence is chosen.

Phase 1 (this): connect over the programming cable or the radio's Bluetooth, see the radio's screen (drawn from the
UI readback) beside a drawn keypad, and press keys and turn the knob from the computer. Remote keys never transmit.

## Layout

| Path | What |
| --- | --- |
| `core/` | The Rust core (`ferrite-console-core`): link sessions (sans I/O), answers (`HELLO`, `INFO`, `SLOT`, text), the UI readback parser, key codes, the unique ID's text, record payloads for phase 2, a demo radio. It reuses ferrite's own code by path (`../ferrite/crates/ferrite-core`: the frame codec, message and status numbers, the key map, the unique ID's base32), never a copy. |
| `wasm/` | The core for the browser (wasm-bindgen). Built into `src/core-wasm/` (not in git) by `npm run wasm`. |
| `src/` | The Svelte 5 UI (Vite). `lib/link.ts` is the session logic (mirrors `ferrite/tools/ferrite_link.py`), `lib/transport/` the byte pipes (Web Serial, Web Bluetooth, demo, native stub), `lib/components/` the screen, keypad and panels. |
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
- Sidebar sections marked "Soon": Activity Log, Channels & Zones (phase 2), Radio Settings, Terminal, Firmware Update.

Phase 2 (channels and zones) builds on `core/src/records.rs` (READ in 200-byte parts with a `Reader`, WRITE parts,
DELETE, BEGIN/END payloads; exported through `wasm/`) and `Link.ok()`; the record layouts come with it.

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
