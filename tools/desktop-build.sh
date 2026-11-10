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
host=${FERRITE_XEON:-infamy@192.168.7.162}
what=all
while [ $# -gt 0 ]; do
  case $1 in
    linux|windows|mac|all) what=$1; shift ;;
    --host) host=$2; shift 2 ;;
    *) echo "usage: $0 [linux|windows|mac|all] [--host USER@HOST]" >&2; exit 2 ;;
  esac
done
here=$(cd "$(dirname "$0")/.." && pwd)
if [ "$what" = mac ]; then
  [ "$(uname)" = Darwin ] || { echo "mac: build on a Mac" >&2; exit 1; }
  cd "$here"
  node scripts/bundle-firmware.mjs ${FIRMWARE:-} >/dev/null # as the Docker builds below
  npx tauri build --bundles app,dmg 2>&1 | tail -n 8
  mkdir -p target/desktop
  rm -rf "target/desktop/Ferrite Console.app"
  cp -R target/release/bundle/macos/*.app target/release/bundle/dmg/*.dmg target/desktop/
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
$ssh "$host" bash -s -- "$dir" "$what" <<'REMOTE'
set -euo pipefail
dir=$HOME/$1 what=$2
cd "$dir"
# Two build boxes: Linux on Ubuntu 22.04 (tools/desktop/linux: the oldest glibc to support), Windows on Debian 13
# (tools/desktop: NSIS 3.11 for the installer). Each its own cargo target folder: build scripts compiled against one
# glibc don't run on the other.
[ "$what" = windows ] || docker build -q -t ferrite-console-desktop-linux "$dir/ferrite-console/tools/desktop/linux" >/dev/null
[ "$what" = linux ] || docker build -q -t ferrite-console-desktop "$dir/ferrite-console/tools/desktop" >/dev/null
docker volume create ferrite-console-xwin >/dev/null
run() { # IMAGE TARGET-DIR COMMAND
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/home -e XWIN_CACHE_DIR=/xwin -e CARGO_TARGET_DIR="/src/ferrite-console/$2" \
    -v "$dir:/src" -v ferrite-console-xwin:/xwin -w /src/ferrite-console "$1" bash -c "npm ci --no-audit --no-fund --silent && $3"
}
docker run --rm -v ferrite-console-xwin:/xwin alpine chmod 777 /xwin
out=$dir/out; rm -rf "$out"; mkdir -p "$out"
if [ "$what" != windows ]; then
  run ferrite-console-desktop-linux target-linux 'npx tauri build 2>&1 | tail -n 15'
  cp ferrite-console/target-linux/release/bundle/deb/*.deb ferrite-console/target-linux/release/bundle/rpm/*.rpm \
     ferrite-console/target-linux/release/bundle/appimage/*.AppImage "$out/" 2>/dev/null || true
fi
if [ "$what" != linux ]; then
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
