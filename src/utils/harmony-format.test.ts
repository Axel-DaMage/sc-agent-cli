import { test } from 'vitest';
import assert from 'node:assert/strict';
import { hasHarmonyMarkup, recoverHarmonyToolCalls } from './harmony-format.js';

test('hasHarmonyMarkup detects channel markup', () => {
  assert.equal(hasHarmonyMarkup('<|channel|>commentary<|message|>{}'), true);
  assert.equal(hasHarmonyMarkup('plain text'), false);
  assert.equal(hasHarmonyMarkup(''), false);
  assert.equal(hasHarmonyMarkup(undefined), false);
});

test('recovers tool call with to=functions.<name> and JSON args', () => {
  const content = '<|channel|>commentary to=functions.read_file<|message|>{"path":"a.ts","offset":10}';
  const calls = recoverHarmonyToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'a.ts', offset: 10 });
  assert.equal(calls[0].type, 'function');
  assert.ok(calls[0].id.startsWith('harmony_'));
});

test('recovers tool call with bare to=<name> (no functions. prefix)', () => {
  const content = '<|channel|>commentary to=run_shell<|message|>{"command":"ls"}<|end|>';
  const calls = recoverHarmonyToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'run_shell');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: 'ls' });
});

test('recovers multiple tool calls from one content block', () => {
  const content =
    '<|channel|>commentary to=functions.read_file<|message|>{"path":"a.ts"}' +
    '<|channel|>commentary to=functions.list_dir<|message|>{"path":"."}';
  const calls = recoverHarmonyToolCalls(content);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, 'read_file');
  assert.equal(calls[1].function.name, 'list_dir');
});

test('skips blocks without a to= target (analysis channels are not tools)', () => {
  const content = '<|channel|>commentary<|message|>{"path":"a.ts","offset":500,"limit":200}';
  assert.equal(recoverHarmonyToolCalls(content).length, 0);
});

test('skips analysis/thinking channels', () => {
  const content = '<|channel|>analysis<|message|>I should read the file first.<|end|>';
  assert.equal(recoverHarmonyToolCalls(content).length, 0);
});

test('wraps non-JSON payload as { input } argument', () => {
  const content = '<|channel|>commentary to=functions.run_shell<|message|>ls -la';
  const calls = recoverHarmonyToolCalls(content);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { input: 'ls -la' });
});

test('returns empty for normal content and empty payload', () => {
  assert.equal(recoverHarmonyToolCalls('The file has been updated.').length, 0);
  assert.equal(recoverHarmonyToolCalls('<|channel|>commentary to=functions.x<|message|>').length, 0);
});

test('mixed text + harmony block still recovers the call', () => {
  const content =
    'Let me read that file for you.\n' +
    '<|channel|>commentary to=functions.search_text<|message|>{"pattern":"TODO"}<|end|>';
  const calls = recoverHarmonyToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'search_text');
});
