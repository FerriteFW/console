# Console usability review (Oct 29, 2026)

From a read of the source (a second agent). Direction from Alex: almost desktop-like, dead easy to use, a Tauri
app likely (system tray and the like); NeonPlug is the reference. Recommendations go to Alex one at a time.

## Status

- [x] Welcome on every visit (connect by cable or Bluetooth, Install for a stock radio, the user guide), as
  NeonPlug's start-up modal. `ConnectModal.svelte`.
- [x] A cable with no answer points to Install (in the welcome).
- [x] The browser's reason a way can't connect, as text (in the welcome; the top bar still uses a tooltip).
- [x] Layout (Alex chose the desktop shell over tabs, Oct 29): sidebar Home, Live View, Channels & Zones, Radio
  Settings, APRS, Firmware, then More (Event Log, Terminal, About); APRS and Firmware as tabs; Home with the jobs as
  cards and Update saying whether the radio is behind. Next for the editors: NeonPlug's toolbar (Read, Write,
  File, "N unwritten") on Channels, Settings and APRS settings.
- [x] Update as a modal wizard (Alex's pick, Oct 29): Check (versions, signature) → Update (progress, keep the cable
  in; Try again from the bootloader) → Done. The page: your radio, the latest, one Update button; a .btf file and
  its checks under Advanced. `UpdateWizard.svelte`.

## Open

1. **No starting point for the main jobs.** Opens on Live View; Install and Update are items 4 and 5 under Tools.
   Proposed: a Home page with Install, Update, Channels; after connecting, the right one highlighted (stock or
   Ferrite).
2. **The demo radio is offered but only exists in developer builds** (LiveView, Channels, Settings empty states).
3. **Update takes too many steps** (`Firmware.svelte`): bundled release, a technical card, two buttons; never says
   whether the radio is up to date. Proposed: "Your radio: X. Latest: Y. [Update]", file checks under Advanced.
4. **Install** (`Install.svelte`): its own connect control (connect twice); five cards and Back to stock at once;
   asks for the stock .BTF without saying where it comes from. Proposed: a wizard, one step at a time; Back to stock
   its own page.
5. **Channel edits are lost silently**: no unload guard, no session save, no pending count, no confirm on delete.
6. **Channels is a 22-column table with 11 toolbar buttons**: no auto-read, no bulk edit, unusable narrow.
   Proposed: auto-read, about 8 columns plus "more", row checkboxes with a bulk bar, one File menu.
7. **Navigation follows UV Studio** (Viewer, Tools, Console); APRS is 5 of 11 items. Proposed: Home, Live, Channels,
   Settings, APRS (tabs), Firmware (Update, Install, Back to stock); Terminal, Event log, About under More.
8. **Contrast and layout**: `--dim` text about 3:1 (needs 4.5:1); errors absolutely positioned over the page; the
   narrow-screen drawer has no backdrop or Esc.

## Quick wins

- About: "channel programming next" is stale; "Never transmits" isn't true with APRS messages ("never keys the radio
  itself"); drop the UV Studio history line.
- Firmware: `href="#install"` opens focus mode with no way back (use `#/install`); "(Connect › Cable)" matches no
  label; "Before:{…}" missing a space.
- Top bar: label the buttons "Connect with cable" / "Connect with Bluetooth"; the theme toggle reads like a state
  (use an icon).
- Install: "No reader image in this copy of Console" is jargon; hide Back to stock once installed.
- Channels: empty rows should offer Read from radio and Import CHIRP.
- Live View: B/s, ms and the screen ID are developer details.
- Terminal: under More/Advanced.
