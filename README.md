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

Create the secrets file (dotenv format) and lock down its permissions:

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
| `quiet`    | `boolean`  | `false` | Silence info/debug messages (warnings are always shown). |
| `debug`    | `boolean`  | `false` | Also log the *names* of applied/skipped keys. Values are never logged. |

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
- **Reloading**: variables are injected once at plugin load. After editing
  `secrets.env`, run `opencode service restart`.
- **Permissions**: keep the file at `chmod 600`. The plugin warns when it is
  readable by other users.
- **No project-level auto-loading**: only your global file (or an explicitly
  configured `path`) is read, so a cloned repository cannot smuggle variables
  into your environment.
- **Local MCP servers inherit the full environment** of the OpenCode process,
  including every injected secret — that is the point of this plugin, but only
  run MCP servers you trust.
- **OpenCode V1**: the package also exports a V1 (`>= 1.18.29`) entry point
  with default behavior (global file, no overrides). V2 is the primary target.

## Development

```sh
npm install
npm run typecheck
npm test
```

The package is published as TypeScript source (OpenCode loads plugins
directly), so there is no build step. The plugin entry point is `index.ts` at
the package root; `env.ts` contains the pure loading logic and is unit tested
with `node --test`.

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
| `quiet`    | `boolean`  | `false` | 静默 info/debug 日志（警告始终输出）。 |
| `debug`    | `boolean`  | `false` | 额外记录注入/跳过的**键名**（值永不记录）。 |

## 日志

后台服务的标准输出不可见，插件日志写入：

```text
~/.local/share/opencode/log/opencode-secrets-env.log
```

## 注意事项

- 修改 `secrets.env` 后需执行 `opencode service restart` 重新注入。
- 请保持文件权限为 `600`；权限过宽时插件会发出警告。
- 插件**不会**自动读取项目目录里的 env 文件，防止恶意仓库投毒。
- 本地 MCP 服务器会继承 OpenCode 进程的完整环境变量（包含注入的全部
  密钥），请只运行可信的 MCP 服务器。
