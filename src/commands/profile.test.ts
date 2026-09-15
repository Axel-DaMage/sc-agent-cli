import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isPromptCancelled, normalizeProfileName } from './profile.js';

test('isPromptCancelled only treats undefined as cancellation', () => {
  assert.equal(isPromptCancelled(undefined), true);
  assert.equal(isPromptCancelled(''), false);
  assert.equal(isPromptCancelled('ollama'), false);
});

test('normalizeProfileName trims valid names and rejects blank input', () => {
  assert.equal(normalizeProfileName('  ollama  '), 'ollama');
  assert.equal(normalizeProfileName('   '), undefined);
  assert.equal(normalizeProfileName(undefined), undefined);
});
