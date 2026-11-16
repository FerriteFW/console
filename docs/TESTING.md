# Manual checks on the radio

Start `npm run dev`, open http://localhost:1420 in Chrome. Close `term.py` and anything else on the cable.

## Cable

1. Connect › Cable, pick the CH340. Expect "230400 baud" ("115200 baud" on Windows).
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

## Event Log and APRS (cable or Bluetooth)

1. Event Log: the rows match the radio's log screen. Times look right (local time). Source filter, CSV export.
2. Heard stations: the list matches the radio's heard list. Distances look right for the radio's GPS fix.
3. Leave it open while a station is heard: it moves to the top without Refresh.
4. Map: stations and the radio (green) on OpenStreetMap.
5. Messages: conversations match the radio. Only with Dry TX on (MENU 0 8 9 2): send one to yourself, check the radio's toast and its state.
6. APRS Settings: read, change Power, write (backup first). Check MENU 0 5 5 4. Open… the backup and write it back.

## Channels & Zones (cable). Keep every backup until done.

1. Read from radio. Counts and names match the radio.
2. Back up radio: a `.ferrite` downloads.
3. Spot-check five channels against the radio's editor.
4. Rename one, set a TX tone `D023N`, set one RX only. Type `700` as RX: a red refusal. Put it back.
5. Write to radio…: a backup downloads, the diff shows exactly the three changes. Cancel.
6. Write and confirm. Console reads back: "the radio holds the table". Check on the radio.
7. File › Open… the step-2 `.ferrite`. Write: the three changes go back. Check on the radio.
8. CHIRP: export, import the same file. No notes; Write shows nothing to write.
9. + Zone, add a channel to it, Write. Delete the zone, Write. Check ◀▶ on the radio.
10. BACK on the radio during a write: Console says cancelled, re-reads.
11. Disconnect: `term.py` answers at 115200 without a power cycle.
12. Bluetooth: Read works, slowly (time it). A small write works.

## Add channels

1. Fixed sets › FRS › Add 22 into a new zone. Green rows, one new zone. Write; check the zone on the radio.
2. Airports › From radio: the radio's GPS fix (or fixed position) fills the place.
3. Pick the nearest airport, add. AM, RX only rows. Write; PTT on one does nothing.
4. Licensed sites: filter, add a group. RX only rows, NFM or FM as listed. Near a border, both countries list. Save for offline once.
5. Undo edits if you don't want them.

## Desktop app (macOS)

Open `target/release/bundle/macos/Ferrite Console.app` (unsigned: right-click › Open the first time). Close `term.py` first.

