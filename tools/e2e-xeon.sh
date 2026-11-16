#!/usr/bin/env bash
# The e2e suite on the Xeon: copies this checkout there, installs the npm packages when package-lock.json changed,
# builds, runs Playwright and prints the summary. The simulator comes from ../ferrite there (synced separately, see
# the root CLAUDE.md). Usage: tools/e2e-xeon.sh [--dir DIR] [--host USER@HOST] [-v] [playwright args...]
# DIR is relative to the home directory there (default code/rt950pro/ferrite-console; keep it next to ferrite/).
set -euo pipefail
host=${FERRITE_XEON:-xeon}
dir=code/rt950pro/ferrite-console
full=0
while [ $# -gt 0 ]; do
  case $1 in
    --dir) dir=${2#\~/}; shift 2 ;;
    --host) host=$2; shift 2 ;;
    -v) full=1; shift ;;
    *) break ;;
  esac
done
here=$(cd "$(dirname "$0")/.." && pwd)
# Other jobs use the Xeon too, and it refuses bursts of new connections: one shared connection, retried slowly.
ssh="ssh -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-e2e-%C -o ControlPersist=120"
for i in $(seq 12); do $ssh -o ConnectTimeout=5 "$host" true 2>/dev/null && break; sleep 10; done
rsync -e "$ssh" -az --delete --exclude .git --exclude .claude --exclude node_modules/ --exclude target/ --exclude dist/ \
  --exclude src/core-wasm/ --exclude test-results/ --exclude playwright-report/ "$here/" "$host:$dir/"
$ssh "$host" bash -s -- "$dir" "$full" "$@" <<'EOF'
set -euo pipefail
dir=$1 full=$2; shift 2
cd "$HOME/$dir"
export PATH=$HOME/.cargo/bin:$PATH
lock=$(sha1sum package-lock.json | cut -d' ' -f1)
if [ "$(cat node_modules/.ferrite-lock 2>/dev/null)" != "$lock" ]; then
  npm ci --no-audit --no-fund >/dev/null
  echo "$lock" > node_modules/.ferrite-lock
fi
log=$(mktemp)
npm run -s build:dev >"$log" 2>&1 || { cat "$log"; exit 1; } # the developer build: the e2e tests connect through the bridge
start=$(date +%s%N)
set +e
if [ "$full" = 1 ]; then npx playwright test "$@"; else npx playwright test "$@" >"$log" 2>&1; fi
code=$?
[ "$full" = 1 ] || tail -n 25 "$log"
rm -f "$log"
echo "playwright: $(( ($(date +%s%N) - start) / 1000000 )) ms"
exit $code
EOF
