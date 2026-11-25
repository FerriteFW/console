# Developing Ferrite Console

For people who want to build Console, change it or read the code. Using it: [README.md](README.md).

Console is Svelte 5 (Vite) over a Rust core compiled to WebAssembly, in a Tauri 2 desktop shell. The core reuses Ferrite's own code, so Console checks edits and speaks the link protocol exactly as the radio does.

## Set up

- Node 22.18+ (`.node-version`), npm, Rust via rustup (`rust-toolchain.toml` pins it) and [just](https://just.systems).
- `just setup`, then `just --list` for the everyday commands. `just doctor` checks the versions.
- Setup clones Ferrite beside this checkout (`../ferrite`) at the release with Console's version when it isn't there:
  Console builds Ferrite's crates from it. An existing `../ferrite` is used as it is.
- Without a Ferrite build in `../ferrite/target`, setup downloads that release's `.ffw`, reader and restorer into
  `target/firmware/` for the desktop builds.
- Optional: `.env` (from `.env.example`) for `just remote RECIPE` on another machine.

## Run

```sh
npm run dev           # http://localhost:1420 in Chrome or Edge
npm run tauri dev     # the desktop app
npm run build         # the web build in dist/
```

- `?demo` connects a demo radio; `?demo&press=MENU,DOWN` presses keys; `?theme=light` picks the theme.
- The demo radio, the Bridge button and the readback harness are in dev builds only (`npm run dev`, `npm run build:dev`), never in a release.

## Test

```sh
npm test            # the core's Rust tests, then the Node unit tests
npm run e2e         # build, then end-to-end tests on headless simulators through the bridge
npm run e2e:run     # the same without the build
```

- On a radio: `FERRITE_E2E_SERIAL=/dev/cu.usbserial-114220 FERRITE_E2E_CHANNEL=999 npm run e2e`. The write tests rename that channel and put it back.
- `FERRITE_E2E_VERBOSE=1` shows the simulator and bridge. Screenshots land in `test-results/shots/`.
- Checks by hand on a radio: [docs/TESTING.md](docs/TESTING.md).

## Desktop builds

For your own machine:

```sh
npm run bundle-firmware   # the Ferrite build to put in the app: ../ferrite/target's (tools/mkbtf.sh tx and reader there first)
npm run tauri build       # the app for this system, in target/release/bundle/
```

- To bundle a downloaded release instead: `npm run bundle-firmware -- ferrite-0.8.0.ffw ferrite-reader.btf` (the reader's `.minisig` beside it).
- Linux needs Tauri's packages too: on Fedora `sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel dbus-devel systemd-devel`; on Debian and Ubuntu `sudo apt install libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev libudev-dev`.

The release builds, all three systems (maintainers):

```sh
FIRMWARE="RELEASE.ffw READER.btf RESTORER.btf" tools/desktop-build.sh mac                      # the .app and .dmg, on a Mac: one universal app (Apple silicon and Intel; once: rustup target add x86_64-apple-darwin)
FIRMWARE="RELEASE.ffw READER.btf RESTORER.btf" tools/desktop-build.sh all --host USER@HOST     # Linux and Windows, in Docker on a Linux build box
FIRMWARE="RELEASE.ffw READER.btf RESTORER.btf" tools/desktop-build.sh release --host USER@HOST # all three at once: the Mac app here, the other two there
```

- `all` builds the web front end once, then Linux and Windows side by side. `release` runs that on the build box while the Mac builds here; the build box's log goes to `target/desktop-remote.log`.

- `FIRMWARE` names the Ferrite release to build in (its signed `.ffw` and the signed reader, `.minisig` beside it). Without it, `../ferrite/target`'s local build goes in.
- The build box is reached over ssh and needs Docker: `--host`, or `FERRITE_XEON`, or else an ssh host named `xeon`.
- It first checks `public/THIRD-PARTY-LICENSES.md` (About's third-party licences) against what the app links; after a dependency change run `python3 tools/thirdparty.py` and commit the file.
- Updates (UPD-25, UPD-26; on since 0.9.0, `UPDATES_ON` in `src/lib/updates.svelte.ts`). A release build signs
  Console's update bundles (the macOS `.app.tar.gz`, the Linux AppImage) with the updater key: the file
  `~/.tauri/ferrite-console-updater.key`, its password in the keychain (`ferrite-console-updater`); never the firmware
  key. `UNSIGNED=1`, or no key on the Mac, builds without them. The public key is in `tauri.conf.json`.
- Releases: after `mac` and `all`, `node tools/release-files.mjs --ffw ferrite-X.Y.Z.ffw` writes `target/desktop/release/`:
  the installers under their release names, the update bundle, Tauri's `latest.json` (attach all of them to the
  GitHub release: the updater reads `releases/latest/download/latest.json`), and `feed.json` with the `.ffw`: these
  two go on ferritefw.dev as `releases/latest.json` and `releases/ferrite-X.Y.Z.ffw` (the website repo's
  `src/releases/`), where `FEED` points. Windows' portable `.exe` doesn't update itself: it links to the download.
- Out: `target/desktop/`. A release ships the `.dmg`, the `.AppImage` and the Windows portable `.exe`.
- The Mac build is signed with the team's Developer ID and notarized: it needs the "Developer ID Application" certificate in the keychain and the notarization profile `FerriteConsole` (`xcrun notarytool store-credentials FerriteConsole --team-id TEAM --apple-id APPLE_ID`, once). `UNSIGNED=1` builds without. The Linux and Windows builds aren't signed.

## Layout

| Path | What |
| --- | --- |
| `core/` | The Rust core: link sessions, records, the write plan and its checks, CHIRP CSV, the channel library |
| `wasm/` | The core for the browser (`npm run wasm` builds it into `src/core-wasm/`) |
| `src/` | The UI: one Svelte file per page in `src/lib/pages/` |
| `src-tauri/` | The desktop shell: native cable and Bluetooth; the protocol stays in the webview |
| `public/data/` | The fixed channel sets; the rest comes from data.ferritefw.dev ([tools/library/README.md](tools/library/README.md)) |
| `scripts/` | The wasm and font builds, and `bundle-firmware.mjs` (the Ferrite release built into the app) |
| `tools/` | `bridge.py` (a WebSocket to a serial port or the simulator), `fakeboot.py` (a fake stock bootloader), the desktop builds |
| `tests/` | Node unit tests and Playwright end-to-end tests |

## Not done yet

- Signed and notarized desktop builds, and the self-updater.
- Channel positions and drag to reorder; a virtual table for very long channel lists.

## More

- [docs/DECISIONS.md](docs/DECISIONS.md): design decisions.
- The `.ferrite` file format: `docs/dev/codeplug-format.md` in the docs repo.
