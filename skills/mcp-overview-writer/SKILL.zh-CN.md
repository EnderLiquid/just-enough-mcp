---
name: mcp-overview-writer
description: 编写、改写或评审 Just Enough MCP 插件的 MCP server overview。用于新增 MCP server 后补写 overview，或在需要时完善、整理已有 overview。
---

# MCP Overview Writer

## 什么是 overview

传统的 MCP 接入方式通常会在一开始就连接所有 MCP server，并向 LLM 全量暴露它们注册的工具，因此从一开始就占用了大量上下文窗口。截至目前，MCP 协议本身并没有针对这个问题提供内建优化。`Just Enough MCP` 插件则注意到：单个 MCP server 通常具有原子性，而同一个 server 内部的工具往往高度耦合。

因此，插件要求为每个 MCP server 维护一份简要描述其功能及用法的 overview。会话中，只有这些 overview 本身会被注入系统提示词；对应 MCP server 的完整工具目录、每个工具的描述及 schema 则被排除在外，模型仅在需要时连接特定 MCP server 并获取详情。通过这种方式，插件得以实现 server 粒度的 MCP 上下文渐进式披露。

overview 的职责是：

- 帮 agent 在 **server 级选择** 阶段快速建立该 server 的能力边界认知
- 说明这个 server **适合做什么 / 不适合做什么**
- 提醒会显著影响选择准确率的限制条件

overview 不是：

- 宣传文案
- 工具目录镜像或 schema 抄录

## 推荐工作流

1. 先读该 MCP server 的现有 overview（如果有）
2. 判断它是不是**自动初始化草稿**
3. 再看该 server 的完整工具目录
4. 如有必要，选 1–2 个代表性工具做真实调用验证
5. 如果有，再参考其他 server overview 的写法和信息密度
6. 最后再写或改 overview

### 自动初始化草稿识别

当前 `just-enough-mcp` 可能会在 server 首次成功连接后，自动创建一个最小草稿。
典型形式如下：

```md
# <serverName>

<description>
```

`description` 字段来自连接时返回的 server description，一般能简要概括 server 功能，但信息量不足以让 agent 形成清晰判断。

因此：

- **文件存在 ≠ overview 已成熟**
- 如果内容只是对 server description 的轻量展开，应继续补全

## 文件路径

名为 `serverName` 的 MCP server，其 overview 默认位于：

- `~/.pi/agent/mcp-overviews/<serverName>.md`

用户也可能在插件配置文件中手动为各 MCP server 指定 overview 路径：

- `~/.pi/agent/just-enough-mcp.json`

若配置里显式指定了 overview 路径，应优先维护显式路径，而不是默认路径。

## 写作取舍标准

优先写这些：

- 适用场景
- 不适用场景 / 常见误用边界
- 关键限制、前置条件、环境要求
- 能明显提升“该不该选这个 server”判断质量的信息

避免写这些：

- 大段复制工具清单
- 工具 schema 的复述
- 对其他工具或其他 server 的硬依赖假设
- overview 中原有、但已随 MCP 功能变化而过时的内容

## 原子性原则

overview 必须能**独立成立**。

这意味着：

- 只描述这个 server 自己是什么、能做什么、有什么限制
- 不把“环境里还有别的工具”写成前提
- 不把跨工具协作规则塞进单个 server overview

例如，不要在某个 server overview 里写：

- “某情况优先用另一个 server”
- “建议配合某个工具使用”

这是因为其他工具可能在未来改变功能、更名或被移除。除非：

- 相关工具非常基础（如 `read`）
- 用户明确要求写组合性文档

## 示例

`~/.pi/agent/mcp-overviews/cua-driver.md`

```md
# cua-driver

跨平台桌面 GUI 自动化与界面感知工具，用于发现本机应用与窗口、读取 UI 无障碍树、抓取窗口截图，并对桌面应用执行点击、输入、快捷键、滚动、拖拽等操作。当任务需要直接操作本地应用界面，或需要通过截图或窗口状态判断桌面程序当前界面时，优先考虑使用它。

## 注意事项

- 优先用在**必须操作 GUI** 的场景；若任务可通过命令行、读文件或其他更直接的 MCP 完成，优先使用成本更低的方式。
- 对支持较差的应用，UI 无障碍树可能不完整；这时可改用截图、缩放和坐标点击等视觉 fallback。
```

如果 server 边界很复杂，可以适度扩展；如果 server 很简单，就保持短小。
