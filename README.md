# Ferrite Console

The companion app for [Ferrite](https://github.com/FerriteFW/ferrite), the free firmware for the [Radtel RT-950 Pro](https://www.radtels.com/products/radtel-rt-950-pro-27mhz-tx-rx-10w-walkie-talkie-am-fm-usb-lsb-cw-receive-gps-aprs-wireless-bluetooth-phone-programming-noaa-two-way-radio?ref=FERRITEFW&variant=44669996794064) (affiliate link: buying through it supports Ferrite at no extra cost to you).

> **Status: 0.9, the first public release,** released together with Ferrite 0.9.

## Start here

1. **Download** from the [Releases page](https://github.com/FerriteFW/console/releases):
   - **macOS** (Apple silicon): the `.dmg`. It isn't notarized yet: if macOS won't open it, choose Open Anyway in System Settings › Privacy & Security.
   - **Linux:** the `.AppImage`. Make it executable (`chmod +x`), then run it. For the cable, your user needs to be in the `dialout` group.
   - **Windows 10 and 11:** the portable `.exe`. No installer: run it from anywhere.
2. **Connect** the radio by its programming cable, or by Bluetooth once Ferrite is on it.
3. **Install Ferrite** from the Install page. It backs up the whole radio first, then installs the Ferrite release built into the app.

Help: the [Ferrite Discord](https://discord.gg/fYygBVD2Kx). Bugs: [GitHub issues](https://github.com/FerriteFW/ferrite/issues).

## What it does

- **Install and go back:** a whole-radio backup, Ferrite installed, and Back to stock from your backup.
- **Update:** a newer Ferrite onto a radio already running it. Releases are signed, and Console refuses one that doesn't verify.
- **Channels and zones:** read, edit, write, with a backup and a list of changes first. CHIRP CSV import and export.
- **Add channels:** fixed sets (FRS, GMRS, marine, weather, airband and more), repeaters, airports and licensed sites near you, on a map.
- **Settings:** every menu setting by its number and name.
- **Live view:** the radio's screen and keys on the computer. Listen to and record what the radio hears (cable).
- **APRS:** messages, stations heard, a map and the APRS settings.
- **Satellites:** pick the FM satellites to put on the radio, which predicts their passes itself.
- **Files:** one `.ferrite` file holds channels, zones, settings, APRS settings and contacts.

Console never keys the radio and never writes its calibration.

## For developers

Building, testing and the code's layout: [DEVELOPING.md](DEVELOPING.md).

## Contributing

Issues are what help most: bugs, ideas, design suggestions and fixes. We'd rather have an issue than an AI-generated pull request: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md), copyright 2026 Alex Harvey: free for any noncommercial use.
