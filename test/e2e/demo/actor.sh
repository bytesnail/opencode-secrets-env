#!/usr/bin/env bash
# Recorded performance. Runs under asciinema inside demo-env.sh.
set -u
cd "$HOME"

type() { # simulate human typing
  local s="$*"
  for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep 0.045; done
  sleep 0.35; echo
}
say() { printf '\n\033[1;36m# %s\033[0m\n' "$*"; sleep 1.8; }
run() { printf '\033[1;32m$\033[0m '; type "$*"; eval "$*"; sleep 1.2; }

clear
say "opencode-secrets-env — live demo against a real OpenCode V2 service"

run "stat -c '%A (%a)  %n' ~/.config/opencode/secrets.env"
run 'cat ~/.config/opencode/secrets.env'
say "an MCP server references the key via {env:...} — no secret in the config"
run 'cat ~/demo-project/opencode.jsonc'
sleep 1

clear
say "start the OpenCode background service (V2)"
run 'cd ~/demo-project && opencode service start'
say "the first CLI call from the project dir boots the location:"
printf '\033[1;32m$\033[0m '; type 'opencode mcp list > /dev/null'
opencode mcp list > /dev/null 2>&1
until [ -s ~/demo-dump.jsonl ]; do sleep 0.2; done # wait for eager MCP connect
sleep 0.8
say "plugin injected at startup — the MCP process was spawned WITH the secret"
run 'head -n 3 ~/.local/share/opencode/log/opencode-secrets-env.log'
run 'cat ~/demo-dump.jsonl'
sleep 1.5

clear
say "now rotate the key — no service restart"
run "sed -i 's/sk-demo-old/sk-demo-new/' ~/.config/opencode/secrets.env"
printf '\n\033[1;36m# the plugin log reacts within ~1s:\033[0m\n'
until [ "$(wc -l < ~/demo-dump.jsonl 2>/dev/null || echo 0)" -ge 2 ]; do sleep 0.2; done
sleep 0.6
printf '\033[1;32m$\033[0m '; type "grep -E 'reload:|reconnecting' ~/.local/share/opencode/log/opencode-secrets-env.log | tail -2"
grep -E 'reload:|reconnecting' ~/.local/share/opencode/log/opencode-secrets-env.log | tail -2
sleep 1.5
printf '\033[1;32m$\033[0m '; type 'cat ~/demo-dump.jsonl'
cat ~/demo-dump.jsonl
sleep 2.5
say "new pid, new value — the MCP server picked up the rotated key automatically"
sleep 1

clear
printf '\n\n  \033[1;32m✔\033[0m \033[1msecrets live outside opencode.json — rotate them without a restart\033[0m\n\n'
printf '  \033[2mhttps://github.com/bytesnail/opencode-secrets-env\033[0m\n'
sleep 3.5
