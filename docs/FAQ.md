# Frequently Asked Questions

## General

### What is SC-Agent CLI?

A provider-agnostic AI agent CLI that works with any OpenAI-compatible API (Ollama, OpenAI, Anthropic via proxy, Groq, Together, etc.). It provides file operations, text search, and shell execution through a conversational interface.

### Why use this instead of Claude Code or Aider?

- **No subscription**: Use your own API keys or local models
- **Provider flexibility**: Switch between providers without changing code
- **Transparency**: Full control over permissions and configuration
- **Extensibility**: Easy to add custom tools or commands

### Is this better than Claude Code?

Not necessarily "better" — different goals. Claude Code is a polished product with many features. SC-Agent CLI is:

- More flexible (any provider)
- More transparent (you control everything)
- Simpler (focused on core agent loop + tools)
- Educational (readable codebase to learn from)

Use Claude Code if you want a complete product. Use SC-Agent CLI if you want control and customization.

## Installation & Setup

### What Node version do I need?

Node.js >= 20.0.0. CI tests the suite on Node 20, 22, 24, and 26 (`engines` in `package.json` sets the floor).

Check with:

```bash
node --version
```

### Can I use this without internet?

Yes, if you use a local model like Ollama:

```bash
ollama pull llama3.2  # Download model once
ollama serve          # Start Ollama locally
sc-agent profile use ollama
sc-agent              # Works offline
```

### Where are my config files stored?

- **Global config**: `~/.sc-agent/config.json`
- **Project config**: `.sc-agent.json` (in project root)

### How do I reset my configuration?

```bash
rm -rf ~/.sc-agent
sc-agent config-init
```

## Usage

### How do I stop the agent from asking for permission every time?

Edit `~/.sc-agent/config.json` and add tools to `autoApprove`:

```json
{
  "permissions": {
    "autoApprove": ["read_file", "write_file", "list_dir", "search_text"]
  }
}
```

Or run with `-y` flag (auto-approve all):

```bash
sc-agent chat -y
```

**Warning**: Only auto-approve if you trust the model completely!

### How do I prevent the agent from accessing certain files?

Edit `denyPaths` in your config:

```json
{
  "permissions": {
    "denyPaths": [".env", ".env.*", "**/*.key", "**/*.pem", "secrets/**"]
  }
}
```

### Can I use this in a CI/CD pipeline?

Not recommended for interactive use in CI. But you could:

1. Run with `-y` for auto-approve
2. Pipe input via stdin (not currently supported, but easy to add)
3. Use it as a library (import the `Agent` class)

### How do I save conversations?

Not currently supported. Conversations exist only in memory for the session. Future enhancement.

### Can I run multiple agents in parallel?

Not in the current design (single-threaded event loop). You could run multiple instances in different terminals.

## Models & Providers

### Which models are supported?

Any model with an OpenAI-compatible `/v1/chat/completions` endpoint:

- **Ollama**: llama3, mistral, codellama, etc.
- **OpenAI**: gpt-4o, gpt-4-turbo, gpt-3.5-turbo
- **Anthropic**: claude-* (via LiteLLM proxy)
- **Groq**: llama3, mixtral, etc.
- **Together**: various open models
- **OpenRouter**: unified gateway to 100+ models
- **vLLM**: self-hosted LLMs

### How do I use Claude models?

See [docs/anthropic-setup.md](anthropic-setup.md) for detailed instructions. Short version:

```bash
pip install litellm
export ANTHROPIC_API_KEY="sk-ant-..."
litellm --model anthropic/claude-sonnet-4-6 --port 8000

# In another terminal
sc-agent profile add anthropic
# Base URL: http://localhost:8000/v1
# Model: anthropic/claude-sonnet-4-6
sc-agent profile use anthropic
sc-agent
```

### How do I use OpenAI?

```bash
sc-agent config-init
# Edit ~/.sc-agent/config.json and replace <YOUR_OPENAI_KEY>
sc-agent profile use openai
sc-agent
```

### Can I use GPT-3.5 instead of GPT-4?

Yes, edit the profile in `~/.sc-agent/config.json`:

```json
{
  "profiles": {
    "openai": {
      "model": "gpt-3.5-turbo"
    }
  }
}
```

### Do I get charged for using OpenAI?

