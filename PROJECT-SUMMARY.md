# SC-Agent CLI - Project Summary

## What This Project Solves

**Problem**: Using AI agents (like Claude Code) requires either:

1. A subscription to a specific service (cost + vendor lock-in)
2. Using API keys that may have unpredictable usage limits
3. No control over which model/provider you use

**Solution**: SC-Agent CLI is a **provider-agnostic** AI agent that:

- Works with **any OpenAI-compatible API** (Ollama, OpenAI, Anthropic via proxy, etc.)
- Runs **locally** with free models (Ollama) or use your own API keys
- Gives you **full control** over configuration, permissions, and costs
- Is **open-source** and easily extensible

## Key Differentiators

### vs. Claude Code

| Feature            | Claude Code                     | SC-Agent CLI                          |
|--------------------|---------------------------------|---------------------------------------|
| Provider           | Claude only                     | Any OpenAI-compatible API             |
| Cost               | Subscription required           | Free (local) or bring your own key    |
| Offline use        | No                              | Yes (with Ollama)                     |
| Customization      | Limited                         | Full source code access               |
| Platform support   | Mac, Windows, Linux, Web        | Mac, Windows, Linux                   |

### vs. Other CLI Agents

- **Aider**: Git-focused, Python-based — SC-Agent is general-purpose, Node-based
- **ChatGPT CLI**: No tool use — SC-Agent has file ops, search, shell execution
- **Custom scripts**: One-off, hard to extend — SC-Agent has a plugin architecture

## Architecture Highlights

```
User Input → CLI (Commander.js)
  ↓
Agent (ReAct loop)
  ↓
Provider (OpenAI-compatible client) → LLM API (Ollama/OpenAI/etc.)
  ↓
Tools (6 built-in, extensible)
  ↓
Filesystem / Shell
```

**Core Loop** (ReAct pattern):

1. **Reason**: Send message + tool schemas to model
2. **Act**: Model decides which tools to call
3. **Observe**: Execute tools (with permission checks)
4. **Repeat**: Add results to history, loop until done

## Technical Stack

- **TypeScript**: Strict mode for type safety
- **Node.js 20+**: Native fetch, no external HTTP library
- **Commander.js**: CLI framework
- **Streaming**: Server-Sent Events for real-time responses
- **Cross-platform**: Works on Windows, Linux, macOS

## Security Model

- **Sandboxing**: All file operations restricted to workspace root
- **Deny patterns**: Block sensitive files (`.env`, `*.key`, etc.)
- **Permission system**: Explicit approval for mutating operations
- **Auto-approve**: Optional for trusted tools

## Installation & Usage

```bash
# Install
npm install && npm run build && npm link

# Configure (first time)
sc config-init

# Use with Ollama (local, free)
ollama pull llama3.2
sc profile use ollama
sc

# Use with OpenAI
# Edit ~/.sc/config.json with your API key
sc profile use openai
sc
```

## Project Structure

```
sc-cli/
├── src/
│   ├── cli.ts                 # Entry point
│   ├── commands/              # CLI commands (chat, profile, init)
│   ├── core/                  # Agent, provider, config, types
│   ├── tools/                 # Built-in tools (read, write, edit, list, search, shell)
│   └── utils/                 # Permissions, path security
├── docs/                      # Additional documentation
├── bin/sc.js            # Executable entry point
├── package.json               # Dependencies & scripts
├── tsconfig.json              # TypeScript config
└── README.md                  # Main documentation
```

## Documentation Index

1. **README.md**: Main documentation (features, installation, usage)
2. **QUICKSTART.md**: 5-minute start guide
3. **INSTALL.md**: Detailed installation instructions
4. **ARCHITECTURE.md**: Technical deep dive (diagrams, data flow, design decisions)
5. **AGENTS.md**: Project context for the agent itself (dogfooding)
6. **CONTRIBUTING.md**: How to contribute (adding tools, commands, providers)
7. **FAQ.md**: Common questions and troubleshooting
8. **docs/anthropic-setup.md**: Using Claude models via proxy
9. **EXAMPLES.md**: Usage examples (currently minimal)

## Supported Providers

Any **OpenAI-compatible** endpoint:

- **Ollama** (local, free): llama3, mistral, codellama, qwen2.5-coder, etc.
- **OpenAI**: gpt-4o, gpt-4-turbo, gpt-3.5-turbo
- **Anthropic** (via LiteLLM proxy): claude-sonnet-4-6, claude-opus-4
- **Groq**: llama3-70b, mixtral-8x7b
- **Together**: various open models
- **OpenRouter**: unified gateway to 100+ models
- **vLLM**: self-hosted LLMs
- **LM Studio**: local model server

## Tools (Built-in)

| Tool          | Description                        | Permission Required |
|---------------|------------------------------------|---------------------|
| `read_file`   | Read file contents                 | Auto-approved       |
| `write_file`  | Create or overwrite files          | Yes                 |
| `edit_file`   | Apply unified diff patches         | Yes                 |
| `list_dir`    | List directory contents            | Auto-approved       |
| `search_text` | Search text with glob patterns     | Auto-approved       |
| `run_shell`   | Execute shell commands             | Yes                 |

**Extensible**: Easy to add custom tools (see CONTRIBUTING.md).

## Use Cases

1. **Codebase exploration**: "What does this project do?"
2. **Code generation**: "Add a function to calculate Fibonacci"
3. **Refactoring**: "Extract this logic into a separate file"
4. **Documentation**: "Generate a README for this module"
5. **Debugging**: "Find all TODO comments in this directory"
6. **Shell automation**: "Run tests and show me failures"

## Roadmap Ideas

- [ ] Multi-turn conversation persistence (save/load sessions)
- [ ] Parallel tool execution (when safe)
- [ ] Plugin system (load tools from npm packages)
- [ ] Web UI (Electron or browser-based)
- [ ] Native Anthropic Messages API support
- [ ] Automated testing suite
- [ ] Performance profiling

## Why This Matters

**Freedom from vendor lock-in**: You're not dependent on:

- A specific subscription service
- A single API provider
- Opaque usage limits
- Pricing changes

**Local-first option**: Run Ollama locally for:

- **Zero cost** after initial setup
- **Offline capability** (no internet required)
- **Privacy** (data never leaves your machine)
- **Full control** (no rate limits, no censorship)

**Educational value**: Clean, readable codebase to:

- Learn how AI agents work
- Understand ReAct pattern
- See streaming API integration
- Study tool-use implementation

## License

MIT — free to use, modify, and distribute.

## Credits

- **Author**: Sergio Canales
- **Co-Author**: Claude Sonnet 4.5 (this project was built with Claude Code, then ported to be provider-agnostic)

## Final Thoughts

This project embodies the principle of **tool independence**: don't let your productivity depend on a single vendor. By building on open standards (OpenAI-compatible API format), you gain:

1. **Portability**: Switch providers in minutes
2. **Cost control**: Use local models or shop for best API pricing
3. **Resilience**: If one provider has an outage, use another
4. **Privacy**: Keep sensitive work local with Ollama

The future of AI tools is **interoperable**, not siloed. SC-Agent CLI is a step in that direction.
