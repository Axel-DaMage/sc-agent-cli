# SC-Agent CLI

A provider-agnostic CLI agent with tool use, compatible with **any OpenAI-compatible API** (OpenAI, Ollama, LM Studio, Anthropic via proxy, Groq, Together, OpenRouter, vLLM, etc.).

No dependency on a specific subscription or provider — configure your preferred model and endpoint, and you're ready to go.

## Features

- **Multi-provider support**: Works with any OpenAI-compatible API endpoint
- **Tool use**: File reading/writing, directory listing, text search, shell command execution
- **Permission system**: Configurable auto-approval for safe tools, explicit permission for sensitive operations
- **Profile management**: Easily switch between models and providers
- **Project context**: Loads `AGENTS.md` / `SC-AGENT.md` / `CLAUDE.md` for project-specific instructions
- **Non-interactive mode**: Accept prompts as CLI parameters for automation and scripting
- **Cross-platform**: Works on Windows, Linux, and macOS

## Installation

Requires **Node.js >= 20.0.0** (tested on 20, 22, 24, and 26).

```bash
cd sc-cli
npm install
npm run build
npm link  # Makes 'sc' available globally
```

## Quick Start

### 1. Initialize configuration (first time only)

```bash
sc config-init
```

This creates `~/.sc-agent/config.json` with default profiles (Ollama, OpenAI, Anthropic).

### 2. Configure your preferred model

Edit `~/.sc-agent/config.json` or use the CLI:

```bash
# List available profiles
sc profile list

# Add a custom profile
sc profile add my-model

# Switch to a profile
sc profile use ollama
```

**Example profiles:**

- **Ollama (local):**
  ```json
  {
    "baseUrl": "http://localhost:11434/v1",
    "model": "llama3.2"
  }
  ```

- **OpenAI:**
  ```json
  {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4o"
  }
  ```

- **Anthropic (via OpenAI-compatible proxy like LiteLLM):**
  ```json
  {
    "baseUrl": "http://localhost:8000/v1",
    "model": "claude-sonnet-4-6"
  }
  ```

### 3. Start chatting

```bash
sc chat
```

Or just:

```bash
sc
```

The agent will maintain conversation context and can use tools to help you with your project.

## Commands

### `sc chat [prompt]` (default)

Start an interactive chat session, or run a single prompt non-interactively.

**Options:**

- `-y, --yes`: Auto-approve all tool executions (use with caution)
- `-q, --quiet`: Suppress UI decorations (for non-interactive use)

**Examples:**

```bash
# Interactive mode
sc chat

# Non-interactive mode
sc "summarize README.md"

# Non-interactive with auto-approve
sc -y "create a file test.txt with content 'Hello World'"

# Fully automated (quiet + auto-approve)
sc -yq "count .ts files in src/"
```

**Chat Commands:**

During a chat session, you can use these commands:

- `/help` - Show available commands and tools
- `/model` - Switch to a different model profile
- `/permissions` - Configure permission mode (ask once/always ask/unlimited)
- `/pre-approved-commands` - Interactive setup wizard for auto-approved tools
- `/reload` - Reload configuration from disk (apply profile changes)
- `/clear` - Clear conversation history
- `/info` - Show current model and configuration
- `exit` or `quit` - End the session

**Shell Commands:**

For quick profile reloading without restarting terminal:

- `reload` (PowerShell/WSL) - Reload shell profile and environment variables

### `sc profile <command>`

Manage model profiles:

- `list`: Show all profiles (5 pre-configured)
- `add [name]`: Add a new profile
- `use [name]`: Switch to a profile
- `remove [name]`: Delete a profile

**Pre-configured profiles:**

1. **ollama** - Llama 3.2 (local, free)
2. **openai** - GPT-4o (cloud, requires API key)
3. **anthropic** - Claude Sonnet 4.6 (cloud, requires API key + proxy)
4. **nvidia** - Nemotron 3 Ultra 550B (cloud, requires NVIDIA API key)
5. **llama-3.3-70b** - Meta Llama 3.3 70B Instruct (cloud, requires NVIDIA API key)

See [docs/available-models.md](docs/available-models.md) for detailed comparison.

### `sc init`

Initialize a project with a default `AGENTS.md` file for providing context to the agent.

Use `sc init --force` to overwrite an existing `AGENTS.md`.

### `sc config-init`

Create the global config file with default profiles.

## Project Context

The agent automatically loads project-specific context from:

1. `AGENTS.md`
2. `SC-AGENT.md`
3. `CLAUDE.md`

Create one of these files in your project root to provide:

- Project overview
- Key file structure
- Coding guidelines
- Build/test instructions
- Any other relevant context

**Performance optimization**: Context files are only loaded when queries contain project-related keywords (e.g., `file`, `code`, `test`, `build`, `function`, `class`, `api`, etc.). Conversational queries like "Hello" or "How are you?" skip context loading entirely. Context is cached in memory after first load to eliminate repeated file I/O.

## Available Tools

The agent has access to:

- **`read_file`**: Read file contents (auto-approved by default)
- **`write_file`**: Create or overwrite files (requires permission)
- **`edit_file`**: Apply unified diff patches (requires permission)
- **`list_dir`**: List directory contents (auto-approved by default)
- **`search_text`**: Search for text patterns with glob support (auto-approved by default)
- **`run_shell`**: Execute shell commands (requires permission)

