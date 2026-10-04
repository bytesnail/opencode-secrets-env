#!/usr/bin/env bash
# Hidden pre-recording setup: sandbox HOME, configs, secrets, service port.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
D=${DEMO_DIR:-/tmp/opencode/demo}
export HOME=$D/home
NODEBIN=$(command -v node)
chmod +x "$HERE/demo-env.sh"

# stop any leftover demo service from a previous take (best-effort)
DEMO_DIR="$D" "$HERE/demo-env.sh" bash -c 'cd "$HOME/demo-project" 2>/dev/null && opencode service stop >/dev/null 2>&1' || true

rm -rf "$HOME"
mkdir -p "$HOME/.config/opencode" "$HOME/demo-project" "$D/bin"
cp "$HERE/stub.mjs" "$D/stub.mjs"
ln -sf "$NODEBIN" "$D/bin/node"
HOSTBIN=""
for c in opencode.exe opencode; do
  if [ -e "$D/host/node_modules/@opencode/cli/bin/$c" ]; then HOSTBIN="$D/host/node_modules/@opencode/cli/bin/$c"; break; fi
done
[ -n "$HOSTBIN" ] || { echo "host binary not found — run record.sh, it installs the host first"; exit 1; }
ln -sf "$HOSTBIN" "$D/bin/opencode"

printf 'DEMO_API_KEY=sk-demo-old\n' > "$HOME/.config/opencode/secrets.env"
chmod 600 "$HOME/.config/opencode/secrets.env"

cat > "$HOME/.config/opencode/opencode.jsonc" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "plugin": [["$D/plugin/node_modules/opencode-secrets-env", { "debug": true }]]
}
EOF

cat > "$HOME/demo-project/opencode.jsonc" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "demo": {
        "type": "local",
        "command": ["$D/bin/node", "$D/stub.mjs"],
        "environment": { "API_KEY": "{env:DEMO_API_KEY}" }
      }
    }
  }
}
EOF

# Fixed non-default service port: never collide with a real OpenCode service
# on this box. Runs INSIDE the sandboxed env so service.json lands in the
# demo config dir, not the user's (see README.md in this directory).
DEMO_DIR="$D" "$HERE/demo-env.sh" bash -c 'cd "$HOME/demo-project" && opencode service set port 46131 >/dev/null'
grep -q 46131 "$HOME/.config/opencode/service.json" || { echo "port not sandboxed!"; exit 1; }
echo "setup done (host: $HOSTBIN)"
