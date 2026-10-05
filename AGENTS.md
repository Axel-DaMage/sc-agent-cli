# SC-Agent CLI - Agent Instructions

## Project Overview

**SC-Agent CLI** (v0.4.2) is a provider-agnostic AI agent CLI tool that supports any OpenAI-compatible API (OpenAI, Anthropic, Ollama, LM Studio, NVIDIA, Groq, Together, etc.). It provides:
- **10+ built-in tools** (web fetch, git, file ops, shell, persistent memory)
- **Parallel tool execution** for maximum performance
- **Smart permission profiles** (Traditional, Blacklist, Custom)
- **Cross-platform** (Windows, macOS, Linux, WSL)
- **Cross-session persistent memory**
- **Shell environment auto-detection**
- **Streaming responses** with status bar UI

## Key Architecture

### Core Components

- **`src/core/types.ts`**: TypeScript type definitions (messages, tools, config)
- **`src/core/config.ts`**: Configuration loading/saving with profile support
- **`src/core/provider.ts`**: OpenAI-compatible API client with streaming
- **`src/core/agent.ts`**: Main agent loop with parallel tool execution & memory injection
- **`src/core/project-context.ts`**: Loads project-specific context from `AGENTS.md|CLAUDE.md`
- **`src/core/message-validator.ts`**: Auto-corrects message sequence errors
- **`src/core/devcontainer.ts`**: Optional `--devcontainer` execution — `devcontainer up` + `devcontainer exec` with `devcontainer_unavailable` host fallback
- **`src/core/repo-probe/`**: Repo toolchain/command detection (`sc probe`); reports `devcontainer` + `devcontainerPath` when `.devcontainer.json`/`.devcontainer/devcontainer.json` exists

### Tools System (10 tools)

- **`src/tools/tool.ts`**: Tool interface and context
- **`src/tools/registry.ts`**: Central registry of all available tools
- File operation tools:
  - `read-file.ts`: Read file contents (auto-approved)
  - `write-file.ts`: Create/overwrite files (requires permission)
  - `edit-file.ts`: Apply unified diff patches (requires permission)
  - `list-dir.ts`: List directory contents (auto-approved)
  - `search-text.ts`: Search text with glob patterns (auto-approved)
- Execution tools:
  - `run-shell.ts`: Execute shell commands (requires permission)
- **New in v0.4.0**:
  - `web-fetch.ts`: Fetch web content (docs, APIs, GitHub). No API key needed. (auto-approved)
  - `git-tool.ts`: Native git operations (status, diff, log, branch, add, commit) (requires permission)
  - `memory-tools.ts`: Persistent cross-session memory read/write (read auto-approved, write requires permission)

### Utilities

- **`src/utils/permissions.ts`**: Permission request system (Traditional + Blacklist profiles)
- **`src/utils/path-security.ts`**: Path validation and sandboxing
- **`src/utils/memory.ts`**: Persistent cross-session memory storage (JSON file in ~/.sc-agent/memory/)
- **`src/utils/shell-env.ts`**: Shell environment auto-detection (cmd, PowerShell, Git Bash, WSL)
- **`src/utils/dangerous-commands.ts`**: Dangerous command detection for Blacklist profile
- **`src/utils/autocomplete.ts`**: Tab completion for commands, tools, and file paths
- **`src/utils/storage-limit.ts`**: Configurable storage limits and auto-cleanup
- **`src/utils/status-bar.ts`**: Real-time status bar with keyboard shortcuts
- **`src/utils/storage-guidance.ts`**: Storage usage tips
- **`src/utils/token-tracker.ts`**: Token usage estimation and cost tracking
- **`src/utils/checkpoint.ts`**: Execution state checkpointing for crash recovery
- **`src/utils/run-manifest.ts`**: Machine-readable run manifest builder/emitter for headless batch runs (`--output-format json`, `--summary-file`, `--output-file`)

### Commands

- **`src/commands/chat-session.ts`**: Interactive REPL with /commands (/help, /memory, /model, /permissions, /profile, /storage, /reload, /clear, /info)
- **`src/commands/profile.ts`**: Profile management (list, add, use, remove)
- **`src/commands/init-command.ts`**: Project initialization with AGENTS.md

### Entry Point

- **`src/cli.ts`**: Main CLI with Commander.js

## Coding Guidelines

1. **TypeScript strict mode**: All code uses strict TypeScript
2. **Error handling**: Always catch and provide meaningful error messages
3. **Security**: All file operations go through `resolveSafePath` validation
4. **Streaming**: Provider supports streaming responses for better UX
5. **Cross-platform**: Use Node's `node:*` imports for built-ins