## Security

- **Path validation**: All file operations are restricted to the workspace root
- **Deny patterns**: Configured patterns (e.g., `.env`, `*.key`) are blocked
- **Scrubbed child env**: Spawned commands (`run_shell`, MCP servers) get an allowlisted environment — provider credentials (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `SC_*`, …) never reach the child, and known secrets are masked (`***`) in shell output before it enters model context
- **Shell deny defaults**: `permissions.denyCommands` ships with rules blocking `cat .env`-style credential reads; `denyPaths` guards the file tools only — it does not constrain `run_shell` (see `docs/permission-profiles.md`)
- **Permission system**: Sensitive operations require explicit approval unless auto-approved
- **Auto-approve**: Safe read-only tools are auto-approved by default

### Quick Setup: Pre-Approved Commands Interview

Use the interactive wizard to quickly configure which tools can auto-approve:

```
You: /pre-approved-commands

√ Allow reading files and listing directories? ... yes
√ Allow writing/editing files in this directory? ... no
√ Allow executing shell commands (non-admin)? ... yes

✓ Configuration saved
```

This creates your `~/.sc-agent/config.json` automatically based on your use case.

See [docs/pre-approved-commands.md](docs/pre-approved-commands.md) for detailed scenarios.

### Manual Configuration

Or configure permissions manually in `~/.sc-agent/config.json` or `.sc-agent.json` (project-local):

```json
{
  "permissions": {
    "autoApprove": ["read_file", "list_dir", "search_text"],
    "denyPaths": [".env", ".env.*", "**/*.key", "**/*.pem"]
  }
}
```

## Configuration Hierarchy

1. **Defaults** (built into the CLI)
2. **Global config** (`~/.sc-agent/config.json`)
3. **Project config** (`.sc-agent.json` in project root)
4. **Active profile** (overrides model settings)
5. **Environment variables** (highest priority for API keys)

Project configs override global settings, the active profile overrides model configuration, and environment variables override API keys.

## Environment Variables

### API Keys

API keys can be provided via environment variables instead of hardcoding them in config files:

- **`SC_API_KEY`**: General API key (highest priority)
- **`OPENAI_API_KEY`**: OpenAI-specific key
- **`ANTHROPIC_API_KEY`**: Anthropic-specific key
- **`NVIDIA_API_KEY`**: NVIDIA-specific key

**Example:**

```bash
# Set for current session
export NVIDIA_API_KEY="nvapi-your-key-here"
sc profile use nvidia
sc

# Or inline
NVIDIA_API_KEY="nvapi-your-key-here" sc
```

**Priority order** (highest to lowest):
1. `SC_API_KEY` environment variable
2. Provider-specific env var (`OPENAI_API_KEY`, etc.)
3. API key in config file
4. No API key (for local models like Ollama)

### Behavior Configuration

- **`SC_MAX_ITERATIONS`**: Maximum agent iterations before stopping (default: `100`)
  ```bash
  # Allow up to 200 iterations for very complex tasks
  export SC_MAX_ITERATIONS=200
  scc chat
  
  # Or inline
  SC_MAX_ITERATIONS=50 scc chat
  ```

- **`SC_DEBUG_METRICS`**: Enable performance metrics logging (default: off)
  ```bash
  # Enable metrics to analyze context loading and self-heal behavior
  export SC_DEBUG_METRICS=1
  scc chat "fix the bug"
  
  # Output includes:
  # [METRICS] Context loading: LOADED/SKIPPED | Query length: 50 | Context size: 12044B
  # [METRICS] Self-heal: ACTIVATED/SKIPPED | Conversational: false | Short: false | Count: 1/10
  ```

## Examples

### Local development with Ollama

```bash
sc profile use ollama
sc
```

### Production with OpenAI

```bash
export OPENAI_API_KEY="sk-your-key-here"
sc profile use openai
sc
```

### NVIDIA Nemotron (Cloud)

```bash
export NVIDIA_API_KEY="nvapi-your-key-here"
sc profile use nvidia
sc
```

### Custom self-hosted model

```bash
sc profile add my-local
# Enter: http://localhost:8080/v1, my-model-name, (no API key)
sc profile use my-local
sc
```

## Development

```bash
npm run build   # Compile TypeScript
npm run dev     # Watch mode
npm run clean   # Remove dist/
```

## Troubleshooting

### Windows: `sc` command conflict

On Windows, `sc` is a built-in command for Service Control. Use one of these workarounds:

```bash
# Option 1: Use direct path
node bin/sc.js --help

# Option 2: Create alias (recommended)
alias scc='node bin/sc.js'
scc --help

# Option 3: Use npx
npx . chat
```

See [docs/windows-sc-conflict.md](docs/windows-sc-conflict.md) for detailed solutions.

### "Missing model.baseUrl in config"

Make sure you've run `sc config-init` or manually created the config file.

### "OpenAI API requires apiKey in config"

If using `api.openai.com`, you must provide an API key. For local models (Ollama, LM Studio), leave the `apiKey` empty or undefined.

### Permission denied for tool execution

The agent requires explicit permission for sensitive operations (write, edit, shell execution). Either:

1. Approve each request interactively
2. Add the tool to `autoApprove` in your config (use with caution)
3. Run with `sc chat -y` to auto-approve all (use only when you trust the agent completely)

## License

MIT
