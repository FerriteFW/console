#!/usr/bin/env bash
# The release builds (DEVELOPING.md; for your own machine only, `npm run tauri build` is enough).
# The desktop app for Linux and Windows, built in Docker on the Xeon (tools/desktop/Dockerfile): copies the last
# commit of this repo and of ../ferrite there (what's committed, not the working tree) plus the bundled firmware
# (scripts/bundle-firmware.mjs, from ../ferrite/target), builds, and brings the
# bundles back to target/desktop/. `mac` builds the macOS app (.app and .dmg) here instead (macOS only; unsigned:
# fine on the Mac that built it); universal: Apple silicon and Intel in one app (MAC_TARGET=aarch64-apple-darwin for
# this Mac's alone). Usage: tools/desktop-build.sh [linux|windows|mac|all|release] [--host USER@HOST]
# (all = linux and windows, side by side on the build box; release = all there and mac here, at the same time)
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
    linux|windows|mac|all|release) what=$1; shift ;;
    --host) host=$2; shift 2 ;;
    *) echo "usage: $0 [linux|windows|mac|all|release] [--host USER@HOST]" >&2; exit 2 ;;
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
# release: the Mac app here while the build box makes Linux and Windows; the firmware is bundled once, first, so the
# two don't rewrite public/firmware under each other. The build box's output goes to target/desktop-remote.log.
if [ "$what" = release ]; then
  node "$here/scripts/bundle-firmware.mjs" ${FIRMWARE:-} >/dev/null
  mkdir -p "$here/target"
  BUNDLED=1 "$0" all --host "$host" >"$here/target/desktop-remote.log" 2>&1 &
  remote=$!
  mac=0; BUNDLED=1 "$0" mac || mac=$?
  rem=0; wait "$remote" || rem=$?
  echo "== Linux and Windows (target/desktop-remote.log):"; tail -n 20 "$here/target/desktop-remote.log"
  [ "$mac" = 0 ] || echo "mac failed ($mac)" >&2
  [ "$rem" = 0 ] || echo "linux/windows failed ($rem): target/desktop-remote.log" >&2
  [ "$mac" = 0 ] && [ "$rem" = 0 ]
  exit
