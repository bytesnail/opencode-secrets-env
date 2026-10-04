# Demo recording harness

Everything needed to re-record `.github/assets/demo.gif` (the hot-reload
demo at the top of the READMEs). The GIF shows the **real chain** — packed
plugin, real pinned V2 host, real service — running in an isolated sandbox;
only the typing and pauses are staged.

## Prereqs

- `asciinema` (`pip install asciinema`) and `agg`
  (prebuilt binary from <https://github.com/asciinema/agg/releases>) on PATH
- network access for `npm pack` / host install (~100 MB on first run)

## Re-record

```sh
test/e2e/demo/record.sh          # writes .github/assets/demo.gif
```

`DEMO_DIR` overrides the work dir (default `/tmp/opencode/demo`);
`OPENCODE_E2E_V2_SPEC` overrides the pinned host, like the e2e harness.
`demo.cast` is the checked-in recording of the current GIF — re-render it
with different `agg` settings without re-recording:

```sh
agg --font-size 16 --fps-cap 12 --last-frame-duration 3 \
  test/e2e/demo/demo.cast /tmp/demo.gif
```

## How it works / gotchas (learned the hard way)

- `setup.sh` builds a sandbox HOME with a global `secrets.env`
  (`DEMO_API_KEY=sk-demo-old`, chmod 600), the plugin from `npm pack`, and a
  `demo-project/` whose MCP server references `{env:DEMO_API_KEY}`.
  `stub.mjs` records pid + inherited/substituted values to a dump file on
  spawn — the on-screen proof that a reconnect actually re-delivered values.
- `demo-env.sh` strips **all** ambient `OPENCODE_*` and `XDG_*` variables and
  pins the XDG dirs inside the sandbox. This matters on a dev box already
  running OpenCode: with the ambient `XDG_CONFIG_HOME`, `opencode service
  set port` would overwrite the *real* `~/.config/opencode/service.json`
  (this actually happened — restore the port from the running service's
  listener if it ever recurs).
- A fixed non-default service port (46131) is configured inside the sandbox
  so the demo never collides with a real service.
- `actor.sh` is the recorded performance (simulated typing). The
  `opencode mcp list` output is redirected to `/dev/null` on purpose: on the
  pinned host it prints `No MCP servers configured` even though the location
  bootstraps and the stub connects (output quirk; the dump file is the
  truthful on-screen proof). Any project-scoped CLI call works as the
  bootstrap trigger.
- When cleaning up manually, never `pkill -f <pattern>` where the pattern
  also appears in your own shell's command line — it self-matches and kills
  your shell. Match `stub.m[j]s`-style bracket patterns or kill by pid.
