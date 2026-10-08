# Architecture Overview

SC-Agent CLI is a provider-agnostic AI agent built with TypeScript, designed for extensibility and security.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        User (CLI)                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           v
┌─────────────────────────────────────────────────────────────┐
│                    CLI Layer (cli.ts)                        │
│  - Command parsing (Commander.js)                            │
│  - Subcommands: chat, profile, init, config-init            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           v
┌─────────────────────────────────────────────────────────────┐
│                  Agent Layer (core/agent.ts)                 │
│  - ReAct-style loop: message → provider → tools → repeat    │
│  - Loads project context (AGENTS.md)                         │
│  - Manages conversation history                              │
└──────────┬────────────────────────────────┬─────────────────┘
           │                                │
           v                                v
┌──────────────────────┐      ┌──────────────────────────────┐
│  Provider Layer      │      │  Tools Layer                 │
│  (core/provider.ts)  │      │  (tools/*)                   │
│                      │      │                              │
│  - HTTP client       │      │  - read_file                 │
│  - Streaming support │      │  - write_file                │
│  - OpenAI-compatible │      │  - edit_file                 │
│    API format        │      │  - list_dir                  │
│                      │      │  - search_text               │
└──────────┬───────────┘      │  - run_shell                 │
           │                  │                              │
           │                  └──────────┬───────────────────┘
           │                             │
           v                             v
┌──────────────────────┐      ┌──────────────────────────────┐
│  External API        │      │  Filesystem / Shell          │
│  - Ollama            │      │  - Read/write operations     │
│  - OpenAI            │      │  - Shell command execution   │
│  - Anthropic (proxy) │      │  - Path validation           │
│  - Custom endpoints  │      │  - Permission checks         │
└──────────────────────┘      └──────────────────────────────┘
```

## Core Components

### 1. CLI Layer (`src/cli.ts`)

Entry point using Commander.js. Defines commands:

- **`chat`**: Default command, starts interactive session
- **`profile <subcommand>`**: Manage model profiles
- **`init`**: Create project `AGENTS.md`
- **`config-init`**: Initialize global config

### 2. Agent Layer (`src/core/agent.ts`)

The main agent loop implementing a **ReAct pattern**:

1. **Reason**: Send message to provider with tool schemas
2. **Act**: Execute any tool calls returned by the model
3. **Observe**: Add tool results to message history
4. **Repeat**: Continue until model stops calling tools

Key features:

- System prompt injection (including project context)
- Streaming response handling
- Maximum iteration safety (prevents infinite loops)
- Error recovery (tool failures don't crash the loop)

### 3. Provider Layer (`src/core/provider.ts`)

Abstraction over the LLM API. Currently implements `OpenAICompatibleProvider`:

- **Request format**: `/v1/chat/completions` (OpenAI Messages API)
- **Streaming**: Server-Sent Events (SSE) with incremental JSON deltas
- **Tool calling**: Native function calling via `tools` parameter
- **Platform**: Uses Node.js native `fetch` (v18+)

**Future**: Could add `AnthropicProvider`, `GoogleProvider`, etc., by implementing the same interface.

### 4. Tools Layer (`src/tools/*`)

Each tool implements the `Tool` interface:

```typescript
interface Tool {
  definition: ToolDefinition;  // JSON Schema sent to the model
  execute(args, ctx): Promise<string>;  // Execution logic
}
```

Tools receive a **ToolContext** with:

- `workspaceRoot`: Base directory for file operations
- `config`: Current configuration (for permissions)
- `autoApprove`: Override flag from CLI

**Security**: All file operations go through `resolveSafePath()`, which:

- Resolves relative paths to absolute
- Validates they're within workspace
- Checks against deny patterns (`.env`, `*.key`, etc.)

### 5. Configuration System (`src/core/config.ts`)

Hierarchical config loading:

1. **Built-in defaults**: Defined in code
2. **Global config**: `~/.sc-agent/config.json`
3. **Project config**: `.sc-agent.json` in workspace
4. **Active profile**: Overrides model settings

**Deep merging**: Later configs override earlier ones, but objects merge recursively (profiles accumulate, not replace).

### 6. Permission System (`src/utils/permissions.ts`)

Before executing a tool:

1. Check if `autoApprove` is set (from `-y` flag)
2. Check if tool is in `config.permissions.autoApprove` list
3. Otherwise, prompt user interactively

**Default auto-approved**: `read_file`, `list_dir`, `search_text` (read-only operations)

### 7. Project Context (`src/core/project-context.ts`)

Searches for context files in this order:

1. `AGENTS.md`
2. `SC-AGENT.md`
3. `CLAUDE.md`

If found, content is prepended to the system prompt. Allows projects to provide:

- Project overview
- Coding guidelines
- File structure explanation
- Build/test instructions

## Data Flow

### Chat Session Flow

```
User input → Chat Session (REPL) → Agent.run()
  ↓
  Agent injects system prompt + project context
  ↓
  Provider.chatCompletion(messages, tools)
  ↓
  Stream chunks → Display to user
  ↓
  Tool calls? → Execute each tool (with permission check)
  ↓
  Add tool results to messages
  ↓
  Loop back to Provider.chatCompletion() if more work needed
  ↓
  Final response → Return to REPL → Next user input
```

### Configuration Resolution

```
DEFAULT_CONFIG (in-memory)
  ↓
  Deep merge with ~/.sc-agent/config.json
  ↓
  Deep merge with ./.sc-agent.json (if exists)
  ↓
  Apply active profile overrides
  ↓
  Replace placeholder API keys with undefined
  ↓
  Validate required fields
  ↓
  Final config → Used by Agent
```

## Key Design Decisions

### Why OpenAI-compatible format?

- **Ubiquity**: Most LLM providers offer an OpenAI-compatible endpoint
- **Standardization**: Well-documented, stable API format
- **Tooling**: Existing libraries and tools work out of the box

### Why Node 20+?

- **Native fetch**: No need for `node-fetch` or `axios`
- **Web Streams**: Standard `ReadableStream` for SSE parsing
- **ESM support**: Modern JavaScript module system

### Why TypeScript?

- **Type safety**: Catch errors at compile time
- **Maintainability**: Clear interfaces and contracts
- **Developer experience**: Autocomplete and inline docs

### Why streaming?

- **Responsiveness**: User sees output immediately
- **Long responses**: No timeout waiting for full completion
- **Better UX**: Feels like a conversation, not waiting for a batch

### Why Commander.js?

- **Mature**: Battle-tested CLI framework
- **Ergonomic**: Clean API for defining commands
- **Cross-platform**: Works on Windows, Linux, macOS

## Extension Points

Want to add functionality? Here are the main extension points:

### Adding a New Tool

1. Create `src/tools/my-tool.ts`
2. Implement `Tool` interface
3. Add to `src/tools/registry.ts`

### Adding a New Provider

1. Create `src/core/my-provider.ts`
2. Implement same interface as `OpenAICompatibleProvider`
3. Update `src/core/agent.ts` to instantiate based on `config.model.provider`

### Adding a New Command

1. Create `src/commands/my-command.ts`
2. Register in `src/cli.ts` with Commander

### Customizing Permissions

Edit `~/.sc-agent/config.json`:

```json
{
  "permissions": {
    "autoApprove": ["read_file", "write_file"],  // Add more tools
    "denyPaths": ["secrets/**", "*.env"]  // Block paths
  }
}
```

## Security Model

### Sandboxing

- **Workspace root**: All file operations confined to `workspaceRoot`
- **Path traversal**: `resolveSafePath` prevents `../../../etc/passwd`
- **Deny patterns**: Configurable blocklist (e.g., `.env`, `*.key`)

### Permission Model

- **Default deny**: Mutating operations require explicit permission
- **User control**: Interactive prompts for sensitive actions
- **Auto-approve**: Opt-in for trusted tools or with `-y` flag

### Audit Trail

- **Tool calls**: Logged to console with arguments
- **Results**: Success/failure displayed immediately
- **Errors**: Clear error messages, no silent failures

## Performance Considerations

### Streaming

- **Incremental rendering**: Chunks displayed as they arrive
- **Low latency**: First token appears in <1s (model-dependent)
- **Memory efficient**: No buffering of full response

### Caching

- **No caching**: Fresh requests every time (consider adding Redis for repeated queries)
- **Session memory**: Conversation history kept in memory (could persist to file)

### Concurrency

- **Single-threaded**: Node.js event loop handles async I/O
- **No parallel tools**: Tools execute sequentially (could parallelize in future)

## Testing Strategy (Future)

Currently manual testing. Future improvements:

1. **Unit tests**: Core logic (config merging, path validation)
2. **Integration tests**: Tool execution with mock provider
3. **E2E tests**: Full chat sessions with real Ollama endpoint
4. **Snapshot tests**: Provider API request/response formats

## Deployment

### Local Development

```bash
npm install
npm run build
npm link
```

### Distribution

Options:

1. **npm package**: Publish to npm registry
2. **Binary**: Bundle with `pkg` or `nexe` (single executable)
3. **Container**: Docker image with Node + agent
4. **Standalone**: `npm pack` → tarball for offline install

## Roadmap Ideas

- [ ] Multi-turn conversation persistence (save/load sessions)
- [ ] Parallel tool execution (when tools don't depend on each other)
- [ ] Plugin system (load tools from external packages)
- [ ] Web UI (Electron or browser-based)
- [ ] Native Anthropic Messages API support (not just via proxy)
- [ ] Telemetry (opt-in usage metrics)
- [ ] Automated testing suite
- [ ] Performance profiling (where does time go?)

## References

- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [Ollama OpenAI Compatibility](https://github.com/ollama/ollama/blob/main/docs/openai.md)
- [Commander.js Documentation](https://github.com/tj/commander.js)
- [Node.js Fetch API](https://nodejs.org/dist/latest-v20.x/docs/api/globals.html#fetch)
