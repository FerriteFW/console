# Ferrite Console's everyday commands: `just --list`. First time: `just setup`.
# The recipes call package.json's scripts, cargo and tools/.

set dotenv-load
set positional-arguments
set shell := ["bash", "-euo", "pipefail", "-c"]

# The maintainers' release recipes (personal.just.example), when present
import? 'personal.just'

version := `sed -n 's/^  "version": "\(.*\)",/\1/p' package.json`

# The firmware the app bundles: FIRMWARE (.env), else ../ferrite/target's build, else the release just setup downloaded
firmware := env("FIRMWARE", if path_exists(justfile_directory() / "../ferrite/target/ferrite-tx.ffw") == "true" { "" } else if path_exists(justfile_directory() / "target/firmware/ferrite-" + version + ".ffw") == "true" { "target/firmware/ferrite-" + version + ".ffw target/firmware/ferrite-reader.btf target/firmware/ferrite-restorer.btf" } else { "" })

_default:
    @just --list

# Ferrite beside this checkout (cloned at the release when absent), the toolchain, wasm-bindgen, npm packages, the wasm core
setup:
    tools/setup.sh

# Check the installed versions against the pins (installs nothing)
doctor:
    tools/setup.sh --check

# The core's Rust tests and the Node unit tests (summaries; full log target/just/test.log)
test:
    #!/usr/bin/env bash
    set -uo pipefail
    mkdir -p target/just; log=target/just/test.log; : > $log; bad=0
    cargo test -p ferrite-console-core >> $log 2>&1 \
        && echo "core: $(grep -E '^test result:' $log | awk '{p+=$4; f+=$6} END {print p" passed, "f" failed"}')" \
        || { echo "core: FAILED"; grep -E "^test .* FAILED|panicked|^error" $log | head -n 20; bad=1; }
    node --test --test-reporter=spec tests/unit/ > target/just/unit.log 2>&1 || bad=1
    cat target/just/unit.log >> $log
    echo "unit: $(grep -E '^ℹ (pass|fail) ' target/just/unit.log | sed 's/^ℹ //' | paste -sd ',' - | sed 's/,/, /')"
    [ $bad -eq 0 ] || { grep -E "^not ok|✖" target/just/unit.log | head -n 20; echo "failed: $log"; }
    exit $bad

# Clippy on the whole workspace (the core, the wasm core, the desktop shell), warnings as errors; there is no JS lint
lint:
    cargo clippy -q --workspace --all-targets -- -D warnings
    @echo "lint: ok"

# The web UI with hot reload (Chrome or Edge): http://localhost:PORT
dev port="1420":
    npm run dev -- --port {{port}} --strictPort

# The web build -> dist/
build:
    mkdir -p target/just
    npm run build 2>&1 | tee target/just/build.log | tail -n 3

# Put the firmware in the app (public/firmware/): FIRMWARE, else ../ferrite/target's build, else the downloaded release
bundle-firmware:
    node scripts/bundle-firmware.mjs {{firmware}}

# The desktop app: mac (here, into target/desktop/), all (Linux and Windows on FERRITE_REMOTE's host), release (both)
desktop what="mac":
    #!/usr/bin/env bash
    set -euo pipefail
    host=()
    if [ "{{what}}" != mac ] && [ -n "${FERRITE_REMOTE:-}" ]; then host=(--host "${FERRITE_REMOTE%%:*}"); fi
    FIRMWARE="{{firmware}}" tools/desktop-build.sh {{what}} ${host[@]+"${host[@]}"}

# The end-to-end tests: build, then Playwright on headless simulators (needs ../ferrite); args go to Playwright
e2e *args:
    #!/usr/bin/env bash
    set -uo pipefail
    mkdir -p target/just
    npm run -s build:dev > target/just/e2e.log 2>&1 || { tail -n 20 target/just/e2e.log; exit 1; }
    npx playwright test "$@" >> target/just/e2e.log 2>&1; code=$?
    grep -E "^ +[0-9]+ (passed|failed|flaky|skipped)|^ +\[.*\] .*›.*$" target/just/e2e.log | grep -vE "^ +\[.*\] .* ✓" | tail -n 25
    [ $code -eq 0 ] || echo "failed: target/just/e2e.log, playwright-report/"
    exit $code

# Run a recipe on FERRITE_REMOTE (.env): copies the checkout (and ../ferrite) there first
remote +args:
    tools/remote.sh "$@"
