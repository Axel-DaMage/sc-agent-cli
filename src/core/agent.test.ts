import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { pruneMessageHistory, limitMessageHistory, Agent } from './agent.js';
import type { Message } from './types.js';

test('Agent.run forwards configured non-streaming mode to the provider', async () => {
  const agent = new Agent({
    workspaceRoot: process.cwd(), quiet: true, autoApprove: true,
    config: { model: { provider: 'openai-compatible', baseUrl: 'http://test.api/v1', model: 'test', stream: false } },
  });
  const calls: boolean[] = [];
  vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async (options) => {
    calls.push(options.stream === true);
    return { content: 'done' };
  });
  await agent.run('test');
  assert.deepEqual(calls, [false]);
});

test('pruneMessageHistory keeps recent tool messages fully intact and truncates old ones', () => {
  const messages: Message[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello' },
    { role: 'tool', content: 'a'.repeat(2000), tool_call_id: '1' }, // old, should be truncated
    { role: 'tool', content: 'b'.repeat(2000), tool_call_id: '2' }, // old, should be truncated
    ...Array.from({ length: 10 }, (_, i) => ({
      role: 'tool' as const,
      content: 'recent_' + i,
      tool_call_id: `recent_${i}`,
    })),
  ];

  const pruned = pruneMessageHistory(messages, 10, 1000);
  
  // The first two tool messages should be truncated
  assert.match(pruned[2].content, /truncated to save context window/);
  assert.match(pruned[3].content, /truncated to save context window/);
  
  // The recent 10 tool messages should remain fully intact
  for (let i = 0; i < 10; i++) {
    assert.equal(pruned[4 + i].content, 'recent_' + i);
  }
});

test('limitMessageHistory preserves system message and slices at safe points', () => {
  // Scenario 1: Slicing on an assistant message (within a tool chain)
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'original user prompt' },
    { role: 'assistant', content: 'thought 1' },
    { role: 'tool', content: 'tool result 1', tool_call_id: 't1' },
    { role: 'assistant', content: 'thought 2' },
    { role: 'tool', content: 'tool result 2', tool_call_id: 't2' },
    { role: 'assistant', content: 'thought 3' },
    { role: 'tool', content: 'tool result 3', tool_call_id: 't3' },
  ];

  // We want to limit history to 4 messages
  const limited = limitMessageHistory(messages, 4);

  assert.equal(limited.length, 6);
  assert.equal(limited[0].role, 'system');
  assert.equal(limited[1].role, 'user');
  assert.equal(limited[1].content, 'original user prompt');
  assert.equal(limited[2].role, 'assistant');
  assert.equal(limited[2].content, 'thought 2');
});

test('limitMessageHistory slices safely when targetStartIndex lands on a tool response', () => {
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'original prompt' },
    { role: 'assistant', content: 'thought 1' },
    { role: 'tool', content: 'tool result 1', tool_call_id: 't1' },
    { role: 'assistant', content: 'thought 2' },
    { role: 'tool', content: 'tool result 2', tool_call_id: 't2' },
  ];

  const limited = limitMessageHistory(messages, 3);

  assert.equal(limited.length, 6);
  assert.equal(limited[0].role, 'system');
  assert.equal(limited[1].content, 'original prompt');
  assert.equal(limited[2].content, 'thought 1');
});

test('Agent.run self-heals when model outputs future intention in autoApprove mode without tool calls', async () => {
  const agent = new Agent({
    workspaceRoot: process.cwd(),
    autoApprove: true,
    quiet: true,
    config: {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'http://test.api/v1',
        model: 'test-model',
      }
    }
  });

  let callCount = 0;
  const mockChatCompletion = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async (params) => {
    callCount++;
    if (callCount === 1) {
      // Long response with future intention (not conversational) should trigger self-heal
      return { content: 'I need to investigate the build errors in your project. I will list the files in this directory first and then check the configuration to diagnose the compilation issues.' };
    }
    return { content: 'Task completed!' };
  });

  const result = await agent.run('Fix the build errors');

  assert.equal(callCount, 2);
  const hasSelfHeal = result.some(m => m.role === 'user' && m.content.includes('SELF-HEAL'));
  assert.ok(hasSelfHeal, 'Should have injected SELF-HEAL nudge');

  mockChatCompletion.mockRestore();
});

test('Agent.run throws after 3 consecutive empty responses', async () => {
  const agent = new Agent({
    workspaceRoot: process.cwd(),
    autoApprove: true,
    quiet: true,
    config: {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'http://test.api/v1',
        model: 'test-model',
      }
    }
  });

  let callCount = 0;
  const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
    callCount++;
    return { content: '' };
  });

  await assert.rejects(
    () => agent.run('test'),
    /Model returned empty response 3 times in 3 iterations/
  );

  assert.equal(callCount, 3);
  mock.mockRestore();
});

test('Agent.run throws after 5 total empty responses across tool call resets (oscillation pattern)', async () => {
  const agent = new Agent({
    workspaceRoot: process.cwd(),
    autoApprove: true,
    quiet: true,
    config: {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'http://test.api/v1',
        model: 'test-model',
      }
    }
  });

  let callCount = 0;
  const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
    callCount++;
    if (callCount % 2 === 0) {
      // Even calls: return tool call to reset consecutive counter (simulating tool→empty oscillation)
      return {
        content: '',
        tool_calls: [{
          id: `call_${callCount}`,
          type: 'function' as const,
          function: { name: '_oscillation_test_tool_', arguments: '{}' }
        }]
      };
    }
    // Odd calls: empty response
    return { content: '' };
  });

  // 9 iterations: 5 empty (odd: 1,3,5,7,9) + 4 tool calls (even: 2,4,6,8)
  // Total empties = 5 → threshold exceeded ≈ catches oscillation where consecutive resets
  await assert.rejects(
    () => agent.run('test'),
    /Model returned empty response 5 times in 9 iterations/
  );

  assert.equal(callCount, 9);
  mock.mockRestore();
});

test('Agent.run recovers after a single empty response', async () => {
  const agent = new Agent({
    workspaceRoot: process.cwd(),
    autoApprove: true,
    quiet: true,
    config: {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'http://test.api/v1',
        model: 'test-model',
      }
    }
  });

  let callCount = 0;
  const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      return { content: '' };
    }
    return { content: 'Task completed successfully!' };
  });

  const result = await agent.run('test');

  assert.equal(callCount, 2);
  assert.ok(result.some(m => m.role === 'assistant' && m.content === 'Task completed successfully!'));
  mock.mockRestore();
});
