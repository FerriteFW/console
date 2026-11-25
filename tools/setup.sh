#!/usr/bin/env bash
# just setup: Ferrite beside this checkout (../ferrite, cloned at the matching release when absent), the pinned Rust
# toolchain and wasm-bindgen, the npm packages, the wasm core, Playwright's Chromium, and the released Ferrite files
# for the app when ../ferrite has no build of its own; then what is here.
# just doctor (tools/setup.sh --check): only checks the versions against the pins, installs nothing.
set -uo pipefail
cd "$(dirname "$0")/.."
check=${1:-}
NODE=$(cat .node-version)
NODE_MIN=22.18 # the unit tests import .ts files: Node strips the types itself from 22.18 (Node 20 can't run them)
TOOLCHAIN=$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml)
BINDGEN=$(sed -n 's/^wasm-bindgen = "=\(.*\)"/\1/p' wasm/Cargo.toml)
VERSION=$(sed -n 's/^  "version": "\(.*\)",/\1/p' package.json)
FERRITE_GIT=https://github.com/FerriteFW/ferrite
bad=0
ok() { printf '  ok       %s\n' "$*"; }
no() { printf '  MISSING  %s\n' "$*"; bad=1; }
note() { printf '  -        %s\n' "$*"; }

echo "ferrite"
# Console builds Ferrite's crates by path (Cargo.toml): a checkout beside this one. Without one, the release of the
# same version (lock-step tags), so a fresh clone builds; the maintainers' own checkout is used as it is.
if [ ! -d ../ferrite/crates ] && [ -z "$check" ] && command -v git >/dev/null; then
    tag=v$VERSION
    git ls-remote --exit-code --tags "$FERRITE_GIT" "refs/tags/$tag" >/dev/null 2>&1 || tag=main
    echo "  cloning $FERRITE_GIT at $tag into ../ferrite"
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" "$FERRITE_GIT" ../ferrite || no "../ferrite: git clone failed"
fi
if [ -d ../ferrite/crates ]; then
    at=$(git -C ../ferrite describe --tags --always 2>/dev/null || echo "?")
    ok "../ferrite ($at)"
else
    no "../ferrite: Ferrite's checkout beside this one (just setup clones it)"
fi

echo "tools"
if ! command -v node >/dev/null; then
    no "Node $NODE (.node-version; https://nodejs.org)"
else
    have=$(node --version | sed 's/^v//')
    if ! printf '%s\n%s\n' "$NODE_MIN" "$have" | sort -V -C; then no "Node >= $NODE_MIN (found $have; .node-version)"
    elif [ "${have%%.*}" = "$NODE" ]; then ok "Node $have (.node-version)"
    else ok "Node $have (>= $NODE_MIN, .node-version)"; fi
fi
if command -v npm >/dev/null; then ok "npm $(npm --version)"; else no "npm"; fi

if ! command -v rustup >/dev/null; then
    no "rustup (https://rustup.rs)"
else
    [ -z "$check" ] && rustup toolchain install >/dev/null 2>&1 # reads rust-toolchain.toml: the version, wasm32, clippy
    if rustup toolchain list | grep -q "^$TOOLCHAIN"; then ok "Rust $TOOLCHAIN (rust-toolchain.toml)"; else no "Rust $TOOLCHAIN (just setup)"; fi
fi

have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')
if [ "$have" != "$BINDGEN" ] && [ -z "$check" ] && command -v cargo >/dev/null; then
    echo "  installing wasm-bindgen-cli $BINDGEN (a few minutes)"
    cargo install -q wasm-bindgen-cli --version "$BINDGEN" --locked && have=$BINDGEN
fi
if [ "$have" = "$BINDGEN" ]; then ok "wasm-bindgen $BINDGEN (wasm/Cargo.toml)"
elif [ -n "$have" ]; then no "wasm-bindgen $BINDGEN (found $have; just setup)"
else no "wasm-bindgen $BINDGEN (just setup)"; fi
if command -v just >/dev/null; then ok "$(just --version)"; else no "just (brew install just, cargo install just)"; fi

echo "packages"
if [ -z "$check" ] && command -v npm >/dev/null; then
    npm ci --no-audit --no-fund --silent || no "npm ci failed"
fi
if [ -d node_modules/vite ]; then ok "node_modules (package-lock.json)"; else no "node_modules (just setup)"; fi
if [ -z "$check" ] && [ -d node_modules/vite ] && [ -d ../ferrite/crates ]; then
    mkdir -p target/just
    npm run -s wasm >target/just/wasm.log 2>&1 || no "the wasm core: npm run wasm (target/just/wasm.log)"
fi
if [ -f src/core-wasm/core.js ]; then ok "the wasm core (src/core-wasm/)"; else no "the wasm core (just setup)"; fi
if [ -z "$check" ] && [ -d node_modules/@playwright ]; then
    npx playwright install chromium >/dev/null 2>&1 || note "Playwright's Chromium: npx playwright install chromium failed (only just e2e needs it)"
fi

echo "firmware (the files the app installs)"
# ../ferrite's own build when there is one (its tools/mkbtf.sh tx, reader); else the release's, from GitHub, into
# target/firmware/ (just desktop and just bundle-firmware use them).
if [ -f ../ferrite/target/ferrite-tx.ffw ] && [ -f ../ferrite/target/ferrite-reader.btf ]; then
    ok "../ferrite/target's build"
else
    rel=$FERRITE_GIT/releases/download/v$VERSION
    if [ -z "$check" ] && [ ! -f "target/firmware/ferrite-$VERSION.ffw" ]; then
        mkdir -p target/firmware
        for f in "ferrite-$VERSION.ffw" ferrite-reader.btf ferrite-reader.btf.minisig ferrite-restorer.btf ferrite-restorer.btf.minisig; do
            curl -fsSL -o "target/firmware/$f" "$rel/$f" || { rm -f "target/firmware/$f"; note "$f: not in Ferrite v$VERSION's release"; }
        done
    fi
    if [ -f "target/firmware/ferrite-$VERSION.ffw" ]; then ok "Ferrite v$VERSION's release (target/firmware/)"
    else note "no firmware to bundle: ../ferrite/target has no build and v$VERSION's release isn't downloaded (just setup)"; fi
fi

echo "optional"
[ -f .env ] && set -a && . ./.env && set +a
if [ -n "${FERRITE_REMOTE:-}" ]; then ok "FERRITE_REMOTE=$FERRITE_REMOTE (just remote RECIPE)"; else note "FERRITE_REMOTE not set (.env.example)"; fi
if [ -f personal.just ]; then ok "personal.just (the release recipes)"; else note "no personal.just (maintainers: personal.just.example)"; fi
exit $bad
