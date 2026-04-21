# llm-switcher

[![Test](https://github.com/fanqi1909/llm-switcher/actions/workflows/test.yml/badge.svg?branch=main&event=push)](https://github.com/fanqi1909/llm-switcher/actions/workflows/test.yml)
&nbsp;[English](README.md)

在不丢失会话上下文的情况下，本地切换 Claude Code 和 Codex CLI 的后端。

`llm-switcher` 是一个运行在本地的代理，位于 AI 客户端和上游服务商之间。它在 `localhost:8411` 提供统一的本地端点，让你可以在 Anthropic 和 OpenAI 支持的 session 之间热切换——无需重启客户端，也不用在新终端重新说明上下文。

## 功能概览

| 客户端 | 后端 | 状态 | 说明 |
|---|---|---|---|
| Claude Code | Anthropic | 支持 | 原生透传，包括 OAuth |
| Claude Code | OpenAI | 支持 | Anthropic → OpenAI 协议转换 |
| Codex CLI | OpenAI | 支持 | 透明 WebSocket 桥接 |
| Codex CLI | Anthropic | 暂不支持 | 反向转换尚未实现 |

## 为什么用这个

- **切换时保持会话连续** — 下一个后端能看到同一段对话、工具调用结果和文件上下文
- **Claude Pro 配额耗尽时轮换账号**，不打断当前工作流
- **在同一个工作流里对比不同模型**，切换后端而不是切换工具
- **统一本地端点**，脚本、slash 命令和客户端配置只需维护一个地址

如果你只是想让 Claude Code 把任务委托给 Codex，[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 这类插件方案更简单。`llm-switcher` 针对的是更强的需求：在传输层完成切换并保留客户端 session。详见 [docs/comparison.md](docs/comparison.md)。

## 当前状态

`llm-switcher` 是一个**实验性但可用的原型**。可以用于真实工作流，但尚未经过生产加固。随着 Claude Code、Codex CLI 和上游后端的更新，协议兼容性可能需要持续维护。

测试环境：Node.js `v25.8.1` · Claude Code `2.1.88` · Codex CLI `0.117.0`

## 安装

环境要求：Node.js 18+、Claude Code（用于 OAuth 导入）、Codex CLI（用于 Codex OAuth 导入）。

```bash
git clone git@github.com:fanqi1909/llm-switcher.git
cd llm-switcher
npm install && npm run build && npm link
```

## 快速上手

**1. 添加 session**

```bash
llm-switcher login              # 导入 Claude Code OAuth session
llm-switcher codex-login        # 导入 Codex OAuth session（先运行一次 `codex`）
```

也可以用 API Key 手动添加：

```bash
llm-switcher add claude-work --provider anthropic --token sk-ant-...
llm-switcher add gpt-work --provider openai --token sk-...
```

**2. 设置模型并启动**

```bash
llm-switcher set-model claude-work claude-sonnet-4-5
llm-switcher set-model gpt-work gpt-5.4
llm-switcher serve
```

**3. 将客户端指向代理**

Claude Code：

```bash
export ANTHROPIC_BASE_URL=http://localhost:8411
claude
```

Codex CLI，在 `~/.codex/config.toml` 中添加：

```toml
[model]
provider = "openai"
name = "gpt-5.4"

[model.openai_compatible]
base_url = "http://localhost:8411"
```

**4. 切换 session**

```bash
llm-switcher switch claude-work
llm-switcher switch gpt-work
llm-switcher status
```

或在任意 Claude Code 对话窗口中使用 `/llm-switch` 命令，只绑定当前窗口：

```
/llm-switch gpt-work
```

安装为全局命令（在该 repo 之外也可用）：

```bash
llm-switcher install-claude-command
```

## CLI 命令

| 命令 | 说明 |
|---|---|
| `serve [-p port]` | 启动代理服务器 |
| `login [name]` | 捕获最新的 Claude Code OAuth token 并保存为 session |
| `codex-login [name]` | 从 `~/.codex/auth.json` 导入 Codex CLI OAuth token |
| `add <name> -p <provider> -t <token> [-b url] [-m model]` | 手动添加 session |
| `remove <name>` | 删除 session |
| `list` | 列出所有已配置的 session |
| `switch <name>` | 设置当前活跃 session |
| `status` | 显示活跃 session 及最新配额信息 |
| `models [name]` | 列出当前或指定 session 的可用模型 |
| `model [name]` | 显示当前或指定 session 已配置的模型 |
| `set-model <name> <model>` | 为 session 设置模型 |
| `statusline [--json]` | 从 Claude 风格的 stdin JSON 渲染状态栏文本 |
| `install-claude-command [--dir path]` | 将 `/llm-switch` 安装到 Claude 命令目录 |

代理运行时，管理命令通过 `http://localhost:8411/admin/*` 执行。未运行时，CLI 直接编辑本地配置文件。

## 深入了解

- [docs/sessions.md](docs/sessions.md) — session 配置、per-chat 绑定、路由优先级、token 刷新
- [docs/design.md](docs/design.md) — 架构、协议映射与事件流
- [docs/comparison.md](docs/comparison.md) — 与多终端方案及 `codex-plugin-cc` 的对比
- [docs/statusline-design.md](docs/statusline-design.md) — 状态栏集成设计
