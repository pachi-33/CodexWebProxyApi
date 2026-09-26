# CodexWebProxyApi

[简体中文](README.md) | [English](README_EN.md)

让本机 Codex 通过你日常使用、已经登录 ChatGPT 的普通 Chrome 调用 ChatGPT Web，并在实验性 Agent 模式下把网页模型生成的工具调用安全地交回 Codex 执行。

> [!IMPORTANT]
> 这是非官方实验项目，不隶属于或受 OpenAI 支持。它依赖 ChatGPT Web 的 DOM，网页更新、账号限制、登录状态或风控都可能导致失效。请自行确认使用方式符合适用条款和组织政策；生产环境请使用受支持的官方 API。

## 它解决什么问题

Codex 原生使用 Responses 协议，但浏览器中的 ChatGPT 会话并不是一个 Responses API。这个项目在本机建立一个最小适配层：

```text
Codex CLI / Desktop
        │ Responses JSON / SSE
        ▼
http://127.0.0.1:4318/v1
        │
        ├── 原生 Codex 模型 ──► 官方 Codex backend（原样透传）
        │
        └── chatgpt-web/*
                 │ WebSocket ws://127.0.0.1:4319
                 ▼
          Manifest V3 扩展
                 │ 当前 Chrome 登录态
                 ▼
             ChatGPT Web
```

整个链路只监听 loopback，不需要公网 IP、MCP Tunnel、Electron、CDP 注入或 Cookie 导出。

## 功能

### 两种网页模型

| 模型 | 用途 | 本地工具 |
| --- | --- | --- |
| `chatgpt-web/browser` | 普通文本问答、分析和写作 | 不可用 |
| `chatgpt-web/agent` | Codex Agent 工作流 | 实验性支持 function/custom tools |

`chatgpt-web/agent` 不直接执行 shell。网页模型只能返回带随机 nonce 的结构化工具请求；本地代理验证 nonce、工具编号与 JSON 参数后，将标准 Responses `function_call` 返回给 Codex。最终是否执行以及如何沙箱隔离，仍由 Codex 决定。

### Responses 兼容层

- `/v1/models`：保留原生模型，并加入两个网页模型。
- `/v1/responses`：支持流式 SSE 和非流式 Responses JSON。
- 支持 `previous_response_id` 和 Codex 的无状态工具历史重放。
- 原生模型继续使用 Codex 原有认证，透明转发到官方 backend。
- 支持 Codex 的 zstd 压缩请求体。

### 稳定的浏览器工具循环

- 工具调用后复用同一个 ChatGPT 会话，不为每一步刷新页面。
- 后续轮次只发送新的工具结果，不重放完整 Codex 请求。
- 只有浏览器上下文确实丢失时才发送恢复 prompt。
- Agent 回复必须包含本轮 nonce 对应的完整 JSON envelope；流式输出中途停顿不会被误判为完成。
- 后台运行锁阻止并发重试在生成期间刷新 provider 标签页。
- 通过逻辑 turn identity 绑定唯一的新 assistant 回复。

### 上下文最小化

发送到 ChatGPT Web 的内容会移除：

- Codex 宿主 developer/system 指令；
- skills、权限、插件、环境和应用元数据；
- Responses Lite 的重复工具元数据；
- 已存在于同一浏览器会话中的完整历史。

工具描述和 JSON Schema 也会压缩，减少网页端 prompt 体积。

### 可恢复配置

CLI 会事务性修改用户级 `~/.codex/config.toml`，并在私有状态目录保存原始字节。`restore` 会检查配置是否被其他程序改动，避免覆盖用户的新修改。

## 系统要求

- Node.js `22.15` 或更高版本；
- Google Chrome `116` 或更高版本；
- 已安装并可以正常运行的 Codex CLI 或 Codex Desktop；
- 能在普通 Chrome 中登录并使用 `https://chatgpt.com`；
- macOS 或 Linux。Windows 尚未做完整验证，欢迎贡献适配。

## 快速开始

### 1. 下载并安装依赖

```bash
git clone https://github.com/pachi-33/CodexWebProxyApi.git
cd CodexWebProxyApi
npm ci
```

