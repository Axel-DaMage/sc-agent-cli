import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from './provider.js';
import { ProviderFailoverError } from './failover.js';
import { EXIT_CODES } from '../utils/exit-codes.js';
import type { ModelConfig } from './types.js';
import type { FailoverCandidate } from './failover.js';

// Keep the retry contract's real implementation but collapse the backoff
// sleeps — tests assert the retry bound, not wall-clock pacing.
vi.mock('./failover.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./failover.js')>();
  return { ...mod, computeRetryDelay: () => 1 };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://primary.test/v1',
    model: 'primary-model',
    ...overrides,
  };
}

function candidate(id: string, baseUrl: string, model: string, extra: Partial<ModelConfig> = {}): FailoverCandidate {
  return { id, model: { provider: 'openai-compatible', baseUrl, model, ...extra } };
}

function okResponse(content = 'ok') {
  return {
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  } as Response;
}

function errResponse(status: number, text = 'failure') {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

const CHAIN: FailoverCandidate[] = [
  candidate('a/m1', 'http://a.test/v1', 'm1'),
  candidate('b/m2', 'http://b.test/v1', 'm2'),
];

function fetchByUrl(handlers: Array<[hostPrefix: string, impl: () => Promise<Response> | Response]>) {
  const urls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    urls.push(url);
    for (const [prefix, impl] of handlers) {
      if (url.startsWith(prefix)) return impl();
    }
    return errResponse(500, 'unmatched-url');
  });
  return { urls, spy };
}

test('cascade: retryable exhaustion on candidate A advances to candidate B', async () => {
  const { urls } = fetchByUrl([
    ['http://a.test', () => errResponse(500)],
    ['http://b.test', () => okResponse('from-b')],
  ]);

  const provider = new OpenAICompatibleProvider(makeConfig());
  provider.setFailoverChain(CHAIN);
  const result = await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: false });

  assert.equal(result.content, 'from-b');
  assert.equal(provider.providerUsed, 'b/m2');
  assert.equal(urls.filter(u => u.startsWith('http://a.test')).length, 4, 'A gets 1 initial + 3 retries');
  assert.equal(urls.filter(u => u.startsWith('http://b.test')).length, 1);

  const attempts = provider.failoverAttempts;
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every(a => a.candidate === 'a/m1' && a.errorClass === 'server_error' && a.retryable));
  assert.deepEqual(attempts.map(a => a.attempt), [1, 2, 3, 4]);
});

test('cascade: non-retryable error advances immediately (no retries burned)', async () => {
  const { urls } = fetchByUrl([
    ['http://a.test', () => errResponse(401, 'unauthorized')],
    ['http://b.test', () => okResponse('from-b')],
  ]);

  const provider = new OpenAICompatibleProvider(makeConfig());
  provider.setFailoverChain(CHAIN);
  const result = await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: false });

  assert.equal(result.content, 'from-b');
  assert.equal(urls.filter(u => u.startsWith('http://a.test')).length, 1, '401 must not be retried');
  assert.equal(provider.failoverAttempts.length, 1);
  assert.equal(provider.failoverAttempts[0].errorClass, 'auth');
  assert.equal(provider.failoverAttempts[0].retryable, false);
});

test('cascade: 429 rate-limit retries within the candidate, then succeeds', async () => {
  let calls = 0;
  fetchByUrl([
    ['http://a.test', () => (++calls < 3 ? errResponse(429, 'rate limited') : okResponse('from-a'))],
  ]);

  const provider = new OpenAICompatibleProvider(makeConfig());
  provider.setFailoverChain(CHAIN);
  const result = await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: false });

  assert.equal(result.content, 'from-a');
  assert.equal(calls, 3);
  assert.equal(provider.providerUsed, 'a/m1');
});

test('cascade: all candidates exhausted → ProviderFailoverError with attempts + exit 24', async () => {
  fetchByUrl([
    ['http://a.test', () => errResponse(503)],
    ['http://b.test', () => errResponse(500)],
  ]);

  const provider = new OpenAICompatibleProvider(makeConfig());
  provider.setFailoverChain(CHAIN);

  await assert.rejects(
    provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderFailoverError, `expected ProviderFailoverError, got ${err}`);
      const fe = err as ProviderFailoverError;
      assert.equal(fe.exitCode, EXIT_CODES.PROVIDER_EXHAUSTED);
      assert.equal(fe.errorClass, 'server_error');
      assert.equal(fe.attempts.length, 8, '4 attempts per candidate × 2 candidates');
      assert.equal(fe.attempts.filter(a => a.candidate === 'a/m1').length, 4);
      assert.equal(fe.attempts.filter(a => a.candidate === 'b/m2').length, 4);
      return true;
    }
  );
});

test('cascade: sticky cursor — after failover, later calls skip the dead candidate', async () => {
  const { urls } = fetchByUrl([
    ['http://a.test', () => errResponse(500)],
    ['http://b.test', () => okResponse('from-b')],
  ]);

  const provider = new OpenAICompatibleProvider(makeConfig());
  provider.setFailoverChain(CHAIN);

  await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: false });
  const aCallsAfterFirst = urls.filter(u => u.startsWith('http://a.test')).length;
  assert.equal(aCallsAfterFirst, 4);

  await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi again' }], stream: false });
  assert.equal(urls.filter(u => u.startsWith('http://a.test')).length, aCallsAfterFirst, 'A must not be retried on the next call');
  assert.equal(urls.filter(u => u.startsWith('http://b.test')).length, 2);
});

test('timeouts: attempt expiry is a retryable transport failure', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
    })
  ) as typeof fetch);

  const provider = new OpenAICompatibleProvider(makeConfig());
  provider.setFailoverChain([candidate('a/m1', 'http://a.test/v1', 'm1', { timeout: 50 })]);

  await assert.rejects(
    provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderFailoverError);
      const fe = err as ProviderFailoverError;
      assert.equal(fe.errorClass, 'timeout');
      assert.equal(fe.attempts.length, 4, 'timeout expiry must be retried to the bound');
      assert.ok(fe.attempts.every(a => a.errorClass === 'timeout' && a.retryable));
      return true;
    }
  );
});

test('single-candidate chain failure still produces the structured failover error', async () => {
  fetchByUrl([['http://primary.test', () => errResponse(400, 'unsupported model')]]);

  const provider = new OpenAICompatibleProvider(makeConfig());
  // default chain: just the configured model
  await assert.rejects(
    provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderFailoverError);
      const fe = err as ProviderFailoverError;
      assert.equal(fe.errorClass, 'client');
      assert.equal(fe.attempts.length, 1, '400 is non-retryable — no retries burned');
      assert.equal(fe.attempts[0].candidate, 'custom/primary-model');
      return true;
    }
  );
});
