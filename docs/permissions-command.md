# /permissions Command

Configure how the agent handles tool execution permissions during your chat session.

## Overview

The `/permissions` command allows you to switch between three permission modes on-the-fly without restarting your chat session.

```
You: /permissions

? Select permission mode: › - Use arrow-keys. Return to submit.
❯   Ask once per tool (recommended)
    Always ask (safer)
    Unlimited (dangerous)
```

---

## Permission Modes

### 1. Ask once per tool (recommended) ✅

**Default mode** - Balance between convenience and safety.

**How it works:**
- First time a tool is used → prompts you with 4 options
- If you select "Session (until exit)" → auto-approves that tool for the rest of the session
- Different tools still prompt independently

**Best for:**
- Normal development work
- Trusted local environments
- When you want control without repetition

**Example flow:**
```
Agent wants to run: list_dir

? Allow this action?
❯   Yes (once)
    Always (save to config)
    Session (until exit)    ← Select this
    No (deny)

✓ "list_dir" auto-approved for this session

[Later in the same session]
Agent wants to run: list_dir
[No prompt - automatically approved]

Agent wants to run: write_file
[Prompts again - different tool]
```

---

### 2. Always ask (safer) 🔒

**Maximum safety** - Prompt every single time.

**How it works:**
- Prompts for EVERY tool use, even if you approved it before
- No session memory - treats each request independently
- Clears any previously approved session permissions

**Best for:**
- Working with sensitive data
- Production environments
- When you want full control over every action
- Learning what the agent does step-by-step

**Example flow:**
```
Agent wants to run: list_dir
[Prompts]

Agent wants to run: list_dir (again)
[Prompts again - no memory]

Agent wants to run: list_dir (third time)
[Prompts again - always asks]
```

---

### 3. Unlimited (dangerous) ⚠️

**Zero friction** - Auto-approve everything.

**How it works:**
- Never prompts for permission
- All tools execute immediately
- Same as running with `-y` flag

**Best for:**
- Fully trusted agents
- Rapid iteration/testing
- Local development with no sensitive data
- When you understand the risks

**Warning:**
- Agent can modify any file
- Agent can run any shell command
- Agent can delete files
- Use with extreme caution!

**Example flow:**
```
Agent wants to run: list_dir
[No prompt - executes immediately]

Agent wants to run: write_file
[No prompt - writes immediately]

Agent wants to run: run_shell "rm -rf build/"
[No prompt - deletes immediately]
```

---

## Switching Modes Mid-Session

You can change permission modes at any time during a chat session:

```
You: /permissions

? Select permission mode:
❯   Ask once per tool (recommended)

✓ Permission mode: Ask once per tool (recommended)
   First use prompts, then auto-approves for session

You: list all files

[Works with new permission mode]

You: /permissions

? Select permission mode:
❯   Always ask (safer)

✓ Permission mode: Always ask (safer)
   You will be prompted for every tool use

[Any session permissions are cleared]
```

---

## Checking Current Mode

Use `/info` to see your current permission mode:

```
You: /info

📊 Current Configuration:

  Profile:     nvidia
  Model:       meta/llama-3.3-70b-instruct
  Provider:    https://integrate.api.nvidia.com/v1
  Temperature: 0.7
  Max Tokens:  4096
  Permissions: Ask once per tool    ← Current mode
  History:     12 messages
```

---

## Comparison Table

| Mode | Prompts | Session Memory | Safety | Convenience |
|------|---------|----------------|--------|-------------|
| **Ask once** | First use only | ✅ Yes | 🟢 High | 🟢 High |
| **Always ask** | Every use | ❌ No | 🟢 Very High | 🟡 Medium |
| **Unlimited** | Never | N/A | 🔴 Low | 🟢 Very High |

---

## Common Workflows

### Development Workflow

```bash
# Start with recommended mode
scc chat

You: /permissions
[Select: Ask once per tool]

You: create a new feature

[First tool prompts, select "Session (until exit)"]
[Rest of session uses that tool without prompting]
```

