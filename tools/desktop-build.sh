#!/usr/bin/env bash
# The release builds (DEVELOPING.md; for your own machine only, `npm run tauri build` is enough).
# The desktop app for Linux and Windows, built in Docker on the Xeon (tools/desktop/Dockerfile): copies the last
# commit of this repo and of ../ferrite there (what's committed, not the working tree) plus the bundled firmware
# (scripts/bundle-firmware.mjs, from ../ferrite/target), builds, and brings the
# bundles back to target/desktop/. `mac` builds the macOS app (.app and .dmg) here instead (macOS only; unsigned:
# fine on the Mac that built it). Usage: tools/desktop-build.sh [linux|windows|mac|all] [--host USER@HOST]
# (all = linux and windows; mac separately)
# Windows: cargo-xwin downloads Microsoft's CRT and Windows SDK on its first run (kept in a cache volume there);
# using them means accepting Microsoft's licence for them. Besides the NSIS setup.exe it brings back the bare app
# ("Ferrite Console portable.exe"), which runs without installing.
set -euo pipefail
# DEBUG=1: every command as it runs, and ssh's own connection log.
[ -n "${DEBUG:-}" ] && set -x
host=${FERRITE_XEON:-xeon}
what=all
while [ $# -gt 0 ]; do
  case $1 in
    linux|windows|mac|all) what=$1; shift ;;
    --host) host=$2; shift 2 ;;
    *) echo "usage: $0 [linux|windows|mac|all] [--host USER@HOST]" >&2; exit 2 ;;
  esac
