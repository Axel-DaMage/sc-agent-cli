# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### ✨ Added

- **MCP client**: `mcp.servers` config key spawns stdio MCP servers at session start and exposes their tools as `mcp__<server>__<tool>` — full JSON-RPC 2.0 handshake, per-request timeouts, crash isolation (a dead server degrades to per-call errors, never kills the loop), and cleanup on exit. See `docs/mcp-servers.md`. (Closes #401)
- **External tool plugins**: `plugins` config key (`~/.sc-agent/config.json` or `.sc-agent.json`) loads `Tool[]` modules at startup via explicit path/package specifiers — no directory scan. Plugin tools join the schema after built-ins, flow through the existing permission system (require approval unless `autoApprove`/`-y`), and can never shadow core tools. Load failures warn and skip. See `docs/plugin-tools.md`. (Closes #400)
- **`--resume [ref]`**: resume a checkpoint by session id, `.json` path, or `latest` (default when bare) — restores conversation history and session id so remediation flows continue the same agent session instead of restarting from zero. Works in interactive and `-q` batch modes; errors clearly when the ref resolves to nothing. (Closes #402)
- **`--audit-log <path>`**: append a JSONL forensic record per run — one object per `llm_request`/`llm_response` (iteration, model, duration, est. tokens) and `tool_call`/`tool_result` (name, sha256 args digest, duration, success/error). Sync append per event survives crashes; args are hashed to avoid leaking secrets; zero cost when the flag is absent. Gives workers the forensic record they currently approximate by regex-counting stdout lines. (Closes #410)
- **`--livelock-threshold <n>`**: abort the run when the model emits N consecutive non-empty responses without tool calls (default: 3 in auto-approve/`-y` mode, 0 disables). Prevents "tool livelock" where weak models narrate plans indefinitely under self-heal nudges — burning the full run budget with zero mutations. Fails with a greppable `[SC_LIVELOCK]` error preserving the last model output. (Closes #416)
- **Headless run manifest**: in batch mode (`sc chat <prompt>`), a single-line JSON manifest is emitted as the last stdout line on success, error, and no-changes exits — `{v, version, success, model, session_id, tokens_in, tokens_out, estimated_cost_usd, tool_calls{name:count}, tool_calls_total, iterations, duration_ms, exit_reason, final_message, checkpoint, error}`. `--summary-file <path>` / `--output-file <path>` also write it to disk; `--output-format json` makes the manifest the *only* stdout output (suppresses the streamed answer and all UI chrome; status markers go to stderr). Signal kills still emit it — `SIGINT` exits 130 and `SIGTERM` (e.g. CI `timeout`) exits 143 with `exit_reason: "interrupted"`. Feeds per-run cost accounting in automation. (Closes #415, closes #399)
- **Exit-code contract**: batch runs now exit with documented, machine-consumable codes — `0` success, `1` generic, `10` zero-mutation (`SCC_NO_CHANGES`), `20` provider error, `21` auth error, `22` budget exhausted (`SC_BUDGET_EXCEEDED`), `23` agent-loop abort (`[SC_LIVELOCK]`). Agent errors are classified automatically; the contract is documented in `docs/non-interactive-mode.md` and stable across releases. (Closes #409)
- **Execution budgets**: `--max-steps <n>` (tool executions), `--max-seconds <n>` (wall clock), `--max-total-tokens <n>` (estimated session tokens; `--max-tokens` stays the per-response cap) — env equivalents `SC_MAX_STEPS`/`SC_MAX_SECONDS`/`SC_MAX_TOTAL_TOKENS`. On exhaustion the run ends gracefully (no external SIGKILL), prints `SC_BUDGET_EXCEEDED <kind>` and exits with code 22 with the partial-work summary preserved. Defaults keep unbounded behavior. (Closes #408)
- **Zero-mutation exit signal**: in batch mode a run that completes without calling any workspace-mutating tool (`write_file`/`edit_file`/`git`) prints `SCC_NO_CHANGES` as the last stdout line and exits with code `10` (success-no-changes, per the exit-code contract sketched in #409). Covers "model refused", "no tools executed" and read-only runs — clean exit, the caller decides. (Closes #412)
- **`--no-commit` / `permissions.denyGitMutation`**: hard-block all git-mutating operations inside a session — `git` tool `add`/`commit` and `run_shell` git-mutating subcommands (commit/push/checkout/switch/reset/rebase/merge/tag-with-args/…) are denied with a clear "git is managed externally" error, in every permission mode including `-y`. Read-only git stays available. For orchestrators (ai-sdlc workers, Hermes) that own git state externally — makes the violation impossible instead of detectable. (Closes #414)
- **`scc doctor`**: preflight diagnostics for headless/automation setups — validates config files parse, effective config schema, active profile resolution (with `--profile`/`SC_PROFILE` override warnings), API-key presence, provider endpoint reachability + auth via a cheap `/models` ping, and prints the effective permission set with flag-override warnings. Exits non-zero on any FAIL with per-item remediation. (Closes #411)

- **`--prompt-file <path>`**: read the chat prompt from a file (or `-` for stdin) instead of the `[prompt]` argument. Eliminates shell quoting/escaping pitfalls and ARG_MAX limits for large prompts in automation. Mutually exclusive with the prompt argument; errors on missing or empty files. (Closes #413)

- **`permissions.denyCommands`**: non-interactive shell command blocklist for `run_shell`. Matching commands are hard-blocked before execution in every permission mode — including `-y`/autoApprove. Patterns support substring match (default) or full-command glob with `*`. Shown in `/config` display and documented in `docs/permission-profiles.md`.

- **`--devcontainer`**: run the agent loop inside the repo's declared devcontainer for CI/prod parity — detects `.devcontainer.json`/`.devcontainer/devcontainer.json` (reported in `sc probe` as `devcontainer: true` + `devcontainerPath`), brings it up via `devcontainer up --workspace-folder .`, then re-enters `scc chat` inside with `devcontainer exec --workspace-folder . --remote-env SC_DEVCONTAINER=1 …`. The exec path is recorded in `--audit-log` (`type: "devcontainer"` events) and the in-container run exposes the `SC_DEVCONTAINER` marker + container `hostname` in the run manifest. Missing `devcontainer`/`docker` CLIs or any `up`/`exec` failure falls back to host execution classified `devcontainer_unavailable` — never hard-fails. `SC_DEVCONTAINER_AGENT_CMD` overrides the in-container command (default `scc`). See `docs/non-interactive-mode.md`. (Closes #421)

- **Context-spend accounting + injection budget guard**: `SC_CONTEXT_BUDGET_TOKENS` caps the estimated size of the assembled system-prompt injection (base prompt, shell guide, repo profile, project context, persistent memories, non-interactive note). Over-budget assemblies are trimmed deterministically — lowest priority first (`memory` → `repo_profile` → `project_context` → `shell` → `non_interactive` → `system`, which is never fully dropped) — with head-preserving truncation plus a visible `[... trimmed ...]` marker, a printed warning, a `-v` `[CONTEXT_BUDGET]` line, and an `--audit-log` `context_budget` event (never silent). Per-source spend lands in the run manifest `context_budget` block (`budget_tokens`, `requested_tokens`, `injected_tokens`, `over_budget`, per-source `tokens_requested`/`tokens_injected`/`truncated`/`dropped`) alongside a cumulative `tool_outputs` line. (Closes #422)

- **GitHub issue + PR templates**: the issue picker now offers structured forms instead of free-text issues — `bug_report.yml` (version, provider, OS, repro steps, required `sc doctor` output, logs) and `feature_request.yml` (problem, proposal, alternatives, affected area) — plus a `config.yml` that links docs/FAQ/security advisories and disables blank issues. New PRs are pre-filled with summary / linked-issue (`Closes #N`) / test-plan / checklist sections covering the conventional-title, tests, docs, and changelog conventions. A `github-templates` vitest guard fails CI if the forms drift from the schema or link to renamed docs. (Closes #500)

### 🐛 Fixed

- **`run_shell` no longer leaks credentials into model context:** spawned shell commands inherited the full parent environment, so `env`/`printenv`/`cat ~/.sc-agent/config.json` inside a run dumped `SC_API_KEY`/`OPENAI_API_KEY`/`GH_TOKEN` into tool output — and from there into provider requests, session history, and checkpoints. Spawned children now receive an allowlisted environment (PATH/HOME/shell basics + optional `run_shell.allowedEnvVars` names; credential-shaped vars — `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_KEY*`, `*_PASSWORD`, `*_AUTH`, `SC_*` — are stripped unconditionally), and `run_shell` output is masked for known secret values (`***`) before it enters the model context. `permissions.denyCommands` ships defaults blocking `cat .env`-style credential reads (`*.env*`, `*.key`/`*.pem`, `~/.ssh/*`, `.sc-agent/config.json`, `/proc/*/environ`, `source .env`) — best-effort; `denyPaths` still does not constrain `run_shell`, documented in `docs/permission-profiles.md`. The same env scrubbing applies to the sandboxed spawn path, `mcp_validate`, and MCP stdio servers (which now get the scrubbed base + their explicit `mcp.servers.*.env` map instead of all of `process.env`). (Fixes #471)
- **`web_fetch` SSRF + resource exhaustion:** `web_fetch` no longer reaches loopback/private/link-local/reserved destinations — the URL is validated before every connect AND after every redirect (previously a public URL could 302 into `169.254.169.254` or `localhost`). Hostnames are resolved via `dns.lookup({all:true})` and blocked if *any* returned address is non-public, covering IPv4 + IPv6 (incl. `::ffff:` mapped, ULA `fc00::/7`, link-local `fe80::/10`, Teredo/6to4/NAT64 transition prefixes). Schemes are restricted to http/https and credential-bearing URLs rejected. Response bodies are now streamed with a hard byte cap (default 5 MiB) instead of buffered whole, and `timeout` is clamped to 60s max. New optional `webFetch` config block: `allowlist` (host[:port] allowlist, same syntax as `sandbox.egressAllowlist`), `allowPrivateHosts` (escape hatch for local dev), `maxBytes`. (Fixes #470)
- **`permissions.denyPaths` bypasses closed in `resolveSafePath`:** the gitignore matcher was fed `path.relative()`'s native separators, so on Windows `secrets\api.key` never matched `secrets/**` — nested deny globs silently failed on Windows. Separators are now normalized to `/` before matching, and both the logical path *and* its realpath are matched so an in-workspace symlink alias can no longer mask a deny-listed target. Surfaced by the new cross-platform CI matrix. (Fixes #484)

- **Cross-platform CI matrix:** the unit suite now runs on `ubuntu-latest` (Node 20 + 22), `windows-latest`, and `macos-latest` (Node 22) instead of Ubuntu-only, closing the gap where Windows/macOS support was advertised but never verified. Sandbox degraded (proxy) mode is now exercised end-to-end on the non-Linux legs, coverage artifacts are named per-OS/Node, and a macOS tmpdir-symlink + Windows 8.3/short-name test fragility was fixed. (Closes #484)

- **`npm run build` / `npm test` self-bootstrap missing dependencies:** fresh worktrees and pre-PR quality gates that invoke the scripts without a prior `npm ci` failed with `sh: line 1: tsc: command not found`. New `scripts/ensure-deps.mjs` pre-hooks detect the missing package and run `npm ci` (or `npm install` without a lockfile) automatically; the hooks are no-ops when `node_modules` is already present. (Fixes #448)

- **Zero-mutation turn completion blocked in unattended runs:** a batch run (`-y`/`--permissions unlimited`) whose prompt requests workspace changes could end its turn having executed zero mutating tools — the model narrated a plan or pasted the fix as prose and the run exited `SCC_NO_CHANGES` with nothing applied (Hermes failure signature `scc:zero-mutations:*`). The agent now detects a pending zero-mutation completion, verifies the git worktree is actually unchanged, and re-prompts the model to apply the change via tools — up to `SC_ZERO_MUTATION_REPROMPTS` times (default 2, 0 disables). `memory_write` no longer counts as a workspace mutation for this guard, and explicit no-change verdicts ("no changes required", "already implemented") still complete immediately, preserving the exit-10 contract for genuine no-op runs. (Fixes #448)

- **`scc doctor` no longer false-fails on admin-protected `/models`:** gateways that require elevated auth for `GET /models` while accepting the inference key on `POST /chat/completions` (e.g. OmniRoute) made doctor report `FAIL auth rejected` on a fully working setup. On a 401/403 from `/models`, doctor now runs a real `max_tokens: 1` completion probe — PASS if inference accepts auth, FAIL only when the inference endpoint also rejects it, WARN when inconclusive or no key is configured. (Fixes #441)

- **Harmony-format tool calls no longer end the turn silently:** some OpenAI-compatible providers emit tool invocations as `<|channel|>commentary to=functions.X<|message|>{args}` markup inside `content` instead of structured `tool_calls`. The agent now recovers named blocks into real tool calls, re-prompts (max 2) on unrecoverable markup, and aborts with a clear error if the model persists — instead of reporting success with zero changes. (Fixes #417)

- **Malformed tool-call arguments no longer crash the agent run:** `JSON.parse(toolCall.function.arguments)` was evaluated once inside `try` and again inside `catch`, so a model emitting invalid JSON (truncated stream, bad escaping — common with smaller/local models) made the rejection escape through `Promise.all` and kill the entire run. Arguments are now parsed once up front; malformed JSON returns a normal tool-error result so the model can self-correct. In headless runs (`sc chat -yq`) a single bad tool call previously meant full-run failure with zero changes produced. (Fixes #406)

- **Config `model` silently ignored**: removed the implicit `activeProfile: 'ollama'` default that overrode user-configured `model.baseUrl`/`model.model` when no profile was selected (#398).

- **Model can no longer self-revert its own edits via `run_shell` git commands:** an unattended run (`-y`/`--permissions unlimited`) could end with `edit_file` applied at an earlier iteration and a later `git checkout -- .`/`git restore`/`git reset --hard`/`git clean -f`/`git stash` silently wiping the worktree before the wrapper committed — the manifest then reported `files_changed` against a clean tree. `run_shell` now refuses all git-mutating commands in unattended mode with a clear refusal routed to the model (the dedicated `git` tool owns repo state); interactive mode is unchanged. `files_changed` now counts the real worktree diff — `git status --porcelain` after the run plus files in commits created during the run, excluding engine artifacts (`--summary-file`/`--output-file`/`--audit-log` inside the worktree) — so a run whose edits were reverted reports `0` instead of its session tool-call count. (Fixes #464)

- **Prototype-pollution guard in config merge and manifest parsers:** `deepMerge` iterated `for...in` with no own-property check and no key denylist, so a crafted `.sc-agent.json`/`config.json` containing `__proto__`/`constructor`/`prototype` keys could flip the merged config's prototype or inject inherited properties. The merge now iterates own enumerable keys only (`Object.keys`) and skips those keys at every nesting level with a stderr warning naming the key path and file — hostile config never crashes the load. The same denylist was applied to the repo-probe manifest parsers (`parseTomlSafe`, `parseCiWorkflowYaml`, `parseMakefileTargets`, `parseXmlProperties`), where a `[__proto__]` TOML table previously traversed into `Object.prototype` itself (global pollution) and `__proto__:`/`hasOwnProperty:` Makefile targets crashed on `.push`; the permission-prompt arg redaction now uses `Object.fromEntries` so model-supplied `__proto__` arg keys define an own property instead of invoking the prototype setter. (Fixes #478)
- **"Always" permission grants are capped at session scope for mutating tools:** selecting "Always (save to config)" appended the tool name to `permissions.autoApprove` in the global `~/.sc-agent/config.json`, so a single approval inside a hostile or throwaway repo permanently auto-approved `run_shell`, `git`, `memory_write`, `write_file` and `edit_file` for every future project. The choice now renders as "Always (this session only)" for mutating tools — the grant goes to the session set, nothing is written to the global config, and a warning states the cap. Non-mutating tools still persist, and the prompt copy declares the grant's scope for both kinds. Per-project persistence is deferred to the `.sc-agent.json` trust model (#469). (Fixes #477)

---

## [0.3.1] - 2026-06-28

### 🐛 Fixed

- **WSL pipe syntax errors:** Fixed WSL commands failing when using pipes (`|`) on Windows
  - ❌ Before: `wsl gh pr diff 149 | head -100` → `'head' is not recognized`
  - ✅ After: System prompt now guides to use `wsl bash -c "command | pipe"`
  - Affects: `head`, `tail`, `grep`, `find`, and complex `jq` filters with pipes
  
- **Loop Detection false positives:** Loop detection now correctly identifies SAME command failing multiple times
  - Previously triggered on different exploratory operations (404s, compatibility errors)
  - Now normalizes commands and excludes expected errors (404, command not found)
  - Only triggers when SAME base command fails ≥3 times consecutively
  
- **Task Status classification:** Windows compatibility errors now correctly distinguished from expected errors
  - ❌ Before: Classified compatibility issues as "expected errors (not blockers)"
  - ✅ After: Shows "Task completed with warnings" + specific compatibility guidance
  - Helps identify issues that need system prompt fixes vs normal operational errors

### ✨ Added

- **Comprehensive PR Review Workflow:** 5-step mandatory review before merge
  - Step 1: Validate PR status & checks
  - Step 2: Review comments (CodeRabbit, reviewers)
  - Step 3: Review code changes (does it solve the problem?)
  - Step 4: Impact analysis (breaking changes, affected files)
  - Step 5: Final decision & summary (present summary, wait for confirmation)

### 📚 Documentation

- Added `docs/wsl-pipes-fix.md` (187 lines) - WSL pipe syntax issue and solution
- Added `TRACE-ANALYSIS-IMPROVEMENTS.md` (381 lines) - Complete trace analysis report
- Added `docs/wsl-integration.md` (500+ lines) - WSL integration guide
- Added WSL pipe syntax examples in system prompt
- Updated loop detection to exclude compatibility errors
- Enhanced task status messages with compatibility warnings

### 🔧 Internal

- Improved error classification: compatibility vs blocking vs expectable
- Command normalization for accurate loop detection
- Added tool arguments tracking for better error analysis

---

## [0.3.0] - 2026-06-27 - CRITICAL SECURITY RELEASE

⚠️ **IMPORTANT:** This release fixes 3 CRITICAL security vulnerabilities. **Update immediately.**

### 🚨 CRITICAL Security Fixes

#### Fixed - Vulnerability #1: --admin Flag Used Without Permission
- **Severity:** CRITICAL (CVSS 8.5)
- **Impact:** Agent bypassed branch protection without user permission
- **Fix:** \`--admin\` flag now requires EXPLICIT user permission
- **Before:** \`merge the PRs\` → used \`--admin\` automatically
- **After:** \`merge the PRs\` → explains blocking, suggests \`--auto\`
- **To use --admin:** User must say "use --admin" or "bypass branch protection"

#### Fixed - Vulnerability #2: Repository Rulesets Modified/Deleted Without Permission
- **Severity:** CRITICAL (CVSS 9.1)
- **Impact:** Agent deleted/modified repository security settings
- **Fix:** Modifying/deleting rulesets now FORBIDDEN without explicit permission

#### Fixed - Vulnerability #3: GitHub Token Exposed in Logs
- **Severity:** CRITICAL (CVSS 9.8)
- **Impact:** Authentication tokens exposed in command logs
- **Fix:** Tokens never exposed, always use \`gh\` CLI for auth

### ✨ Added

- Task Status Intelligence (smart error classification)
- Loop Detection (detects ≥3x same error)
- GitHub PR Merge Workflow (3-step verification)
- Cross-Platform Compatibility (Windows jq syntax, 404 handling)

### 📚 Documentation

- 2,150+ lines of security and feature documentation
- SECURITY-CRITICAL-FIXES.md (800+ lines)
- github-merge-workflow.md (500+ lines)
- task-status-intelligence.md (457 lines)
- loop-detection.md (400+ lines)

### ⚠️ Breaking Changes

- Agent will NO LONGER use \`--admin\` without explicit permission
- Agent will NO LONGER modify repository rulesets automatically

---

## [0.1.0] - 2026-06-25 - Initial Release

### ✨ Features

- Provider-agnostic architecture (OpenAI-compatible API)
- 6 built-in tools (read, write, edit, list, search, run_shell)
- Interactive chat session
- Permission system