## Key Patterns

### Tool Execution Flow (Parallel)

1. User sends message
2. Agent injects system prompt + shell env + persistent memory + project context
3. Agent calls provider with 10+ tools schema
4. Provider returns response (may include multiple tool calls)
5. **All independent tool calls execute in parallel** via `Promise.all`
6. Each tool passes through permission system
7. Tool results added to message history
8. Loop continues until no more tool calls

### Memory System

- Memories persist across sessions in `~/.sc-agent/memory/memory.json`
- Agent auto-loads last 10 memories into system prompt
- Model can call `memory_read`/`memory_write` to manage context
- User commands: `/memory`, `/memory show <key>`, `/memory forget <key>`, `/memory clear`
- Default tags for categorization

### Shell Environment Auto-Detection

- Detects: cmd, PowerShell, Git Bash, WSL, native Linux
- Injects platform-specific tips into system prompt
- Adapts tool usage guidance dynamically

### Configuration Hierarchy

1. Built-in defaults
2. Global config (`~/.sc-agent/config.json`)
3. Project config (`.sc-agent.json`)
4. Active profile overrides
5. Environment variables (SC_API_KEY, SC_MODEL, SC_BASE_URL, SC_PROFILE)

### Permission System

- Read-only tools (read_file, list_dir, search_text, web_fetch, memory_read) auto-approved
- Mutating tools (write_file, edit_file, run_shell, git, memory_write) require permission
- Blacklist profile: only dangerous commands ask (rm, sudo, del, etc.)
- Session tracking: "Ask once" mode remembers per session
- User can override with `-y` flag (auto-approve all)

### Error Recovery & Classification

- Errors classified into: compatibility, blocking, expectable
- Loop detection: detects repeated errors to prevent infinite loops
- Auto-retry with alternative approaches suggested
- Three failed attempts → alert user
- **Zero-mutation completion guard**: in unattended runs (`-y`/`--permissions unlimited`), a mutation-scoped prompt cannot end its turn with zero mutating tool calls — the agent re-prompts up to `SC_ZERO_MUTATION_REPROMPTS` times (default 2, 0 disables), honoring explicit no-change verdicts and real worktree deltas

### Long-Running Execution (100+ iterations)

- **Token tracking**: `TokenTracker` class estimates input/output tokens via chars/4 heuristic; tracks per-session totals; configurable model cost map
- **Message compression**: `compressOldMessages()` compresses old tool outputs to structured summaries (keeps `keepRecentCount=30` intact) before pruning, enabling far more iterations within the context window
- **Checkpoint auto-save**: Agent state saved every 5 iterations to `~/.sc-agent/checkpoints/` for crash recovery; supports `/checkpoint save` + `/checkpoint list`
- **HUD fields**: `tokens` (est. tokens + cost), `iterations` (counter), `cost` (dollar estimate) available via `/hud fields`
- **`limitMessageHistory`**: Max increased from 60 → 80 to accommodate longer runs
- **Auto-compress tool results**: Tool outputs >10KB auto-compressed before entering history
- **Memory monitoring**: Heap usage checked every 10 iterations; warning at 80% usage
- **Smart re-prompting**: Self-heal prompts include list of failed tools and "try a DIFFERENT approach" instructions
- **Pagination**: `read_file` supports `offset` + `limit` for partial file reads

### Phase 3 — Robusteza (Edge Cases & Hardening)

- **`deepMerge` cycle detection**: Uses `WeakSet` to track visited objects; throws on circular references in config
- **URL validation**: `validateConfig` + `provider.ts` validate `baseUrl` with `new URL()` before use
- **`collectFiles` depth limit**: Max 20 directory depth to prevent stack overflow on deeply nested trees
- **`unlinkSync` error propagation**: Logs warning with error message instead of silent catch during cleanup
- **`web-fetch` redirect limit**: `redirect: 'manual'` with counter (max 10), prevents infinite redirect loops
- **`edit-file` error distinction**: Distinguishes malformed patch (missing `@@` headers) from content mismatch; shows first 10 lines of patch on failure
- **Sensitive key redaction**: Expanded key patterns (25+ keys: `passwd`, `accessToken`, `refreshToken`, `jwt`, `sshKey`, `credentials`, etc.)
- **History persistence warnings**: All silent catch blocks for history/input persistence now show yellow warning on failure

### Phase 4 — Long-Running Execution (Token Tracking, Compression, Checkpointing)