done
here=$(cd "$(dirname "$0")/.." && pwd)
# Console's own updates (UPD-26): a release build signs the update bundles (the macOS .app.tar.gz, the Linux AppImage)
# with the updater key (never the firmware key): the file ~/.tauri/ferrite-console-updater.key, its password in the
# keychain. UNSIGNED=1, or no key here, builds without them. tools/release-files.mjs then writes latest.json.
updkey=${TAURI_UPDATER_KEY:-$HOME/.tauri/ferrite-console-updater.key}
upd=()
if [ -z "${UNSIGNED:-}" ] && [ -f "$updkey" ]; then
  TAURI_SIGNING_PRIVATE_KEY=$(cat "$updkey")
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s ferrite-console-updater -w)
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  upd=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
fi
# The third-party notices About shows must match what this build links (tools/thirdparty.py).
python3 "$here/tools/thirdparty.py" --check
if [ "$what" = mac ]; then
  [ "$(uname)" = Darwin ] || { echo "mac: build on a Mac" >&2; exit 1; }
  cd "$here"
  node scripts/bundle-firmware.mjs ${FIRMWARE:-} >/dev/null # as the Docker builds below
  # Signed with the team's Developer ID and notarized, so macOS opens it without a warning. The certificate is in
  # this Mac's keychain; the notarization login is the keychain profile FerriteConsole (made once with
  # `xcrun notarytool store-credentials FerriteConsole --team-id TEAM --apple-id APPLE_ID`; org/signing.md).
  # UNSIGNED=1 builds as before (an ad-hoc signature, fine on the Mac that built it).
  identity=""
  if [ -z "${UNSIGNED:-}" ]; then
    identity=${APPLE_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)}
    [ -n "$identity" ] || { echo "mac: no Developer ID Application certificate in the keychain (UNSIGNED=1 to build without)" >&2; exit 1; }
    profile=${NOTARY_PROFILE:-FerriteConsole}
    xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1 || { echo "mac: no notarization profile $profile in the keychain (see above)" >&2; exit 1; }
  fi
  # unsigned: the variable left out (an empty one makes Tauri sign with an identity named "", which fails)
  if [ -n "$identity" ]; then
    APPLE_SIGNING_IDENTITY="$identity" npx tauri build --bundles app,dmg ${upd[@]+"${upd[@]}"} 2>&1 | tail -n 8
  else
    env -u APPLE_SIGNING_IDENTITY npx tauri build --bundles app,dmg ${upd[@]+"${upd[@]}"} 2>&1 | tail -n 8
  fi
  dmg=$(ls target/release/bundle/dmg/*.dmg | head -n 1)
  if [ -n "$identity" ]; then
    codesign --verify --deep --strict target/release/bundle/macos/*.app
    codesign --force --timestamp --sign "$identity" "$dmg"
    xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
    xcrun stapler staple "$dmg"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
  fi
  mkdir -p target/desktop
  rm -rf "target/desktop/Ferrite Console.app"
  cp -R target/release/bundle/macos/*.app "$dmg" target/desktop/
  [ ${#upd[@]} -eq 0 ] || cp target/release/bundle/macos/*.app.tar.gz target/release/bundle/macos/*.app.tar.gz.sig target/desktop/
  ls -la target/desktop
  exit 0
fi
dir=code/console-build
ssh="ssh ${DEBUG:+-v} -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-desk-%C -o ControlPersist=120"
for i in $(seq 12); do $ssh -o ConnectTimeout=5 "$host" true 2>/dev/null && break; sleep 10; done
$ssh -o ConnectTimeout=5 "$host" true 2>/dev/null || {
  echo "can't reach the build box $host (a Linux machine with Docker; --host USER@HOST or FERRITE_XEON picks it)." >&2
  echo "To build for this machine only: npm run tauri build (DEVELOPING.md)." >&2
  exit 1
}
$ssh "$host" "mkdir -p $dir && rm -rf $dir/ferrite $dir/ferrite-console/src $dir/ferrite-console/src-tauri/src && mkdir -p $dir/ferrite $dir/ferrite-console"
git -C "$here/../ferrite" archive HEAD | $ssh "$host" "tar -x -C $dir/ferrite"
git -C "$here" archive HEAD | $ssh "$host" "tar -x -C $dir/ferrite-console"
# The bundled firmware (the tx release and the reader: scripts/bundle-firmware.mjs) is generated, never committed,
# so it goes along from here.
# FIRMWARE="RELEASE.ffw READER.btf" bundles a signed release (its .minisig files beside); else ../ferrite/target's.
node "$here/scripts/bundle-firmware.mjs" ${FIRMWARE:-} >/dev/null
COPYFILE_DISABLE=1 tar -C "$here" -c public/firmware | $ssh "$host" "rm -rf $dir/ferrite-console/public/firmware && tar -x -C $dir/ferrite-console"
# The updater key goes over as an env file only the build reads (mode 600), deleted when the build ends.
if [ ${#upd[@]} -gt 0 ]; then
  printf 'TAURI_SIGNING_PRIVATE_KEY=%s\nTAURI_SIGNING_PRIVATE_KEY_PASSWORD=%s\n' "$TAURI_SIGNING_PRIVATE_KEY" "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" |
    $ssh "$host" "umask 077 && cat > $dir/updater.env"
else
  $ssh "$host" "rm -f $dir/updater.env"
fi
$ssh "$host" bash -s -- "$dir" "$what" <<'REMOTE'
set -euo pipefail
dir=$HOME/$1 what=$2
cd "$dir"
envf=() upd=""
if [ -f updater.env ]; then envf=(--env-file "$dir/updater.env"); upd=" --config '{\"bundle\":{\"createUpdaterArtifacts\":true}}'"; fi
trap 'rm -f "$dir/updater.env"' EXIT
# Two build boxes: Linux on Ubuntu 22.04 (tools/desktop/linux: the oldest glibc to support), Windows on Debian 13
# (tools/desktop: NSIS 3.11 for the installer). Each its own cargo target folder: build scripts compiled against one
# glibc don't run on the other.
[ "$what" = windows ] || docker build -q -t ferrite-console-desktop-linux "$dir/ferrite-console/tools/desktop/linux" >/dev/null
[ "$what" = linux ] || docker build -q -t ferrite-console-desktop "$dir/ferrite-console/tools/desktop" >/dev/null
docker volume create ferrite-console-xwin >/dev/null
run() { # IMAGE TARGET-DIR COMMAND
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/home -e XWIN_CACHE_DIR=/xwin -e CARGO_TARGET_DIR="/src/ferrite-console/$2" ${envf[@]+"${envf[@]}"} \
    -v "$dir:/src" -v ferrite-console-xwin:/xwin -w /src/ferrite-console "$1" bash -c "npm ci --no-audit --no-fund --silent && $3"
}
docker run --rm -v ferrite-console-xwin:/xwin alpine chmod 777 /xwin
out=$dir/out; rm -rf "$out"; mkdir -p "$out"
if [ "$what" != windows ]; then
  rm -rf ferrite-console/target-linux/release/bundle # only this build's installers, not every older version's
  run ferrite-console-desktop-linux target-linux "npx tauri build$upd 2>&1 | tail -n 15"
  cp ferrite-console/target-linux/release/bundle/deb/*.deb ferrite-console/target-linux/release/bundle/rpm/*.rpm \
     ferrite-console/target-linux/release/bundle/appimage/*.AppImage ferrite-console/target-linux/release/bundle/appimage/*.AppImage.sig \
     "$out/" 2>/dev/null || true
fi
if [ "$what" != linux ]; then
  rm -rf ferrite-console/target/x86_64-pc-windows-msvc/release/bundle
  run ferrite-console-desktop target 'npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc 2>&1 | tail -n 15'
  cp ferrite-console/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe "$out/" 2>/dev/null || true
  # The bare app too: runs without installing (Windows 10 and 11 have the WebView2 runtime it needs).
  cp ferrite-console/target/x86_64-pc-windows-msvc/release/ferrite-console-app.exe "$out/Ferrite Console portable.exe" 2>/dev/null || true
fi
ls -la "$out"
REMOTE
mkdir -p "$here/target/desktop"
rsync -e "$ssh" -a "$host:$dir/out/" "$here/target/desktop/"
ls -la "$here/target/desktop"
