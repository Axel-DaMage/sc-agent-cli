import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyError, EXIT_CODES } from './exit-codes.js';
import { ProviderError, ProviderCascadeError } from '../core/provider-error.js';

test('classifyError: auth errors → 21', () => {
  for (const msg of [
    'Request failed with status 401',
    'provider returned 403 Forbidden',
    'Invalid API key provided',
    'NVIDIA API requires an API key. Set model.apiKey in config',
    'authentication failed',
  ]) {
    assert.equal(classifyError(new Error(msg)), EXIT_CODES.AUTH_ERROR, msg);
  }
});

test('classifyError: provider errors → 20', () => {
  for (const msg of [
    'Model returned empty response 5 times in 3 iterations',
    'fetch failed',
    'Connection timeout after 60000ms',
    'read ECONNRESET',
    'Request failed with status 502',
    'rate limit exceeded',
    'API Error 429: too many requests',
  ]) {
    assert.equal(classifyError(new Error(msg)), EXIT_CODES.PROVIDER_ERROR, msg);
  }
});

test('classifyError: structured failureClass beats message sniffing (#425)', () => {
  // A 400-class message whose structured class is transient → provider error
  assert.equal(
    classifyError(new ProviderError('request failed', 'server', 503)),
    EXIT_CODES.PROVIDER_ERROR
  );
  assert.equal(
    classifyError(new ProviderError('API Error 429: slow down', 'rate_limit', 429)),
    EXIT_CODES.PROVIDER_ERROR
  );
  assert.equal(
    classifyError(new ProviderError('Connection timed out', 'timeout')),
    EXIT_CODES.PROVIDER_ERROR
  );
  assert.equal(
    classifyError(new ProviderError('token expired', 'auth', 401)),
    EXIT_CODES.AUTH_ERROR
  );
  // Terminal failure of an exhausted cascade drives the exit code
  assert.equal(
    classifyError(new ProviderCascadeError([
      { label: 'primary', model: 'a', baseUrl: 'http://x/v1', failureClass: 'server', error: 'API Error 503' },
      { label: 'fallback', model: 'b', baseUrl: 'http://y/v1', failureClass: 'auth', error: 'API Error 401' },
    ])),
    EXIT_CODES.AUTH_ERROR
  );
  // Non-taxonomy classes fall through to message matching
  assert.equal(
    classifyError(new ProviderError('API Error 400: bad request', 'client', 400)),
    EXIT_CODES.ERROR
  );
});

test('classifyError: livelock → 23', () => {
  assert.equal(
    classifyError(new Error('[SC_LIVELOCK] Model produced 3 consecutive responses without tool calls')),
    EXIT_CODES.LOOP_ABORT
  );
});

test('classifyError: auth takes precedence over generic provider patterns', () => {
  assert.equal(classifyError(new Error('Request timeout; server replied 401')), EXIT_CODES.AUTH_ERROR);
});

test('classifyError: unknown → 1', () => {
  assert.equal(classifyError(new Error('something weird happened')), EXIT_CODES.ERROR);
  assert.equal(classifyError('a string error'), EXIT_CODES.ERROR);
});
