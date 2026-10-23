# Manual checks on the radio

Start `npm run dev`, open http://localhost:1420 in Chrome. Close `term.py` and anything else on the cable.

## Cable

1. Connect › Cable, pick the CH340. Expect "460800 baud" (or 230400).
2. Radio panel: firmware, build, callsign, unique ID match About (MENU 0 9 9).
3. The screen matches the radio's home.
4. MENU opens quick settings; ▲▼ move; BACK returns. Hold MENU: advanced settings. Hold #: key lock.
5. Knob: click its right half, scroll on the screen. The frequency steps on both.
6. Keyboard: 0-9, Enter, Esc, arrows, S, V, [ ].
7. Unplug: the bar says so. Plug back, connect again.
8. Disconnect, wait 10 s: `term.py` opens as usual.

## Bluetooth (MENU 0 9 2 1)

1. Connect › Bluetooth. Pick the right "walkie-talkie".
2. With a PIN lock (MENU 0 9 3 1): a wrong PIN is refused, the right one connects.
3. Live View's toolbar shows B/s, not ms: the screen comes from the radio's updates. Idle: under ~100 B/s.
4. Keys and the knob show within about half a second. Open a menu: it draws in about a second.
5. Out of range or Bluetooth off: the bar says disconnected.
6. Cable and Bluetooth in two tabs: both run. The newest Live View subscription wins on the radio (LINK-47).

## Activity Log and APRS (cable or Bluetooth)

1. Activity Log: the rows match the radio's log screen. Times look right (local time). Source filter, CSV export.
2. Heard stations: the list matches the radio's heard list. Distances look right for the radio's GPS fix.
3. Leave it open while a station is heard: it moves to the top without Refresh.
4. Map: stations and the radio (green) on OpenStreetMap.
5. Messages: conversations match the radio. Only with Dry TX on (MENU 0 8 9 2): send one to yourself, check the radio's toast and its state.
6. APRS Settings: read, change Power, write (backup first). Check MENU 0 5 5 4. Load the backup and write it back.

## Channels & Zones (cable). Keep every backup until done.

1. Read from radio. Counts and names match the radio.
2. Back up radio: a backup file downloads.
3. Spot-check five channels against the radio's editor.
4. Rename one, set a TX tone `D023N`, set one RX only. Type `700` as RX: a red refusal. Put it back.
5. Write to radio…: a backup downloads, the diff shows exactly the three changes. Cancel.
6. Write and confirm. Console reads back: "the radio holds the table". Check on the radio.
7. Load file › the step-2 backup. Write: the three changes go back. Check on the radio.
8. CHIRP: export, import the same file. No notes; Write shows nothing to write.
9. + Zone, add a channel to it, Write. Delete the zone, Write. Check ◀▶ on the radio.
10. BACK on the radio during a write: Console says cancelled, re-reads.
11. Disconnect: `term.py` answers at 115200 without a power cycle.
12. Bluetooth: Read works, slowly (time it). A small write works.

## Add channels

1. Fixed sets › FRS › Add 22 into a new zone. Green rows, one new zone. Write; check the zone on the radio.
2. Airports › From radio: the radio's GPS fix (or fixed position) fills the place.
3. Pick the nearest airport, add. AM, RX only rows. Write; PTT on one does nothing.
4. Canadian sites (TAFL): filter, add a group. RX only, NFM rows.
5. Undo edits if you don't want them.

## Desktop app (macOS)

Open `target/release/bundle/macos/Ferrite Console.app` (unsigned: right-click › Open the first time). Close `term.py` first.

