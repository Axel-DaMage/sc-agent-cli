# Non-Interactive Mode

SC-Agent CLI can be used in non-interactive mode, allowing other tools to invoke it programmatically with a single prompt.

---

## Usage

### Basic Syntax

```bash
sc <prompt>
```

or

```bash
sc chat <prompt>
```

### With Auto-Approve

```bash
sc -y <prompt>
```

Auto-approves all tool executions (use with caution).

### Quiet Mode

```bash
sc -q <prompt>
```

Suppresses UI decorations for cleaner output.

### Combined Flags

```bash
sc -yq <prompt>
```

Auto-approve + quiet mode (fully non-interactive).

---

## Examples

### 1. Get File Summary

```bash
sc "summarize the contents of README.md"
```

**Output:**
```
┌─ Prompt ──────────────────────────────────────────────────┐
│ summarize the contents of README.md
└───────────────────────────────────────────────────────────┘

┌─ Assistant ───────────────────────────────────────────────┐
  ┌─ Tools ─────────────────────────────────────────────────┐
  │ 🔧 Using tool: read_file
  │    Args: {"path":"README.md"}
  │ ✓ Tool completed
  └─────────────────────────────────────────────────────────┘

The README.md file contains:
- Project title: SC-Agent CLI
- Description: Provider-agnostic CLI agent
- Installation instructions
- Usage examples
- License: Apache 2.0
└───────────────────────────────────────────────────────────┘
```

---

### 2. Code Analysis

```bash
sc "analyze src/cli.ts and list all exported functions"
```

---

### 3. File Operations

```bash
sc -y "create a file called test.txt with content 'Hello World'"
```

**Note:** `-y` flag auto-approves the write operation.

---

### 4. Integration with Other Tools

#### Shell Scripts

```bash
#!/bin/bash
result=$(sc -yq "count the number of .ts files in src/")
echo "TypeScript files: $result"
```

#### GitHub Actions

```yaml
- name: Analyze code changes
  run: |
    sc -yq "summarize changes in the last commit"
```

#### CI/CD Pipeline

```bash
# Run tests via SC-Agent
sc -yq "run npm test and report results"
```

---

## Flags

| Flag | Description | Use Case |
|------|-------------|----------|
| `-y, --yes` | Auto-approve all tool executions | Automation, trusted environments |
| `-q, --quiet` | Suppress UI decorations | Piping output, logging |
| `-yq` | Combined: auto-approve + quiet | Fully automated scripts |
| `--output-format json` | Emit *only* the JSON run manifest on stdout | Machine consumers (CI workers, dashboards) |
| `--summary-file <path>` / `--output-file <path>` | Also write the manifest to a file | Artifact collection, cost accounting |
| `--devcontainer` | Run the agent inside the repo `.devcontainer` image | CI/prod parity, toolchain drift prevention |

---

## Run Manifest (JSON)

In batch mode, the last stdout line is always a single-line JSON manifest — parse with `tail -1 | jq`. With `--output-format json` it is the *only* stdout output: the model's streamed answer is suppressed (carried in `final_message`), and status markers (`SCC_NO_CHANGES`, `SC_BUDGET_EXCEEDED`), warnings, and errors go to **stderr** so stdout stays a single parseable JSON object.

```bash
sc chat -yq --output-format json --output-file run.json "add input validation"
```

```json
{"v":1,"version":"0.4.2","success":true,"model":"gpt-4o","session_id":"<id>",
 "exit_reason":"success","iterations":14,
 "tool_calls":{"read_file":5,"edit_file":3,"run_shell":2},"tool_calls_total":10,
 "tokens_in":41230,"tokens_out":3180,"estimated_cost_usd":0.1284,
 "duration_ms":84210,"final_message":"Added zod validation to ...",
 "checkpoint":"/home/u/.sc-agent/checkpoints/<id>.json","error":null}
```

`exit_reason` is one of `success | error | no_changes | budget_exceeded | interrupted`. `checkpoint` points to the resumable state file when one exists (see `--resume`; `session_id` is also a valid resume ref). `error` carries the failure description on non-success exits, else `null`.

The manifest is emitted on **every** exit path — success, error, no-changes (`SCC_NO_CHANGES`), budget exhaustion (`SC_BUDGET_EXCEEDED`), and signal interruption (`SIGINT` → exit 130, `SIGTERM` → exit 143, e.g. CI `timeout` kills) — always as the last stdout line, with `success:false` on failure exits.

`--output-format json` requires a prompt (or `--prompt-file`); it is rejected for interactive sessions.

When `--devcontainer` is used the manifest also carries a `devcontainer` block recording the resolved execution path:

```json
"devcontainer": {"requested": true, "exec_path": "devcontainer", "status": "devcontainer",
  "marker": "SC_DEVCONTAINER=1", "hostname": "b3f1a2c4d5e6",
  "config_path": ".devcontainer/devcontainer.json"}
```

or, on fallback:

```json
"devcontainer": {"requested": true, "exec_path": "host",
  "status": "devcontainer_unavailable", "reason": "cli_missing",
  "config_path": ".devcontainer/devcontainer.json"}
```

---

## Devcontainer Execution (`--devcontainer`)

Repos that declare a `.devcontainer.json` (repo root) or `.devcontainer/devcontainer.json` already pin their toolchain. `--devcontainer` runs the agent loop inside that image instead of on the host:

```bash
scc chat -yq --devcontainer --output-file run.json "implement issue #42"
```

How it works (all via the [Dev Container CLI](https://github.com/devcontainers/cli), which must be on `PATH` together with `docker`):

1. Detect the devcontainer config (`sc probe` reports it as `devcontainer: true` + `devcontainerPath`).
2. `devcontainer up --workspace-folder .` — build/start the container.
3. `devcontainer exec --workspace-folder . --remote-env SC_DEVCONTAINER=1 scc chat <original args>` — the full argv is forwarded verbatim, and the `SC_DEVCONTAINER` remote-env marker tells the in-container run to record itself in the manifest (`marker` + container `hostname`) instead of re-orchestrating. The in-container exit code propagates to the caller.

**Fallback — never hard-fails.** If the `devcontainer`/`docker` CLIs are missing, no devcontainer config exists, or `devcontainer up`/`exec` fails for any reason, the run continues on the host and is classified `devcontainer_unavailable` with a `reason` of `no_config | cli_missing | docker_missing | up_failed | exec_failed`. The decision is written to the audit log (`--audit-log`, `type: "devcontainer"` events record the exec path and command) and to the run manifest.

Env knobs: `SC_DEVCONTAINER_AGENT_CMD` overrides the in-container command (default `scc`). `SC_DEVCONTAINER` is set automatically inside the container — do not set it on the host.

---

## Output Formats

### Normal Mode

```bash
$ sc "what is the current date"
```

**Output:**
```
╔════════════════════════════════════════════════════════════╗
  🤖 SC-Agent CLI
╠════════════════════════════════════════════════════════════╣
  Workspace: D:\git\sc-agent-cli
  Model:     claude-3-5-sonnet-20240620
  Provider:  https://api.anthropic.com/v1
  Storage:   1.2 MB / 1.00 GB (0.1%)
╠════════════════════════════════════════════════════════════╣
╚════════════════════════════════════════════════════════════╝

┌─ Prompt ──────────────────────────────────────────────────┐
│ what is the current date
└───────────────────────────────────────────────────────────┘

┌─ Assistant ───────────────────────────────────────────────┐
Today is June 28, 2026.
└───────────────────────────────────────────────────────────┘
```

### Quiet Mode (`-q`)

```bash
$ sc -q "what is the current date"
```

**Output:**
```
Today is June 28, 2026.
```

---

## Environment Variables

All standard SC-Agent environment variables apply:

```bash
export SC_API_KEY="your-api-key"
export SC_MODEL="gpt-4"
export SC_BASE_URL="https://api.openai.com/v1"

sc "analyze this code"
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (API error, invalid prompt, etc.) |

---

## Best Practices

### ✅ DO:

- Use `-yq` for fully automated scripts
- Set `SC_MAX_ITERATIONS` for long-running tasks
- Validate prompt before passing to `sc`
- Handle exit codes in scripts
- Use quotes around multi-word prompts

### ❌ DON'T:

- Use `-y` in untrusted environments
- Pass sensitive data in prompts (use files instead)
- Run without error handling in production
- Pipe untrusted input directly to `sc`

---

## Automation Examples

### Daily Code Summary

```bash
#!/bin/bash
# Generate daily code summary

DATE=$(date +%Y-%m-%d)
OUTPUT="summary-$DATE.md"

sc -yq "summarize all changes in the last 24 hours" > "$OUTPUT"

echo "Summary saved to $OUTPUT"
```

### Pre-Commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit

# Check for TODO comments
todos=$(sc -yq "count TODO comments in staged files")

if [ "$todos" -gt 10 ]; then
  echo "Too many TODOs ($todos). Please address some before committing."
  exit 1
fi
```

### Slack Bot Integration

```javascript
const { exec } = require('child_process');

// Slack command handler
app.command('/analyze', async ({ command, ack, respond }) => {
  await ack();

  const prompt = command.text;
  exec(`sc -yq "${prompt}"`, (error, stdout, stderr) => {
    if (error) {
      respond(`Error: ${stderr}`);
    } else {
      respond(stdout);
    }
  });
});
```

---

## Troubleshooting

### Issue: Prompt not recognized

```bash
$ sc analyze this code
Error: Unknown command 'analyze'
```

**Solution:** Wrap prompt in quotes:
```bash
$ sc "analyze this code"
```

### Issue: Tool requires approval

```bash
$ sc "delete temp files"
⚠️  run_shell requires approval (rm -rf /tmp/*.tmp)
[Waiting for user input...]
```

**Solution:** Use `-y` flag:
```bash
$ sc -y "delete temp files"
```

### Issue: Too much output

```bash
$ sc "analyze entire codebase"
[Hundreds of lines of output...]
```

**Solution:** Use `-q` to suppress decorations:
```bash
$ sc -q "analyze entire codebase" | head -20
```

---

## Comparison: Interactive vs Non-Interactive

| Feature | Interactive Mode | Non-Interactive Mode |
|---------|------------------|---------------------|
| **Invocation** | `sc` | `sc "prompt"` |
| **UI** | Full UI with status bar | Minimal (or none with `-q`) |
| **Approval** | Prompts for each tool | Auto (with `-y`) or one-time |
| **Exit** | User types `exit` | Auto after response |
| **Use Case** | Development, exploration | Automation, scripting |

---

## See Also

- [README.md](../README.md) - Main documentation
- [QUICKSTART.md](../QUICKSTART.md) - Getting started guide
- [permissions.md](permissions.md) - Permission system

---

## Changelog

### v0.3.3 (2026-06-28)
- ✅ Added non-interactive prompt parameter
- ✅ Added `-q, --quiet` flag for minimal output
- ✅ Auto-exit after processing single prompt
- ✅ Compatible with all existing flags (`-y`)

---

## Resuming a Checkpoint

```bash
sc chat -yq --resume latest "CI failed on test X, fix it"
sc chat -yq --resume <sessionId> "continue"
sc chat -yq --resume ~/.sc-agent/checkpoints/<id>.json "…"
```

Restores the checkpoint's conversation history and reuses its session id (checkpoints keep saving under the same id, so remediation runs stay chainable). `--resume` with no value resolves the latest checkpoint for the current workspace.

## Exit-Code Contract (stable, machine-consumable)

Batch runs terminate with a documented exit code — wrappers branch on `$?` alone:

| Code | Meaning | Marker on last stdout line |
|------|---------|----------------------------|
| `0`  | Success (changes produced, or interactive run) | — |
| `1`  | Generic/unspecified error | `Error: …` |
| `10` | Success, **zero mutations** — model refused / read-only / no tools executed | `SCC_NO_CHANGES` |
| `20` | Provider error — network, timeout, 5xx, repeated empty responses | `Error: …` |
| `21` | Auth error — 401/403, missing or invalid API key | `Error: …` |
| `22` | Execution budget exhausted (`--max-steps`/`--max-seconds`/`--max-total-tokens`) | `SC_BUDGET_EXCEEDED <steps\|seconds\|tokens>` |
| `23` | Agent-loop abort — tool livelock (`--livelock-threshold`), unrecoverable loop | `[SC_LIVELOCK] …` |
| `130` | Interrupted by `SIGINT` (batch only) | manifest `exit_reason: "interrupted"` |
| `143` | Interrupted by `SIGTERM` (batch only, e.g. `timeout` kills) | manifest `exit_reason: "interrupted"` |

Reserved: 2-9 clean terminals, 11-19 run outcomes, 24+ fatal. Codes are stable across releases.

```bash
scc chat -yq --max-steps 50 'implement issue #42'
case $? in
  0)  echo "PR-ready changes" ;;
  10) echo "no-op run — check the issue spec" ;;
  21) echo "rotate the provider key" ;;
  22) echo "raise the budget or split the task" ;;
esac
```

## Zero-Mutation Completion Guard

In unattended runs (`-y` / `--permissions unlimited`), a prompt that requests workspace changes must not end its turn having executed zero mutating tools. When the model answers with prose only — a narrated plan, a patch pasted as text, or a premature "done" — the agent blocks the turn completion and re-prompts the model to apply the change via `write_file`/`edit_file`/`git`/`run_shell`.

- **Budget:** `SC_ZERO_MUTATION_REPROMPTS` (default `2`; `0` disables the guard).
- **Worktree check:** the guard also compares git status before/after the run, so writes made through unclassified shell paths still count as mutations and are never re-prompted.
- **No-change verdict honored:** an explicit verdict ("no changes required", "already implemented", "nothing to commit") completes the turn immediately — `SCC_NO_CHANGES` / exit `10` remains the contract for genuine no-op runs.
- **Scope:** only mutation-scoped prompts in unattended mode. Interactive sessions and read-only prompts (summarize, explain, list) complete without re-prompting.