- **Token tracker** (`src/utils/token-tracker.ts`): Estimates input/output tokens using chars/4 heuristic; tracks per-run totals; configurable per-model cost mapping for cost estimation (`gpt-4o`, `claude-sonnet-4-6`, etc.)
- **Message compression** (`compressOldMessages` in `agent.ts`): Replaces old tool outputs with structured summaries (first N chars + compression notice) instead of dropping them; keeps `keepRecentCount=30` pairs intact; far more token-efficient than the old truncation approach
- **Execution checkpointing** (`src/utils/checkpoint.ts`): Saves full agent state (history, iterations, toolRunCount) every 5 iterations to `~/.sc-agent/checkpoints/`; supports `/checkpoint save` and `/checkpoint list` commands; crash recovery via `findLatestCheckpoint()` matching workspace root
- **Improved message pruning**: `limitMessageHistory` max increased from 60 → 80; `compressOldMessages` runs before `pruneMessageHistory` to compress before potentially dropping messages
- **HUD fields**: Added `tokens` (estimated token usage + cost), `iterations` (iteration counter), `cost` (estimated dollar cost); all configurable via `/hud fields`
- **`/checkpoint` command**: Manual save/list checkpoints alongside auto-save every 5 iterations
- **Auto-compress tool results**: Tool outputs >10KB auto-compressed to structured summary (first 5K + last 3K) before entering message history, preventing context window saturation
- **Memory monitoring**: Heap usage checked every 10 iterations; yellow warning when >80% of available heap used
- **Smart re-prompting**: Self-heal prompts include list of failed tools, recent error summaries, and explicit instruction to "try a DIFFERENT approach" — breaking retry loops
- **Pagination support**: `read_file` now accepts `offset` (line number) and `limit` (max lines) for partial reads of large files; auto-appends line count context with hint to read next chunk

## Competitive Advantages

| Feature | sc-agent-cli | Claude Code | Copilot CLI | Aider |
|---------|-------------|-------------|-------------|-------|
| Provider agnostic | ✅ (any API) | ❌ (Anthropic) | ❌ (OpenAI) | ✅ (any) |
| Web fetch tool | ✅ (native) | ❌ | ❌ | ❌ |
| Git tool | ✅ (native) | ✅ | ❌ | ❌ |
| Persistent memory | ✅ (cross-session) | ❌ | ❌ | ❌ |
| Parallel tool exec | ✅ (Promise.all) | ❌ | ❌ | ❌ |
| Smart permissions | ✅ (3 profiles) | ❌ (binary) | ❌ | ❌ |
| Cross-platform | ✅ (Win/Mac/Linux/WSL) | ❌ (Mac/Linux) | ❌ (Mac/Linux) | ✅ |
| Local models | ✅ (Ollama first) | ❌ | ❌ | ✅ |
| Shell env detection | ✅ (auto) | ❌ | ❌ | ❌ |
| Storage management | ✅ (limits/cleanup) | ❌ | ❌ | ❌ |
| Error classification | ✅ (3 categories) | ❌ | ❌ | ❌ |

## Build and Test

```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript
npm run dev       # Watch mode
npm link          # Install globally
sc-agent          # Run the CLI
```

## Common Tasks

### Adding a New Tool

1. Create `src/tools/my-tool.ts` implementing the `Tool` interface
2. Add to `src/tools/registry.ts` in `ALL_TOOLS` array
3. Auto-approve in `src/core/config.ts` if read-only
4. Rebuild: `npm run build`

### Adding a New Command

1. Create `src/commands/my-command.ts`
2. Import and register in `src/cli.ts`
3. Add to autocomplete in `src/utils/autocomplete.ts`
4. Update /help in `src/commands/chat-session.ts`
5. Rebuild: `npm run build`

### Testing with Different Providers

```bash
# Ollama (local - default)
sc-agent profile use ollama

# OpenAI
sc-agent profile use openai

# Custom
sc-agent profile add my-custom
sc-agent profile use my-custom
```

## Dependencies

- **chalk**: Terminal colors
- **commander**: CLI framework
- **diff**: Unified diff patching
- **fast-glob**: Fast file globbing
- **ignore**: .gitignore-style pattern matching
- **prompts**: Interactive prompts

## Notes

- Uses native `fetch` (Node 18+), no external HTTP library needed
- Streaming is done via `ReadableStream` (Web Streams API)
- Cross-platform shell execution uses `spawn({ shell: true })`
- No external AI SDK dependencies (direct API calls)