### Production Review

```bash
# Start with safer mode
scc chat

You: /permissions
[Select: Always ask (safer)]

You: review this file and suggest changes

[Every tool prompts - you see exactly what it does]
```

### Rapid Prototyping

```bash
# Start with unlimited (if you trust the agent)
scc chat -y

# Or switch mid-session
You: /permissions
[Select: Unlimited (dangerous)]

You: build a complete CRUD API

[Agent works without interruptions]
```

---

## Permission Mode vs Individual Tool Permissions

The `/permissions` command sets the **overall behavior**, but individual tool permissions within "Ask once" mode still give you fine-grained control:

**Overall mode** (via `/permissions`):
- Ask once per tool (recommended)
- Always ask (safer)
- Unlimited (dangerous)

**Individual tool response** (when prompted):
- Yes (once) - This action only
- Session (until exit) - This tool for session
- Always - Scope depends on the tool: non-mutating tools are saved to the
  global config ("Always (save to config)"); mutating tools (`run_shell`,
  `git`, `memory_write`, `write_file`, `edit_file`) are capped at session
  scope ("Always (this session only)") and are never persisted
- No (deny) - Deny this action

**Example:**

```
Permission mode: Ask once per tool

Agent wants to run: read_file
? Allow this action?
❯ Session (until exit)

[read_file now auto-approves for session]

Agent wants to run: write_file
? Allow this action?
❯ Always (this session only)

[write_file is mutating — auto-approves until exit; never saved to global config]

Agent wants to run: run_shell
? Allow this action?
❯ No (deny)

[run_shell denied this time, will prompt again next time]
```

---

## Tips

### Start Conservative

Begin with "Ask once" or "Always ask", then switch to "Unlimited" only if needed:

```
You: /permissions
[Select: Ask once per tool]

[Work for a while...]

You: I trust this agent now, let's go faster
You: /permissions
[Select: Unlimited (dangerous)]
```

### Use Always Ask for Learning

When learning what the agent does, use "Always ask" to see every action:

```
You: /permissions
[Select: Always ask (safer)]

You: help me understand this codebase

[Every tool prompts - you learn the agent's workflow]
```

### Quick Toggle

Create a keyboard shortcut or alias for switching modes:

```bash
# In chat
You: /permissions  # ⬆ Press up arrow + Enter
```

---

## Security Best Practices

1. **Default to safer modes** in production environments
2. **Use unlimited mode** only in isolated development environments
3. **Review session permissions** before approving "Session (until exit)"
4. **Clear permissions** when switching contexts (dev → prod)
5. **Audit config** after selecting "Always (save to config)" on non-mutating tools

---

## Troubleshooting

### Mode doesn't change

Make sure you selected a mode and pressed Enter. If cancelled, the mode stays the same.

### Still prompting after "Unlimited"

Check if you actually selected "Unlimited" with `/info`:

```
You: /info
[Check "Permissions:" line]
```

### Session permissions not working

"Always ask" mode clears session permissions. Switch to "Ask once per tool" to use session memory.

### Want to reset everything

```
You: /permissions
[Select: Always ask (safer)]

[Clears all session permissions]

You: /permissions
[Select: Ask once per tool]

[Fresh start with no session memory]
```

---

## Related Commands

- `/help` - Show all available commands
- `/info` - View current configuration including permission mode
- `/reload` - Reload config (doesn't affect permission mode)
- `/clear` - Clear conversation history (doesn't affect permission mode)

---

## Cross-Platform Support

The `/permissions` command works identically on:
- ✅ Windows (PowerShell)
- ✅ Windows (WSL)
- ✅ Linux
- ✅ macOS

No platform-specific configuration needed!

---

## See Also

- [README.md](../README.md) - Main documentation
- [visual-improvements.md](visual-improvements.md) - UI improvements including permission prompts
- [environment-variables.md](environment-variables.md) - SC_MAX_ITERATIONS and other env vars
