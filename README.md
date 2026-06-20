# just-enough-mcp

`just-enough-mcp` is a Pi plugin that embeds a minimal multi-server MCP runtime.

## MVP goals

- support `stdio` and `Streamable HTTP`
- support only the Tools primitive in v1
- expose a single `mcp` tool to the model
- use server-level progressive disclosure
- materialize tool-call payloads to local artifacts

## Project layout

- `extensions/config/` — config loading and server overviews
- `extensions/clients/` — MCP client lifecycle and transports
- `extensions/modeling/` — shared runtime models and types
- `extensions/prompting/` — system prompt injection helpers
- `extensions/tools/` — the public `mcp` tool surface
- `extensions/rendering/` — TUI render helpers
- `extensions/artifacts/` — result materialization helpers

## Status

Scaffold only. Implementation is in progress.
