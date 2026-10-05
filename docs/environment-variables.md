# Environment Variables

SC CLI supports configuration via environment variables for API keys and behavior settings.

## API Keys

### SC_API_KEY

General-purpose API key with highest priority. Use this when you want a single key for all providers.

```bash
export SC_API_KEY="your-api-key-here"
scc chat
```

### OPENAI_API_KEY

OpenAI-specific API key. Get from [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

```bash
export OPENAI_API_KEY="sk-your-openai-key-here"
scc profile use openai
scc chat
```

### ANTHROPIC_API_KEY

Anthropic-specific API key. Get from [console.anthropic.com](https://console.anthropic.com/).

```bash
export ANTHROPIC_API_KEY="sk-ant-your-anthropic-key-here"
scc profile use anthropic
scc chat
```

### NVIDIA_API_KEY

NVIDIA API key. Get from [build.nvidia.com](https://build.nvidia.com/).

```bash
export NVIDIA_API_KEY="nvapi-your-nvidia-key-here"
scc profile use nvidia
scc chat
```

### Priority Order

When multiple API keys are set, the priority is:

1. `SC_API_KEY` (highest)
2. Provider-specific key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`)
3. API key in config file
4. No API key (for local models like Ollama)

---

## Behavior Configuration

### SC_ZERO_MUTATION_REPROMPTS

Controls how many times the agent may block a turn that would complete with zero workspace mutations in unattended mode (`-y` / `--permissions unlimited`). When a prompt requests file changes but the model answers with prose only, the run is re-prompted to execute mutating tools instead of silently finishing as `SCC_NO_CHANGES`.

**Default:** `2` (`0` disables the guard)

```bash
# Give a weak/routed model more chances to actually apply changes
export SC_ZERO_MUTATION_REPROMPTS=4
scc chat -yq 'implement issue #446'
```

---

### SC_MAX_ITERATIONS

Controls the maximum number of agent iterations before stopping. Each iteration consists of:
1. Agent thinks
2. Calls one or more tools
3. Processes results
4. Decides next action

**Default:** `100`

---

### SC_MAX_STORAGE_GB

Controls the maximum storage in gigabytes for persistent data in `~/.sc-agent/`.

When the limit is exceeded, the oldest files are automatically deleted to free up space (cleanup to 90% of limit).

**Default:** `1` (1 GB)

**When to adjust:**

- **Lower (10-50):** Quick tasks, cost control, prevent runaway loops
- **Higher (200-500):** Complex projects, deep analysis, extensive refactoring

**Examples:**

```bash
# Very complex task - allow 200 iterations
export SC_MAX_ITERATIONS=200
scc chat

# Quick check - limit to 20 iterations
SC_MAX_ITERATIONS=20 scc chat

# Production - be cautious (50 iterations)
SC_MAX_ITERATIONS=50 scc chat
```

**PowerShell:**

```powershell
# Temporary (session only)
$env:SC_MAX_ITERATIONS = "200"
scc chat

# Permanent (add to $PROFILE)
[Environment]::SetEnvironmentVariable("SC_MAX_ITERATIONS", "200", "User")
```

**Add to .env file:**

```bash
# .env
SC_MAX_ITERATIONS=150
```

**What happens when limit is reached:**

```
  ┌─ Warning ───────────────────────────────────────────────┐
  │ ⚠ Maximum iteration limit reached
  └─────────────────────────────────────────────────────────┘
```

The agent stops and returns whatever it accomplished so far.

---

**When to adjust:**

- **Lower (0.5-1 GB):** Limited disk space, short-term projects
- **Higher (5-10 GB):** Large projects, long conversation histories

**Examples:**

```bash
# Increase to 5GB for large project
export SC_MAX_STORAGE_GB=5
scc chat

# Temporary 2GB limit
SC_MAX_STORAGE_GB=2 scc chat

# Check current usage
scc chat
You: /storage
```

**PowerShell:**

```powershell
# Temporary (session only)
$env:SC_MAX_STORAGE_GB = "5"
scc chat

# Permanent (add to $PROFILE)
[Environment]::SetEnvironmentVariable("SC_MAX_STORAGE_GB", "5", "User")
```

**What happens when limit is exceeded:**

```
⚠️  Storage limit exceeded
  Current: 1.05 GB
  Limit:   1.00 GB
  Usage:   105.0%

  Cleaning up oldest files...

✓ Cleaned up 150.23 MB
  New size: 900.00 MB (90.0%)
```

Oldest files are automatically deleted to bring usage down to 90% of the limit.

---

## Complete Examples

### Development (Local Ollama)

```bash
# No API key needed for local models
# Set high iteration limit for exploration
export SC_MAX_ITERATIONS=200
scc profile use ollama
scc chat
```

### Production (OpenAI)

```bash
# API key required
export OPENAI_API_KEY="sk-your-key-here"
# Conservative iteration limit
export SC_MAX_ITERATIONS=50
scc profile use openai
scc chat
```

### Research (NVIDIA Cloud)

```bash
# NVIDIA API key
export NVIDIA_API_KEY="nvapi-your-key-here"
# High limit for deep analysis
export SC_MAX_ITERATIONS=300
scc profile use nvidia
scc chat
```

### Quick Check (Any Provider)

```bash
# Inline variables for one-off commands
SC_MAX_ITERATIONS=20 scc chat
```

---

## Setting Variables Permanently

### Linux/macOS (Bash/Zsh)

Add to `~/.bashrc` or `~/.zshrc`:

```bash
export NVIDIA_API_KEY="nvapi-your-key-here"
export SC_MAX_ITERATIONS=150
```

Then reload:

```bash
source ~/.bashrc
# or
reload  # if you installed the reload function
```

### Windows (PowerShell)

Add to `$PROFILE`:

```powershell
$env:NVIDIA_API_KEY = "nvapi-your-key-here"
$env:SC_MAX_ITERATIONS = "150"
```

Then reload:

```powershell
. $PROFILE
# or
reload  # if you installed the reload function
```

### Windows (System-wide)

```powershell
# Requires admin privileges
[Environment]::SetEnvironmentVariable("NVIDIA_API_KEY", "nvapi-your-key-here", "User")
[Environment]::SetEnvironmentVariable("SC_MAX_ITERATIONS", "150", "User")
```

---

## .env File Support

Create a `.env` file in your project root:

```bash
# .env
SC_API_KEY=your-api-key-here
SC_MAX_ITERATIONS=100
```

**Note:** SC CLI does not automatically load `.env` files. You need to use a tool like `dotenv` or export them manually:

```bash
# Option 1: Export manually
export $(cat .env | xargs)

# Option 2: Use with dotenv
npm install -g dotenv-cli
dotenv scc chat
```

---

## Checking Current Values

```bash
# Check if variables are set
echo $SC_API_KEY
echo $SC_MAX_ITERATIONS

# PowerShell
$env:SC_API_KEY
$env:SC_MAX_ITERATIONS

# In chat session, use /info
scc chat
You: /info
```

---

## Unsetting Variables

```bash
# Bash/Zsh
unset SC_MAX_ITERATIONS
unset NVIDIA_API_KEY

# PowerShell
Remove-Item Env:\SC_MAX_ITERATIONS
Remove-Item Env:\NVIDIA_API_KEY
```

---

## Troubleshooting

### Variable not working

**Check if set:**
```bash
echo $SC_MAX_ITERATIONS
```

If empty, it's not set. Export it:
```bash
export SC_MAX_ITERATIONS=100
```

**Check shell:**
- Bash uses `~/.bashrc`
- Zsh uses `~/.zshrc`
- PowerShell uses `$PROFILE`

### Still using default value

Environment variables are read when the agent starts. If you change them mid-session:

```bash
# Option 1: Restart scc
exit
scc chat

# Option 2: Use /reload (for config, not env vars)
/reload
```

### Permission denied

Make sure you have permission to set environment variables:

```bash
# Linux/macOS - check file permissions
ls -la ~/.bashrc

# Windows - run PowerShell as user (not admin needed for user vars)
```

---

## Security Best Practices

1. **Never commit API keys to git**
   - Add `.env` to `.gitignore`
   - Use `.env.example` as template

2. **Use different keys per environment**
   - Development: local models (no key)
   - Staging: separate API key
   - Production: separate API key

3. **Rotate keys regularly**
   - Update environment variables when rotating
   - Test after rotation

4. **Limit permissions**
   - Use read-only keys when possible
   - Set spending limits in provider dashboards

---

## See Also

- [README.md](../README.md) - Main documentation
- [SETUP.md](../SETUP.md) - Initial setup guide
- [reload-command.md](reload-command.md) - Reloading configuration
