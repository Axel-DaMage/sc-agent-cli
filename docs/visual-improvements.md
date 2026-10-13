# Visual Improvements

Complete redesign of the chat interface for better readability and user experience.

## Overview

The new design uses:
- **Box separators** - Clear visual boundaries between sections
- **Color coding** - Different colors for user, assistant, and operations
- **Consistent spacing** - Easier to scan conversations

---

## Color Scheme

| Element | Color | Purpose |
|---------|-------|---------|
| User input | **Blue** | Clearly identify your messages |
| Assistant response | **Green** | Distinguish agent responses |
| Operations (tools, system) | **Gray** | Background operations and metadata |
| Errors | **Red** | Problems and failures |
| Warnings | **Yellow** | Cautions and summaries |

---

## Visual Examples

### 1. Welcome Screen

**Before:**
```
🤖 SC-Agent CLI

Workspace: D:\git\sc-agent-cli
Model: llama3.2
Provider: http://localhost:11434/v1

Type "exit" or "quit" to end the session
Type "/help" for available commands
```

**After:**
```
╔════════════════════════════════════════════════════════════╗
  🤖 SC-Agent CLI
╠════════════════════════════════════════════════════════════╣
  Workspace: D:\git\sc-agent-cli
  Model:     llama3.2
  Provider:  http://localhost:11434/v1
╠════════════════════════════════════════════════════════════╣
  Type "exit" or "quit" to end the session
  Type "/help" for available commands
╚════════════════════════════════════════════════════════════╝
```

✅ Boxed layout with clear sections  
✅ Aligned labels for easier reading  
✅ Professional appearance  

---

### 2. User Input

**Before:**
```
You: what files are in this directory?
```

**After:**
```
┌─ You ─────────────────────────────────────────────────────┐
│ what files are in this directory?
└───────────────────────────────────────────────────────────┘
```

✅ Clear visual box around user input  
✅ Blue color to distinguish from agent  
✅ Easy to identify who said what  

---

### 3. Assistant Response

**Before:**
```
Assistant: 
Let me check the files in the current directory...
```

**After:**
```
┌─ Assistant ───────────────────────────────────────────────┐
│
Let me check the files in the current directory...
└───────────────────────────────────────────────────────────┘
```

✅ Green color for assistant text  
✅ Boxed section with clear boundaries  
✅ Easy to distinguish from user messages  

---

### 4. Tool Operations

**Before:**
```
🔧 Using tool: list_dir
   Args: {"path":"."}
✓ Tool completed

🔧 Using tool: read_file
   Args: {"path":"README.md"}
✓ Tool completed
```

**After:**
```
  ┌─ Tools ─────────────────────────────────────────────────┐
  │ 🔧 Executing 2 tools...
  │    → list_dir: {"path":"."}
  │    → read_file: {"path":"README.md"}
  │
  │ ✓ All 2 tools completed successfully
  └─────────────────────────────────────────────────────────┘
```

✅ Gray color to show it's operational  
✅ Grouped in a single box  
✅ Clear summary of what happened  
✅ Indented to show it's part of assistant's work  

---

### 5. Permission Requests

**Before:**
```
🔐 Permission required for tool: run_shell
   Args: {"command": "dir"}

   💡 To auto-approve shell commands, use: scc chat -y

√ Allow this action? » (y/N)
```

**After:**
```
  ┌─ Permission ────────────────────────────────────────────┐
  │ 🔐 Tool: run_shell
  │    Args: {"command":"dir"}
  └─────────────────────────────────────────────────────────┘

? Allow this action? › - Use arrow-keys. Return to submit.
❯   Yes (once) - Allow this time only
    Always (this session only) - Mutating tool — never saved to global config
    Session (until exit) - Auto-approve this session
    No (deny) - Deny this action
```

✅ Gray boxed layout  
✅ Four clear options  
✅ Default to "Yes (once)"  
✅ Session and Always options prevent repetition  
✅ "Always" is capped at session scope for mutating tools  

---

### 6. Error Summary

**Before:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  Summary: 2 error(s) encountered
   • list_dir: path must not be empty
   • run_shell: Command exited with code 1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**After:**
```
  ┌─ Summary ───────────────────────────────────────────────┐
  │ ⚠️  2 error(s) encountered
  │    • list_dir: path must not be empty
  │    • run_shell: Command exited with code 1
  └─────────────────────────────────────────────────────────┘
```

✅ Consistent box style  
✅ Gray background color  
✅ Yellow emoji for warnings  
✅ Red bullets for errors  

---

### 7. Goodbye Message

**Before:**
```
Goodbye!
```

**After:**
```
╔════════════════════════════════════════════════════════════╗
  👋 Goodbye!
╚════════════════════════════════════════════════════════════╝
```

✅ Boxed farewell  
✅ Consistent with welcome screen  
✅ Professional exit  

---

## Complete Conversation Example