### 2. 加载 Chrome 扩展

先打印扩展目录：

```bash
node src/cli.mjs extension
```

然后在你日常使用的 Chrome 中：

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择仓库内的 `chrome-extension/` 目录。
5. 打开 `https://chatgpt.com`，确认已经登录且能正常发送消息。

扩展只申请 `tabs`、`https://chatgpt.com/*` 和本机 loopback 权限。它直接运行在当前 Chrome profile 中，因此自然使用现有登录态；不会读取、复制或导出 Cookie。

### 3. 启动本地 Provider

```bash
npm start
```

保持这个终端运行。正常输出类似：

```text
Provider listening at http://127.0.0.1:4318/v1
Waiting for normal Chrome extension at ws://127.0.0.1:4319
```

检查连接状态：

```bash
npm run status
curl http://127.0.0.1:4318/healthz
```

健康响应中的 `extension_connected` 应为 `true`。

### 4. 接入 Codex

另开一个终端执行：

```bash
node src/cli.mjs install
```

该命令会先检查 provider 健康状态，然后在用户级 `~/.codex/config.toml` 写入：

```toml
openai_base_url = "http://127.0.0.1:4318/v1"
```

这符合 Codex 自定义 provider 的 Responses 路由方式；项目级 `.codex/config.toml` 不适合配置 provider 路由。CLI 不会修改审批策略、sandbox 或默认模型。

重启 Codex，然后从模型选择器选择：

- `ChatGPT Web (Browser)`：只读网页问答；
- `ChatGPT Web (Agent, experimental)`：允许网页模型请求 Codex 的本地工具。

### 5. 验证

Browser 模式：

```text
Reply exactly: WEBGPT READY
```

Agent 模式：

```text
调用只读 shell 工具执行 pwd，然后告诉我当前目录。
```

正常情况下，Chrome 会保留一个专用 Temporary Chat 标签页。一次 Agent 任务中的多轮工具调用会持续使用这个会话。

## 恢复原始 Codex 配置

停止 provider 后执行：

```bash
node src/cli.mjs restore
```

如果安装前已经存在 `openai_base_url`，CLI 默认拒绝覆盖。确认需要替换时才使用：

```bash
node src/cli.mjs install --replace-existing-route
```

`restore` 会恢复安装前的原始配置。若安装后配置已被其他程序修改，它会拒绝覆盖并提示人工处理。

## CLI 命令

```text
codex-chatgpt-web extension
codex-chatgpt-web login [--transport extension|playwright]
codex-chatgpt-web serve [--port 4318] [--transport extension|playwright]
codex-chatgpt-web install [--port 4318] [--replace-existing-route]
codex-chatgpt-web status [--port 4318]
codex-chatgpt-web restore
```

通过源码运行时，将 `codex-chatgpt-web` 替换为 `node src/cli.mjs`。

可选参数：

- `serve --timeout SECONDS`：调整等待 ChatGPT 回复的时间，默认 600 秒；
- `serve --port PORT`：修改 HTTP provider 端口；
- `login/serve --transport playwright`：使用隔离的 Playwright profile；
- `--chrome PATH`、`--profile DIR`：仅用于 Playwright fallback。

## Playwright fallback

正常 Chrome 扩展不可用时，可以使用隔离 profile：

```bash
node src/cli.mjs login --transport playwright
node src/cli.mjs serve --transport playwright
```

不要让 Playwright 直接使用正在运行的日常 Chrome user-data-dir。Chrome profile 有独占锁，异常退出可能损坏 Preferences 或 Cookie 数据，并且自动化启动特征更容易触发站点风控。

## 安全设计

- HTTP provider 固定监听 `127.0.0.1`；非 loopback 地址会被拒绝。
- WebSocket bridge 固定监听 `127.0.0.1`，只接受 `chrome-extension://` Origin。
- Node.js 不读取或保存 Chrome Cookie。
- 原生 Codex bearer token 只在内存中透明转发，不写日志或磁盘。
- 网页文本永远不会直接作为 shell 执行。
- Agent 工具调用必须通过随机 nonce、声明工具表和 JSON 参数校验。
- 真正的本地工具调用由 Codex 执行，因此继续受其 sandbox 和审批策略控制。
- 配置备份保存在 `~/.codex-chatgpt-web-minimal/`，权限设置为当前用户私有。

