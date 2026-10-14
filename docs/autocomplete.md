# Autocomplete

Tab completion for commands, file paths, and tools.

## Quick Start

Press **Tab** while typing to see suggestions:

```
You: /he[Tab]
→ /help

You: read file src/[Tab]
→ src/index.ts
→ src/core/
→ src/utils/
```

---

## What Gets Autocompleted

### 1. Slash Commands

All `/` commands have autocomplete:

```
/h[Tab]       → /help
/m[Tab]       → /model
/p[Tab]       → /permissions, /profile, /pre-approved-commands
/s[Tab]       → /storage
/r[Tab]       → /reload
/c[Tab]       → /clear
/i[Tab]       → /info
```

**Example:**
```
You: /per[Tab]

/permissions
/profile
```

---

### 2. File Paths

Autocompletes files and directories in your workspace:

```
You: read ./src/[Tab]

./src/index.ts
./src/core/
./src/utils/
./src/commands/
```

**Supports:**
- Relative paths: `./`, `../`
- Home directory: `~/`
- Absolute paths: `/home/user/`, `C:\Users\`
- Windows paths: `C:\`, `D:\`

**Example:**
```
You: edit the file in src/co[Tab]
→ src/core/

You: edit the file in src/core/ag[Tab]
→ src/core/agent.ts
```

---

### 3. Tool Names

Autocompletes tool names when mentioned:

Available tools:
- `read_file`
- `write_file`
- `edit_file`
- `list_dir`
- `search_text`
- `run_shell`

**Example:**
```
You: use the read_f[Tab]
→ read_file

You: call the write[Tab]
→ write_file
```

---

## How It Works

### Press Tab Once

Shows first match or completes partial:

```
You: /h[Tab]
→ /help  (único match, completa automáticamente)

You: /p[Tab]
→ /p  (múltiples matches, no completa)
```

### Press Tab Twice

Shows all matches:

```
You: /p[Tab][Tab]

/permissions
/profile
/pre-approved-commands
```

---

## Examples

### Example 1: Navigate to File

```
You: read the config file in .[Tab]

./src/
./docs/
./package.json
./tsconfig.json

You: read the config file in ./src/[Tab]

./src/core/
./src/utils/
./src/commands/

You: read the config file in ./src/core/[Tab]

./src/core/agent.ts
./src/core/config.ts
./src/core/types.ts

You: read the config file in ./src/core/config.ts
```

**Result:** Navegaste 3 niveles con Tab, sin escribir todo el path.

---

### Example 2: Find Command

```
You: /pr[Tab][Tab]

/profile
/pre-approved-commands

You: /pro[Tab]
→ /profile  (completa automáticamente)
```

---

### Example 3: Multiple Files

```
You: compare ./src/core/agent.ts with ./src/core/[Tab]

./src/core/config.ts
./src/core/provider.ts
./src/core/types.ts

You: compare ./src/core/agent.ts with ./src/core/provider.ts
```

---

## Path Completion Rules

### Workspace Relative

When you type `./` or `../`, autocomplete shows files **relative to workspace root**:

```
Workspace: /home/user/project

You: ./[Tab]
→ ./src/
→ ./docs/
→ ./package.json

You: ../[Tab]
→ ../project/
→ ../other-project/
```

### Home Directory

`~/` expands to your home directory:

```
You: ~/[Tab]
→ ~/Documents/
→ ~/Downloads/
→ ~/Desktop/
```

### Absolute Paths

Works with full paths:

```
You: /home/user/proj[Tab]
→ /home/user/project/

You: C:\Users\[Tab]
→ C:\Users\YourName\
```

---

## Autocomplete Triggers

### Slash commands
Any line starting with `/`:
```
/[Tab]  → Shows all commands
```

### File paths
Lines containing path indicators:
```
file:
path:
./
../
~/
in <path>
from <path>
read <path>
write <path>
edit <path>
```

### Tools
Lines mentioning tools:
```
use tool
run <tool>
execute <tool>
call <tool>
```

---

## Limitations

### Max Suggestions: 20

If a directory has 100+ files, only first 20 show:

```
You: ./node_modules/[Tab]

@types/
chalk/
commander/
...
(showing first 20 of 150 packages)
```

### No Fuzzy Matching

Autocomplete is **prefix-based only**:

```
✅ /hel[Tab] → /help
❌ /hlp[Tab] → (no match)

✅ ./src/core/ag[Tab] → ./src/core/agent.ts
❌ ./src/core/gent[Tab] → (no match)
```

### Workspace Boundary

File autocomplete **respects workspace root** for security:

```
Workspace: /home/user/project

You: read /etc/[Tab]
→ (no suggestions - outside workspace)
```

---

## Tips

### 1. Tab Early and Often

```
# Instead of typing:
You: read the file in ./src/core/agent.ts

# Tab your way:
You: read the file in ./s[Tab]c[Tab]ag[Tab]
→ read the file in ./src/core/agent.ts
```

### 2. Use Tab to Explore

Not sure what's in a directory?

```
You: what's in ./docs/[Tab]

./docs/autocomplete.md
./docs/permissions-command.md
./docs/pre-approved-commands.md
...

[You see the files without running a command]
```

### 3. Combine with Arrows

```
You: read ./src/[Tab]
[Pick from suggestions]

[Press ↑ to recall]
You: read ./src/core/agent.ts

[Edit slightly]
You: edit ./src/core/agent.ts
```

---

## Keyboard Reference

| Key | Action |
|-----|--------|
| **Tab** | Complete or show matches |
| **Tab Tab** | Show all matches |
| **↑** | Previous command |
| **↓** | Next command |
| **Ctrl+C** | Cancel/Exit |
| **Enter** | Submit |

---

## Platform Support

### ✅ Linux
```bash
You: /[Tab]  → Works
You: ./[Tab] → Works
```

### ✅ macOS
```bash
You: /[Tab]  → Works
You: ~/[Tab] → Works
```

### ✅ Windows (PowerShell)
```powershell
You: /[Tab]     → Works
You: ./[Tab]    → Works
You: C:\[Tab]   → Works
```

### ✅ Windows (WSL)
```bash
You: /[Tab]       → Works
You: /mnt/c/[Tab] → Works
```

---

## Troubleshooting

### Tab doesn't do anything

**Problem:** Pressing Tab has no effect

**Solution:**
1. Make sure you're using Node.js 20+
2. Check that you're in an interactive terminal (not piped)
3. Try pressing Tab twice quickly

---

### Shows wrong suggestions

**Problem:** Autocomplete suggests files from wrong directory

**Solution:**
- Check your current workspace with `/info`
- Paths are relative to **workspace root**, not current shell directory

---

### Too many suggestions

**Problem:** 100+ files shown

**Solution:**
- Be more specific: `./src/c[Tab]` instead of `./src/[Tab]`
- Only first 20 matches are shown (others are hidden)

---

### No file suggestions

**Problem:** Tab doesn't suggest files

**Solution:**
- Include a path indicator: `./`, `/`, `~/`
- Use words like: `read`, `edit`, `file`, `path`

**Example:**
```
❌ You: analyze main.ts[Tab]
   (no path indicator)

✅ You: analyze ./main.ts[Tab]
   (has ./ indicator)
```

---

## Future Enhancements

Planned features:

- [ ] Fuzzy matching (hlp → /help)
- [ ] Git branch autocomplete
- [ ] npm package autocomplete
- [ ] Variable autocomplete
- [ ] Custom completions per tool
- [ ] Smart context-aware suggestions

---

## See Also

- [keyboard-shortcuts.md](keyboard-shortcuts.md) - All shortcuts
- [README.md](../README.md) - Main documentation