```
╔════════════════════════════════════════════════════════════╗
  🤖 SC-Agent CLI
╠════════════════════════════════════════════════════════════╣
  Workspace: D:\git\sc-agent-cli
  Model:     llama3.2
  Provider:  http://localhost:11434/v1
╠════════════════════════════════════════════════════════════╣
  Type "exit" or "quit" to end the session
  Type "/help" for available commands
╚════════════════════════════════════════════════════════════╝

┌─ You ─────────────────────────────────────────────────────┐
│ what files are in this directory?
└───────────────────────────────────────────────────────────┘

┌─ Assistant ───────────────────────────────────────────────┐
│
Let me check the files in the current directory...

  ┌─ Tools ─────────────────────────────────────────────────┐
  │ 🔧 Using tool: list_dir
  │    Args: {"path":"."}
  │ ✓ Tool completed
  └─────────────────────────────────────────────────────────┘

Here are the files:
- README.md
- package.json
- src/
- dist/
└───────────────────────────────────────────────────────────┘

┌─ You ─────────────────────────────────────────────────────┐
│ exit
└───────────────────────────────────────────────────────────┘

╔════════════════════════════════════════════════════════════╗
  👋 Goodbye!
╚════════════════════════════════════════════════════════════╝
```

---

## Benefits

✅ **Clear separation** - Each message has its own box  
✅ **Color coding** - User (blue), Assistant (green), Operations (gray)  
✅ **Better scanning** - Easy to find specific parts of conversation  
✅ **Professional look** - Polished, modern interface  
✅ **Consistent style** - All elements use the same box format  
✅ **Reduced clutter** - Operations are visually de-emphasized with gray  

---

## Permission System Improvements

### New Permission Options

When the agent needs permission, you now get **4 choices**:

1. **Yes (once)** *(default)*
   - Allow this time only
   - Safest option
   - No permanent changes

2. **Always**
   - Non-mutating tools: **"Always (save to config)"** — auto-approve this
     tool forever, saved to `~/.sc-agent/config.json`
   - Mutating tools (`run_shell`, `git`, `memory_write`, `write_file`,
     `edit_file`): **"Always (this session only)"** — capped at session
     scope, never written to the global config

3. **Session (until exit)**
   - Auto-approve for this chat session
   - Resets when you exit
   - Good for temporary trust

4. **No (deny)**
   - Deny this action
   - Agent tries another approach

### Default Behavior

- **Default selection**: "Yes (once)"
- **No typing required**: Just press Enter to approve once
- **Smart saving**: "Always" updates config automatically for non-mutating
  tools; for mutating tools it stays session-scoped

### Example Flow

```
  ┌─ Permission ────────────────────────────────────────────┐
  │ 🔐 Tool: run_shell
  │    Args: {"command":"npm test"}
  └─────────────────────────────────────────────────────────┘

? Allow this action?
❯   Yes (once) - Allow this time only           ← Press Enter
    Always (this session only) - Mutating tool — never saved to global config
    Session (until exit) - Auto-approve this session
    No (deny) - Deny this action

✓ Action approved
```

### Configuration Impact

When you choose **Always** on a non-mutating tool, it modifies
`~/.sc-agent/config.json`:

```json
{
  "permissions": {
    "autoApprove": [
      "read_file",
      "list_dir",
      "search_text",
      "web_fetch"  ← Added automatically
    ]
  }
}
```

Mutating tools (`run_shell`, `git`, `memory_write`, `write_file`,
`edit_file`) are never added by "Always" — the grant expires with the
session so an approval in one repository cannot auto-approve mutations
everywhere else.

---

## Technical Details

### Files Modified

1. **`src/commands/chat-session.ts`**
   - Welcome screen boxed layout
   - User input separator (blue box)
   - Assistant response separator (green box)
   - Goodbye message box

2. **`src/core/agent.ts`**
   - Tool execution box (gray)
   - Error summary box (gray)
   - Green text for assistant responses
   - Warning box for iteration limit

3. **`src/utils/permissions.ts`**
   - Permission box layout (gray)
   - Four-option selection system
   - Session-level auto-approve tracking
   - Config file saving for "Always"

### Color Constants

```typescript
chalk.blue()    // User messages
chalk.green()   // Assistant responses
chalk.gray()    // Operations, boxes, metadata
chalk.yellow()  // Warnings
chalk.red()     // Errors
```

### Box Characters

```
┌─┐  Top corners
│    Vertical sides
└─┘  Bottom corners
╔═╗  Double-line top (welcome/goodbye)
║    Double vertical
╚═╝  Double-line bottom
╠═╣  Double-line middle divider
```

---

## Future Enhancements

Potential improvements:

- [ ] Configurable color scheme
- [ ] Emoji toggle option
- [ ] Compact mode (no boxes)
- [ ] Dark/light theme support
- [ ] Custom box width
- [ ] Token usage display in gray box
- [ ] Timestamp for each message

---

## Feedback

These visual improvements make conversations easier to read and follow. If you have suggestions for further UI enhancements, please open an issue on GitHub.
