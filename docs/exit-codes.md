# Exit-Code Contract

**Normative specification.** This document is the single source of truth for
the process exit codes emitted by `sc` (sc-agent-cli). Wrappers, CI
pipelines, and orchestrating runtimes — including `os-santiago/ai-sdlc`'s
implement stage, which retries an implement run exactly once on `20 | 21` —
branch on `$?` alone, so the contract is **stable across releases**:

- A code's meaning never changes and is never reused for a different outcome.
- New codes may be added only inside the reserved ranges below.
- New *trigger paths* may land on an existing code when they share its
  semantics (e.g. a new timeout still maps to `20`/`24`).

Mirrors: the numeric table is `EXIT_CODES` in `src/utils/exit-codes.ts`, and
the mapping is asserted end-to-end by `test/e2e/chat-exit-codes.test.ts`,
which spawns the built `bin/sc.js` and checks the real process exit status.

## The contract

Codes apply to headless/batch runs (`sc chat <prompt>`,
`sc chat --prompt-file <path>`). Interactive sessions exit `0` on `/exit`,
`exit`/`quit`, or Ctrl+C at the prompt.

| Code | Constant | Terminal outcome | Marker |
| ---: | --- | --- | --- |
| `0` | `SUCCESS` | Run completed with workspace mutations (or a clean interactive exit) | — |
| `1` | `ERROR` | Generic/unspecified error — usage errors (bad flag values, unreadable `--prompt-file`, `--output-format` misuse), unclassified failures | `Error: …` on stderr |
| `10` | `NO_CHANGES` | Completed with **zero workspace mutations** — read-only answer, refusal, or explicit `VERDICT: NO_CHANGES`/`VERDICT: COMPLETED` | `SCC_NO_CHANGES` |
| `11` | `NOT_ACTIONABLE` | Completed with zero mutations and a terminal **not-actionable/blocked** resolution — explicit `VERDICT: NOT_ACTIONABLE` / `VERDICT: BLOCKED`, or matching prose ("requires repo-admin", "requires human intervention", …) | `SCC_NOT_ACTIONABLE <reason>` / `SCC_BLOCKED <reason>` |
| `20` | `PROVIDER_ERROR` | Provider failure **outside** the failover envelope — e.g. the consecutive-empty-response abort | `Error: …` on stderr |
| `21` | `AUTH_ERROR` | Auth failure **before the network** — missing/invalid credentials for a known provider host (config validation) | `Error: …` on stderr |
| `22` | `BUDGET_EXCEEDED` | Execution budget hit — `--max-steps`/`SC_MAX_STEPS`, `--max-seconds`/`SC_MAX_SECONDS`, `--max-total-tokens`/`SC_MAX_TOTAL_TOKENS` | `SC_BUDGET_EXCEEDED <steps\|seconds\|tokens>` |
| `23` | `LOOP_ABORT` | Agent-loop abort — tool livelock (`--livelock-threshold`, default 3 under `-y`), malformed-args storm | `Error: [SC_LIVELOCK] …` on stderr |
| `24` | `PROVIDER_EXHAUSTED` | Every failover candidate exhausted — any HTTP/transport failure (incl. live `401`/`500`) after retries/cascade | `Error: All provider candidates exhausted …` on stderr |
| `130` | — | `SIGINT` during a batch run | manifest `exit_reason: "interrupted"` |
| `143` | — | `SIGTERM` during a batch run (e.g. CI `timeout`) | manifest `exit_reason: "interrupted"` |

Markers go to **stdout** in the default `text` output format (the JSON run
manifest remains the last stdout line on every batch exit, signals included);
under `--output-format json` markers move to **stderr** so stdout carries the
manifest only. `Error:` lines always go to stderr.

## Mapping rules

Errors thrown by a run are classified by `classifyError()`
(`src/utils/exit-codes.ts`). Precedence:

1. **Declared `exitCode` wins** — `ProviderFailoverError` declares `24`.
2. Auth patterns (`401`/`403`, "requires an API key", …) → `21`.
3. Livelock marker (`[SC_LIVELOCK]`, "tool livelock") → `23`.
4. Provider patterns (fetch/network/timeout/5xx/empty response/rate limit) → `20`.
5. Anything else → `1`.

Graceful run outcomes bypass `classifyError` — the batch path sets
`process.exitCode` directly: `10`/`11` on zero-mutation terminals, `22` on
budget exhaustion.

### HTTP failures are always `24`, never `20`/`21`

Every HTTP/transport failure traverses the failover contract
(`src/core/failover.ts`): each candidate gets up to 4 attempts with bounded
backoff, then the `SC_FAILOVER` cascade advances. When the chain is exhausted
the call throws `ProviderFailoverError` → **24** — this holds for a single
configured provider too. Consequently:

- A live `401`/`403` exits `24` (non-retryable, one attempt per candidate);
  `21` is reserved for auth failures raised **before any request** (missing
  API key for a known-auth host fails config validation).
- A live `500`/`502`/`503`/`504`/`429` exits `24` after the retry bound;
  `20` is reserved for provider failures that never reach the failover
  envelope (the consecutive-empty-response abort).
- The manifest on `24` carries `terminalResolution: "provider_error"`,
  `errorClass`, and the per-candidate `attempts` array.

### Zero-mutation terminals: `10` vs `11`

`10` and `11` are both *clean* terminals — the run finished, the caller
decides what to do next. `11` means the final answer declared (or matched)
**not actionable / blocked**: the task cannot be resolved by code changes at
all. It requires zero workspace mutations; a run that changed files and still
claims non-actionability exits `0` (the edits stand). The manifest refines
the outcome as `resolution: "not_actionable" | "blocked"` with
`resolution_reason` and `files_changed`.

## Reserved ranges

- `2–9` — other clean terminals
- `12–19` — run outcomes (`11` is taken: not-actionable/blocked)
- `25+` — fatal errors
- `128+n` — signal exits (`130` = SIGINT, `143` = SIGTERM)

## Coverage

Every code above is asserted at the **process exit status** level in
`test/e2e/chat-exit-codes.test.ts` (spawn `bin/sc.js` against a mock
OpenAI-compatible provider) — plus `test/e2e/cli-smoke.test.ts` for the
offline `doctor` paths (`0`/`1`). If a refactor renumbers or swallows a code,
this suite fails; do not weaken it.

| Code | Fixture driving the real error path |
| ---: | --- |
| `0` | `write_file` tool call + synthesis; SSE streaming variant |
| `1` | unreadable `--prompt-file`; `sc doctor` on a dead endpoint |
| `10` | read-only answer; explicit `VERDICT: NO_CHANGES` |
| `11` | `VERDICT: NOT_ACTIONABLE`, `VERDICT: BLOCKED`, and heuristic prose — each with zero mutations |
| `20` | consecutive empty responses (`{kind:'message'}` with no content) |
| `21` | `SC_BASE_URL=https://api.openai.com/v1` with no key — pre-flight config check |
| `22` | `--max-steps 1` and `--max-seconds 1` + delayed reply (`delayMs`) |
| `23` | `--livelock-threshold 1` + tool-free scripted reply |
| `24` | HTTP `401` (non-retryable, 1 attempt) and HTTP `500` (retried to the 4-attempt bound) |
| `143` | `SIGTERM` delivered while a delayed request is in flight (POSIX only) |

## Consumers

`os-santiago/ai-sdlc` implements this contract in its implement stage
(`implement.yml` retries exactly once on `20 | 21`); its
`docs/runtime.md` links back here as the normative spec. When changing this
table, treat it as a breaking change for that runtime.