1. Connect › Cable: a list pops up under the bar. The CH340 (`usbserial-…`) is first. Pick it: "230400 baud" ("115200 baud" on Windows).
2. Run the Cable checks above. Unplug: the bar says so. Disconnect: `term.py` answers at 115200.
3. Connect › Bluetooth: macOS asks for Bluetooth access once. Allow it.
4. The list shows each radio by its ID, strongest first. Pick one.
5. Run the Bluetooth checks above. Cancel and Esc close the list without an error.
6. Write a channel table: the backup file lands in ~/Downloads (the webview's downloads are the open question).

## Firmware Update (clear radio, cable). Alex only.

1. Have the current image as a fallback, and `flash.py` ready.
2. Build the new image: `tools/mkbtf.sh tx` in ferrite.
3. Connect › Cable. Firmware Update › Choose .btf (or "Use the bundled release (vX)": the image Console ships, SHA-256 checked). Version, size, blocks show; "Checks passed".
4. Pick a stock `.btf`: refused, "not a Ferrite image". Pick a CI release with its `.btf.minisig`: "Signed by Ferrite: …"; with a `.minisig` from another image: refused, "Bad signature".
5. Update firmware…: the radio's firmware and build show against the file's version. Install.
6. The radio restarts; the bar says "Firmware Update holds"; blocks count up (about 85 s).
7. Done: Console connects again and shows the version. Check About (MENU 0 9 9) and a channel.
8. Optional, Dry TX on (MENU 0 8 9 2): hold PTT, press Install. Expect "it refused REBOOT (busy)".
9. If a block fails: the radio waits in the bootloader. Resume, or reload the page and use "Open the cable and resume".
10. If nothing answers: power-cycle the radio while Console waits, or fall back to `flash.py`.

## Install page (black radio, cable). Alex only.

Needs the `console-install` firmware (STOCK_RESTORE) for steps 9-14. Keep black's existing backups.

1. `npm run bundle-firmware` (ferrite's `target/ferrite-tx.btf` and `target/ferrite-reader.btf`: `tools/mkbtf.sh tx` and `tools/mkbtf.sh reader`), `npm run build`, open `#install` in Chrome. The release check uses this default `tx` bundle (`bundle-firmware.mjs` defaults to `ferrite-tx.btf`); a bench radio may override it with the tx-bench image.
2. Connect cable. Back up the radio: the reader loads and the radio's screen says "Ferrite Console / Backing up your radio / Keep the cable in" with a percentage (not hwtest's diagnostics pages); "Reading the flash at 500 kbaud" counts up, then the flashcrc check. Note the time (expect about 4 min).
3. The Radio ID matches About (MENU 0 9 8). "Model marker" says blank on black (the reader's `mdump`, ferrite BACKUP-12.1; a reader built before Nov 1 has no `mdump`: "not read by this reader"). Save backup: Chrome's save dialog opens once; one file lands (no "name (1).bin"); the page says Saved with its name. The file is 4 MB, named `rt950pro-backup-<ID>-<date>.bin` with the radio's ID, and its SHA-256 matches `backups/blackradio/flash.bin` for the regions stock and Ferrite didn't change since.
4. Before saving: SSB and Install stay locked. After "I have saved it": they unlock.
5. Drop `firmware/stock/RT_950Pro_V0.29_OEM.BTF`: "the known stock patch".
6. Install Ferrite: blocks count up; Ferrite starts, formats, opens setup; Console shows its version. MENU 0 9 6 says SSB installed.
7. Desktop app (`npm run tauri dev`): Save backup opens the macOS save dialog; the page says Saved with the path.
8. A cut backup: pull the cable mid-read. Console says so; Back up again works after reconnecting.
9. Back to stock with clear's backup on black: "from another radio (ID ...)", "Nothing was written"; black restarts into Ferrite as it was. This must refuse even though both radios' calibration sectors are byte-identical (CRC DF32432F): the check is the MCU ID (decision 263).
9a. Rename black's backup (e.g. `black.bin`) and open the page in a private window: Back to stock asks for the radio's ID ("Console can't tell which radio..."), nothing is written and the radio restarts; typing the ID shown (as About shows it) and starting again goes on.
10. Back to stock with black's backup and the stock `.BTF`: the screen says "Restoring stock data", then "Done: restarting"; Console catches the bootloader without a power cycle and sends the stock file. The Install card no longer says "Done. The radio runs Ferrite"; it offers Install Ferrite again.
11. Stock boots with its channels, settings, splash and prompts. The stock file went as 951 blocks (padded through 0x080F07FF, ferrite BACKUP-12.2); stock's info page shows its default model name (black's marker was blank). Calibration: TX power on Low into the dummy load as before (by hand, SDR away).
12. Take a new backup (Install page or `fw/tools/backup.py`): 0x00F000-0x00FFFF and 0x300000 up are byte for byte the first backup's.
13. Pull the cable mid-restore: Console says part is written. Turn black off, hold the two lower side keys, turn on, "Send the stock firmware only": stock boots (its data then is partly Ferrite's: restore again from Ferrite to fix).
14. Then reinstall Ferrite (tx-bench) from the Install page.
15. Reload the page and Connect cable again: the card says "Connected: Cable (CH340)" (never a blank name).

## Rust reader against hwtest (black radio, cable, once). Alex only.

Ferrite decision 264: the reader is now ferrite's `reader/` (Rust, read only by construction). fw/hwtest retires once this passes. Both backups must see the same flash: take them back to back, with no Ferrite or stock boot in between (the second backup restarts the reader into the bootloader itself).

1. Build both readers: in ferrite (branch `reader`), `tools/mkbtf.sh reader` (`target/ferrite-reader.btf`, 34,816 bytes); hwtest as before (`../fw/build/target/hwtest.btf`, 119,808 bytes). Here (branch `rust-reader`): `npm run bundle-firmware`, `npm run build`, open `#install` in Chrome, Connect cable.
2. hwtest first: Advanced › Reader image › Use a file… `hwtest.btf`. Back up the radio. Save it as `hwtest.bin`. Note the read time ("Reading the flash at 500 kbaud" to the flashcrc check) and the check time (flashcrc to Done).
3. Rust reader: reload the page (the bundled reader is the Rust one; Advanced shows `ferrite-reader.btf (included)`), Connect cable, Back up the radio. It reads with `fdumpz` (ferrite BACKUP-9.6): "Reading the flash at 230.4 kbaud", the bar counting the chip's bytes (not the cable's). Note the same two times. Save it as `rust.bin`.
4. The screen during step 3: "Ferrite Console / Backup reader / Waiting for Ferrite Console." while it starts, then "Ferrite Console / Backing up your radio / Keep the cable in. Don't turn it off." with a blue bar, "Reading N%", then "Checking N%", then a green bar and "Read and checked". Backlight on, keypad light off.
5. Byte for byte: `cmp hwtest.bin rust.bin` prints nothing; `shasum -a 256 hwtest.bin rust.bin` and `python3 -c 'import sys,zlib; [print(f, "%08X" % zlib.crc32(open(f,"rb").read())) for f in sys.argv[1:]]' hwtest.bin rust.bin` show the same values, and the CRC is the one the page showed. Both file names carry the same radio ID (the `sys` UID).
6. Timing: hwtest's read about 85 s at 500 kbaud; the Rust reader's `fdumpz` read about 75 s at 230400 (73.6 s on black with fdump_proto.py, decision 265), no bad frames expected; the Rust reader's check is seconds (120 MHz) where hwtest's was about a minute (8 MHz). Write both times in the results.
7. Older tools still work with the Rust reader running (same protocol): `../fw/tools/backup.py /dev/cu.usbserial-* out --twice` ends "agree" and its `flash.bin` equals `rust.bin`.
8. The power switch with the reader idle: off turns the radio off; on starts the reader again (Waiting screen). Then Install Ferrite (tx-bench) from the Install page as usual.

Results: date, ferrite commit, the CRC-32 and SHA-256 of both files, the four times, pass or fail. On a pass, ferrite's `reader` and this `rust-reader` branch merge, and fw/apps/hwtest is retired.