Yes, if you use an `api.openai.com` endpoint with your API key, you'll be charged per token by OpenAI. Check [OpenAI's pricing](https://openai.com/pricing).

Local models (Ollama) are free.

### Which local models work best?

For coding tasks:

- **llama3.2** (or llama3): Good balance of speed and quality
- **codellama**: Specialized for code
- **mistral**: Fast and capable
- **qwen2.5-coder**: Strong code understanding

For general chat:

- **llama3**: Well-rounded
- **phi3**: Smaller, faster

## Tools

### What tools are available?

- **read_file**: Read file contents
- **write_file**: Create or overwrite files
- **edit_file**: Apply unified diff patches
- **list_dir**: List directory contents
- **search_text**: Search text with glob patterns (e.g., `**/*.ts`)
- **run_shell**: Execute shell commands

### How do I add a custom tool?

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-new-tool) for details. Short version:

1. Create `src/tools/my-tool.ts`
2. Implement the `Tool` interface
3. Add to `src/tools/registry.ts`
4. Rebuild: `npm run build`

### Can the agent delete files?

Not by default (no `delete_file` tool). You could add one, but it's intentionally excluded for safety.

The agent can use `run_shell` with `rm` commands, but that requires permission.

### Can the agent access the internet?

Not directly. You could add a `fetch_url` tool or use `run_shell` with `curl`. Currently not included.

## Troubleshooting

### "Cannot find module" errors

Run:

```bash
npm run build
```

### Permission errors when running `sc-agent`

Make sure the bin file is executable:

```bash
chmod +x bin/sc-agent.js
```

Or run directly:

```bash
node bin/sc-agent.js
```

### "Connection refused" errors

- **Ollama**: Make sure it's running (`ollama serve`)
- **Custom endpoint**: Check the base URL and port
- **OpenAI**: Check your internet connection

### Tool calls not working

Check that your model supports function calling. Not all models do. Known to work:

- OpenAI: gpt-4, gpt-3.5-turbo
- Ollama: llama3, mistral, qwen2.5-coder (with recent Ollama versions)
- Anthropic: All Claude models

If your model doesn't support function calling, it will try to respond in plain text instead of calling tools.

### Streaming stops mid-response

Could be:

- Model timeout (increase in provider settings)
- Network interruption
- Model hit token limit (increase `maxTokens` in config)

### Agent gets stuck in a loop

The agent has a `MAX_ITERATIONS` limit (default: 10). If it hits this, it stops and shows a warning.

This can happen if:

- Tool keeps failing but agent retries
- Model is confused about what to do next

Try rephrasing your request or approving a failed tool manually.

## Development

### How do I run in watch mode?

```bash
npm run dev
```

### How do I debug TypeScript compilation errors?

```bash
npx tsc --noEmit
```

### Can I publish this to npm?

Yes! Update `package.json` with your details and:

```bash
npm publish
```

### Can I bundle this as a standalone binary?

Yes, using tools like `pkg` or `nexe`:

```bash
npm install -g pkg
pkg package.json
```

This creates a single executable with Node + your code bundled.

## Licensing & Usage

### What license is this?

MIT License — free to use, modify, and distribute.

### Can I use this commercially?

Yes, the MIT license allows commercial use.

### Can I fork and modify?

Yes! See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

### How do I report bugs?

Open an issue on GitHub (or wherever this project is hosted).

## Comparison with Other Tools

### vs. Claude Code

- **Claude Code**: Polished product, subscription-based, tightly integrated with Claude
- **SC-Agent CLI**: Open-source, provider-agnostic, customizable

### vs. Aider

- **Aider**: Git-focused, advanced refactoring, Python-based
- **SC-Agent CLI**: General-purpose agent, Node-based, simpler architecture

### vs. Cursor

- **Cursor**: Full IDE with AI features, proprietary
- **SC-Agent CLI**: CLI-only, open-source, bring your own editor

### vs. ChatGPT CLI tools

- **ChatGPT CLI**: Chat-only, no tool use (usually)
- **SC-Agent CLI**: Full agent with file ops, shell, search

## Future Roadmap

### Will you add feature X?

Maybe! Check [ARCHITECTURE.md](../ARCHITECTURE.md#roadmap-ideas) for planned features. Open an issue to discuss.

### Can I contribute?

Absolutely! See [CONTRIBUTING.md](../CONTRIBUTING.md).

### Will there be a GUI?

Not planned in the core project, but could be added as a separate package (Electron, web UI, etc.).

## Still have questions?

- Read the full [README.md](../README.md)
- Check [ARCHITECTURE.md](../ARCHITECTURE.md) for technical details
- Open an issue on GitHub
