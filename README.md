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

### Server 定义

`command` 用于 stdio server；`url` 用于 HTTP server，通常会据此自动判断 transport。也可显式设置 `transport` 为 `"stdio"` 或 `"http"`，用来兼容既有配置或在同时提供 `command` 和 `url` 时消除歧义。无论采用哪种方式，stdio server 仍须提供非空 `command`，HTTP server 仍须提供非空 `url`。

stdio server 还可设置：

- `args`：字符串数组，作为启动命令的参数。
- `cwd`：启动命令的工作目录。
- `env`：传给启动命令的字符串键值环境变量。

HTTP server 还可设置：

- `headers`：静态请求头的字符串键值对象。
- `bearerToken`：自动生成 `Authorization: Bearer <token>`；配置中的同名 `Authorization` 会被覆盖。

所有 server 均可设置：

- `connectionMode`：`lazy`（默认）或 `eager`。`eager` 会在会话启动时尽力预热；预热失败不会阻止插件启动，后续显式连接或 `mcp_tool` 调用仍会重试。
- `overview`：显式指定 overview Markdown 文件。相对路径相对于配置文件解析；未指定时使用 `~/.pi/agent/mcp-overviews/<serverName>.md`。
- `includeTools`：非空工具名数组，作为允许列表；未设置时默认允许全部工具。
- `excludeTools`：非空工具名数组，在允许列表之后排除工具。它优先于 `includeTools`，并同时限制工具目录和实际调用。

未显式配置 `overview` 且默认 overview 文件不存在时，插件会在首次成功初始化后尝试依据 server 描述创建最小草稿。

server 名称同时用于工具调用、overview 文件名和物化目录，必须匹配 `^[a-z0-9][a-z0-9._-]{0,31}$`；Windows 保留设备名（如 `con`、`com1`）不可用。

### 结果物化与 TUI

顶层的 `materialization` 控制结果文件和给模型的摘要预算；`artifactRoot` 使用相对路径时相对于当前 Pi 工作目录解析，也可使用绝对路径。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `materialization.artifactRoot` | `.pi/mcp` | 每次调用的 payload 与 `manifest.json` 的存放根目录。 |
| `materialization.summaryItemCount` | `6` | 多 payload 结果中展示在模型摘要内的最大条目数。 |
| `materialization.previewFullCharsPerItem` | `1500` | 单个文本 payload 不截断时的最大字符数。 |
| `materialization.previewTruncateToCharsPerItem` | `600` | 超出预览阈值时保留的字符数，不能大于前一项。 |
| `materialization.hardMaxChars` | `40000` | 最终模型摘要的硬字符上限。 |
| `materialization.prettyPrintJson` | `true` | 是否格式化可识别的 JSON payload。 |

顶层的 `tui` 只控制 Pi TUI 的渲染：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `tui.renderMode` | `expanded` | `hidden`、`minimal` 或 `expanded`。`minimal` 默认仅显示简短摘要，`expanded` 显示结果预览。 |
| `tui.expandedModeCollapsedLines` | `4` | `expanded` 模式下未手动展开时显示的最大结果行数。 |

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
