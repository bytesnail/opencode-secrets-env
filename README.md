# opencode-secrets-env

[![English](https://img.shields.io/badge/lang-English-blue)](./README.md)
[![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](./README.zh-CN.md)

An [OpenCode](https://opencode.ai) plugin that loads secrets from
`~/.config/opencode/secrets.env` into `process.env` when OpenCode starts.

The injected variables can then be used by:

- **MCP servers** — via `{env:NAME}` substitution in `mcp.servers.*.environment` / `headers`
- **Other plugins** — any plugin loaded after this one reads them from `process.env`
- **OpenCode itself** — e.g. provider API keys discovered from the environment

Secrets stay out of `opencode.json(c)`, so your configuration can be committed
to a dotfiles repo without leaking keys.

## Install

```sh
opencode plugin add opencode-secrets-env
```

Or add it manually to `~/.config/opencode/opencode.jsonc` (global) or a
project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // list it FIRST so later plugins already see the variables in their setup()
    "opencode-secrets-env"
  ]
}
```

## Usage

Create the secrets file (dotenv format) and lock down its permissions
([secrets.env.example](./secrets.env.example) is a starting point):

```sh
mkdir -p ~/.config/opencode
cat >> ~/.config/opencode/secrets.env <<'EOF'
GITHUB_TOKEN=ghp_xxx
CONTEXT7_API_KEY=ctx7_xxx
EOF
chmod 600 ~/.config/opencode/secrets.env
```

Reference the variables from your OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-secrets-env"],
  "mcp": {
    "servers": {
      "context7": {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp",
        "oauth": false,
        "headers": { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" }
      },
      "github": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
        "environment": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
      }
    }
  }
}
```

Restart the service so the plugin (re)injects the variables:

```sh
opencode service restart
```

The file location follows the XDG Base Directory spec, like OpenCode itself:
`$XDG_CONFIG_HOME/opencode/secrets.env` when `XDG_CONFIG_HOME` is set,
otherwise `~/.config/opencode/secrets.env`.

### File format

Standard [dotenv](https://github.com/motdotla/dotenv) syntax:

```dotenv
# comments and blank lines are fine
export OPTIONAL_EXPORT_PREFIX=value
QUOTED="values with spaces"
SINGLE='also quoted'
INLINE=value # trailing comment
EMPTY=
```

## Options

Pass options with the object form in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-secrets-env",
      "options": {
        "path": "~/secrets/work.env",
        "override": false,
        "required": ["GITHUB_TOKEN"],
        "debug": true
      }
    }
  ]
}
```

| Option     | Type       | Default | Description |
| ---------- | ---------- | ------- | ----------- |
| `path`     | `string`   | `~/.config/opencode/secrets.env` | Custom secrets file. Supports `~` and relative paths (resolved against the project directory). |
| `override` | `boolean`  | `false` | Overwrite variables that already exist in the real environment. By default the real environment always wins. |
| `required` | `string[]` | `[]`    | Variables that must exist after loading. A warning is logged for each missing one. |
| `watch`    | `boolean`  | `true`  | Watch the secrets file and hot-reload `process.env` when it changes (see below). |
| `mcpReconnect` | `boolean \| "all" \| string[]` | `true` | After a hot reload, reconnect MCP servers so they pick up new values. `true` = only servers whose config references a changed variable (precise), `"all"` = every enabled server, `["name"]` = only those servers, `false` = never. |
| `quiet`    | `boolean`  | `false` | Silence info/debug messages (warnings are always shown). |
| `debug`    | `boolean`  | `false` | Also log the *names* of applied/skipped keys. Values are never logged. |

## Hot reload

When `watch` is enabled (the default), editing `secrets.env` takes effect
within about a second — no `opencode service restart` needed:

- **Added keys** are injected into the running service's `process.env`.
- **Changed keys** are updated in place — but only keys the plugin itself
  injected. Variables that came from your real shell environment are never
  touched (unless `override` is set).
- **Deleted keys** are withdrawn from `process.env` (with `override`, the
  original shell value is restored).

The file does not have to exist at startup: the plugin watches the nearest
existing parent directory and starts applying entries as soon as the file
(and its directory) appears — handy when you install the plugin first and
create `secrets.env` afterwards.

MCP servers are long-lived processes that received their environment at
spawn, so after a hot reload the plugin reconnects the affected ones
(`mcpReconnect`). With the default `true`, "affected" is computed
precisely: the plugin scans your raw config files for `{env:...}`
references and only reconnects enabled servers that reference one of the
changed variables — unrelated servers keep running untouched. Servers you
explicitly disabled are never touched. Caveats:

- A tool call in flight while its server reconnects may fail (the agent can
  simply retry).
- Stateful MCP servers (e.g. browser automation) lose their state across a
  reconnect — they are not reconnected unless they reference a changed
  variable, and you can exclude them further with `mcpReconnect: ["name"]`.
- Servers that read secrets from the *inherited* environment without an
  explicit `{env:...}` reference cannot be detected this way; they pick up
  new values on their next natural connect, or use `mcpReconnect: "all"`
  to restart every enabled server on each change.

The plugin also registers a permanent transform that re-resolves every
`{env:...}` reference found in your raw config files against the live
environment whenever OpenCode rebuilds its MCP configuration. Besides hot
reloads, this fixes a race where a server's *first* connection could
otherwise start with empty substituted values.

## Logging

The OpenCode background service runs detached, so plugin console output is
invisible. This plugin therefore also appends to its own log file:

```text
~/.local/share/opencode/log/opencode-secrets-env.log
```

(`$XDG_DATA_HOME/opencode/log/...` when `XDG_DATA_HOME` is set.)

Only counts and key *names* are ever logged — never secret values.

## Notes & security

- **Ordering**: put `opencode-secrets-env` before other plugins in the
  `plugins` array. Plugins run their `setup()` in order, and only later
  plugins will see the injected variables.
- **Reloading**: with `watch` on (default), edits to `secrets.env` apply
  automatically within a second. With `watch: false`, run
  `opencode service restart` after editing.
- **Permissions**: keep the file at `chmod 600`. The plugin warns when it is
  readable by other users.
- **No project-level auto-loading**: only your global file (or an explicitly
  configured `path`) is read, so a cloned repository cannot smuggle variables
  into your environment.
- **Local MCP servers inherit the full environment** of the OpenCode process,
  including every injected secret — that is the point of this plugin, but only
  run MCP servers you trust.
- **OpenCode V1**: the package also exports a V1 (`>= 1.18.29`) entry point.
  V1 hosts have no MCP transform API, so env substitution into MCP configs and
  MCP reconnection are skipped; secret injection, `options`, hot reload and
  clean withdrawal on shutdown all work. V2 is the primary target.

## Development

```sh
npm install
npm run typecheck
npm test
```

The package is published as TypeScript source (OpenCode loads plugins
directly), so there is no build step. The plugin entry point is `index.ts` at
the package root; `env.ts` holds the pure loading logic and `rawconfig.ts`
the raw-config scanning. Everything is unit tested with `node --test`,
including an end-to-end pass through the V1 entry point and a V2 pass
through `setup()` with a fake MCP domain covering env-ref substitution and
precise reconnection.

To load a local checkout while developing, reference the directory:

```jsonc
{
  "plugins": [
    { "package": "/path/to/opencode-secrets-env", "options": { "debug": true } }
  ]
}
```

## License

[MIT](./LICENSE)
