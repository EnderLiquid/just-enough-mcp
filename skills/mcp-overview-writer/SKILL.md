---
name: mcp-overview-writer
description: Maintain MCP server overviews for the Just Enough MCP plugin. Use it when creating, rewriting, organizing, or reviewing the overview file for a server.
---

# MCP Overview Writer

## When to use this skill

Load this skill before you do any of the following for an MCP server overview:

- Create a new overview
- Rewrite an existing overview
- Reorganize or refactor an overview structure
- Review whether an overview is strong enough to support server selection

This skill focuses on **how to maintain overviews**.
The runtime rationale for overviews, why they are injected into the system prompt, and why full tool catalogs are not exposed up front are already covered by the system prompt and are not repeated here.

## Goal

An overview is not meant to describe a server exhaustively. Its job is to help the agent make more accurate judgments during the **server-level selection** stage.

A good overview should primarily help answer these questions:

- What is this server **suitable for**?
- What is this server **not suitable for**?
- What key constraints, prerequisites, or environment requirements apply before using it?
- What information would materially improve the judgment of whether this server should be selected?

## Recommended workflow

1. Read the current overview for the server first, if there is one
2. Decide whether it is only an auto-initialized draft
3. Then inspect the server's full tool catalog
4. If necessary, validate with 1–2 representative tool calls
5. Refer to the information density and writing style of other overviews
6. Only then write or revise the overview

## Identifying an auto-initialized draft

After a server connects successfully for the first time, the plugin may generate a minimal draft from the `description` field found in the metadata returned by that server.
A typical form looks like this:

```md
# <serverName>

<description>
```

This kind of content usually only tells you roughly what the server is. It is not enough to support reliable task routing or suitability judgments on its own.

So:

- **The existence of a file does not mean the overview is already mature**
- If the content is only a light expansion of the `description`, keep refining it

## File paths

By default, the overview for a server named `serverName` is located at:

- `~/.pi/agent/mcp-overviews/<serverName>.md`

Users may also explicitly configure an overview path in the plugin config file:

- `~/.pi/agent/just-enough-mcp.json`

Follow these rules when maintaining overviews:

- If an explicit overview path is configured, maintain that explicit path first
- If no explicit path is configured, maintain the default overview file
- After changing an overview or config, remind the user to run `/reload` or restart the session if the updated content needs to appear in the system prompt

## Writing priorities

Prioritize writing these:

- Suitable use cases
- Unsuitable use cases / common misuse boundaries
- Key constraints, prerequisites, and environment requirements
- Information that can clearly improve server selection accuracy

Avoid writing these:

- Large copied blocks of tool listings
- Restatements of tool schemas
- Marketing-style descriptions
- Outdated content that no longer matches the server's actual capabilities
- Hard dependency assumptions about other servers or other tools

## Atomicity principle

An overview must be able to **stand on its own**.

This means:

- Describe only what this server is, what it can do, and what its limitations are
- Do not assume that other tools are available by default
- Do not put cross-tool collaboration rules into a single server overview

For example, do not write:

- "In some cases, prefer another server first"
- "It is recommended to use this together with another tool"

Unless:

- The related tool is fairly fundamental, such as `read`
- The user explicitly asks for a cross-tool document

## Suggested structure

For most servers, start from this minimal structure:

```md
# <serverName>

<One sentence describing what it is and when it should be considered>

## Notes

- <Key limitation or suitability boundary 1>
- <Key limitation or suitability boundary 2>
```

If a server has more complex boundaries, extend the structure as needed. If a server is simple, keep it short and you may omit the notes section.

## Example

`~/.pi/agent/mcp-overviews/cua-driver.md`

```md
# cua-driver

A cross-platform desktop GUI automation and UI awareness tool for discovering local applications and windows, reading UI accessibility trees, capturing window screenshots, and performing clicks, text input, hotkeys, scrolling, and dragging in desktop applications. Prefer it when a task requires direct interaction with a local application UI, or when you need to judge the current state of a desktop program through screenshots or window state.

## Notes

- Prefer it for scenarios where **GUI interaction is required**. If the task can be completed through the command line, file reading, or another more direct MCP, prefer the lower-cost path.
- For applications with weak support, the UI accessibility tree may be incomplete. In that case, use visual fallbacks such as screenshots, zooming, and coordinate-based clicking.
```

## Self-check list

Before you finalize an overview, quickly check:

- Does it make it easier for the agent to decide whether this server should be selected?
- Does it clearly describe unsuitable scenarios or misuse boundaries?
- Does it include key constraints rather than only capabilities?
- Does it avoid copying tool catalogs or schemas directly?
- Can it still stand on its own without relying on documentation for other servers?
