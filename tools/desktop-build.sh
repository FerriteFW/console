#!/usr/bin/env bash
# The desktop app for Linux and Windows, built in Docker on the Xeon (tools/desktop/Dockerfile): copies the last
# commit of this repo and of ../ferrite there (what's committed, not the working tree), builds, and brings the
# bundles back to target/desktop/. Usage: tools/desktop-build.sh [linux|windows|all] [--host USER@HOST]
# Windows: cargo-xwin downloads Microsoft's CRT and Windows SDK on its first run (kept in a cache volume there);
# using them means accepting Microsoft's licence for them.
set -euo pipefail
host=${FERRITE_XEON:-infamy@192.168.7.162}
what=all
while [ $# -gt 0 ]; do
  case $1 in
    linux|windows|all) what=$1; shift ;;
    --host) host=$2; shift 2 ;;
    *) echo "usage: $0 [linux|windows|all] [--host USER@HOST]" >&2; exit 2 ;;
  esac
done
here=$(cd "$(dirname "$0")/.." && pwd)
dir=code/console-build
ssh="ssh -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-desk-%C -o ControlPersist=120"
for i in $(seq 12); do $ssh -o ConnectTimeout=5 "$host" true 2>/dev/null && break; sleep 10; done
$ssh "$host" "mkdir -p $dir && rm -rf $dir/ferrite $dir/ferrite-console/src $dir/ferrite-console/src-tauri/src && mkdir -p $dir/ferrite $dir/ferrite-console"
git -C "$here/../ferrite" archive HEAD | $ssh "$host" "tar -x -C $dir/ferrite"
git -C "$here" archive HEAD | $ssh "$host" "tar -x -C $dir/ferrite-console"
$ssh "$host" bash -s -- "$dir" "$what" <<'REMOTE'
set -euo pipefail
dir=$HOME/$1 what=$2
docker build -q -t ferrite-console-desktop "$dir/ferrite-console/tools/desktop" >/dev/null
docker volume create ferrite-console-xwin >/dev/null
run() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/home -e XWIN_CACHE_DIR=/xwin \
    -v "$dir:/src" -v ferrite-console-xwin:/xwin -w /src/ferrite-console ferrite-console-desktop bash -c "$1"
}
docker run --rm -v ferrite-console-xwin:/xwin alpine chmod 777 /xwin
run 'npm ci --no-audit --no-fund --silent'
out=$dir/out; rm -rf "$out"; mkdir -p "$out"
if [ "$what" != windows ]; then
  run 'npx tauri build 2>&1 | tail -n 15'
  cp ferrite-console/target/release/bundle/deb/*.deb ferrite-console/target/release/bundle/rpm/*.rpm \
     ferrite-console/target/release/bundle/appimage/*.AppImage "$out/" 2>/dev/null || true
fi
if [ "$what" != linux ]; then
  run 'npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc 2>&1 | tail -n 15'
  cp ferrite-console/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe "$out/" 2>/dev/null || true
fi
ls -la "$out"
REMOTE
mkdir -p "$here/target/desktop"
rsync -e "$ssh" -a "$host:$dir/out/" "$here/target/desktop/"
ls -la "$here/target/desktop"
