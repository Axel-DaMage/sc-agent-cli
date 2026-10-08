// E2E smoke — headless `sc chat` against a mock OpenAI-compatible provider
// (#483). Asserts the documented exit-code contract end-to-end through the
// built bin: 0 success, 10 SCC_NO_CHANGES, 20 provider error, 21 auth error,
// 22 SC_BUDGET_EXCEEDED, 23 agent-loop abort, 24 provider chain exhausted.
//
// Notes on the mapping (see src/utils/exit-codes.ts + src/core/failover.ts):
//   * HTTP/transport failures traverse the failover contract and surface as
//     ProviderFailoverError → 24, not 20. Exit 20 is reached via non-failover
//     provider failures (the consecutive-empty-response abort here).
//   * Exit 21 is asserted through config validation — a known-auth host with
//     no key fails before any network call (deterministic, offline).
//
// Requires `npm run build` first — tests spawn `node bin/sc.js`.

import { afterEach, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
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
    opts?: { input?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
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
        env: chatEnv(ws, runOpts.env),
        input: runOpts.input,
        timeoutMs: runOpts.timeoutMs,
      }),
  };
}

function chatRequests(provider: MockProvider) {
  return provider.requests.filter((r) => r.url.endsWith('/chat/completions'));
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
