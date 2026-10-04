#!/usr/bin/env bash
# Re-record .github/assets/demo.gif end to end. See README.md in this
# directory for prereqs (asciinema + agg) and gotchas.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/../../.." && pwd)
export DEMO_DIR=${DEMO_DIR:-/tmp/opencode/demo}
HOST_SPEC=${OPENCODE_E2E_V2_SPEC:-@opencode/cli@2.0.22}

# 1. pack the plugin and install it + the pinned host into the work dir
mkdir -p "$DEMO_DIR"
(cd "$REPO_ROOT" && npm pack --silent --pack-destination "$DEMO_DIR" >/dev/null)
npm install --prefix "$DEMO_DIR/plugin" --loglevel=error "$DEMO_DIR"/opencode-secrets-env-*.tgz
npm install --prefix "$DEMO_DIR/host" --loglevel=error "$HOST_SPEC"

# 2. sandbox + configs + sandboxed service port
bash "$HERE/setup.sh"

# 3. record (100x26 terminal, idle time capped at 2s)
asciinema rec --overwrite --cols 100 --rows 26 -i 2 \
  -c "DEMO_DIR='$DEMO_DIR' bash '$HERE/demo-env.sh' bash '$HERE/actor.sh'" \
  "$DEMO_DIR/demo.cast"

# 4. render the GIF into the repo
agg --font-size 16 --fps-cap 12 --last-frame-duration 3 \
  "$DEMO_DIR/demo.cast" "$REPO_ROOT/.github/assets/demo.gif"

# 5. cleanup (kill by pid list — a pkill pattern would match this script too)
"$HERE/demo-env.sh" bash -c 'cd "$HOME/demo-project" && opencode service stop >/dev/null 2>&1' || true
pgrep -f "$DEMO_DIR/stub.mjs" | xargs -r kill 2>/dev/null || true
echo "done: $REPO_ROOT/.github/assets/demo.gif"
