# AGENTS.md

## 项目概述

`just-enough-mcp` 是一个 Pi 插件，提供最小化的多 MCP server runtime。核心设计目标是 server 级渐进披露：启动时只注入 server overview，需要时再连接单个 server、读取工具目录并调用工具。

当前范围以 Tools 为主；Resources、Prompts、Sampling、Elicitation 暂不支持。

## 常用命令

- `npm test`：运行 Vitest 测试。
- `npm run test:types`：运行 TypeScript 类型检查。

## 代码结构

- `packages/core/src/`：宿主无关的 MCP runtime、配置解析、overview、artifact、OAuth broker、并发和领域类型；npm 包 `@enderliquid/just-enough-mcp` 的源码根。
- `packages/core/src/config/`：Core 配置 raw layer 读取、合并、校验和 resolved server/materialization snapshot。
- `packages/core/src/modeling/`：跨模块共享的核心类型。
- `packages/core/src/concurrency/`：Registry 和 SDK session 生命周期使用的异步读写锁。
- `packages/core/src/servers/`：宿主无关的 `McpRegistry`、稳定 Registry errors 与 MCP server runtime。
- `packages/core/src/servers/servers/`：transport 推断、具体 stdio/HTTP server 组装、SDK session 生命周期与工具过滤；OAuth server 只在该层注入 authenticated fetch，不自行实现 OAuth 编排。
- `packages/core/src/oauth/`：OAuth capability contract 以及 broker 的协议、identity、credential persistence、授权事务与 session-side adapter 依赖；broker runtime/client 按 ownership 分层组织。
- `packages/core/src/oauth/broker/`：broker identity/credential 内核、broker-owned credential persistence、token/status/logout/authorize/scope-challenge HTTP API、session client/launcher 与 standalone process；commit `ecc3434` 的 claim/election/endpoint publication 已由简化 Phase 2 取代。已包含基于 SDK 低层函数的 discovery/DCR/refresh/authorize/code-exchange 协议 adapter、内存 authorize 事务与 callback 路由、平台 browser opener，以及 session 侧 authenticated fetch；真实浏览器与真实 AS 的端到端授权仍未手工验证。
- `packages/core/src/artifacts/`：工具调用结果物化、payload 提取/归一化、artifact 存储、manifest 与模型 summary 生成。
- `packages/core/src/formatting/`：宿主无关文本格式化工具，如英文单复数 `pluralize()`。
- `packages/pi-adapter/src/`：Pi adapter；路径、配置的 TUI 层、Pi tools、rendering、prompting 和生命周期均在此目录；npm 包 `@enderliquid/pi-just-enough-mcp` 的源码根。
- `packages/pi-adapter/src/tools/`：暴露给 Pi 的 `mcp_server` 与 `mcp_tool` 工具入口。
- `packages/pi-adapter/src/rendering/`：TUI 工具调用/结果渲染、footer status、用户可见通知和 TUI result settings。
- `packages/pi-adapter/src/prompting/`：系统 prompt 注入和 Pi-specific 用户文案。
- `__tests__/`：按 Core、Pi adapter、OAuth broker、artifact 和 lifecycle 边界覆盖行为。

## 架构约定

- `packages/pi-adapter/src/index.ts` 是 Pi session 生命周期的 composition root：config 是由有序全局/项目 raw 配置层解析出的整体替换 value snapshot；root 创建 session-scoped OAuth broker client/launcher、`McpRegistry`、Notifier 和 FooterStatusController。`McpRegistry` 自己拥有 OverviewBootstrapper 和 MCP server runtime，并在 `close()` 中排空它们；Registry、具体 server 与 OAuth server 只借用 root 注入的 OAuth broker capability。

