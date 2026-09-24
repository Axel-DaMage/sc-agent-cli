import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyError, EXIT_CODES } from './exit-codes.js';

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

test('classifyError: unknown → 1', () => {
  assert.equal(classifyError(new Error('something weird happened')), EXIT_CODES.ERROR);
  assert.equal(classifyError('a string error'), EXIT_CODES.ERROR);
});
