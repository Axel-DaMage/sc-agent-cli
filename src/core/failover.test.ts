import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  ProviderFailoverError,
  ProviderHttpError,
  ProviderTimeoutError,
  classifyProviderError,
  computeRetryDelay,
  resolveFailoverChain,
  resolveProviderTimeouts,
} from './failover.js';
import { EXIT_CODES, classifyError } from '../utils/exit-codes.js';
import type { ProjectConfig } from './types.js';

const ENV_KEYS = [
  'SC_FAILOVER',
  'SC_PROVIDER_CONNECT_TIMEOUT_MS',
  'SC_PROVIDER_ATTEMPT_TIMEOUT_MS',
  'SC_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NVIDIA_API_KEY',
];

let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envBackup[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    model: {
      provider: 'openai-compatible',
      baseUrl: 'http://test.api/v1',
      model: 'test-model',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Timeout contract
// ---------------------------------------------------------------------------

test('resolveProviderTimeouts defaults to 30s connect / 120s attempt', () => {
  const t = resolveProviderTimeouts(makeConfig().model);
  assert.equal(t.connectMs, DEFAULT_CONNECT_TIMEOUT_MS);
  assert.equal(t.attemptMs, DEFAULT_ATTEMPT_TIMEOUT_MS);
});

test('resolveProviderTimeouts honors env overrides', () => {
  process.env.SC_PROVIDER_CONNECT_TIMEOUT_MS = '5000';
  process.env.SC_PROVIDER_ATTEMPT_TIMEOUT_MS = '90000';
  const t = resolveProviderTimeouts(makeConfig().model);
  assert.equal(t.connectMs, 5000);
  assert.equal(t.attemptMs, 90000);
});

test('resolveProviderTimeouts: explicit model.timeout wins over env; connect never exceeds attempt', () => {
  process.env.SC_PROVIDER_ATTEMPT_TIMEOUT_MS = '90000';
  const t = resolveProviderTimeouts({ ...makeConfig().model, timeout: 5000 });
  assert.equal(t.attemptMs, 5000);
  assert.equal(t.connectMs, 5000); // capped at attempt bound
});

test('resolveProviderTimeouts ignores malformed env values', () => {
  process.env.SC_PROVIDER_CONNECT_TIMEOUT_MS = 'abc';
  process.env.SC_PROVIDER_ATTEMPT_TIMEOUT_MS = '-5';
  const t = resolveProviderTimeouts(makeConfig().model);
  assert.equal(t.connectMs, DEFAULT_CONNECT_TIMEOUT_MS);
  assert.equal(t.attemptMs, DEFAULT_ATTEMPT_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test('computeRetryDelay follows 2s→4s→8s with +20% jitter and an 8s cap', () => {
  const zero = () => 0;
  assert.equal(computeRetryDelay(0, zero), 2000);
  assert.equal(computeRetryDelay(1, zero), 4000);
  assert.equal(computeRetryDelay(2, zero), 8000);
  assert.equal(computeRetryDelay(3, zero), 8000); // capped

  const max = () => 1;
  assert.equal(computeRetryDelay(0, max), 2400);
  assert.equal(computeRetryDelay(1, max), 4800);
  assert.equal(computeRetryDelay(2, max), 8000); // jitter cannot exceed cap

  const half = () => 0.5;
  for (let i = 0; i < 6; i++) {
    const d = computeRetryDelay(i, half);
    assert.ok(d > 0 && d <= 8000, `delay ${d} out of bounds at index ${i}`);
  }
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test('classifyProviderError: 429 → rate_limit retryable', () => {
  const info = classifyProviderError(new ProviderHttpError(429, 'slow down'));
  assert.equal(info.errorClass, 'rate_limit');
  assert.equal(info.retryable, true);
  assert.equal(info.status, 429);
});

test('classifyProviderError: 500/502/503/504 → server_error retryable', () => {
  for (const status of [500, 502, 503, 504]) {
    const info = classifyProviderError(new ProviderHttpError(status, 'oops'));
    assert.equal(info.errorClass, 'server_error', `${status}`);
    assert.equal(info.retryable, true, `${status}`);
  }
});

test('classifyProviderError: other 5xx → server_error non-retryable', () => {
  const info = classifyProviderError(new ProviderHttpError(501, 'not implemented'));
  assert.equal(info.errorClass, 'server_error');
  assert.equal(info.retryable, false);
});

test('classifyProviderError: 401/403 → auth non-retryable; 400 → client non-retryable', () => {
  for (const status of [401, 403]) {
    const info = classifyProviderError(new ProviderHttpError(status, 'no'));
    assert.equal(info.errorClass, 'auth', `${status}`);
    assert.equal(info.retryable, false, `${status}`);
  }
  const badModel = classifyProviderError(new ProviderHttpError(400, 'model "x" is not supported'));
  assert.equal(badModel.errorClass, 'client');
  assert.equal(badModel.retryable, false);
});

test('classifyProviderError: timeout expiry → retryable transport failure', () => {
  for (const phase of ['connect', 'attempt'] as const) {
    const info = classifyProviderError(new ProviderTimeoutError(phase, 30000));
    assert.equal(info.errorClass, 'timeout');
    assert.equal(info.retryable, true);
  }
});

test('classifyProviderError: socket-level errors → transport retryable', () => {
  const reset = new TypeError('fetch failed');
  (reset as { cause?: unknown }).cause = { code: 'ECONNRESET' };
  assert.equal(classifyProviderError(reset).errorClass, 'transport');
  assert.equal(classifyProviderError(reset).retryable, true);

  const refused = new TypeError('fetch failed');
  (refused as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
  assert.equal(classifyProviderError(refused).errorClass, 'transport');

  const timed = new Error('read ETIMEDOUT');
  assert.equal(classifyProviderError(timed).errorClass, 'timeout');

  const generic = new Error('something unrelated');
  const g = classifyProviderError(generic);
  assert.equal(g.errorClass, 'unknown');
  assert.equal(g.retryable, false);
});

// ---------------------------------------------------------------------------
// Failover chain resolution
// ---------------------------------------------------------------------------

test('resolveFailoverChain: empty SC_FAILOVER → single configured model', () => {
  const chain = resolveFailoverChain(makeConfig());
  assert.equal(chain.length, 1);
  assert.equal(chain[0].id, 'custom/test-model');
  assert.equal(chain[0].model.model, 'test-model');
  assert.equal(chain[0].model.baseUrl, 'http://test.api/v1');
});

test('resolveFailoverChain: csv order preserved; provider names resolve via known URLs', () => {
  process.env.SC_FAILOVER = 'openai/gpt-4o-mini, anthropic/claude-test';
  const chain = resolveFailoverChain(makeConfig());
  assert.equal(chain.length, 3);
  assert.equal(chain[1].id, 'openai/gpt-4o-mini');
  assert.equal(chain[1].model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(chain[1].model.model, 'gpt-4o-mini');
  assert.equal(chain[2].id, 'anthropic/claude-test');
  assert.equal(chain[2].model.baseUrl, 'https://api.anthropic.com/v1');
});

test('resolveFailoverChain: provider name resolves against config.profiles first', () => {
  process.env.SC_FAILOVER = 'corp/their-model';
  const chain = resolveFailoverChain(makeConfig({
    profiles: { corp: { baseUrl: 'http://corp.internal/v2', apiKey: 'corp-key' } },
  }));
  assert.equal(chain.length, 2);
  assert.equal(chain[1].id, 'corp/their-model');
  assert.equal(chain[1].model.baseUrl, 'http://corp.internal/v2');
  assert.equal(chain[1].model.apiKey, 'corp-key');
  assert.equal(chain[1].model.model, 'their-model');
});

test('resolveFailoverChain: bare token swaps only the model on the configured endpoint', () => {
  process.env.SC_FAILOVER = 'llama3.1';
  const chain = resolveFailoverChain(makeConfig());
  assert.equal(chain.length, 2);
  assert.equal(chain[1].model.baseUrl, 'http://test.api/v1');
  assert.equal(chain[1].model.model, 'llama3.1');
});

test('resolveFailoverChain: slash in model id is preserved when prefix resolves nowhere', () => {
  process.env.SC_FAILOVER = 'meta/llama-3.3-70b-instruct';
  const chain = resolveFailoverChain(makeConfig());
  assert.equal(chain.length, 2);
  // 'meta' is neither a profile nor a known provider → whole token is the
  // model id on the configured endpoint (e.g. NVIDIA model names).
  assert.equal(chain[1].model.model, 'meta/llama-3.3-70b-instruct');
  assert.equal(chain[1].model.baseUrl, 'http://test.api/v1');
});

test('resolveFailoverChain: malformed and duplicate entries collapse', () => {
  process.env.SC_FAILOVER = 'openai/, ,test-model';
  // 'openai/' has no model id → skipped; bare 'test-model' resolves to the
  // same baseUrl+model as the primary → deduped.
  const chain = resolveFailoverChain(makeConfig());
  assert.equal(chain.length, 1);
});

test('resolveFailoverChain: primary credential is not leaked to a different host', () => {
  process.env.SC_FAILOVER = 'openai/gpt-x';
  const cfg = makeConfig();
  cfg.model.apiKey = 'primary-secret';
  const chain = resolveFailoverChain(cfg);
  assert.equal(chain[1].model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(chain[1].model.apiKey, undefined);
});

test('resolveFailoverChain: SC_API_KEY and host-matched env keys fill candidates', () => {
  process.env.SC_FAILOVER = 'openai/gpt-x,anthropic/claude-x';
  process.env.OPENAI_API_KEY = 'openai-key';
  const chain = resolveFailoverChain(makeConfig());
  assert.equal(chain[1].model.apiKey, 'openai-key');
  assert.equal(chain[2].model.apiKey, undefined); // no anthropic key available

  process.env.SC_API_KEY = 'global-key';
  const chain2 = resolveFailoverChain(makeConfig());
  assert.equal(chain2[1].model.apiKey, 'global-key');
  assert.equal(chain2[2].model.apiKey, 'global-key');
});

test('resolveFailoverChain: placeholder profile keys are cleaned, not forwarded', () => {
  process.env.SC_FAILOVER = 'anthropic/claude-x';
  const chain = resolveFailoverChain(makeConfig({
    profiles: { anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKey: '<YOUR_ANTHROPIC_KEY>' } },
  }));
  assert.equal(chain[1].model.apiKey, undefined);
});

// ---------------------------------------------------------------------------
// Terminal error → exit code contract
// ---------------------------------------------------------------------------

test('ProviderFailoverError maps to exit code 24 and carries attempts + errorClass', () => {
  const err = new ProviderFailoverError([
    { candidate: 'a/m1', attempt: 4, errorClass: 'server_error', retryable: true, status: 503, error: 'API Error 503: down', durationMs: 10 },
  ], 'server_error');

  assert.equal(err.name, 'ProviderFailoverError');
  assert.equal(err.exitCode, EXIT_CODES.PROVIDER_EXHAUSTED);
  assert.equal(err.errorClass, 'server_error');
  assert.equal(err.attempts.length, 1);
  assert.match(err.message, /API Error 503/);
  assert.equal(classifyError(err), 24);
});

test('classifyError prefers a declared exitCode over message patterns', () => {
  // A failover error whose last attempt was a 401 must still exit 24 (the
  // chain was exhausted), not 21.
  const err = new ProviderFailoverError([
    { candidate: 'a/m1', attempt: 1, errorClass: 'auth', retryable: false, status: 401, error: 'API Error 401: denied', durationMs: 5 },
  ], 'auth');
  assert.equal(classifyError(err), 24);
});
