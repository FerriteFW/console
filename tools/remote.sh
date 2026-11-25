#!/usr/bin/env bash
# just remote RECIPE [ARGS]: copy this checkout to FERRITE_REMOTE (user@host:path) and run `just RECIPE ARGS` there.
# The checkout goes to path/console, ../ferrite (when present) to path/ferrite beside it, as Cargo.toml expects.
# Not copied: target/, node_modules/, .git, .env (the remote keeps its own); the build outputs (dist/, src/core-wasm/)
# are made there. The remote needs just, cargo and Node (just setup there installs the rest).
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { echo "usage: just remote RECIPE [ARGS...]" >&2; exit 2; }
: "${FERRITE_REMOTE:?set FERRITE_REMOTE=user@host:path in .env (.env.example)}"
host=${FERRITE_REMOTE%%:*}
dir=${FERRITE_REMOTE#*:}
[ "$host" != "$FERRITE_REMOTE" ] && [ -n "$dir" ] || { echo "FERRITE_REMOTE: user@host:path, not $FERRITE_REMOTE" >&2; exit 2; }

ex=(--exclude /target/ --exclude /target-linux/ --exclude .git --exclude /node_modules/ --exclude /.env
    --exclude /dist/ --exclude /dist-single/ --exclude /src/core-wasm/ --exclude /src/fonts/ --exclude /public/firmware/
    --exclude /test-results/ --exclude /playwright-report/ --exclude /.claude/ --exclude __pycache__/)
ssh "$host" "mkdir -p $dir"
rsync -az --delete "${ex[@]}" ./ "$host:$dir/console/"
if [ -d ../ferrite ]; then
    rsync -az --delete --exclude /target/ --exclude .git --exclude /.venv/ --exclude /.env --exclude /.claude/ --exclude __pycache__/ \
        ../ferrite/ "$host:$dir/ferrite/"
fi
# the remote copy of ../ferrite has no .git: its commit goes along, for Ferrite's build stamp (as ferrite's own remote.sh)
fcommit=""
if git -C ../ferrite rev-parse --git-dir >/dev/null 2>&1; then
    fcommit=$(git -C ../ferrite rev-parse --short=7 HEAD)
    if [ -n "$(git -C ../ferrite status --porcelain --untracked-files=no)" ]; then fcommit+=+; fi
fi
args=$(printf ' %q' "$@")
exec ssh "$host" "cd $dir/console && export PATH=\$HOME/.cargo/bin:\$HOME/.local/bin:\$PATH FERRITE_COMMIT=$fcommit &&
    if ! command -v just >/dev/null; then echo 'just is not installed on $host: cargo install just' >&2; exit 127; fi &&
    just$args"
