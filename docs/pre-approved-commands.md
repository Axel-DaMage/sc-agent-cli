# /pre-approved-commands Interview

Interactive setup wizard to configure which tools can auto-approve without asking for permission every time.

## Overview

Instead of manually editing your config file, use this interactive interview to quickly set up pre-approved commands based on your use case.

```
You: /pre-approved-commands

📋 Pre-Approved Commands Interview

Answer a few questions to configure which tools can auto-approve.
This will update your config file for future sessions.

√ Allow reading files and listing directories without asking? ... yes
  ✓ Added: read_file, list_dir, search_text

√ Allow writing/editing files in this directory (D:\git\sc-agent-cli)? ... no

√ Allow executing shell commands (non-admin, e.g., npm, git)? ... yes
  ✓ Added: run_shell

√ Common git operations (status, diff, log) without asking? ... yes
  ℹ️  Git operations use run_shell (already configured)

√ Common package manager operations (npm install, build, test)? ... yes
  ℹ️  Package operations use run_shell (already configured)

📊 Summary:

  4 tool(s) will be auto-approved:
    • read_file
    • list_dir
    • search_text
    • run_shell

√ Save this configuration permanently? ... yes

✓ Configuration saved to:
  C:\Users\sergi\.sc-agent\config.json

✓ Configuration reloaded
  Pre-approved tools are now active
```

---

## Questions Explained

### 1. Allow reading files and listing directories?

**What it does:**
- Auto-approves: `read_file`, `list_dir`, `search_text`
- Agent can explore your codebase without asking

**Recommended:** ✅ **Yes** (safe, read-only)

**Use cases:**
- Code reviews
- Documentation generation
- Bug investigation
- Understanding project structure

**Risks:** ⚠️ Low
- Agent can read all files (including sensitive data like `.env`)
- Cannot modify anything

---

### 2. Allow writing/editing files in this directory?

**What it does:**
- Auto-approves: `write_file`, `edit_file`
- Agent can create and modify files without asking

**Recommended:** ⚠️ **Depends on trust level**

**Use cases:**
- Automated refactoring
- Code generation
- Quick fixes
- Documentation updates

**Risks:** ⚠️⚠️ Medium
- Agent can overwrite files
- Agent can create new files
- Changes can be undone with git

**Best practice:**
- Enable in development environments only
- Always review changes before committing
- Keep git status clean before starting

---

### 3. Allow executing shell commands (non-admin)?

**What it does:**
- Auto-approves: `run_shell`
- Agent can run commands like `npm test`, `git status`, etc.

**Recommended:** ⚠️ **Depends on environment**

**Use cases:**
- Running tests
- Building projects
- Git operations
- Package management

**Risks:** ⚠️⚠️⚠️ High
- Agent can run any command you can run
- Can modify files indirectly (via `echo`, `sed`, etc.)
- Can install packages
- Cannot run admin/sudo commands

**Best practice:**
- Enable in isolated development environments
- Disable in production environments
- Review command before auto-approving first time

---

### 4. Common git operations without asking?

**Info only** - Git uses `run_shell`, so if you approved shell commands, git is already enabled.

**Common operations:**
- `git status`
- `git diff`
- `git log`
- `git add`
- `git commit`

**Note:** Git push/pull still prompt because they're network operations.

---

### 5. Common package manager operations?

**Info only** - Package managers use `run_shell`, so if you approved shell commands, these are already enabled.

**Common operations:**
- `npm install`
- `npm run build`
- `npm test`
- `npm run dev`

**Note:** These can modify `node_modules` and `package-lock.json`.

---

## Common Scenarios

### Scenario 1: Code Review Only

**Goal:** Review code, understand structure, no modifications

**Answers:**
```
√ Allow reading files? ... yes
√ Allow writing files? ... no
√ Allow shell commands? ... no
√ Git operations? ... no
√ Package operations? ... no
```

**Result:**
- `read_file`, `list_dir`, `search_text` auto-approved
- Agent can explore but not modify

---

### Scenario 2: Development Assistant

**Goal:** Help with coding, run tests, make changes

**Answers:**
```
√ Allow reading files? ... yes
√ Allow writing files? ... yes
√ Allow shell commands? ... yes
√ Git operations? ... yes
√ Package operations? ... yes
```

**Result:**
- All tools auto-approved
- Agent is fully autonomous
- High productivity, review changes before committing

---

### Scenario 3: Testing & CI

**Goal:** Run tests, build project, no code changes

**Answers:**
```
√ Allow reading files? ... yes
√ Allow writing files? ... no
√ Allow shell commands? ... yes
√ Git operations? ... yes
√ Package operations? ... yes
```

**Result:**
- Can run tests and build
- Cannot modify source code
- Safe for CI-like workflows

---

### Scenario 4: Documentation Writer

**Goal:** Generate/update docs, no code changes

**Answers:**
```
√ Allow reading files? ... yes
√ Allow writing files? ... yes (for docs only)
√ Allow shell commands? ... no
√ Git operations? ... no
√ Package operations? ... no
```

**Result:**
- Can read code and write docs
- Cannot run commands
- Limited to file operations

---

## What Gets Saved

The interview updates `~/.sc-agent/config.json`:

```json
{
  "permissions": {
    "autoApprove": [
      "read_file",
      "list_dir",
      "search_text",
      "run_shell"
    ]
  }
}
```

This configuration persists across sessions and projects.

---

## Project-Specific Configuration

To configure per-project instead of globally:

1. Run the interview in your project directory
2. Manually create `.sc-agent.json` in project root:

