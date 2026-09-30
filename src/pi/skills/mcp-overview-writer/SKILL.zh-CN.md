---
name: mcp-overview-writer
description: 维护 Just Enough MCP 插件中的 MCP server overview。用于新增、改写、整理或评审某个 server 的 overview 文件。
---

# MCP Overview Writer

## 何时使用

当你准备对某个 MCP server 的 overview 做以下工作时，先加载本 skill：

- 新增 overview
- 改写已有 overview
- 整理或重构 overview 结构
- 评审 overview 是否足够支撑 server 选择

本 skill 关注的是 **如何维护 overview**。
关于 overview 在运行时为什么存在、为什么会被注入系统提示词、以及为什么不直接暴露完整工具目录，这些前提在系统提示词已说明，这里不再重复。

## 目标

overview 的目标不是全面介绍一个 server，而是帮助 agent 在 **服务器选择** 阶段快速做出更准确的判断，并规避服务器使用的已知误区。

一份好的 overview 应优先帮助回答下面这些问题：

- 这个 server **适合做什么**
- 这个 server **不适合做什么**
- 使用它的前置条件或环境要求
- 使用时有哪些工具清单中未能注明的隐式限制

## 推荐工作流

1. 先读该 server 当前的 overview（如有）
2. 判断它是否只是自动初始化草稿
3. 再查看该 server 的完整工具目录
4. 如有必要，选择代表性工具做真实调用验证
5. 如有必要，查找关于该 server 的更多信息
6. 参考其他 overview 的信息密度与写法（如有）
7. 最后再写或改 overview

## 自动初始化草稿识别

插件在某个 server 首次成功连接后，可能会根据该 server 返回的元信息中的 `description` 自动生成一个最小草稿。
典型形式如下：

```md
# <serverName>

<description>
```

这类内容通常只够表达“这个 server 大概是什么”，不足以可靠地支撑适用性判断与使用误区识别。

因此：

- **文件存在 ≠ overview 已成熟**
- 如果内容信息不足，应继续补全

## 文件路径

名为 `serverName` 的 server，其 overview 默认位于：

- `~/.pi/agent/just-enough-mcp/overviews/<serverName>.md`

overview 也可以在以下插件配置文件中显式指定路径。插件按全局配置到项目配置的顺序读取：

- 全局配置：`~/.pi/agent/just-enough-mcp/config.json`
- 当前项目配置：`<project-dir>/.pi/just-enough-mcp/config.json`

项目配置仅在当前项目受 Pi 信任时生效。项目层的 server object 会完整替换同名全局 server，`null` 会移除继承的全局 server，不会与全局 server definition 递归合并。每个配置文件中的相对 `overview` 路径都相对于该文件所在目录解析，并在合并前规范化为绝对路径；因此项目配置中的相对路径以项目配置目录为起点，全局配置中的相对路径以全局配置目录为起点。

维护时遵循以下规则：

- 系统提示词中若显示 `> Overview file: ...`，优先使用其中的已解析路径维护文件。
- 若没有显示文件路径，按上述配置优先级查找显式 overview 路径；有则维护配置指定的文件，没有则维护全局默认 overview 文件。
- 修改 overview 或配置后，如需让系统提示词看到最新内容，提醒用户运行 `/reload` 或重启会话

## 写作取舍标准

优先写这些：

- 适用场景
- 不适用场景 / 常见误用边界
- 关键限制、前置条件和环境要求
- 工具目录无法表达、但会影响使用的信息

避免写这些：

- 大段复制工具清单
- 工具 schema 的复述
- 营销文案式描述
- 与当前能力不符的过时内容
- 对其他 server 或其他工具的硬依赖假设

## 原子性原则

overview 必须能**独立成立**。

这意味着：

- 只描述这个 server 自己是什么、能做什么、有什么限制
- 不把“环境里还有别的工具”写成默认前提
- 不把跨工具协作规则塞进单个 server overview
- 不依赖其他服务器的 overview 文档

例如，不要写：

- “某种情况优先用另一个 server”
- “建议与某个工具配合使用”

除非：

- 相关工具较为基础
- 用户明确要求写组合性文档

## 建议结构

对于大多数 server，推荐从下面这个最小结构开始：

```md
# <serverName>

<一句话说明它是什么，以及什么时候应该考虑它>

## 注意事项

- <适用边界或隐式限制 1>
- <适用边界或隐式限制 2>
```

如果 server 的边界更复杂，可以扩展；如果 server 很简单，就保持短小，注意事项可以不写。

## 示例

`~/.pi/agent/just-enough-mcp/overviews/cua-driver.md`

```md
# cua-driver

跨平台桌面 GUI 自动化与界面感知工具，用于发现本机应用与窗口、读取 UI 无障碍树、抓取窗口截图，并对桌面应用执行点击、输入、快捷键、滚动、拖拽等操作。当任务需要直接操作本地应用界面，或需要通过截图或窗口状态判断桌面程序当前界面时，优先考虑使用它。

## 注意事项

- 优先用在**必须操作 GUI** 的场景；若任务可通过命令行、读文件或其他更直接的 MCP 完成，优先使用成本更低的方式。
- 对支持较差的应用，UI 无障碍树可能不完整；这时可改用截图、缩放和坐标点击等视觉 fallback。
```

## 自检清单

提交 overview 前，快速检查：

- 读完后，agent 是否更容易判断“该不该选这个 server”
- 是否有助于 agent 规避 server 使用的误区
- 是否避免把工具目录或 schema 直接抄进去
- 在其他 server、工具或其 overview 文档不可用时是否仍能独立成立
