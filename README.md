# just-enough-mcp

`just-enough-mcp` 是一个 Pi 插件，为多个 MCP server 提供按需访问的 Tools 运行时。它聚焦 server 发现、工具目录读取与工具调用，不试图覆盖完整 MCP 协议。

## 工作方式

会话启动时，插件只将各个 server 的 overview 注入系统提示词。Agent 先选择合适的 server，再读取该 server 的工具目录；`mcp_tool` 的 `list` 和 `call` 会在需要时初始化目标 server。这样无需在启动时连接所有 server，也不会提前注入全部工具 schema。

工具调用结果会物化为本地文件，并向模型返回带有 manifest 路径和有限预览的摘要。默认物化目录为 `~/.pi/agent/just-enough-mcp/artifacts/`。

## 支持范围

当前支持 `stdio`、Streamable HTTP（静态 `headers`、`bearerToken` 或 OAuth），以及 Tools primitive：`tools/list` 和 `tools/call`。同时提供 lazy / eager 初始化、server overview、OAuth Dynamic Client Registration（经 agentDir 级 broker 共享凭据）、结果物化与 TUI 渲染。

Resources、Prompts、Sampling、Elicitation，以及将每个 MCP tool 直接注册为 Pi 工具，均不在当前范围内。

## 配置

配置文件位于 `~/.pi/agent/just-enough-mcp/config.json`，项目配置文件位于当前项目的 `.pi/just-enough-mcp/config.json`。会话启动时按全局配置到项目配置的顺序读取；项目配置只覆盖当前项目的 effective config，不会修改全局文件。项目配置仅在当前 Pi session 受信时加入。默认 overview 目录为 `~/.pi/agent/just-enough-mcp/overviews/`，工具调用结果物化到 `~/.pi/agent/just-enough-mcp/artifacts/`。它们在会话启动时读取；修改配置或 overview 后，请在 Pi 中执行 `/reload`。

项目配置支持三种 server 层语义：省略 server 名称表示继承全局定义；配置 object 表示新增或完整替换同名 server；配置 `null` 表示禁用继承的全局 server。例如：

```json
{
  "servers": {
    "global-search": null,
    "project-tools": {
      "command": "node",
      "args": ["./tools/mcp-server.mjs"]
    }
  }
}
```

项目层与全局层的 `materialization`、`tui` 字段按字段覆盖，server definition 不做递归合并。每个配置文件中的相对 `overview` 路径都相对于该文件所在目录解析；运行时会先将其规范化为绝对路径。

下面的配置同时展示一个 stdio server、一个静态 token HTTP server 和一个 OAuth HTTP server：

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
    },
    "oauth-search": {
      "transport": "http",
      "url": "https://oauth.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "scope": "tools.read"
      }
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
- `auth: "oauth"`：启用 OAuth。它只适用于 HTTP server，不能与 `bearerToken` 或 `headers.Authorization` 同时使用。
- `oauth.scope`：可选的 OAuth scope。它作为 base scope 的优先来源；缺省时使用初始 401 challenge 的 scope，再缺省时使用 resource metadata 的 `scopes_supported`。
- `oauth.clientMetadataUrl`：可选的 HTTPS Client ID Metadata Document URL。它参与 credential identity，但当前版本只使用 Dynamic Client Registration（DCR）建立 client 身份，不会把该 URL 用作 `client_id`；支持 CIMD 是后续增强。除 `oauth.profile` 外，它也会区分凭据作用域，修改它等同于换一份凭据。

OAuth callback URI 固定为 `http://127.0.0.1:33418/oauth/callback`，DCR 会自动注册它。

所有 server 均可设置：

- `connectionMode`：`lazy`（默认）或 `eager`。`eager` 会在会话启动时尽力预热；预热失败不会阻止插件启动，后续显式连接或 `mcp_tool` 调用仍会重试。
- `overview`：显式指定 overview Markdown 文件。相对路径相对于配置文件解析；未指定时使用 `~/.pi/agent/just-enough-mcp/overviews/<serverName>.md`。
- `includeTools`：非空工具名数组，作为允许列表；未设置时默认允许全部工具。
- `excludeTools`：非空工具名数组，在允许列表之后排除工具。它优先于 `includeTools`，并同时限制工具目录和实际调用。

未显式配置 `overview` 且默认 overview 文件不存在时，插件会在首次成功初始化后尝试依据 server 描述创建最小草稿。

server 名称同时用于工具调用、overview 文件名和物化目录，必须匹配 `^[a-z0-9][a-z0-9._-]{0,31}$`；Windows 保留设备名（如 `con`、`com1`）不可用。

### 结果物化与 TUI

顶层的 `materialization` 控制结果文件和给模型的摘要预算。每次调用的 payload 与 `manifest.json` 固定存放于 `~/.pi/agent/just-enough-mcp/artifacts/`。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
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
| `mcp_server` | `status`、`connect`、`disconnect`、`authorize`、`logout` | 查看状态、控制可用性或管理 OAuth。 |
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

OAuth server 首次使用前执行：

```ts
mcp_server({ action: "authorize", server: "oauth-search" })
```

`authorize` 会打开浏览器并等待 callback（默认 5 分钟超时）。普通 `mcp_tool` 在需要交互授权时不会自行打开浏览器；先执行 `authorize`，再显式重新调用 `list` 或 `call`。logout 只清除本机保存的 OAuth access token 与 refresh token，保留 client registration 与 discovery，不关闭 MCP 连接，也不向 Authorization Server 发起远端 token revocation。

OAuth credential 由 agentDir 级 broker 管理，token 与 client registration 保存于 `~/.pi/agent/just-enough-mcp/oauth/broker-credentials.json`；`broker-access.json` 保存端口与 control secret。这是本地文件方案，不等同于 OS keychain；不要复制、提交或共享这些文件。access token、refresh token、client secret 和 PKCE verifier 均不会写入普通 plugin config、MCP result artifact 或 overview。

无需把 `mcp_server({ action: "connect" })` 作为普通 server 的常规前置步骤；`mcp_tool` 会自行初始化目标 server。只有需要主动检查状态、预热或断开连接时，才使用 `mcp_server`。

## 开发

```bash
npm test
npm run test:types
```

## 许可证

[MIT](LICENSE)
