# opencode-secrets-env

[![English](https://img.shields.io/badge/lang-English-blue)](./README.md)
[![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](./README.zh-CN.md)

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

密钥文件无需在启动时就存在：插件会监听最近一层已存在的父目录，当文件
（及其所在目录）创建后立即开始生效 —— 适合先装插件、后建
`secrets.env` 的场景。

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

## 许可证

[MIT](./LICENSE)
