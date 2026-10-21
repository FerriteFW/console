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
3. The screen updates about once a second. Keys work, a second or so behind.
4. Out of range or Bluetooth off: the bar says disconnected.
5. Cable and Bluetooth in two tabs: both run.

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
