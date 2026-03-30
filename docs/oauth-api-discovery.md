# Claude Code OAuth Token 直接调用 Anthropic API 的发现记录

## 概述

本文档记录了我们对 Claude Code OAuth 认证机制的逆向工程过程，以及如何使用 Claude Code 的 OAuth Token 直接调用 Anthropic API。这一发现是 LLM Switcher 透明代理架构的技术基础。

---

## 问题背景

### 现象

执行 `claude login` 后，Claude Code 会生成前缀为 `sk-ant-oat01-` 的 OAuth Token，存储于 `~/.claude/.env` 文件中：

```
ANTHROPIC_API_KEY=sk-ant-oat01-xxxxxxxxxxxx...
```

然而，当你尝试用该 Token 直接调用标准 Anthropic API 时：

```bash
curl -X POST "https://api.anthropic.com/v1/messages" \
  -H "x-api-key: sk-ant-oat01-..." \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "claude-opus-4-5", ...}'
```

会返回错误：

```
OAuth authentication is currently not supported.
```

### 根本原因

OAuth Token (`sk-ant-oat01-*`) 与标准 API Key (`sk-ant-api03-*`) 使用不同的认证机制：

| 属性 | 标准 API Key | OAuth Token |
|------|-------------|-------------|
| 前缀 | `sk-ant-api03-` | `sk-ant-oat01-` |
| 认证头 | `x-api-key: <token>` | `Authorization: Bearer <token>` |
| 端点 | `/v1/messages` | `/v1/messages?beta=true` |
| Beta 标志 | 不需要 | 必须包含 `oauth-2025-04-20` |
| 计费头 | 不需要 | 必须在 system prompt 中包含 |

---

## 调查方法

### 流量拦截

通过设置 `ANTHROPIC_BASE_URL` 环境变量，将 Claude Code 的 API 请求重定向到本地 HTTP 嗅探器，从而捕获真实的请求格式。

```bash
ANTHROPIC_BASE_URL=http://localhost:9999 claude
```

### 关键挑战：HEAD 健康检查

Claude Code 在发送实际 API 请求之前，会先发送一个 `HEAD /` 请求来验证端点是否可达。代理服务器必须正确响应该请求，否则 Claude Code 会拒绝连接。

```
HEAD / HTTP/1.1
Host: localhost:9999
```

代理需要返回 `200 OK`（无响应体）才能让 Claude Code 继续发送后续请求。

---

## 核心发现：OAuth Token 的正确调用方式

### 请求 URL

```
POST https://api.anthropic.com/v1/messages?beta=true
```

注意 `?beta=true` 参数是必须的。

### 必需请求头

```http
Authorization: Bearer <oauth-token>
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,oauth-2025-04-20
anthropic-dangerous-direct-browser-access: true
x-app: cli
Content-Type: application/json
```

各请求头说明：

| 请求头 | 说明 |
|--------|------|
| `Authorization: Bearer` | OAuth Token 使用 Bearer 认证，而非 `x-api-key` |
| `anthropic-version` | API 版本，固定值 |
| `anthropic-beta` | 必须包含 `claude-code-20250219` 和 `oauth-2025-04-20` 两个标志 |
| `anthropic-dangerous-direct-browser-access` | 允许直接浏览器访问的标志，OAuth 场景必须 |
| `x-app: cli` | 标识调用来源为 CLI 工具 |

### 必需请求体格式

