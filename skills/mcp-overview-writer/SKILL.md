---
name: mcp-overview-writer
description: Maintain MCP server overviews for the Just Enough MCP plugin. Use it when creating, rewriting, organizing, or reviewing the overview file for a server.
---

# MCP Overview Writer

## When to use this skill

Load this skill before doing any of the following for an MCP server overview:

- Create an overview
- Rewrite an existing overview
- Organize or refactor an overview's structure
- Review whether an overview is sufficient to support server selection

This skill focuses on **how to maintain overviews**.
The system prompt already explains why overviews exist at runtime, why they are injected into the system prompt, and why the complete tool catalog is not exposed directly, so those premises are not repeated here.

## Goal

An overview is not meant to introduce a server exhaustively. Its purpose is to help the agent make faster, more accurate decisions during **server selection** and avoid known server-use pitfalls.

A good overview should primarily help answer these questions:

- What is this server **suitable for**?
- What is this server **not suitable for**?
- What prerequisites or environment requirements apply before using it?
- What implicit constraints are not stated in the tool catalog?

## Recommended workflow

1. Read the server's current overview first, if one exists.
2. Determine whether it is only an auto-initialized draft.
3. Then inspect the server's complete tool catalog.
4. If necessary, validate it with representative real tool calls.
5. If necessary, find more information about the server.
6. Refer to the information density and style of other overviews, if any.
7. Only then write or revise the overview.

## Identifying an auto-initialized draft

After a server connects successfully for the first time, the plugin may generate a minimal draft from the `description` in the metadata returned by that server.
A typical form looks like this:

```md
# <serverName>

<description>
```

This kind of content usually only conveys roughly what the server is. It is not enough to reliably support suitability judgments or identify usage pitfalls.

Therefore:

- **The existence of a file does not mean the overview is mature.**
- Continue filling it in when the content is insufficient.

## File paths

For a server named `serverName`, the default overview is located at:

- `~/.pi/agent/just-enough-mcp/overviews/<serverName>.md`

An overview may also be explicitly configured in a server definition. The plugin reads configuration in this order:

- Global config: `~/.pi/agent/just-enough-mcp/config.json`
- Current project config: `<project-dir>/.pi/just-enough-mcp/config.json`

The project config is included only when the current project is trusted by Pi. A project-level server object fully replaces a same-named global server, and `null` removes an inherited global server; server definitions are not recursively merged. Relative `overview` paths are resolved against the directory containing their respective config file and normalized to absolute paths before the layers are merged. Therefore, a relative path in project config is based in the project config directory, while one in global config is based in the global config directory.

Follow these rules when maintaining overviews:

- If the system prompt shows `> Overview file: ...`, use that resolved path as the primary source of truth.
- If no file path is shown, inspect the effective config in the precedence order above. If it explicitly sets `overview`, maintain the configured file; otherwise maintain the global default overview file.
- After changing an overview or config, remind the user to run `/reload` or restart the session when the system prompt needs the latest content.

## Writing priorities

Prioritize writing these:

- Suitable use cases
- Unsuitable use cases / common misuse boundaries
- Key constraints, prerequisites, and environment requirements
- Information that the tool catalog cannot express but that affects use

Avoid writing these:

- Large copied blocks of tool listings
- Restatements of tool schemas
- Marketing-style descriptions
- Outdated content that no longer matches the server's actual capabilities
- Hard dependency assumptions about other servers or tools

## Atomicity principle

An overview must be able to **stand on its own**.

This means:

- Describe only what this server is, what it can do, and its limitations.
- Do not treat the availability of other tools as a default prerequisite.
- Do not put cross-tool collaboration rules into one server's overview.
- Do not depend on overview documentation for other servers.

For example, do not write:

- "In some cases, prefer another server first."
- "Use this together with another tool."

Unless:

- The related tool is fairly fundamental.
- The user explicitly asks for compositional documentation.

## Suggested structure

For most servers, start with this minimal structure:

```md
# <serverName>

<One sentence explaining what it is and when it should be considered>

## Notes

- <Suitability boundary or implicit constraint 1>
- <Suitability boundary or implicit constraint 2>
```

If a server has more complex boundaries, extend the structure as needed. If a server is simple, keep it short; the notes section may be omitted.

## Example

`~/.pi/agent/just-enough-mcp/overviews/cua-driver.md`

```md
# cua-driver

A cross-platform desktop GUI automation and UI awareness tool for discovering local applications and windows, reading UI accessibility trees, capturing window screenshots, and performing clicks, text input, hotkeys, scrolling, and dragging in desktop applications. Prefer it when a task requires direct interaction with a local application UI, or when you need to judge the current state of a desktop program through screenshots or window state.

## Notes

- Prefer it for scenarios where **GUI interaction is required**. If the task can be completed through the command line, file reading, or another more direct MCP, prefer the lower-cost path.
- For applications with weak support, the UI accessibility tree may be incomplete. In that case, use visual fallbacks such as screenshots, zooming, and coordinate-based clicking.
```

## Self-check list

Before finalizing an overview, quickly check:

- Does it make it easier for the agent to decide whether this server should be selected?
- Does it help the agent avoid server-use pitfalls?
- Does it avoid copying the tool catalog or schema directly?
- Can it still stand on its own when other servers, tools, or their overview documentation are unavailable?
