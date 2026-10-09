# Keyboard Shortcuts

Quick reference for keyboard shortcuts and helpful commands in SC CLI.

## Visual Guide

Every time you're about to type a message, you'll see a helpful hint line:

```
↑↓:history │ Ctrl+C:exit │ /help:commands │ /permissions:setup │ /pre-approved:quick-setup
┌─ You ─────────────────────────────────────────────────────┐
│ hello, how can you help?
└───────────────────────────────────────────────────────────┘
```

The hint line appears **before** your input box, reminding you of available shortcuts and commands.

---

## Keyboard Shortcuts

### ↑ / ↓ (Arrow Keys)

**Navigate through your message history**

Just like in bash/terminal:
- **↑** (Up Arrow) - Previous message
- **↓** (Down Arrow) - Next message

**Example:**
```
You: create a new component
[Press ↑]
You: create a new component  ← Your last message appears
```

Useful for:
- Repeating similar commands
- Editing previous prompts
- Avoiding retyping

---

### Ctrl+C

**Exit the chat session immediately**

Quick way to exit without typing "exit" or "quit".

**Example:**
```
You: working on something...
[Press Ctrl+C]

╔════════════════════════════════════════════════════════════╗
  👋 Goodbye!
╚════════════════════════════════════════════════════════════╝
```

**Alternative ways to exit:**
- Type `exit`
- Type `quit`

---

## Quick Commands

### /help

**Show all available commands**

```
You: /help

📖 Available Commands:

  /help                          - Show this help message
  /model                         - Switch to a different model
  /permissions                   - Configure permission mode
  /pre-approved-commands         - Setup pre-approved commands via interview
  /storage                       - Show storage usage and cleanup options
  /reload                        - Reload configuration from disk
  /clear                         - Clear conversation history
  /info                          - Show current model and config
  exit, quit                     - End the chat session

💡 Tools Available:

  • read_file     - Read file contents
  • write_file    - Create/overwrite files
  • edit_file     - Apply diffs to files
  • list_dir      - List directory contents
  • search_text   - Search text in files
  • run_shell     - Execute shell commands
```

---

### /permissions

**Configure how permissions work**

Quick access to permission modes:

```
You: /permissions

? Select permission mode: › - Use arrow-keys. Return to submit.
❯   Ask once per tool (recommended)
    Always ask (safer)
    Unlimited (dangerous)
```

**Modes:**
- **Ask once** (recommended) - Prompt first time, remember for session
- **Always ask** (safer) - Prompt every time
- **Unlimited** (dangerous) - Never ask

See [permissions-command.md](permissions-command.md) for details.

---

### /pre-approved

**Quick setup for auto-approved tools**

Interactive interview to configure which tools auto-approve:

```
You: /pre-approved

📋 Pre-Approved Commands Interview

√ Allow reading files and listing directories? ... yes
  ✓ Added: read_file, list_dir, search_text

√ Allow writing/editing files in this directory? ... no

√ Allow executing shell commands (non-admin)? ... yes
  ✓ Added: run_shell

✓ Configuration saved
```

See [pre-approved-commands.md](pre-approved-commands.md) for scenarios.

---

## Additional Commands

### /model

Switch to a different model without restarting:

```
You: /model

? Select a model profile:
❯ ollama (current) - llama3.2
  openai - gpt-4o
  nvidia - meta/llama-3.3-70b-instruct

✓ Switched to: nvidia
```

---

### /storage

Check storage usage and cleanup:

```
You: /storage

💾 Storage Usage:

  Current:   450.23 MB
  Limit:     1.00 GB
  Usage:     45.0%
  Directory: ~/.sc-agent

✓ Storage usage is healthy
```

---

### /reload

Reload configuration without restarting:

```
You: /reload

♻️  Reloading configuration...

✓ Configuration reloaded successfully!
  Active profile: nvidia
  Model: meta/llama-3.3-70b-instruct
```

---

### /clear

Clear conversation history:

```
You: /clear

✓ Conversation history cleared
```

Useful when:
- Starting a new topic
- Context is getting too long
- Want a fresh start

---

### /info

Show current configuration:

```
You: /info

📊 Current Configuration:

  Profile:     nvidia
  Model:       meta/llama-3.3-70b-instruct
  Provider:    https://integrate.api.nvidia.com/v1
  Temperature: 0.7
  Max Tokens:  4096
  Permissions: Ask once per tool
  Auto-approve: read_file, list_dir, search_text
  Storage:     450.23 MB / 1.00 GB (45.0%)
  History:     12 messages
```

---

## Tips

### Use Tab Completion (Not Yet Implemented)

Currently commands must be typed fully. Tab completion is planned for future releases.

---

### Combine Shortcuts

1. **↑** to recall previous command
2. Edit it
3. **Enter** to send
4. **Ctrl+C** when done

---

### Command History Persists

Your message history stays during the entire session. It resets when you:
- Exit the chat
- Use `/clear`

Commands (starting with `/`) are **not** added to history.

---

## Common Workflows

### Quick Permission Setup

```
1. Start chat: scc
2. Type: /pre-approved
3. Answer questions
4. Start working
```

---

### Switch Models Mid-Session

```
1. Press ↑ to recall last prompt
2. Type: /model
3. Select new model
4. Press ↑ again to recall prompt
5. Send same prompt to new model
```

---

### Clean Up After Long Session

```
1. Type: /storage
2. Check usage
3. Clean if needed
4. Type: /clear (clear chat history)
5. Continue working
```

---

## Platform-Specific Notes

### Windows (PowerShell)

All shortcuts work as documented.

---

### WSL / Linux

All shortcuts work as documented.

---

### macOS

All shortcuts work as documented.

Note: On macOS, Ctrl+C works the same as on other platforms.

---

## Troubleshooting

### Arrow keys don't work

**Problem:** ↑↓ don't navigate history

**Solution:** This is a Node.js readline feature and should work automatically. If not:
- Make sure you're using Node.js 20+
- Try restarting your terminal

---

### Ctrl+C doesn't exit cleanly

**Problem:** Session doesn't exit or shows errors

**Solution:**
- Try typing `exit` instead
- Press Ctrl+C twice quickly
- Close the terminal window

---

### Commands not working

**Problem:** `/help` or other commands don't work

**Solution:**
- Make sure to include the `/` prefix
- Commands are case-insensitive: `/HELP` works
- Type exactly as shown (no spaces before `/`)

---

## See Also

- [README.md](../README.md) - Main documentation
- [permissions-command.md](permissions-command.md) - Permission modes
- [pre-approved-commands.md](pre-approved-commands.md) - Setup wizard
- [visual-improvements.md](visual-improvements.md) - UI design
