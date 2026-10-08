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

### SC_BASE_URL

Overrides `model.baseUrl` — the OpenAI-compatible endpoint the agent talks to. Wins over the active profile and both config files; the value is validated with `new URL()` at startup, so an invalid URL fails config validation with the same error as a bad config-file value.

**Default:** unset (uses `model.baseUrl` from config/profile)

```bash
# Point at a different compatible endpoint without editing config
export SC_BASE_URL="https://models.github.ai/inference"
scc chat
```

---

### SC_MODEL

Overrides `model.model` — the model id sent to the provider. Wins over the active profile and both config files.

**Default:** unset (uses `model.model` from config/profile)

```bash
export SC_MODEL="openai/gpt-4.1"
scc chat
```

---

### SC_PROFILE

Overrides `activeProfile` — selects which entry of `profiles` is merged into `model.*`. Only applied when the named profile exists in `config.profiles`; an unknown name is ignored.

**Default:** unset (uses `activeProfile` from config)

```bash
export SC_PROFILE=nvidia
scc chat
```

---

### SC_FAILOVER

Ordered csv of `provider/model` candidates forming the provider cascade. The configured model is always tried first; each `SC_FAILOVER` entry is then tried in declared order when a candidate fails persistently.

**Default:** empty (single configured model, no cascade)

```bash
# Try the configured model, then gpt-4o-mini on OpenAI, then Claude on Anthropic
export SC_FAILOVER="openai/gpt-4o-mini,anthropic/claude-sonnet-4-6"
```

How `provider` resolves (in order):

