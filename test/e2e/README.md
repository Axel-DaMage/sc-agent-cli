# E2E smoke suite

CLI-level end-to-end tests (#483). They spawn the **built** `bin/sc.js` via
`execFile(process.execPath, [bin/sc.js, ...])` — never the TypeScript sources —
so a broken bin entry, a missing `dist/` output, or a packaging miss fails
here instead of shipping green.

## Running locally

```bash
npm ci
npm run build       # required: tests spawn bin/sc.js → dist/cli.js
npm run test:e2e    # vitest --config vitest.e2e.config.ts
```

The suite is fully offline and deterministic: the only socket the CLI ever
contacts is a mock OpenAI-compatible server on `127.0.0.1` started by the
test itself. No API keys, no real provider, no secrets — `SC_*` and
`*_API_KEY` environment variables are stripped from every spawned process.

## What's covered

- **Offline commands** — `--version`, `--help`, `sc doctor` against a
  reachable mock endpoint (exit 0) and a dead one (exit 1).
- **Headless chat** — `sc chat -q --prompt-file` (file path *and* `-` for
  stdin) against the mock's `POST /v1/chat/completions`.
- **Exit-code contract end-to-end** — the canonical spec is
  [`docs/exit-codes.md`](../../docs/exit-codes.md); every row below asserts the
  real process exit status of `bin/sc.js` (#486):

  | code | scenario                                              |
  | ---: | ----------------------------------------------------- |
  | 0    | `write_file` tool call + synthesis → success          |
  | 0    | SSE streaming transport (`stream:true`) → success     |
  | 1    | unreadable `--prompt-file` → generic/usage error      |
  | 10   | read-only answer → `SCC_NO_CHANGES`                   |
  | 10   | explicit `VERDICT: NO_CHANGES` → `SCC_NO_CHANGES`     |
  | 11   | `VERDICT: NOT_ACTIONABLE` → `SCC_NOT_ACTIONABLE`      |
  | 11   | `VERDICT: BLOCKED` → `SCC_BLOCKED`                    |
  | 11   | not-actionable prose (heuristic, no marker)           |
  | 20   | consecutive empty responses → provider error          |
  | 21   | known-auth host with no API key (config check)        |
  | 22   | `--max-steps 1` → `SC_BUDGET_EXCEEDED steps`          |
  | 22   | `--max-seconds 1` + `delayMs` reply → `… seconds`     |
  | 23   | `--livelock-threshold 1` → `[SC_LIVELOCK]`            |
  | 24   | HTTP 401 → chain exhausted (non-retryable, 1 attempt) |
  | 24   | HTTP 500 → retried to the 4-attempt bound → exhausted |
  | 143  | `SIGTERM` mid-request → `interrupted` manifest (POSIX)|

  Note: HTTP/transport failures traverse the failover contract and surface as
  `ProviderFailoverError` → **24**, not 20/21 — exit 20 is reached through
  non-failover provider failures such as the empty-response abort, and exit 21
  is asserted at the config-validation boundary (deterministic, no socket).
  Exit 11 is wired in `chat-session.ts` from the resolution detector's
  `exit_code`/`stdout_marker` (#446 verdict semantics).
- **Batch output contracts** — last-stdout-line run manifest
  (`exit_reason`/`terminalResolution`/`attempts`), `--output-format json`
  (manifest-only stdout), `--summary-file`.
- **Both transports** — plain JSON (`stream:false`, default for the matrix)
  and SSE streaming (`stream:true` → `data:` frames + `[DONE]`).

## Layout

- `helpers/mock-provider.ts` — `startMockProvider(handler)` serves
  `GET /v1/models` + `POST /v1/chat/completions`; records every request
  (headers + parsed JSON body) for assertions; replies as SSE when the client
  sends `stream:true`. `scriptedCompletions([...])` scripts a reply sequence.
  `delayMs` on a scripted reply adds artificial latency (seconds-budget and
  signal tests).
- `helpers/run-cli.ts` — `runCli()` (spawn wrapper returning
  `{code, signal, stdout, stderr, timedOut}` with ANSI stripped; `onSpawn`
  exposes the live child for mid-run signals),
  `makeWorkspace()` (temp cwd with `.sc-agent.json` + `prompt.md`),
  `cleanEnv()`/`chatEnv()` (hermetic child environment),
  `lastManifest()` (parse the manifest off stdout).
- `cli-smoke.test.ts` — offline command coverage.
- `chat-exit-codes.test.ts` — the headless exit-code matrix.

Each test uses its own mock server (ephemeral port) and temp workspace;
`HOME`/`USERPROFILE` are pointed inside the workspace so `~/.sc-agent` state
stays hermetic and is deleted on cleanup.

## Adding a case

```ts
const { ws, provider, run } = await setupRun(
  [{ kind: 'message', toolCalls: [{ name: 'write_file', arguments: { path: 'x.txt', content: 'y' } }] },
   { kind: 'message', content: 'Done.' }],
  { prompt: 'Create x.txt.' },
);
const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md']);
assert.equal(result.code, 0);
```

Replies: `{kind:'message', content?, toolCalls?}` or
`{kind:'http', status, body?}`. The last scripted reply repeats when the run
re-prompts (self-heal / zero-mutation guards).
