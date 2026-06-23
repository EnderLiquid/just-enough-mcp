---
name: mcp-overview-writer
description: Write, rewrite, or review MCP server overviews for the Just Enough MCP plugin. Use when adding an overview for a newly added MCP server, or when improving or reorganizing an existing overview.
---

# MCP Overview Writer

## What is an overview?

Conventional MCP integrations usually connect to all MCP servers up front and fully expose all tools registered by those servers to the LLM, which consumes a large amount of context window from the very beginning. So far, the MCP protocol itself does not provide a built-in optimization for this problem. The `Just Enough MCP` plugin takes a different view: a single MCP server is usually atomic, while the tools inside that server are often highly coupled.

For that reason, the plugin maintains an overview for each MCP server to briefly describe its functionality and usage. During a session, only these overviews are injected into the system prompt. The full tool catalog of a given MCP server, along with each tool's descriptions and schemas, is left out. The model connects to a specific server and retrieves those details only when needed. This allows the plugin to achieve server-level progressive disclosure for MCP context.

An overview is meant to:

- Help the agent quickly understand a server's capability boundaries during the **server-level selection** stage
- Explain what the server **is suitable for / is not suitable for**
- Highlight constraints that would significantly affect selection accuracy

An overview is not meant to be:

- Marketing copy
- A mirror of the tool catalog or a transcription of schemas

## Recommended workflow

1. Read the existing overview for the MCP server first, if there is one
2. Decide whether it is an **auto-initialized draft**
3. Then inspect the complete tool catalog of that server
4. If necessary, validate with 1–2 representative tool calls
5. Refer to the writing style and information density of other server overviews, if any
6. Only then write or revise the overview

### Identifying an auto-initialized draft

Currently, `just-enough-mcp` may automatically create a minimal draft after a server connects successfully for the first time.
A typical form looks like this:

```md
# <serverName>

<description>
```

The `description` field comes from the server description returned during connection. It usually provides a brief summary of what the server does, but it is not rich enough for the agent to form a clear judgment on its own.

So:

- **The existence of a file does not mean the overview is already mature**
- If the content is little more than a light rewrite of the server description, keep refining it

## File paths

By default, the overview for the server named `serverName` is located at:

- `~/.pi/agent/mcp-overviews/<serverName>.md`

Users may also manually specify overview paths for MCP servers in the plugin config file:

- `~/.pi/agent/just-enough-mcp.json`

If an overview path is explicitly configured there, maintain the explicit path first rather than the default path.

## Writing priorities

Prioritize writing these:

- Suitable use cases
- Unsuitable use cases / common misuse boundaries
- Key constraints, prerequisites, and environment requirements
- Information that can clearly improve the quality of the judgment of whether this server should be selected

Avoid writing these:

- Large copied blocks of tool listings
- Restatements of tool schemas
- Hard dependency assumptions about other tools or other servers
- Content that already exists in the overview but has become outdated as the MCP server's capabilities have changed

## Atomicity principle

An overview must be able to **stand on its own**.

This means:

- Describe only what this server is, what it can do, and what its limitations are
- Do not assume that other tools are present in the environment
- Do not put cross-tool collaboration rules into a single server overview

For example, do not write things like this in a server overview:

- "In some cases, prefer another server first"
- "It is recommended to use this together with another tool"

This is because other tools may change functionality, be renamed, or be removed in the future. Unless:

- The related tool is extremely fundamental, such as `read`
- The user explicitly asks for a cross-tool document

## Example

`~/.pi/agent/mcp-overviews/cua-driver.md`

```md
# cua-driver

A cross-platform desktop GUI automation and UI awareness tool for discovering local applications and windows, reading UI accessibility trees, capturing window screenshots, and performing clicks, text input, hotkeys, scrolling, and dragging in desktop applications. Prefer it when a task requires direct interaction with a local application UI, or when you need to judge the current state of a desktop program through screenshots or window state.

## Notes

- Prefer it for scenarios where **GUI interaction is required**. If the task can be completed through the command line, file reading, or another more direct MCP, prefer the lower-cost path.
- For applications with weak support, the UI accessibility tree may be incomplete. In that case, use visual fallbacks such as screenshots, zooming, and coordinate-based clicking.
```

If a server has complex boundaries, you may extend the structure appropriately. If a server is simple, keep it short.