公开部署、端口转发或反向代理不在安全模型内。不要把 `4318` 或 `4319` 暴露到局域网或公网。

## 数据流与隐私

选择网页模型时，经过过滤的用户对话、工具定义和工具输出会显示在 ChatGPT Web 页面中，并发送给 ChatGPT 服务。选择原生 Codex 模型时，请求会由本地代理透明转发到 Codex backend。

使用前请评估代码、文件内容、终端输出及其他上下文是否适合发送到你的 ChatGPT 账号。公司设备或组织账号还可能受到管理员网络、浏览器和数据保留策略约束。

## 已知限制

- ChatGPT Web DOM 不是稳定 API，选择器可能随时变化。
- 登录失效、账号限额、风控、网络代理和网页错误都会导致调用失败。
- `chatgpt-web/agent` 是实验功能，不应无人值守运行高风险命令。
- 暂不支持结构化输出、网页模型 compaction、图片输入/输出和多 Agent。
- continuation 状态保存在当前 Node 进程内；重启后无法恢复旧的 `previous_response_id`。
- 同一时间只处理一个网页请求，以避免多个任务争用同一 provider 标签页。
- Playwright fallback 每轮使用新的临时页面，连续工具会话能力弱于扩展模式。

## 故障排查

### `extension_connected` 为 `false`

- 确认扩展已启用；
- 在 `chrome://extensions` 点击扩展的“重新加载”；
- 确认 provider 正在监听 `4319`；
- 检查是否有另一个 provider 进程占用端口。

### `Could not establish connection. Receiving end does not exist`

扩展代码更新后，旧 ChatGPT 标签页可能没有新的 content script。重新加载扩展和 provider 标签页后再试。

### `Composer did not retain the complete prompt`

ChatGPT 在页面 hydration 时替换了编辑器，或者其他扩展修改了输入框。先禁用会改写 ChatGPT 页面/输入框的扩展，再重试。

### 一直显示“正在重新连接”

确认 `npm start` 没有退出，并检查：

```bash
curl http://127.0.0.1:4318/healthz
```

如果长回复经常超时，可提高等待时间：

```bash
npm start -- --timeout 900
```

### Codex 中看不到网页模型

运行：

```bash
npm run status
node src/cli.mjs install
```

然后完整重启 Codex。安装命令会清理本地模型目录缓存，以便重新获取增强后的模型列表。

## 开发

安装并运行测试：

```bash
npm ci
npm test
```

测试覆盖：

- Responses JSON、SSE 生命周期与原生请求透传；
- zstd 请求解码；
- 配置事务与原字节恢复；
- Chrome 扩展 WebSocket Origin 检查；
- composer hydration、内容保留和 assistant turn 绑定；
- nonce envelope、工具调用翻译和同会话 continuation；
- 长 JSON 流式回复不会被提前截断。

项目结构：

```text
chrome-extension/   Manifest V3 后台与 ChatGPT content script
src/                Node.js Responses provider、代理、CLI 和状态管理
test/               Node.js 单元与集成测试
skills/             可选 Codex 插件 skill
.codex-plugin/      Codex 插件 manifest
```

欢迎阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 后提交 Issue 或 Pull Request。安全问题请遵循 [SECURITY.md](SECURITY.md)。

## 为什么不是 MCP Tunnel

这个项目要替换的是 Codex 的模型 Responses provider，而不是为模型增加一个远程 MCP 工具。Chrome 扩展和 Node provider 都运行在本机，工具调用最终回到 Codex 已有的本地执行与权限体系中，因此不需要 MCP broker 或 Secure MCP Tunnel。

## 官方配置参考

Codex 官方配置文档说明了 `openai_base_url`、`model_providers.<id>.base_url`、`requires_openai_auth`、重试/流式超时以及唯一支持的 `responses` wire protocol：

- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference)

本项目的配置安装器使用用户级 `openai_base_url`，不会把 provider 路由写进仓库级配置。

## License

[MIT](LICENSE)
