import { test } from 'vitest';
import assert from 'node:assert/strict';
import { getModelProfileEmptyStateGuidance } from './chat-session-guidance.js';

test('getModelProfileEmptyStateGuidance explains how to recover from missing profiles', () => {
  assert.deepEqual(getModelProfileEmptyStateGuidance(), [
    'No model profiles available.',
    '  • Run "sc config-init" in another terminal to create the default profiles',
    '  • Or add one with "sc profile add <name>"',
    '  • Then return here and run "/reload"',
  ]);
});
