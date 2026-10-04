#!/usr/bin/env bash
# Env wrapper for the demo recording: strip ambient OpenCode/XDG variables
# (they would leak the real user's config/data dirs on a dev box that runs
# OpenCode), pin sandbox dirs under the demo HOME, and exec the command.
for v in $(env | sed -n 's/^\(OPENCODE_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
D=${DEMO_DIR:-/tmp/opencode/demo}
mkdir -p "$D"
export HOME=$D/home
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share
export XDG_CACHE_HOME=$HOME/.cache XDG_STATE_HOME=$HOME/.local/state
export XDG_RUNTIME_DIR=$D/run
export PATH=$D/bin:/usr/local/bin:/usr/bin:/bin
export OPENCODE_DISABLE_MODELS_FETCH=1 STUB_DUMP=$HOME/demo-dump.jsonl
export TERM=xterm-256color LANG=C.UTF-8
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
exec "$@"
