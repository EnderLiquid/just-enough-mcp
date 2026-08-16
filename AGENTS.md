# AGENTS.md

## 项目概述

`just-enough-mcp` 是一个 Pi 插件，提供最小化的多 MCP server runtime。核心设计目标是 server 级渐进披露：启动时只注入 server overview，需要时再连接单个 server、读取工具目录并调用工具。

当前范围以 Tools 为主；Resources、Prompts、Sampling、Elicitation 暂不支持。

## 常用命令

- `npm test`：运行 Vitest 测试。
- `npm run test:types`：运行 TypeScript 类型检查。

## 代码结构

- `extensions/config/`：插件配置、current config snapshot、overview 加载与异步 overview bootstrap。
- `extensions/modeling/`：跨模块共享的核心类型。
- `extensions/servers/`：MCP server registry、current registry reference 与具体 server 实现。
- `extensions/tools/`：暴露给 Pi 的 `mcp_server` 与 `mcp_tool` 工具入口。
- `extensions/artifacts/`：工具调用结果物化、payload 提取/归一化、artifact 存储、manifest 与模型 summary 生成。
- `extensions/rendering/`：TUI 工具调用/结果渲染与 footer status 展示。
- `extensions/formatting/`：跨模块共享的轻量文本格式化工具，如英文单复数 `pluralize()`。
- `extensions/prompting/`：系统提示词中 server overview 的生成逻辑。
- `extensions/ui/`：插件 UI 通知等 Pi TUI 交互辅助。

## 架构约定

- `extensions/just-enough-mcp.ts` 是插件 session 生命周期的唯一 composition root：config 是整体替换的 value snapshot，Registry/OverviewBootstrapper 是由 root 显式构造和关闭的 owned resource，Notifier/FooterStatusSink 是只在 Pi session 有效期内借用的 capability。
- module-level `currentXxx` 只作为非拥有型访问槽；只有插件 root 可以安装/卸载引用，资源销毁必须使用 root 自己持有的实例，旧 disposer 必须按对象身份清理，不能影响后安装的新引用。
- Registry 只管理 `McpServer` 对象并转发调用，不直接理解 SDK transport、鉴权或具体 server 组装细节。
- Registry 按当前 session 的 `ResolvedServerConfig[]` 一次性装配，不支持原地配置同步；其 `initialize()` 自行尽力预热 eager server，root 只驱动初始化、处理结果并负责关闭。
- Pi direct tool 按能力域划分：`mcp_server` 管理 server 状态与生命周期，`mcp_tool` 承载 MCP Tools primitive；不要重新合并为依赖 optional 字段组合分派的单一入口。
- `createMcpServer()` 是当前唯一 transport 推断与具体 server 组装分派点。
- 配置层输出 `ResolvedServerConfig`，只保留通用字段和 `definition`；具体 server 组装实现负责校验并保存自己需要的配置字段。
- `ServerOverview` 只表示文档内容与来源，不携带 transport、鉴权等 runtime 分类信息。
- 当前 `connect` / `connectServer` / `connectState` 是历史命名，实际语义是“让 server 进入可用状态”，不应狭义理解为底层网络连接。
- 对 HTTP server，`connected` 表示 MCP client/transport 已初始化且 tools catalog 可用，不表示 TCP 连接长期存在。
- 插件配置顶层按职责拆分为 `materialization` 与 `tui`；`materialization` 控制 artifact 落盘、payload/JSON 归一化和给模型的 summary 预算，`tui` 只控制 TUI 渲染模式与展开模式折叠行数。
- TUI 渲染模式为 `hidden` / `minimal` / `expanded`，默认 `expanded`；不要把 TUI 展示配置混入 materialization 或模型 summary 配置。
- 用户可见英文数量文案应使用 `extensions/formatting/english.ts` 的 `pluralize()` 处理单复数，避免写出 `1 tools`、`1 payload items` 等文本。

## 开发注意事项

- 保持变更聚焦，不要顺手修无关问题。
- 优先补充贴近变更边界的单元测试。
- 完成代码修改后优先运行 `npm test` 和 `npm run test:types`。
- `docs/` 在本地可能被 git exclude，用于任务说明和本地笔记时不要默认强制加入提交。
