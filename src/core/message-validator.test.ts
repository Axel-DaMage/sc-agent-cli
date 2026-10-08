import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  MessageValidationError,
  validateMessageSequence,
  autoCorrectMessageSequence,
  isMessageSequenceValid,
} from './message-validator.js';
import type { Message, ToolCall } from './types.js';

// Locks the current repair contract (#482): the validator throws on hard
// errors (orphaned tool_result, duplicate tool_call_id, misplaced system
// messages, tool results with the wrong role), warns — but does not throw —
// on dangling tool_use, and autoCorrect only repairs assistant-role tool
// results before re-validating.

afterEach(() => {
  vi.restoreAllMocks();
});

function toolCall(id: string, name = 'read_file'): ToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

function assistantWithCall(id: string, name = 'read_file'): Message {
  return { role: 'assistant', content: '', tool_calls: [toolCall(id, name)] };
}

function toolResult(id: string, content = 'ok'): Message {
  return { role: 'tool', tool_call_id: id, content };
}

test('a well-formed conversation validates without warnings', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    assistantWithCall('c1'),
    toolResult('c1'),
    { role: 'assistant', content: 'done' },
  ];
  assert.doesNotThrow(() => validateMessageSequence(messages));
  assert.equal(warn.mock.calls.length, 0);
});

test('multiple leading system messages are allowed', () => {
  const messages: Message[] = [
    { role: 'system', content: 'a' },
    { role: 'system', content: 'b' },
    { role: 'user', content: 'hi' },
  ];
  assert.doesNotThrow(() => validateMessageSequence(messages));
});

test('orphaned tool_result (result without matching call) throws', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hi' },
    toolResult('orphan-id'),
  ];
  assert.throws(
    () => validateMessageSequence(messages),
    (err: unknown) => {
      assert.ok(err instanceof MessageValidationError);
      const e = err as MessageValidationError;
      assert.equal(e.messageIndex, 1);
      assert.equal(e.invalidMessage, messages[1]);
      assert.match(e.message, /unknown tool_call_id 'orphan-id'/);
      assert.equal(e.name, 'MessageValidationError');
      return true;
    }
  );
});

test('tool result with a role other than tool throws (OpenAI spec violation)', () => {
  for (const role of ['user', 'system'] as const) {
    const messages: Message[] = [{ role, tool_call_id: 'c1', content: 'x' }];
    assert.throws(
      () => validateMessageSequence(messages),
      (err: unknown) => {
        assert.ok(err instanceof MessageValidationError);
        assert.match((err as Error).message, new RegExp(`role:'tool', not role:'${role}'`));
        return true;
      }
    );
  }
});

test('autoCorrectMessageSequence rewrites assistant-role tool results to role tool', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const messages: Message[] = [
    assistantWithCall('c1'),
    { role: 'assistant', tool_call_id: 'c1', content: 'file contents' },
  ];

  const corrected = autoCorrectMessageSequence(messages);
  assert.equal(corrected.length, 2);
  assert.equal(corrected[1].role, 'tool');
  assert.equal(corrected[1].tool_call_id, 'c1');
  assert.equal(corrected[1].content, 'file contents');
  assert.match(warn.mock.calls.map((c) => String(c[0])).join('\n'), /Auto-correcting/);
});

test('autoCorrect still throws on an orphaned assistant-role tool result', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const messages: Message[] = [{ role: 'assistant', tool_call_id: 'gone', content: 'x' }];
  assert.throws(() => autoCorrectMessageSequence(messages), MessageValidationError);
});

test('dangling tool_use (call without result) warns but does not throw', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const messages: Message[] = [
    { role: 'user', content: 'hi' },
    assistantWithCall('c1', 'run_shell'),
    assistantWithCall('c2', 'read_file'),
  ];
  assert.doesNotThrow(() => validateMessageSequence(messages));
  const out = warn.mock.calls.map((c) => String(c[0])).join('\n');
  assert.match(out, /2 tool calls without results/);
  assert.match(out, /run_shell \(index 1\)/);
  assert.match(out, /read_file \(index 2\)/);
});

test('duplicate tool_call_id across assistant messages throws', () => {
  const messages: Message[] = [
    assistantWithCall('dup'),
    assistantWithCall('dup'),
  ];
  assert.throws(
    () => validateMessageSequence(messages),
    /Duplicate tool_call_id 'dup'/
  );
});

test('a resolved tool_call_id can be re-issued — it re-registers as pending', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const messages: Message[] = [
    assistantWithCall('c1'),
    toolResult('c1'),
    assistantWithCall('c1'),
  ];
  // The result consumed the pending entry, so the second call registers
  // cleanly — it is only flagged because it never gets a result itself.
  assert.doesNotThrow(() => validateMessageSequence(messages));
  assert.match(warn.mock.calls.map((c) => String(c[0])).join('\n'), /1 tool calls? without results/);
});

test('system message after non-system messages throws', () => {
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'late sys' },
  ];
  assert.throws(
    () => validateMessageSequence(messages),
    (err: unknown) => {
      assert.ok(err instanceof MessageValidationError);
      assert.equal((err as MessageValidationError).messageIndex, 2);
      assert.match((err as Error).message, /System message found after non-system/);
      return true;
    }
  );
});

test('isMessageSequenceValid returns true for valid and warn-only sequences', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  assert.equal(isMessageSequenceValid([{ role: 'user', content: 'hi' }]), true);
  // Dangling tool_use is a warning, not an error — the sequence is "valid".
  assert.equal(isMessageSequenceValid([assistantWithCall('c1')]), true);
});

test('isMessageSequenceValid returns false for invalid sequences without throwing', () => {
  assert.equal(
    isMessageSequenceValid([{ role: 'user', content: 'hi', tool_call_id: 'x' }]),
    false
  );
  assert.equal(isMessageSequenceValid([toolResult('nope')]), false);
});

test('a tool result that arrives before its call is still orphaned', () => {
  const messages: Message[] = [
    toolResult('c1'),
    assistantWithCall('c1'),
  ];
  assert.throws(() => validateMessageSequence(messages), /unknown tool_call_id/);
  assert.throws(() => autoCorrectMessageSequence(messages), MessageValidationError);
});

test('autoCorrectMessageSequence passes a valid sequence through unchanged', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hi' },
    assistantWithCall('c1'),
    toolResult('c1'),
    { role: 'assistant', content: 'done' },
  ];
  const corrected = autoCorrectMessageSequence(messages);
  assert.deepEqual(corrected, messages);
});