fi
if [ "$what" = mac ]; then
  [ "$(uname)" = Darwin ] || { echo "mac: build on a Mac" >&2; exit 1; }
  cd "$here"
  [ -n "${BUNDLED:-}" ] || node scripts/bundle-firmware.mjs ${FIRMWARE:-} >/dev/null # as the Docker builds below
  [ -n "${UNSIGNED:-}" ] || node "$here/tools/check-bundle.mjs" "$here/public/firmware/manifest.json" || exit 1 # UPD-27
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
  # One app for Apple silicon and Intel Macs (Rust's x86_64-apple-darwin target: `rustup target add` once).
  mt=${MAC_TARGET:-universal-apple-darwin}
  out=target/$mt/release/bundle
  rm -rf "$out"
  # unsigned: the variable left out (an empty one makes Tauri sign with an identity named "", which fails)
  if [ -n "$identity" ]; then
    APPLE_SIGNING_IDENTITY="$identity" npx tauri build --target "$mt" --bundles app,dmg ${upd[@]+"${upd[@]}"} 2>&1 | tail -n 8
  else
    env -u APPLE_SIGNING_IDENTITY npx tauri build --target "$mt" --bundles app,dmg ${upd[@]+"${upd[@]}"} 2>&1 | tail -n 8
  fi
  dmg=$(ls $out/dmg/*.dmg | head -n 1)
  if [ -n "$identity" ]; then
    codesign --verify --deep --strict $out/macos/*.app
    codesign --force --timestamp --sign "$identity" "$dmg"
    xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
    xcrun stapler staple "$dmg"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
  fi
  mkdir -p target/desktop
  rm -rf "target/desktop/Ferrite Console.app"
  rm -f target/desktop/*.dmg
  cp -R $out/macos/*.app "$dmg" target/desktop/
  [ ${#upd[@]} -eq 0 ] || cp $out/macos/*.app.tar.gz $out/macos/*.app.tar.gz.sig target/desktop/
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
# FIRMWARE="RELEASE.ffw READER.btf RESTORER.btf" bundles a signed release (its .minisig files beside); else ../ferrite/target's.
[ -n "${BUNDLED:-}" ] || node "$here/scripts/bundle-firmware.mjs" ${FIRMWARE:-} >/dev/null
[ -n "${UNSIGNED:-}" ] || node "$here/tools/check-bundle.mjs" "$here/public/firmware/manifest.json" || exit 1 # UPD-27
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
envf=() cfg='{"build":{"beforeBuildCommand":""}}'
if [ -f updater.env ]; then envf=(--env-file "$dir/updater.env"); cfg='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":true}}'; fi
trap 'rm -f "$dir/updater.env"' EXIT
# Two build boxes: Linux on Ubuntu 22.04 (tools/desktop/linux: the oldest glibc to support), Windows on Debian 13
# (tools/desktop: NSIS 3.11 for the installer). Each its own cargo target folder: build scripts compiled against one
# glibc don't run on the other.
[ "$what" = windows ] || docker build -q -t ferrite-console-desktop-linux "$dir/ferrite-console/tools/desktop/linux" >/dev/null
[ "$what" = linux ] || docker build -q -t ferrite-console-desktop "$dir/ferrite-console/tools/desktop" >/dev/null
docker volume create ferrite-console-xwin >/dev/null
run() { # IMAGE TARGET-DIR COMMAND
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/home -e XWIN_CACHE_DIR=/xwin -e CARGO_TARGET_DIR="/src/ferrite-console/$2" ${envf[@]+"${envf[@]}"} \
    -v "$dir:/src" -v ferrite-console-xwin:/xwin -w /src/ferrite-console "$1" bash -c "set -o pipefail; $3"
}
docker run --rm -v ferrite-console-xwin:/xwin alpine chmod 777 /xwin
out=$dir/out; rm -rf "$out"; mkdir -p "$out"
# The web front end once (the wasm core, fonts, Vite), in the Linux box: both apps bundle the same dist/, and the
# npm packages (the Tauri CLI's binary included) run in either box, both x86-64 Linux. The Tauri builds then skip
# their beforeBuildCommand. (They each ran npm ci and the whole front end before, one after the other.)
fe=$(date +%s)
run ferrite-console-desktop-linux target-linux "npm ci --no-audit --no-fund --silent && npm run build:app >/dev/null 2>&1" ||
  { echo "the front end failed: npm run build:app on its own shows why" >&2; exit 1; }
echo "front end: $(( $(date +%s) - fe )) s"
# Then Linux and Windows at once: their cargo targets are apart, and a release build spends long stretches on one
# core (LTO with one codegen unit), so two side by side finish in little more than the slower one's time.
pids=() names=()
if [ "$what" != windows ]; then
  ( t=$(date +%s)
    rm -rf ferrite-console/target-linux/release/bundle # only this build's installers, not every older version's
    run ferrite-console-desktop-linux target-linux "npx tauri build --config '$cfg'" >"$dir/linux.log" 2>&1
    cp ferrite-console/target-linux/release/bundle/deb/*.deb ferrite-console/target-linux/release/bundle/rpm/*.rpm \
       ferrite-console/target-linux/release/bundle/appimage/*.AppImage "$out/"
    [ -z "${envf[*]}" ] || cp ferrite-console/target-linux/release/bundle/appimage/*.AppImage.sig "$out/"
    echo "linux: $(( $(date +%s) - t )) s" ) &
  pids+=($!) names+=(linux)
fi
if [ "$what" != linux ]; then
  ( t=$(date +%s)
    rm -rf ferrite-console/target/x86_64-pc-windows-msvc/release/bundle
    run ferrite-console-desktop target "npx tauri build --config '$cfg' --runner cargo-xwin --target x86_64-pc-windows-msvc" >"$dir/windows.log" 2>&1
    cp ferrite-console/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe "$out/"
    # The bare app too: runs without installing (Windows 10 and 11 have the WebView2 runtime it needs).
    cp ferrite-console/target/x86_64-pc-windows-msvc/release/ferrite-console-app.exe "$out/Ferrite Console portable.exe"
    echo "windows: $(( $(date +%s) - t )) s" ) &
  pids+=($!) names+=(windows)
fi
failed=""
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || { failed="$failed ${names[$i]}"; echo "== ${names[$i]} failed; the end of $dir/${names[$i]}.log:" >&2; tail -n 25 "$dir/${names[$i]}.log" >&2; }
done
[ -z "$failed" ] || exit 1
ls -la "$out"
REMOTE
mkdir -p "$here/target/desktop"
rsync -e "$ssh" -a "$host:$dir/out/" "$here/target/desktop/"
ls -la "$here/target/desktop"
