# opencode-secrets-env

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
including an end-to-end pass through the V1 entry point.

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

---

# 中文说明

一个 [OpenCode](https://opencode.ai) 插件：在 OpenCode 启动时，把
`~/.config/opencode/secrets.env` 中配置的密钥注入到 `process.env`，供
MCP 服务器（`{env:NAME}` 替换）和其他插件使用，避免把密钥写进
`opencode.json(c)`。

## 安装

```sh
opencode plugin add opencode-secrets-env
```

或在 `~/.config/opencode/opencode.jsonc` 中配置（建议放在 `plugins` 数组
**最前面**，这样后面的插件在 `setup()` 时就能读到变量）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-secrets-env"]
}
```

## 使用

```sh
mkdir -p ~/.config/opencode
echo 'Z_AI_API_KEY=your-key' >> ~/.config/opencode/secrets.env
chmod 600 ~/.config/opencode/secrets.env
opencode service restart
```

在 MCP 配置中引用：

```jsonc
{
  "mcp": {
    "servers": {
      "my-server": {
        "type": "remote",
        "url": "https://mcp.example.com/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:MY_API_KEY}" }
      }
    }
  }
}
```

文件路径遵循 XDG 规范：设置了 `XDG_CONFIG_HOME` 时为
`$XDG_CONFIG_HOME/opencode/secrets.env`，否则为
`~/.config/opencode/secrets.env`。文件格式即标准 dotenv
（支持注释、`export ` 前缀、单双引号、行尾注释）。

## 选项

| 选项       | 类型       | 默认值 | 说明 |
| ---------- | ---------- | ------ | ---- |
| `path`     | `string`   | 全局 secrets.env | 自定义密钥文件路径，支持 `~` 与相对路径（相对项目目录解析）。设置后不再读取默认文件。 |
| `override` | `boolean`  | `false` | 是否覆盖真实环境中已存在的变量。默认真实环境优先。 |
| `required` | `string[]` | `[]`    | 加载后必须存在的变量名，缺失时输出警告。 |
| `watch`    | `boolean`  | `true`  | 监听密钥文件变化并热更新 `process.env`（见下文）。 |
| `mcpReconnect` | `boolean \| "all" \| string[]` | `true` | 热更新后自动重连 MCP 服务器使其拿到新值。`true` = 仅重连配置中引用了变化变量的服务器（精确按需），`"all"` = 所有启用的服务器，`["名字"]` = 仅指定服务器，`false` = 不重连。 |
| `quiet`    | `boolean`  | `false` | 静默 info/debug 日志（警告始终输出）。 |
| `debug`    | `boolean`  | `false` | 额外记录注入/跳过的**键名**（值永不记录）。 |

## 热更新

`watch` 开启时（默认），修改 `secrets.env` 后约 1 秒内自动生效，无需
`opencode service restart`：

- **新增**的 key 立即注入运行中的服务进程；
- **修改**的 key 原地更新 —— 但只更新插件自己注入的 key，真实 shell
  环境里的同名变量永不被触碰（除非开启 `override`）；
- **删除**的 key 会从 `process.env` 撤回（`override` 模式下恢复 shell
  原值）。

MCP 服务器是长生命周期子进程，环境变量在启动时确定，因此热更新后插件
会**按需重连**受影响的服务器（`mcpReconnect`）。默认 `true` 为精确
模式：插件扫描原始配置文件中的 `{env:...}` 引用，只重连引用了本次
变化变量的启用服务器，无关服务器不受打扰；你手动禁用的服务器也不会
被触碰。注意：

- 重连瞬间该服务器上进行中的工具调用可能失败（让 agent 重试即可）；
- 有状态的 MCP 服务器（如浏览器自动化类）重连后状态丢失 —— 只要它
  们不引用变化的变量就不会被重连，还可用 `mcpReconnect: ["名字"]`
  进一步收敛范围；
- 靠进程继承环境直接读取密钥、没有显式 `{env:...}` 引用的服务器无法
  被精确识别，它们会在下次自然重连时拿到新值；如需覆盖这类服务器，
  使用 `mcpReconnect: "all"`。

另外，插件会注册一个永久 transform：每当 OpenCode 重建 MCP 配置时，
把原始配置文件中所有 `{env:...}` 引用按当前环境重新替换。这不仅支撑
热更新，还修复了服务器**首次连接**可能拿到空替换值的竞态问题。

## 日志

后台服务的标准输出不可见，插件日志写入：

```text
~/.local/share/opencode/log/opencode-secrets-env.log
```

## 注意事项

- `watch` 开启（默认）时修改 `secrets.env` 自动生效；若关闭
  `watch`，修改后需执行 `opencode service restart` 重新注入。
- 请保持文件权限为 `600`；权限过宽时插件会发出警告。
- 插件**不会**自动读取项目目录里的 env 文件，防止恶意仓库投毒。
- 本地 MCP 服务器会继承 OpenCode 进程的完整环境变量（包含注入的全部
  密钥），请只运行可信的 MCP 服务器。
- **OpenCode V1**：包同时提供 V1（`>= 1.18.29`）入口。V1 宿主没有 MCP
  transform API，因此 MCP 配置内的 `{env:...}` 重替换与 MCP 重连不可用；
  密钥注入、插件选项、热更新与关闭时的清理均正常。V2 是主要目标。
