# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### ✨ Added

- **Execution budgets**: `--max-steps <n>` (tool executions), `--max-seconds <n>` (wall clock), `--max-total-tokens <n>` (estimated session tokens; `--max-tokens` stays the per-response cap) — env equivalents `SC_MAX_STEPS`/`SC_MAX_SECONDS`/`SC_MAX_TOTAL_TOKENS`. On exhaustion the run ends gracefully (no external SIGKILL), prints `SC_BUDGET_EXCEEDED <kind>` and exits with code 22 with the partial-work summary preserved. Defaults keep unbounded behavior. (Closes #408)
- **Zero-mutation exit signal**: in batch mode a run that completes without calling any workspace-mutating tool (`write_file`/`edit_file`/`git`) prints `SCC_NO_CHANGES` as the last stdout line and exits with code `10` (success-no-changes, per the exit-code contract sketched in #409). Covers "model refused", "no tools executed" and read-only runs — clean exit, the caller decides. (Closes #412)
- **`--no-commit` / `permissions.denyGitMutation`**: hard-block all git-mutating operations inside a session — `git` tool `add`/`commit` and `run_shell` git-mutating subcommands (commit/push/checkout/switch/reset/rebase/merge/tag-with-args/…) are denied with a clear "git is managed externally" error, in every permission mode including `-y`. Read-only git stays available. For orchestrators (ai-sdlc workers, Hermes) that own git state externally — makes the violation impossible instead of detectable. (Closes #414)
- **`scc doctor`**: preflight diagnostics for headless/automation setups — validates config files parse, effective config schema, active profile resolution (with `--profile`/`SC_PROFILE` override warnings), API-key presence, provider endpoint reachability + auth via a cheap `/models` ping, and prints the effective permission set with flag-override warnings. Exits non-zero on any FAIL with per-item remediation. (Closes #411)

- **`--prompt-file <path>`**: read the chat prompt from a file (or `-` for stdin) instead of the `[prompt]` argument. Eliminates shell quoting/escaping pitfalls and ARG_MAX limits for large prompts in automation. Mutually exclusive with the prompt argument; errors on missing or empty files. (Closes #413)

- **`permissions.denyCommands`**: non-interactive shell command blocklist for `run_shell`. Matching commands are hard-blocked before execution in every permission mode — including `-y`/autoApprove. Patterns support substring match (default) or full-command glob with `*`. Shown in `/config` display and documented in `docs/permission-profiles.md`.

### 🐛 Fixed

- **Harmony-format tool calls no longer end the turn silently:** some OpenAI-compatible providers emit tool invocations as `<|channel|>commentary to=functions.X<|message|>{args}` markup inside `content` instead of structured `tool_calls`. The agent now recovers named blocks into real tool calls, re-prompts (max 2) on unrecoverable markup, and aborts with a clear error if the model persists — instead of reporting success with zero changes. (Fixes #417)

- **Malformed tool-call arguments no longer crash the agent run:** `JSON.parse(toolCall.function.arguments)` was evaluated once inside `try` and again inside `catch`, so a model emitting invalid JSON (truncated stream, bad escaping — common with smaller/local models) made the rejection escape through `Promise.all` and kill the entire run. Arguments are now parsed once up front; malformed JSON returns a normal tool-error result so the model can self-correct. In headless runs (`sc chat -yq`) a single bad tool call previously meant full-run failure with zero changes produced. (Fixes #406)

- **Config `model` silently ignored**: removed the implicit `activeProfile: 'ollama'` default that overrode user-configured `model.baseUrl`/`model.model` when no profile was selected (#398).

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
