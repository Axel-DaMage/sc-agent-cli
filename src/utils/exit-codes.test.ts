import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyError, EXIT_CODES } from './exit-codes.js';
import { ProviderFailoverError } from '../core/failover.js';

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
  ]) {
    assert.equal(classifyError(new Error(msg)), EXIT_CODES.PROVIDER_ERROR, msg);
  }
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

test('classifyError: failover chain exhausted → 24', () => {
  const err = new ProviderFailoverError([
    { candidate: 'openai/gpt-4o', attempt: 4, errorClass: 'server_error', retryable: true, status: 503, error: 'API Error 503: down', durationMs: 10 },
  ], 'server_error');
  assert.equal(classifyError(err), EXIT_CODES.PROVIDER_EXHAUSTED);
});

test('classifyError: declared exitCode beats auth-looking message content', () => {
  // A failover error ending on a 401 is still "chain exhausted" (24), not 21.
  const err = new ProviderFailoverError([
    { candidate: 'openai/gpt-4o', attempt: 1, errorClass: 'auth', retryable: false, status: 401, error: 'API Error 401: denied', durationMs: 5 },
  ], 'auth');
  assert.equal(classifyError(err), EXIT_CODES.PROVIDER_EXHAUSTED);
});

test('classifyError: unknown → 1', () => {
  assert.equal(classifyError(new Error('something weird happened')), EXIT_CODES.ERROR);
  assert.equal(classifyError('a string error'), EXIT_CODES.ERROR);
});
