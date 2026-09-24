# MCP Servers

`sc` can consume [Model Context Protocol](https://modelcontextprotocol.io)
servers as tool providers — reusing the existing MCP ecosystem (context7,
GitHub MCP, filesystem servers, …) instead of bespoke tools.

## Configuration

```json
// ~/.sc-agent/config.json or .sc-agent.json
{
  "mcp": {
    "servers": {
      "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
      "gh":       { "command": "gh-mcp-server", "args": [] }
    }
  }
}
```

Per server:

| Field | Description |
|-------|-------------|
| `command` | Executable to spawn (required) |
| `args` | Arguments array |
| `env` | Extra environment variables |
| `timeoutMs` | Per-request timeout (default `30000`) |

## Behavior

- **Transport:** stdio, newline-delimited JSON-RPC 2.0 (`initialize` →
  `notifications/initialized` → `tools/list`).
- **Naming:** remote tools surface as `mcp__<server>__<tool>` in the schema,
  `/tools`, `scc doctor`, and the audit log.
- **Permissions:** MCP tools go through the normal permission system — they
  require approval unless in `permissions.autoApprove` or `-y`.
- **Isolation:** a server that fails to spawn, times out, or crashes
  mid-session is skipped / degrades to per-call errors. It can never kill
  the agent loop. All servers are killed on CLI exit.

## Scope notes

- stdio transport only (HTTP/SSE may follow).
- Connect happens at session start so the tool schema is complete before the
  first model call; a dead server simply contributes zero tools.
