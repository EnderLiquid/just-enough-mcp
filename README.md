# just-enough-mcp

`just-enough-mcp` 是一个 Pi 插件，为多个 MCP server 提供按需访问的 Tools 运行时。它聚焦 server 发现、工具目录读取与工具调用，不试图覆盖完整 MCP 协议。

## 工作方式

会话启动时，插件只将各个 server 的 overview 注入系统提示词。Agent 先选择合适的 server，再读取该 server 的工具目录；`mcp_tool` 的 `list` 和 `call` 会在需要时初始化目标 server。这样无需在启动时连接所有 server，也不会提前注入全部工具 schema。

工具调用结果会物化为本地文件，并向模型返回带有 manifest 路径和有限预览的摘要。默认物化目录为当前工作目录下的 `.pi/mcp/`，可通过配置调整。

## 支持范围

当前支持 `stdio`、Streamable HTTP（可使用静态 `headers` 或 `bearerToken`），以及 Tools primitive：`tools/list` 和 `tools/call`。同时提供 lazy / eager 初始化、server overview 与结果物化、TUI 渲染。

Resources、Prompts、Sampling、Elicitation、OAuth 和将每个 MCP tool 直接注册为 Pi 工具，均不在当前范围内。

## 配置

配置文件位于 `~/.pi/agent/just-enough-mcp.json`，默认 overview 目录为 `~/.pi/agent/mcp-overviews/`。它们在会话启动时读取；修改配置或 overview 后，请在 Pi 中执行 `/reload`。

下面的配置同时展示一个 stdio server 和一个 HTTP server：

```json
{
  "servers": {
    "local-tools": {
      "command": "node",
      "args": ["C:/path/to/server.mjs"]
    },
    "search": {
      "url": "https://example.com/mcp",
      "bearerToken": "<token>"
    }
  }
}
```

`command` 用于 stdio server；`url` 用于 HTTP server，transport 会据此自动判断。stdio 配置还可包含 `cwd`、`env` 和 `args`，HTTP 配置可使用 `headers` 或 `bearerToken`。

每个 server 还可设置：

- `connectionMode`：`lazy`（默认）或 `eager`。
- `overview`：显式指定 overview Markdown 文件；未指定时使用 `~/.pi/agent/mcp-overviews/<serverName>.md`。

顶层的 `materialization` 和 `tui` 分别用于调整结果物化与 TUI 展示。没有 overview 时，插件会在首次成功初始化后尝试依据 server 描述创建最小草稿。

server 名称同时用于工具调用、overview 文件名和物化目录，必须匹配 `^[a-z0-9][a-z0-9._-]{0,31}$`；Windows 保留设备名（如 `con`、`com1`）不可用。

## 工具入口

| 工具 | action | 用途 |
| --- | --- | --- |
| `mcp_server` | `status`、`connect`、`disconnect` | 查看状态或显式控制某个 server 的可用性。 |
| `mcp_tool` | `list`、`call` | 读取一个 server 的工具目录，并调用其中的工具。 |

通常先读取目录，再按照返回的输入 schema 调用工具：

```ts
mcp_tool({ action: "list", server: "search" })

mcp_tool({
  action: "call",
  server: "search",
  tool: "search_web",
  args: { query: "MCP specification" }
})
```

无需把 `mcp_server({ action: "connect" })` 作为常规前置步骤；`mcp_tool` 会自行初始化目标 server。只有需要主动检查状态、预热或断开连接时，才使用 `mcp_server`。

## 开发

```bash
npm test
npm run test:types
```

## 许可证

[MIT](LICENSE)