```json
{
  "permissions": {
    "denyPaths": [
      ".env",
      ".env.*",
      "**/*.key",
      "**/*.pem",
      "secrets/**"
    ],
    "denyCommands": [
      "git push --force"
    ]
  }
}
```

> **Trust boundary (#469):** a project config can only *restrict* — it may add
> `denyPaths`/`denyCommands` entries but cannot raise `permissions.autoApprove`
> (the key is ignored with a stderr warning when it comes from inside the
> workspace). Auto-approve lists must live in the global `~/.sc-agent/config.json`.

---

## Re-running the Interview

You can re-run the interview anytime to change your configuration:

```
You: /pre-approved-commands

[Answer questions again]

√ Save this configuration permanently? ... yes

✓ Configuration saved
  Previous settings overwritten
```

---

## Checking Current Configuration

Use `/info` to see what's currently auto-approved:

```
You: /info

📊 Current Configuration:

  Profile:     nvidia
  Model:       meta/llama-3.3-70b-instruct
  Provider:    https://integrate.api.nvidia.com/v1
  Temperature: 0.7
  Max Tokens:  4096
  Permissions: Ask once per tool
  Auto-approve: read_file, list_dir, search_text, run_shell
  History:     5 messages
```

---

## Manual Configuration

If you prefer editing the config file directly:

```bash
# Global config
code ~/.sc-agent/config.json

# Project config
code .sc-agent.json
```

```json
{
  "permissions": {
    "autoApprove": [
      "read_file",
      "list_dir",
      "search_text",
      "write_file",
      "edit_file",
      "run_shell"
    ],
    "denyPaths": [
      ".env",
      ".env.*",
      "**/*.key",
      "**/*.pem"
    ]
  }
}
```

Then reload:

```
You: /reload
```

---

## Combining with Permission Modes

The interview configures **which tools** auto-approve.

The `/permissions` command configures **when** to ask.

**Example:**

```
Configuration:
  autoApprove: [read_file, list_dir, run_shell]

Permission mode: Ask once per tool

Result:
- read_file, list_dir, run_shell → auto-approve immediately
- write_file, edit_file → ask once, then remember for session

Permission mode: Always ask

Result:
- read_file, list_dir, run_shell → auto-approve immediately
- write_file, edit_file → ask every time

Permission mode: Unlimited

Result:
- All tools → auto-approve immediately
```

---

## Security Best Practices

### 1. Start Conservative

Begin with read-only operations:

```
√ Allow reading files? ... yes
√ Allow writing files? ... no
√ Allow shell commands? ... no
```

Expand permissions as needed.

---

### 2. Review Before Committing

Even with auto-approve, always review:

```bash
git diff
git status
```

Before:

```bash
git commit
git push
```

---

### 3. Use Project-Specific Config

Different projects need different permissions:

```bash
# Trusted project - full access
cd ~/my-project
[Configure with write + shell enabled]

# Client project - read-only
cd ~/client-project
[Configure with read-only]
```

---

### 4. Deny Sensitive Paths

Even with auto-approve, protect sensitive files:

```json
{
  "permissions": {
    "autoApprove": ["write_file", "edit_file"],
    "denyPaths": [
      ".env",
      ".env.*",
      "**/*.key",
      "**/*.pem",
      "secrets/**"
    ]
  }
}
```

---

### 5. Audit Regularly

Check what's auto-approved:

```
You: /info
[Review auto-approve list]

You: /pre-approved-commands
[Re-run interview to update]
```

---

## Troubleshooting

### Interview doesn't save

**Check permissions:**

```bash
ls -la ~/.sc-agent/config.json
```

Make sure you have write access.

---

### Still asking for permission

**Check config:**

```
You: /info
[Verify auto-approve list]
```

**Reload config:**

```
You: /reload
```

---

### Want to reset to defaults

Delete the config file:

```bash
rm ~/.sc-agent/config.json
```

Then re-run:

```
You: /pre-approved-commands
```

---

### Different behavior per project

Create `.sc-agent.json` in project root with project-specific settings. It overrides global config for non-privileged keys — note that `permissions.autoApprove`, `model.baseUrl`, `model.apiKey`, and `mcp.servers` are ignored at project scope (#469); `denyPaths` merges additively.

---

## Examples

### Example 1: Safe Code Review

```
You: /pre-approved-commands

√ Allow reading files? ... yes
√ Allow writing files? ... no
√ Allow shell commands? ... no

Result: read_file, list_dir, search_text

You: review this codebase and find bugs

[Agent explores freely, cannot modify]
```

---

### Example 2: Full Development

```
You: /pre-approved-commands

√ Allow reading files? ... yes
√ Allow writing files? ... yes
√ Allow shell commands? ... yes

Result: All tools auto-approved

You: refactor this component and run tests

[Agent works autonomously]

You: show me what changed
You: git diff

[Review before committing]
```

---

### Example 3: CI/CD Mode

```
You: /pre-approved-commands

√ Allow reading files? ... yes
√ Allow writing files? ... no
√ Allow shell commands? ... yes

Result: read_file, list_dir, search_text, run_shell

You: run all tests and report results

[Agent runs tests, cannot modify code]
```

---

## Related Commands

- `/permissions` - Set permission mode (ask once/always/unlimited)
- `/info` - View current configuration
- `/reload` - Reload config after manual edits
- `/help` - Show all available commands

---

## See Also

- [permissions-command.md](permissions-command.md) - Permission modes
- [README.md](../README.md) - Main documentation
- [SETUP.md](../SETUP.md) - Initial setup guide
