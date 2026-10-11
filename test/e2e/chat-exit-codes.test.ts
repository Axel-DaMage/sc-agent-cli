// E2E smoke — headless `sc chat` against a mock OpenAI-compatible provider
// (#483, extended in #486). Asserts the documented exit-code contract
// end-to-end through the built bin — docs/exit-codes.md is the canonical
// spec; every code below is the real process exit status, not an internal
// assertion:
//   0 success · 1 generic error · 10 SCC_NO_CHANGES · 11 SCC_NOT_ACTIONABLE/
//   SCC_BLOCKED · 20 provider error · 21 auth error · 22 SC_BUDGET_EXCEEDED
//   (steps + seconds) · 23 agent-loop abort · 24 provider chain exhausted
//   (401 non-retryable + 500 retried) · 143 SIGTERM interruption.
//
// Notes on the mapping (see src/utils/exit-codes.ts + src/core/failover.ts):
//   * HTTP/transport failures traverse the failover contract and surface as
//     ProviderFailoverError → 24, not 20 — whether the status was auth (401,
//     non-retryable, single attempt) or transient (500, retried to the
//     4-attempt bound). Exit 20 is reached via non-failover provider
//     failures (the consecutive-empty-response abort here).
//   * Exit 21 is asserted through config validation — a known-auth host with
//     no key fails before any network call (deterministic, offline).
//
// Requires `npm run build` first — tests spawn `node bin/sc.js`.

import { afterEach, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DIST_ENTRY,
  chatEnv,
  describeRun,
  lastManifest,
  makeWorkspace,
  runCli,
  type CliRunResult,
  type RunManifestShape,
} from './helpers/run-cli.js';
import {
  scriptedCompletions,
  startMockProvider,
  type MockCompletion,
  type MockHandler,
  type MockProvider,
} from './helpers/mock-provider.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

beforeAll(() => {
  assert.ok(
    existsSync(DIST_ENTRY),
    'dist/cli.js not found — run `npm run build` before `npm run test:e2e`.',
  );
});

interface ChatFixture {
  ws: string;
  provider: MockProvider;
  run(
    args: string[],
    opts?: {
      input?: string;
      env?: Record<string, string | undefined>;
      timeoutMs?: number;
      onSpawn?: (child: ChildProcess) => void;
    },
  ): Promise<CliRunResult>;
}

