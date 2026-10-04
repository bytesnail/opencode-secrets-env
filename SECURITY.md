# Security Policy

[English](#reporting-a-vulnerability) · [简体中文](#报告安全漏洞)

## Reporting a vulnerability

This plugin handles API keys and other secrets, so anything that could expose
secret material is treated with the highest priority.

**Please do not report security issues through public GitHub issues or pull
requests.**

Report privately via GitHub:
[Security → Advisories → Report a vulnerability](https://github.com/bytesnail/opencode-secrets-env/security/advisories/new).

Please include:

- the affected plugin version, host (`opencode-ai` 1.x / `@opencode/cli` 2.x,
  with version) and OS,
- steps to reproduce,
- what secret material could be exposed, and how.

**Never include real secret values in a report** — redact them or use
placeholders. (The plugin itself never logs values, so quoting its log file
is safe.)

Reports are typically acknowledged within a few days. Confirmed issues get a
patch release; reporters are credited in the release notes unless they prefer
to stay anonymous.

## Supported versions

Only the latest published release receives security fixes. Please upgrade to
the newest version before reporting.

## Deliberate behavior (not a vulnerability)

These are documented design decisions — still report them if you find they can
be abused beyond what is documented:

- Local MCP servers inherit the OpenCode process environment, including every
  injected secret — that is this plugin's purpose; only run servers you trust.
- With the `debug` option on, the log file records key *names* (never values).
- The secrets-file permission warning is POSIX-only; on Windows, access must
  be restricted with NTFS ACLs.
- Only your global secrets file (or an explicitly configured `path`) is read —
  a cloned repository cannot inject variables on its own.

## 报告安全漏洞

本插件负责处理 API key 等机密信息，任何可能泄露机密的问题都会以最高优先级对待。

**请不要通过公开的 GitHub issue 或 PR 报告安全问题。**

请通过 GitHub 私密渠道报告：
[Security → Advisories → Report a vulnerability](https://github.com/bytesnail/opencode-secrets-env/security/advisories/new)。

请附上：

- 受影响的插件版本、宿主（`opencode-ai` 1.x / `@opencode/cli` 2.x，含版本号）与操作系统；
- 复现步骤；
- 可能泄露的机密内容及其途径。

**报告中绝不要包含真实密钥值** —— 请打码或使用占位符。（本插件本身从不记录密钥值，引用其日志文件是安全的。）

报告通常会在数日内得到确认回复。确认的问题会以 patch 版本修复；除非报告人希望匿名，否则会在 release notes 中署名致谢。

## 支持版本

仅最新发布版本获得安全修复，报告前请先升级到最新版本。

## 属于有意设计的行为（不算漏洞）

以下为文档中明确说明的设计决策 —— 如果你发现它们可能被超出文档范围地滥用，仍欢迎报告：

- 本地 MCP 服务器会继承 OpenCode 进程的全部环境变量，包括注入的所有机密 —— 这正是本插件的用途；请只运行你信任的服务器。
- 开启 `debug` 选项后，日志文件会记录键*名*（绝不记录值）。
- 密钥文件的权限检查仅限 POSIX；Windows 下请用 NTFS ACL 限制访问。
- 插件只读取全局密钥文件（或显式配置的 `path`）—— 克隆的仓库无法自行注入变量。
