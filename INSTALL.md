# Installation Guide

## Prerequisites

- **Node.js** >= 20.0.0 (tested on 20, 22, 24, and 26 — see `engines` in `package.json`)
- **npm** or **yarn**

Check your Node version:

```bash
node --version  # Should be >= 20.0.0
```

If you need to upgrade Node, download it from [nodejs.org](https://nodejs.org) or use a version manager like [nvm](https://github.com/nvm-sh/nvm).

## Step 1: Install Dependencies

```bash
cd sc-cli
npm install
```

## Step 2: Build the Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

## Step 3: Link Globally (Optional)

To make the `sc` command available system-wide:

```bash
npm link
```

Or, if you prefer to run it locally:

```bash
node bin/sc.js
```

Or add an alias to your shell config:

```bash
# In ~/.bashrc or ~/.zshrc
alias sc='node /d/git/sc-cli/bin/sc.js'
```

## Step 4: Initialize Configuration

```bash
sc config-init
```

This creates `~/.sc-agent/config.json` with default profiles (Ollama, OpenAI, Anthropic).

## Step 5: Configure Your Model

Edit `~/.sc-agent/config.json` or use the CLI to set up your preferred provider:

### Using Ollama (local)

1. Install and start Ollama: https://ollama.com
2. Pull a model: `ollama pull llama3.2`
3. Use the profile:

```bash
sc profile use ollama
```

### Using OpenAI

```bash
sc profile use openai
```

Then edit `~/.sc-agent/config.json` and replace `<YOUR_OPENAI_KEY>` with your actual API key.

### Using a custom endpoint

```bash
sc profile add my-model
# Enter the base URL, model name, and API key (if needed)
sc profile use my-model
```

## Step 6: Start Chatting

```bash
sc
```

Type `exit` or `quit` to end the session.

## Troubleshooting

### TypeScript compilation errors

Make sure you have TypeScript installed:

```bash
npm install -D typescript
```

### Permission denied when running `sc`

Make the bin file executable:

```bash
chmod +x bin/sc.js
```

### "Cannot find module" errors after build

Make sure you ran `npm run build` and check that the `dist/` directory exists with compiled `.js` files.

### Ollama connection refused

Make sure Ollama is running:

```bash
ollama serve
```

By default, Ollama listens on `http://localhost:11434`.

## Development Mode

To auto-recompile on file changes:

```bash
npm run dev
```

Then in another terminal:

```bash
node bin/sc.js
```

## Uninstalling

```bash
npm unlink  # If you used npm link
rm -rf ~/.sc  # Remove global config
cd ..
rm -rf sc-cli
```