async function setupRun(
  script: MockCompletion[] | MockHandler,
  opts: { stream?: boolean; prompt?: string } = {},
): Promise<ChatFixture> {
  const provider = await startMockProvider(Array.isArray(script) ? scriptedCompletions(script) : script);
  cleanups.push(provider.close);
  const ws = await makeWorkspace({ baseUrl: provider.baseUrl, stream: opts.stream, prompt: opts.prompt });
  cleanups.push(() => rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  return {
    ws,
    provider,
    run: (args, runOpts = {}) =>
      runCli({
        args,
        cwd: ws,
        // #469: the workspace .sc-agent.json's model.baseUrl is now a blocked
        // privileged key — route to the mock via SC_BASE_URL instead.
        env: chatEnv(ws, { SC_BASE_URL: provider.baseUrl, ...runOpts.env }),
        input: runOpts.input,
        timeoutMs: runOpts.timeoutMs,
        onSpawn: runOpts.onSpawn,
      }),
  };
}

function chatRequests(provider: MockProvider) {
  return provider.requests.filter((r) => r.url.endsWith('/chat/completions'));
}

// POSIX-only signal tests — Windows cannot deliver SIGTERM to a child.
const posix = test.skipIf(process.platform === 'win32');

/** Poll a predicate (e.g. "the mock saw the chat request") until it holds. */
async function waitFor(pred: () => boolean, failMsg: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${failMsg}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('sc chat headless — exit code contract', () => {
  test('mutating tool call completes → exit 0 + success manifest', async () => {
    const { ws, provider, run } = await setupRun(
      [
        {
          kind: 'message',
          toolCalls: [{ name: 'write_file', arguments: { path: 'e2e-output.txt', content: 'hello from e2e\n' } }],
        },
        { kind: 'message', content: 'Done.' },
      ],
      { prompt: 'Create e2e-output.txt with a short greeting.' },
    );

    const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md', '--summary-file', 'run-manifest.json']);

    assert.equal(result.code, 0, describeRun(result));
    const manifest = lastManifest(result.stdout);
    assert.equal(manifest.exit_reason, 'success');
    assert.equal(manifest.success, true);
    assert.equal(manifest.tool_calls?.write_file, 1);
    assert.equal(await readFile(join(ws, 'e2e-output.txt'), 'utf-8'), 'hello from e2e\n');

    // The provider really served the run: prompt forwarded, bearer auth sent.
    const reqs = chatRequests(provider);
    assert.equal(reqs.length, 2, 'expected exactly tool-call + synthesis requests');
    assert.equal(reqs[0].headers.authorization, 'Bearer e2e-test-key');
    assert.match(JSON.stringify(reqs[0].json), /e2e-output\.txt/);

    // --summary-file contract: identical manifest persisted to disk.
    const fromFile = JSON.parse(await readFile(join(ws, 'run-manifest.json'), 'utf-8')) as RunManifestShape;
    assert.equal(fromFile.exit_reason, 'success');
  });

  test('unreadable --prompt-file → generic error exit 1', async () => {
    // Usage/config-class failure: exits before loadConfig, no provider needed.
    const ws = await makeWorkspace({ baseUrl: 'http://127.0.0.1:1/v1' });
    cleanups.push(() => rm(ws, { recursive: true, force: true }));

    const result = await runCli({
      args: ['chat', '-q', '--prompt-file', 'does-not-exist.md'],
      cwd: ws,
      env: chatEnv(ws),
    });

    assert.equal(result.code, 1, describeRun(result));
    assert.match(result.stderr, /cannot read prompt file/i);
  });

  test('read-only answer → SCC_NO_CHANGES + exit 10 (prompt via --prompt-file -)', async () => {
    const { provider, run } = await setupRun([{ kind: 'message', content: '2 + 2 = 4.' }]);

    const result = await run(['chat', '-q', '-y', '--prompt-file', '-'], {
      input: 'What is 2 + 2? Reply briefly.\n',
    });

    assert.equal(result.code, 10, describeRun(result));
    assert.match(result.stdout, /SCC_NO_CHANGES/);
    assert.equal(lastManifest(result.stdout).exit_reason, 'no_changes');
    const reqs = chatRequests(provider);
    assert.equal(reqs.length, 1);
    assert.match(JSON.stringify(reqs[0].json), /2 \+ 2/);
  });

  test('explicit VERDICT: NO_CHANGES → still SCC_NO_CHANGES + exit 10', async () => {
    const { run } = await setupRun(
      [{ kind: 'message', content: 'VERDICT: NO_CHANGES - the requested change is already present.' }],
      { prompt: 'Triage this issue and report its actionability.' },
    );

    const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 10, describeRun(result));
    assert.match(result.stdout, /SCC_NO_CHANGES/);
    assert.equal(lastManifest(result.stdout).resolution, 'no_changes');
  });

  test('VERDICT: NOT_ACTIONABLE (zero mutations) → SCC_NOT_ACTIONABLE + exit 11', async () => {
    const { provider, run } = await setupRun(
      [{ kind: 'message', content: 'VERDICT: NOT_ACTIONABLE - changing branch protection requires repo-admin access.' }],
      { prompt: 'Triage this issue and report its actionability.' },
    );

    const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 11, describeRun(result));
    assert.match(result.stdout, /SCC_NOT_ACTIONABLE/);
    const manifest = lastManifest(result.stdout);
    assert.equal(manifest.resolution, 'not_actionable');
    assert.equal(manifest.exit_reason, 'no_changes');
    assert.equal(manifest.files_changed, 0);
    assert.equal(chatRequests(provider).length, 1, 'non-mutating prompt: no zero-mutation re-prompts');
  });

  test('VERDICT: BLOCKED (zero mutations) → SCC_BLOCKED + exit 11', async () => {
    const { run } = await setupRun(
      [{ kind: 'message', content: 'VERDICT: BLOCKED - the task is blocked by missing registry credentials.' }],
      { prompt: 'Triage this issue and report its actionability.' },
    );

    const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 11, describeRun(result));
    assert.match(result.stdout, /SCC_BLOCKED/);
    assert.equal(lastManifest(result.stdout).resolution, 'blocked');
  });

  test('not-actionable prose without a verdict marker → exit 11', async () => {
    const { run } = await setupRun(
      [{ kind: 'message', content: 'This failure requires human intervention — repository settings are not editable from code.' }],
      { prompt: 'Triage this issue and report its actionability.' },
    );

    const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 11, describeRun(result));
    assert.match(result.stdout, /SCC_NOT_ACTIONABLE/);
    assert.equal(lastManifest(result.stdout).resolution, 'not_actionable');
  });

  test('persistent empty responses → exit 20', async () => {
    const { provider, run } = await setupRun([{ kind: 'message' }]);

    const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 20, describeRun(result));
    assert.match(result.stderr, /empty response/i);
    const manifest = lastManifest(result.stdout);
    assert.equal(manifest.exit_reason, 'error');
    assert.equal(manifest.terminalResolution, 'provider_error');
    assert.equal(
      chatRequests(provider).length,
      3,
      'the consecutive-empty-response abort fires on the third reply',
    );
  });

  test('missing API key for a known-auth host → exit 21', async () => {
    const { run } = await setupRun([{ kind: 'message', content: 'unreachable' }]);

    const result = await run(['chat', '-q', '--prompt-file', 'prompt.md'], {
      env: { SC_BASE_URL: 'https://api.openai.com/v1', SC_API_KEY: undefined },
    });

    assert.equal(result.code, 21, describeRun(result));
    assert.match(result.stderr, /api.?key/i);
  });

  test('--max-steps budget exhaustion → SC_BUDGET_EXCEEDED + exit 22', async () => {
    const { provider, run } = await setupRun(
      [
        { kind: 'message', toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] },
        { kind: 'message', content: 'unreached' },
      ],
      { prompt: 'List the files in this workspace.' },
    );

    const result = await run(['chat', '-q', '-y', '--max-steps', '1', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 22, describeRun(result));
    assert.match(result.stdout, /SC_BUDGET_EXCEEDED steps/);
    assert.equal(lastManifest(result.stdout).exit_reason, 'budget_exceeded');
    assert.equal(chatRequests(provider).length, 1, 'budget check runs before the next LLM call');
  });

  test('--max-seconds budget exhaustion → SC_BUDGET_EXCEEDED seconds + exit 22', async () => {
    // The seconds dimension needs a reply slower than the budget: a delayed
    // tool-call response lands past the 1s wall-clock bound, the agent loop
    // checks budgets before the next LLM call, and stops gracefully.
    const { provider, run } = await setupRun(
      [
        { kind: 'message', toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }], delayMs: 1_500 },
      ],
      { prompt: 'List the files in this workspace.' },
    );

    const result = await run(['chat', '-q', '-y', '--max-seconds', '1', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 22, describeRun(result));
    assert.match(result.stdout, /SC_BUDGET_EXCEEDED seconds/);
    assert.equal(lastManifest(result.stdout).exit_reason, 'budget_exceeded');
    assert.equal(chatRequests(provider).length, 1, 'the seconds budget fires before the second LLM call');
  });

  test('livelock abort (tool-free responses) → exit 23', async () => {
    const { run } = await setupRun([{ kind: 'message', content: 'Thinking out loud with no tool calls.' }]);

    const result = await run(['chat', '-q', '-y', '--livelock-threshold', '1', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 23, describeRun(result));
    assert.match(result.stderr, /SC_LIVELOCK|tool livelock/i);
    const manifest = lastManifest(result.stdout);
    assert.equal(manifest.exit_reason, 'error');
    assert.equal(manifest.terminalResolution, 'loop_abort');
  });

  test('provider chain exhausted on HTTP 401 → exit 24', async () => {
    const { provider, run } = await setupRun([
      { kind: 'http', status: 401, body: { error: { message: 'Invalid API key', type: 'invalid_api_key' } } },
    ]);

    const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 24, describeRun(result));
    assert.match(result.stderr, /401|exhausted/i);
    const manifest = lastManifest(result.stdout);
    assert.equal(manifest.exit_reason, 'error');
    assert.equal(manifest.terminalResolution, 'provider_error');
    assert.equal(manifest.errorClass, 'auth');
    assert.equal(chatRequests(provider).length, 1, '401 is non-retryable — single attempt');
  });

  test('HTTP 500 retried to the per-candidate bound, then exhausted → exit 24', async () => {
    // Transient 5xx is retryable: the failover contract retries the candidate
    // 3× after the initial attempt (2s→4s→8s backoff, ~14s worst case), then
    // throws ProviderFailoverError → 24 — never collapsing into 20.
    const { provider, run } = await setupRun([
      { kind: 'http', status: 500, body: { error: { message: 'mock server error', type: 'server_error' } } },
    ]);

    const result = await run(['chat', '-q', '-y', '--prompt-file', 'prompt.md'], { timeoutMs: 55_000 });

    assert.equal(result.code, 24, describeRun(result));
    const reqs = chatRequests(provider);
    assert.equal(reqs.length, 4, 'retryable 5xx exhausts the 4-attempt per-candidate bound');
    const manifest = lastManifest(result.stdout);
    assert.equal(manifest.exit_reason, 'error');
    assert.equal(manifest.terminalResolution, 'provider_error');
    assert.equal(manifest.errorClass, 'server_error');
    assert.equal(manifest.attempts?.length, 4);
  });

  posix('SIGTERM mid-request → interrupted manifest + exit 143', async () => {
    // A delayed reply keeps the request in flight; SIGTERM is sent only after
    // the mock confirms it arrived, so the signal handlers in the batch path
    // are already registered (no spawn-timing race).
    const { provider, run } = await setupRun([{ kind: 'message', content: 'slow', delayMs: 15_000 }]);

    let child: ChildProcess | undefined;
    const pending = run(['chat', '-q', '-y', '--prompt-file', 'prompt.md'], {
      timeoutMs: 45_000,
      onSpawn: (c) => {
        child = c;
      },
    });
    await waitFor(() => chatRequests(provider).length > 0, 'mock provider never saw the chat request');
    assert.ok(child, 'child handle was not captured by onSpawn');
    child!.kill('SIGTERM');

    const result = await pending;

    assert.equal(result.code, 143, describeRun(result));
    assert.equal(result.signal, null, 'run should convert SIGTERM to a graceful exit, not die by it');
    assert.equal(lastManifest(result.stdout).exit_reason, 'interrupted');
  });

  test('SSE streaming transport end-to-end (--output-format json) → exit 0', async () => {
    const { ws, provider, run } = await setupRun(
      [
        {
          kind: 'message',
          toolCalls: [{ name: 'write_file', arguments: { path: 'streamed.txt', content: 'streamed\n' } }],
        },
        { kind: 'message', content: 'Done.' },
      ],
      { stream: true, prompt: 'Create streamed.txt with one line.' },
    );

    const result = await run(['chat', '-q', '-y', '--output-format', 'json', '--prompt-file', 'prompt.md']);

    assert.equal(result.code, 0, describeRun(result));
    // --output-format json contract (#399): the manifest is the ONLY stdout output.
    const manifest = JSON.parse(result.stdout.trim()) as RunManifestShape;
    assert.equal(manifest.exit_reason, 'success');
    assert.equal(manifest.tool_calls?.write_file, 1);
    assert.ok(existsSync(join(ws, 'streamed.txt')), 'streamed write_file did not land');
    const first = chatRequests(provider)[0];
    assert.ok(first, 'no /chat/completions call recorded');
    assert.equal(
      (first.json as { stream?: unknown }).stream,
      true,
      'default streaming transport was not exercised',
    );
  });
});