1. Connect › Cable: a list pops up under the bar. The CH340 (`usbserial-…`) is first. Pick it: "460800 baud".
2. Run the Cable checks above. Unplug: the bar says so. Disconnect: `term.py` answers at 115200.
3. Connect › Bluetooth: macOS asks for Bluetooth access once. Allow it.
4. The list shows each radio by its ID, strongest first. Clear is `5F9EEB12-…`, black `E5A6A6FF-…`. Pick one.
5. Run the Bluetooth checks above. Cancel and Esc close the list without an error.
6. Write a channel table: the backup file lands in ~/Downloads (the webview's downloads are the open question).

## Firmware Update (clear radio, cable). Alex only.

1. Have the current image as a fallback, and `flash.py` ready.
2. Build the new image: `tools/mkbtf.sh tx` in ferrite.
3. Connect › Cable. Firmware Update › Choose .btf. Version, size, blocks show; "Checks passed".
4. Pick a stock `.btf`: refused, "not a Ferrite image".
5. Update firmware…: the radio's firmware and build show against the file's version. Install.
6. The radio restarts; the bar says "Firmware Update holds"; blocks count up (about 85 s).
7. Done: Console connects again and shows the version. Check About (MENU 0 9 9) and a channel.
8. Optional, Dry TX on (MENU 0 8 9 2): hold PTT, press Install. Expect "it refused REBOOT (busy)".
9. If a block fails: the radio waits in the bootloader. Resume, or reload the page and use "Open the cable and resume".
10. If nothing answers: power-cycle the radio while Console waits, or fall back to `flash.py`.

## Install page (black radio, cable). Alex only.

Needs the `console-install` firmware (STOCK_RESTORE) for steps 9-14. Keep black's existing backups.

1. `npm run bundle-firmware` (ferrite's `target/ferrite-tx.btf` and `../fw/build/target/hwtest.btf`), `npm run build`, open `#install` in Chrome. The release check uses this default `tx` bundle (`bundle-firmware.mjs` defaults to `ferrite-tx.btf`); a bench radio may override it with the tx-bench image.
2. Connect cable. Back up the radio: the reader loads and the radio's screen says "Ferrite Console / Backing up your radio / Keep the cable in" with a percentage (not hwtest's diagnostics pages); "Reading the flash at 500 kbaud" counts up, then the flashcrc check. Note the time (expect about 4 min).
3. The Radio ID matches About (MENU 0 9 8). Save backup: Chrome's save dialog opens once; one file lands (no "name (1).bin"); the page says Saved with its name. The file is 4 MB, named `rt950pro-backup-<ID>-<date>.bin` with the radio's ID, and its SHA-256 matches `backups/blackradio/flash.bin` for the regions stock and Ferrite didn't change since.
4. Before saving: SSB and Install stay locked. After "I have saved it": they unlock.
5. Drop `firmware/stock/RT_950Pro_V0.29_OEM.BTF`: "the known stock patch".
6. Install Ferrite: blocks count up; Ferrite starts, formats, opens setup; Console shows its version. MENU 0 9 6 says SSB installed.
7. Desktop app (`npm run tauri dev`): Save backup opens the macOS save dialog; the page says Saved with the path.
8. A cut backup: pull the cable mid-read. Console says so; Back up again works after reconnecting.
9. Back to stock with clear's backup on black: "from another radio (ID ...)", "Nothing was written"; black restarts into Ferrite as it was. This must refuse even though both radios' calibration sectors are byte-identical (CRC DF32432F): the check is the MCU ID (decision 263).
9a. Rename black's backup (e.g. `black.bin`) and open the page in a private window: Back to stock asks for the radio's ID ("Console can't tell which radio..."), nothing is written and the radio restarts; typing the ID shown (as About shows it) and starting again goes on.
10. Back to stock with black's backup and the stock `.BTF`: the screen says "Restoring stock data", then "Done: restarting"; Console catches the bootloader without a power cycle and sends the stock file. The Install card no longer says "Done. The radio runs Ferrite"; it offers Install Ferrite again.
11. Stock boots with its channels, settings, splash and prompts. Calibration: TX power on Low into the dummy load as before (by hand, SDR away).
12. Take a new backup (Install page or `fw/tools/backup.py`): 0x00F000-0x00FFFF and 0x300000 up are byte for byte the first backup's.
13. Pull the cable mid-restore: Console says part is written. Turn black off, hold the two lower side keys, turn on, "Send the stock firmware only": stock boots (its data then is partly Ferrite's: restore again from Ferrite to fix).
14. Then reinstall Ferrite (tx-bench) from the Install page.
15. Reload the page and Connect cable again: the card says "Connected: Cable (CH340)" (never a blank name).