- 不使用 module-level `currentXxx` 作为运行时依赖查找机制；Registry、配置和 UI capability 必须由 Pi root 通过 session-bound closure 或显式 runtime 注入，资源销毁由 root 持有的实例负责。
- standalone OAuth broker 直接由 Node 执行 `packages/core/src/oauth/broker/broker-process.ts`；其传递依赖必须保持 Node 原生 type stripping 可执行，只使用 erasable TypeScript syntax，并在 broker 子树内部使用显式 `.ts` import。`tsconfig.broker-native.json` 是该边界的额外类型门禁。
- broker process control plane 使用 broker-lifetime file lock、固定配置端口和可原子覆盖但允许残留的 access file；不引入 endpoint publication、claim election、旧实际端口发现/复用或 PID stale cleanup。session 侧 lock/port probe 只用于诊断，子进程自身的 lock acquisition 与固定端口 bind 才是最终启动判定。
- `broker-credentials.json` v1 只能由 broker 写入；credential mutation 在 broker 内串行化，通过同目录临时文件加原子 rename 持久化，只有持久化成功后才能发布新的内存 snapshot。token/status/logout API 必须校验 control secret、当前 presence incarnation 和 identity namespace。
- 仅当 session 配置了 OAuth server 时，插件 root 才创建一个 session-scoped broker client 和非阻塞 launcher，并共享给该 session 的 OAuth server；client 断连时可以重读 access file 并重连，但不自动 spawn broker。presence 使用 incarnation fence，断连或关闭时 best-effort release，TTL 只作兜底。
- Registry 是当前 session 的 server runtime aggregate：它装配、管理并关闭 `McpServer`；不拥有 session-scoped OAuth broker client，也不实现 SDK transport、OAuth 协议或具体 server 的组装逻辑。OAuth broker capability 由 root 注入并经 `createMcpServer()` 借给 OAuth server；不能把旧的 `OauthSessionServices` 重新放回 Registry。
- Registry 对外使用 `McpRegistry` contract；`initialize()` 返回结构化 `McpRegistryInitializationReport`，未知 server、关闭状态和不支持的 OAuth capability 返回带稳定 code 的 `McpRegistryError` 子类。
- `SdkSessionManager` 持有单个 server 的 SDK Client 并用异步读写锁协调生命周期。单次目录读取或工具调用至多按需初始化一次；若初始化后、操作开始前 client 已不可用，应报错而非静默重连或重放调用，避免重复副作用。
- `includeTools` / `excludeTools` 必须在 `SdkSessionManager` 中同时约束工具目录与实际调用；`excludeTools` 优先于 `includeTools`，不能只在展示层过滤。
- `Notifier` 与 `FooterStatusController` 是 session 内显式创建的用户可见 capability；root 负责创建并在 session shutdown 时释放 footer controller，其他模块不得通过 module-level sink 或全局 notify 函数发布消息。
- Pi direct tool 按能力域划分：`mcp_server` 管理 server 状态与生命周期，`mcp_tool` 承载 MCP Tools primitive；不要重新合并为依赖 optional 字段组合分派的单一入口。
- `createMcpServer()` 是当前唯一 transport 推断与具体 server 组装分派点。
- 配置层输出 `ResolvedServerConfig`，只保留通用字段和 `definition`；具体 server 组装实现负责校验并保存自己需要的配置字段。
- `ServerOverview` 只表示文档内容与来源，不携带 transport、鉴权等 runtime 分类信息。
- 当前 `connect` / `connectServer` / `connectState` 是历史命名，实际语义是“让 server 进入可用状态”，不应狭义理解为底层网络连接。
- `connected` 表示 manager 最近一次已提交的状态中持有已初始化且 tools catalog 可用的 Client；transport 可能已经关闭而对应的失效 writer 尚未提交，因此不保证底层 HTTP TCP 长连接存活，也不保证尚未收到 SDK `Client.onclose`。一次 tool call 报错不改变该状态。
- `disconnecting` 表示显式关闭已撤销当前 Client 的可用性，正在等待 `Client.close()` 完成；完成后才进入 `disconnected`。
- 插件配置顶层按职责拆分为 `materialization` 与 `tui`；`materialization` 控制 artifact 落盘、payload/JSON 归一化和给模型的 summary 预算，`tui` 只控制 TUI 渲染模式与展开模式折叠行数。
- TUI 渲染模式为 `hidden` / `minimal` / `expanded`，默认 `expanded`；不要把 TUI 展示配置混入 materialization 或模型 summary 配置。
- 用户可见英文数量文案应使用 `packages/core/src/formatting/english.ts` 的 `pluralize()` 处理单复数，避免写出 `1 tools`、`1 payload items` 等文本。

## 开发注意事项

- 使用中文书写代码注释和测试名称，避免语言偏移。
- 优先补充贴近变更边界的单元测试。
- 完成代码修改后优先运行 `npm test` 和 `npm run test:types`。
- `docs/` 在本地可能被 git exclude，用于任务说明和本地笔记时不要默认强制加入提交。
