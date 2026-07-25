# just-enough-mcp

`just-enough-mcp` 是一个为 Pi 提供多 MCP server 接入能力的**现实主义工具运行时插件**。

它的目标不是完整实现 MCP 协议，也不是做透明代理或协议展示器；它只聚焦当前社区里最常见、最实用的主路径：**把 MCP 当作跨 agent 的外部工具注册与调用层来使用**。

## 产品定位

可以把它理解为：

> **一个通过少量能力域工具暴露多 MCP server 的轻量运行时。**

核心特点：

- 提供两个职责明确的入口：`mcp_server` 管理 server 状态与生命周期，`mcp_tool` 承载 Tools primitive
- 支持多 server
- 采用 **server 级渐进式披露**，而不是把每个 MCP tool 直接注册成 Pi 一等工具
- 优先优化真实 agent 使用体验，而不是追求协议面完整覆盖

## 当前范围

当前版本支持：

- `stdio`
- `Streamable HTTP`
- Tools primitive（`tools/list` / `tools/call`）
- eager / lazy 连接模式
- tool result 本地物化
- 物化结果的紧凑 TUI 展示

当前版本明确不支持：

- Resources
- Prompts
- Sampling
- Elicitation
- direct tool registration
- OAuth
- 全量 MCP 协议能力

## 配置

全局配置文件：

- `~/.pi/agent/just-enough-mcp.json`

可选的 server overview 目录：

- `~/.pi/agent/mcp-overviews/`

配置在 `session_start` 时加载。修改配置或 overview 后，需要在 Pi 中执行：

- `/reload`

### Server 名称

`servers` 对象的 key 是 server 名称，会用于 `mcp_server`、`mcp_tool` 和默认 overview 文件名。名称必须符合：

```txt
^[a-z0-9][a-z0-9._-]{0,31}$
```

也就是 1–32 个字符，只允许小写 ASCII 字母、数字、`.`, `_`, `-`，且首字符必须是字母或数字。Windows 保留设备名及其点号扩展形式不可用，例如 `con`、`con.docs`、`com1`。

推荐使用简短、有语义的名称，例如 `context7`、`cua-driver`、`github.enterprise`。

## 当前状态

MVP 主链路已可用：

- 配置加载
- overview 注入
- 多 server 管理
- `mcp_server({ action: "status" })`
- `mcp_server({ action: "status", server })`
- `mcp_server({ action: "connect", server })`
- `mcp_server({ action: "disconnect", server })`
- `mcp_tool({ action: "list", server })`
- `mcp_tool({ action: "call", server, tool, args? })`
- tool result 物化与预览

它现在已经不是脚手架，但仍然故意保持狭窄范围。