1. A matching name in `config.profiles` (uses that profile's `baseUrl`, `apiKey`, etc.)
2. A known provider name (`openai`, `anthropic`, `nvidia`, `groq`, `together`, `ollama`, `lmstudio`) mapped to its canonical base URL
3. Otherwise — a token with no `/` (e.g. `llama3.1`) or a prefix matching neither of the above (e.g. `meta/llama-3.3-70b-instruct`) — the whole token is treated as a model id on the configured endpoint

Behavior:

- **Cascade on:** retry exhaustion (4 attempts) or non-retryable errors (400/401/403, incl. unsupported model)
- **Transient failures** (connect/attempt timeouts, `ECONNRESET`/`ETIMEDOUT`, HTTP 429, HTTP 500/502/503/504) retry first with bounded backoff (2s→4s→8s +20% jitter, capped at 8s)
- The primary credential is never forwarded to a different host — each candidate resolves its own key (`SC_API_KEY`, host-matched env key, or its profile's `apiKey`)
- Once the cascade advances to a working candidate, later calls in the run stick to it
- If every candidate is exhausted, the run exits with code **24** and the manifest reports `terminalResolution: "provider_error"`, `errorClass`, and the `attempts` array per candidate

---

### SC_ROLE

Pin a headless run to a single orchestration phase (`--role` flag equivalent). Valid values: `planner`, `executor`, `reviewer`. With no `SC_ROLE`/`--role`, a configured `roles` map expands the run into the full planner → executor → reviewer pipeline.

**Default:** unset (full pipeline when `config.roles` is present, classic single-phase run otherwise)

```bash
# Run only the executor phase, on its configured role model
SC_ROLE=executor scc chat -yq "implement issue #424"
```

See [non-interactive-mode.md](non-interactive-mode.md#multi-model-orchestration-roles-424) for the `roles` config, phase policies, and manifest fields.

---

### SC_ROLE_MAX_FIXES

Bounds the reviewer ↔ executor consensus loop in orchestrated runs. When the reviewer phase emits `VERDICT: request_changes`, its comments are sent back to the executor for a rework round and the reviewer re-reviews — at most this many rounds. A terminal `request_changes` at the bound is recorded in the manifest's `review` block (`verdict`, `fix_rounds`, `max_fixes`).

**Default:** `3` (`0` disables the rework loop — the review still runs once and its verdict is recorded)

```bash
# Allow up to 5 executor rework rounds per run
export SC_ROLE_MAX_FIXES=5
scc chat -yq "implement issue #462"
```

---

### SC_PROVIDER_CONNECT_TIMEOUT_MS

Maximum time (ms) to wait for response headers on each provider attempt.

**Default:** `30000` (30s). Expiry counts as a retryable transport failure.

---

### SC_PROVIDER_ATTEMPT_TIMEOUT_MS

Maximum total time (ms) per provider attempt, including the streamed body.

**Default:** `120000` (120s). Overridden by `model.timeout` in config or `--timeout`. Expiry counts as a retryable transport failure.

### SC_ZERO_MUTATION_REPROMPTS

Controls how many times the agent may block a turn that would complete with zero workspace mutations in unattended mode (`-y` / `--permissions unlimited`). When a prompt requests file changes but the model answers with prose only, the run is re-prompted to execute mutating tools instead of silently finishing as `SCC_NO_CHANGES`.

**Default:** `2` (`0` disables the guard)

```bash
# Give a weak/routed model more chances to actually apply changes
export SC_ZERO_MUTATION_REPROMPTS=4
scc chat -yq 'implement issue #446'
```

---

### SC_CONTEXT_BUDGET_TOKENS

Caps the estimated size of the assembled system-prompt injection — the base system prompt plus shell guide, repo profile, project context (`AGENTS.md`/`CLAUDE.md`/policy file), repo map (skeleton mode), persistent memories, and the non-interactive note. Tokens are estimated with the shared chars/4 heuristic.

**Default:** unset (no cap; per-source spend is still accounted in the run manifest)

When the assembly exceeds the cap, sources are trimmed deterministically — lowest priority first:

1. `memory` — persistent cross-session memories
2. `repo_profile` — probed toolchain hints
3. `project_context` — `AGENTS.md` / `CLAUDE.md` / policy file
4. `repo_map` — generated repo skeleton (only present with `context.mode=skeleton`)
5. `shell` — shell environment guide
6. `non_interactive` — auto-approve note (only present with `-y`)
7. `system` — base system prompt (trimmed last, never fully dropped)

A source whose full size exceeds the remaining overflow is truncated (head kept, `[... context source "X" trimmed ...]` marker appended); a source entirely covered by the overflow is dropped. Trims are never silent: a visible warning is printed, a `[CONTEXT_BUDGET]` line is emitted under `-v`, an audit event is recorded (with `--audit-log`), and the run manifest carries a `context_budget` block with `budget_tokens`, `requested_tokens`, `injected_tokens`, `over_budget`, and per-source `tokens_requested`/`tokens_injected`/`truncated`/`dropped`.

The manifest's `context_budget.sources` also carries a cumulative `tool_outputs` line — estimated tokens of tool results injected into the conversation during the run (tool outputs are bounded by the >10KB auto-compressor and history pruning, not by this cap).

```bash
# Keep the injected context under ~8k estimated tokens
export SC_CONTEXT_BUDGET_TOKENS=8000
scc chat -yq 'implement issue #422'
```

---

### SC_CONTEXT_MODE

Selects how workspace knowledge is injected into the system prompt. Valid values: `full`, `skeleton`.

**Default:** `full` (or `context.mode` in `.sc-agent.json` / `config.json` — env wins)

- `full` — injects discovered context files (`AGENTS.md`/`SC-AGENT.md`/`CLAUDE.md` + `settings.policyFile`) verbatim as the `project_context` source.
- `skeleton` — replaces that whole-file injection with a generated repo map: per-file exported symbols, signatures, and import edges extracted with dependency-free regex heuristics (JS/TS, Python, Go, Rust, SQL, JVM, C-family, C#, Ruby, PHP, shell, Swift, Lua — keyed by extension). The map is emitted as the `repo_map` injection source (bounded: ~60 lines/file, capped file count and total lines) and counts toward `SC_CONTEXT_BUDGET_TOKENS` like every other source. File bodies are pulled on demand via the existing `read_file` tool — the skeleton names exact workspace-relative paths. An explicitly configured `settings.policyFile` is still injected in skeleton mode.

```bash
# .sc-agent.json
{ "context": { "mode": "skeleton" } }

# or via env
SC_CONTEXT_MODE=skeleton scc chat -yq 'refactor the provider layer'
```

---

### SC_POLICY_FILE

Overrides `settings.policyFile` — an extra policy/doctrine file injected into the `project_context` system-prompt source alongside the auto-discovered `AGENTS.md`/`SC-AGENT.md`/`CLAUDE.md` files. The path is resolved against the workspace root and must land inside it (deny-path rules still apply); unreadable or denied files are skipped silently. An explicitly set policy file is still injected when `context.mode`/`SC_CONTEXT_MODE` is `skeleton`.

**Default:** unset

```bash
export SC_POLICY_FILE=docs/TEAM-RULES.md
scc chat
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

### SC_MAX_STEPS

Stops the run gracefully after N tool executions. Equivalent of `--max-steps <n>`; the flag wins when both are set. Must be a positive integer — anything else is a usage error.

**Default:** unset (no step cap)

```bash
SC_MAX_STEPS=25 scc chat -yq "triage issue #123"
```

On exhaustion the run ends gracefully: partial work is preserved, an `SC_BUDGET_EXCEEDED steps` marker is emitted, and the process exits with code **22** (see [Headless output markers](#headless-output-markers)).

---

### SC_MAX_SECONDS

Stops the run gracefully after N seconds of wall-clock time. Equivalent of `--max-seconds <n>`; the flag wins when both are set. Must be a positive integer — anything else is a usage error.

**Default:** unset (no time cap)

```bash
SC_MAX_SECONDS=300 scc chat -yq "update the changelog"
```

On exhaustion the run emits `SC_BUDGET_EXCEEDED seconds` and exits with code **22**.

---

### SC_MAX_TOTAL_TOKENS

Stops the run gracefully when estimated session tokens exceed N (chars/4 heuristic, covering the whole conversation including tool outputs). Equivalent of `--max-total-tokens <n>`; the flag wins when both are set. Must be a positive integer — anything else is a usage error.

**Default:** unset (no token cap)

```bash
SC_MAX_TOTAL_TOKENS=200000 scc chat -yq "refactor the provider layer"
```

On exhaustion the run emits `SC_BUDGET_EXCEEDED tokens` and exits with code **22**.

---

### SC_HUD

Forces the interactive status bar (HUD) on or off — wins over `settings.hud` in config.

**Accepted values:** `1` or `true` (case-insensitive) enables; any other set value (e.g. `0`, `false`) disables.

**Default:** unset (uses `settings.hud`, which defaults to enabled)

```bash
# Run interactively without the status bar
SC_HUD=false scc chat
```

---

### SC_DEBUG_METRICS

When set (any non-empty value), enables extra `[METRICS]` diagnostic lines for agent-loop decisions — context-injection loaded/skipped with sizes and mode, and self-heal activation/skip reasons. They go through the stderr verbose channel, so combine with `-v` to see them.

**Default:** unset (metrics lines suppressed)

```bash
SC_DEBUG_METRICS=1 scc chat -v "implement the feature"
```

---

### SC_DEVCONTAINER_AGENT_CMD

Command executed inside the devcontainer when `scc chat --devcontainer` runs the agent loop via `devcontainer exec`.

**Default:** `scc`

```bash
# Use a differently-named/global install inside the container
export SC_DEVCONTAINER_AGENT_CMD="sc"
scc chat -yq --devcontainer "run the test suite"
```

### SC_DEVCONTAINER

Remote-env marker **set automatically** by `devcontainer exec` — it marks that the current process already runs inside the container (recursion guard + run-manifest evidence). Do not set it on the host.

---

### SC_SANDBOX

Force the tool-call sandbox on or off for every `run_shell` invocation — wins over `sandbox.enabled` in config so CI runners can enforce the boundary without editing files.

**Accepted values:** `1|true|on|yes` enable, `0|false|off|no` disable. Anything else fails config validation at startup.

```bash
# Full profile from .sc-agent.json (egressAllowlist, paths, seccomp) applies
SC_SANDBOX=1 scc chat -yq 'implement issue #423'
```

See [sandboxing.md](sandboxing.md) for the `sandbox` config block.

---

### SC_CONFIG_PATH

Overrides the location of the global config file. Reads (`loadConfig`) and writes (`saveConfig`, `sc config-init`, `/profile` defaults) all honor it. Useful for tests, CI, and containers that must not touch the host's `~/.sc-agent/config.json`.

**Default:** `~/.sc-agent/config.json`

```bash
# Run the agent against a throwaway config
export SC_CONFIG_PATH=/tmp/sc-agent/config.json
scc chat
```

---

## Headless Output Markers

These are **not** environment inputs — the CLI *emits* them so wrappers and CI can branch on run outcomes without parsing prose. In `--output-format text` they go to stdout; with `--output-format json` stdout is reserved for the run manifest, so markers move to stderr.

### SC_BUDGET_EXCEEDED

Emitted as `SC_BUDGET_EXCEEDED <dimension>` when an execution budget (`--max-steps`/`SC_MAX_STEPS`, `--max-seconds`/`SC_MAX_SECONDS`, `--max-total-tokens`/`SC_MAX_TOTAL_TOKENS`) ends the run gracefully — `<dimension>` is one of `steps`, `seconds`, `tokens`. Pairs with exit code **22** and `resolution: "budget_exceeded"` in the run manifest.

### SC_LIVELOCK

Emitted as an `[SC_LIVELOCK]`-prefixed error when the agent aborts on a tool livelock — N consecutive non-empty model responses with no tool calls (default 3 under `-y`/`--permissions unlimited`; `--livelock-threshold 0` disables). Pairs with exit code **23**.

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