`system` 字段必须是 **文本块数组**（不能是纯字符串），且第一个块必须是计费头：

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 1024,
  "stream": true,
  "system": [
    {
      "type": "text",
      "text": "x-anthropic-billing-header: cc_version=2.1.87.d34; cc_entrypoint=cli; cch=00000;"
    },
    {
      "type": "text",
      "text": "你的实际 system prompt 内容"
    }
  ],
  "messages": [
    {"role": "user", "content": "用户消息"}
  ]
}
```

---

## 重要注意事项

### 0. ~/.claude/.env 中的 Token 已失效（Stale .env Token Issue）

**This is a common pitfall.** After running `claude login`, Claude Code writes the initial OAuth token to `~/.claude/.env` as:

```
ANTHROPIC_API_KEY="sk-ant-oat01-..."
```

However, **this token is only the initial login token and will NOT work for direct API calls** for the following reasons:

- Claude Code **refreshes OAuth tokens at runtime** by reading from the macOS Keychain, not from `~/.claude/.env`.
- The token in `.env` quickly becomes **stale** — it no longer matches the current active token held in the Keychain.
- Attempting to use the `.env` token directly for API calls will result in authentication errors.

**Token expiry:** OAuth access tokens typically expire every few hours (standard OAuth access token lifetime). The Keychain entry is kept up to date automatically by Claude Code, but the `.env` file is not.

**How to get a fresh, working token:**

Use `llm-switcher login` to capture a fresh token via the sniff method (intercepting a live Claude Code subprocess request). This always yields the current valid token from the Keychain, not the stale `.env` value.

```bash
llm-switcher login
```

Do **not** rely on reading `~/.claude/.env` directly for API calls.

---

### 1. Token 刷新机制

Claude Code 会在运行时动态刷新 OAuth Token。存储在 `~/.claude/.env` 中的 Token 可能是**过期的旧 Token**。

- **macOS**：实际使用的 Token 存储在 macOS **钥匙串（Keychain）**中，可能与 `.env` 文件中的值不同。
- **建议**：通过拦截 Claude Code 的实际请求来获取当前有效 Token，而非直接读取 `.env` 文件。

### 2. 计费头（Billing Header）是必须的

如果请求体中缺少 `x-anthropic-billing-header`，API 会返回一个模糊的错误，而非认证错误：

```json
{"type":"error","error":{"type":"invalid_request_error","message":"Error"}}
```

这是服务端的业务校验，不是认证问题。计费头的格式：

```
x-anthropic-billing-header: cc_version=2.1.87.d34; cc_entrypoint=cli; cch=00000;
```

各字段含义：
- `cc_version`：Claude Code 客户端版本号
- `cc_entrypoint`：入口点类型（`cli` 表示命令行）
- `cch`：某种校验哈希（目前发现全零可通过验证）

### 3. Beta 标志说明

`anthropic-beta` 头中的标志：

| 标志 | 用途 | 是否必须 |
|------|------|----------|
| `claude-code-20250219` | 启用 Claude Code 专属功能 | 必须 |
| `oauth-2025-04-20` | 启用 OAuth Token 认证 | 必须 |
| `interleaved-thinking-2025-05-14` | 启用交错思考模式 | 可选 |
| `context-management-2025-06-27` | 启用上下文管理功能 | 可选 |

### 4. system 字段格式要求

使用 OAuth Token 时，`system` 字段**必须是数组格式**，不能使用纯字符串：

```json
// 错误：纯字符串格式（OAuth 场景不支持）
"system": "You are a helpful assistant."

// 正确：数组格式，且计费头必须是第一个元素
"system": [
  {"type": "text", "text": "x-anthropic-billing-header: ..."},
  {"type": "text", "text": "You are a helpful assistant."}
]
```

---

## 完整示例

### curl 命令

```bash
TOKEN="sk-ant-oat01-..."

curl -X POST "https://api.anthropic.com/v1/messages?beta=true" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: claude-code-20250219,oauth-2025-04-20" \
  -H "anthropic-dangerous-direct-browser-access: true" \
  -H "x-app: cli" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 100,
    "stream": true,
    "system": [
      {
        "type": "text",
        "text": "x-anthropic-billing-header: cc_version=2.1.87.d34; cc_entrypoint=cli; cch=00000;"
      },
      {
        "type": "text",
        "text": "You are a helpful assistant."
      }
    ],
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

### 预期响应（流式）

```
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514",...}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

...

data: {"type":"message_stop"}
```

---

## 对 LLM Switcher 架构的影响

### 核心价值

这一发现证明了**透明代理架构是可行的**，无需依赖子进程包装方案。

### 代理工作流程

```
Claude Code
    |
    | ANTHROPIC_BASE_URL=http://localhost:8411
    v
LLM Switcher Proxy (localhost:8411)
    |
    |-- 响应 HEAD / 健康检查
    |-- 注入 OAuth 必需请求头
    |-- 在 system 数组中插入计费头（首位）
    |-- 根据路由规则选择目标模型/提供商
    v
api.anthropic.com/v1/messages?beta=true
    |
    | 原样透传响应
    v
Claude Code
```

### 代理需要完成的工作

1. **处理 HEAD / 请求**：立即返回 `200 OK`，无需转发
2. **请求头注入**：
   - 将 `x-api-key` 转换为 `Authorization: Bearer`
   - 添加 `anthropic-beta: claude-code-20250219,oauth-2025-04-20`
   - 添加 `anthropic-dangerous-direct-browser-access: true`
   - 添加 `x-app: cli`
3. **请求体处理**：
   - 确保 `system` 字段是数组格式
   - 在数组首位插入计费头文本块
4. **URL 处理**：确保转发到 `?beta=true` 端点
5. **响应透传**：直接将 API 响应流式传回 Claude Code

---

## 参考信息

- Anthropic API 文档：https://docs.anthropic.com/en/api/
- Claude Code 配置目录：`~/.claude/`
- OAuth Token 存储位置：
  - 文件：`~/.claude/.env`（可能过期）
  - macOS 钥匙串：`Anthropic Claude Code` 条目（当前有效值）
- 默认代理端口：`8411`（LLM Switcher 项目约定）

---

*文档创建时间：2026-03-30*
*发现来源：对 Claude Code 实际 API 流量的拦截分析*
