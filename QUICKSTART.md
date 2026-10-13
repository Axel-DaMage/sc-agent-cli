# Quick Start Guide

Get up and running with SC-Agent CLI in 5 minutes.

## Prerequisites

- Node.js >= 20.0.0
- A running LLM endpoint (Ollama, OpenAI, or any OpenAI-compatible API)

## Installation

```bash
cd sc-cli
npm install
npm run build
npm link
```

## First Run

### Option 1: Ollama (easiest for local testing)

1. Install Ollama: https://ollama.com
2. Start Ollama and pull a model:
   ```bash
   ollama pull llama3.2
   ```
3. Initialize and run:
   ```bash
   sc config-init
   sc profile use ollama
   sc
   ```

### Option 2: OpenAI

1. Get an API key from https://platform.openai.com
2. Initialize config:
   ```bash
   sc config-init
   ```
3. Edit `~/.sc-agent/config.json` and replace `<YOUR_OPENAI_KEY>` with your actual key
4. Run:
   ```bash
   sc profile use openai
   sc
   ```

### Option 3: Custom Endpoint

```bash
sc config-init
sc profile add my-model
# Enter your base URL, model name, and API key
sc profile use my-model
sc
```

## Try It Out

Once the chat session starts, try these commands:

```
You: list files in this directory
You: read the README.md file
You: search for the word Agent in all TypeScript files
You: what is this project about?
```

Type `exit` or `quit` to end the session.

## Next Steps

- Read [README.md](README.md) for full documentation
- See [INSTALL.md](INSTALL.md) for detailed installation instructions
- Check [EXAMPLES.md](EXAMPLES.md) for usage examples
- Read [AGENTS.md](AGENTS.md) to understand the codebase

## Troubleshooting

### "Cannot find module" errors

Make sure you ran `npm run build`:

```bash
npm run build
```

### Permission prompts on every file read

This is normal! The agent asks for permission before sensitive operations. To auto-approve safe tools:

```bash
sc chat -y  # Auto-approve all (use with caution)
```

Or edit `~/.sc-agent/config.json` and add tools to `permissions.autoApprove`.

### Connection refused (Ollama)

Make sure Ollama is running:

```bash
ollama serve
```

### API key errors (OpenAI)

Check that you replaced `<YOUR_OPENAI_KEY>` in `~/.sc-agent/config.json` with your actual API key.

## Need Help?

Open an issue on GitHub or check the documentation files in this project.
