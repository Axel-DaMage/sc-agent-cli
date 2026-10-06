import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { pruneMessageHistory, limitMessageHistory, Agent } from './agent.js';
import { resolveRole, phasePolicy } from './roles.js';
import { writeFileTool } from '../tools/write-file.js';
import { estimateTokens } from '../utils/token-tracker.js';
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
    // Explicit no-changes verdict ends the turn cleanly — the #448
    // zero-mutation guard honors it instead of re-prompting forever.
    return { content: 'No changes required — the build already passes cleanly.' };
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

// --- Zero-mutation completion guard (#448) ---
// Failure signature scc:zero-mutations:auto/best-coding: in unattended runs
// the model completed its turn with a prose answer and zero mutating tool
// calls, so the wrapper had nothing to commit. The guard must re-prompt.

test('Agent.run re-prompts a zero-mutation turn completion on a mutation-scoped prompt (#448)', async () => {
  const agent = new Agent({
    workspaceRoot: process.cwd(),
    autoApprove: true,
    quiet: true,
    config: {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'http://test.api/v1',
        model: 'auto/best-coding',
      }
    }
  });

  // Mock the mutating tool so nothing touches the real worktree.
  const { writeFileTool } = await import('../tools/write-file.js');
  const writeSpy = vi.spyOn(writeFileTool, 'execute').mockResolvedValue('ok');

  let callCount = 0;
  const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      // The #448 failure shape: prose narration of the fix, no tool calls.
      return { content: 'The parser is missing a null check on the token stream. The right approach is a guard clause at the top of parseToken before accessing token.value.' };
    }
    if (callCount === 2) {
      return {
        content: '',
        tool_calls: [{
          id: 'w1',
          type: 'function' as const,
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'parser.ts', content: 'x' }) },
        }],
      };
    }
    return { content: 'The fix has been applied and the parser is patched.' };
  });

  const result = await agent.run('Fix the null check in parser.ts');

  assert.equal(callCount, 3);
  assert.equal(writeSpy.mock.calls.length, 1);
  const reprompts = result.filter(m => m.role === 'user' && m.content.includes('ZERO-MUTATION'));
  assert.equal(reprompts.length, 1);
  assert.match(reprompts[0].content, /apply it now using the tools/i);

  mock.mockRestore();
  writeSpy.mockRestore();
});

test('Agent.run caps zero-mutation re-prompts and still completes cleanly', async () => {
  const agent = new Agent({
    workspaceRoot: process.cwd(),
    autoApprove: true,
    quiet: true,
    livelockThreshold: 0, // disable livelock abort so the reprompt cap is the limiter
    config: {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'http://test.api/v1',
        model: 'auto/best-coding',
      }
    }
  });

  let callCount = 0;
  const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
    callCount++;
    return { content: 'Here is a detailed narrative about the codebase structure and how the pieces fit together for the reader.' };
  });

  const result = await agent.run('Implement the new config option');

  // 1 initial turn + 2 re-prompts (default SC_ZERO_MUTATION_REPROMPTS budget)
  assert.equal(callCount, 3);
  assert.equal(result.filter(m => m.role === 'user' && m.content.includes('ZERO-MUTATION')).length, 2);
  mock.mockRestore();
});

test('Agent.run does not re-prompt zero-mutation turns for read-only prompts', async () => {
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
    return { content: 'This project is a provider-agnostic CLI agent with parallel tool use.' };
  });

  const result = await agent.run('Summarize what this project does');

  assert.equal(callCount, 1);
  assert.ok(!result.some(m => m.role === 'user' && m.content.includes('ZERO-MUTATION')));
  mock.mockRestore();
});

test('Agent.run does not re-prompt zero-mutation turns in interactive mode', async () => {
  const agent = new Agent({
    workspaceRoot: process.cwd(),
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
    return { content: 'The bug sits in the tokenizer where the offset drifts after each consumed chunk.' };
  });

  const result = await agent.run('Fix the parser bug');

  assert.equal(callCount, 1);
  assert.ok(!result.some(m => m.role === 'user' && m.content.includes('ZERO-MUTATION')));
  mock.mockRestore();
});

test('Agent.run honors an explicit no-changes verdict without re-prompting', async () => {
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
    return { content: 'I inspected the relevant code paths and no changes are required — the guard already exists.' };
  });

  const result = await agent.run('Fix issue #448 in the engine');

  assert.equal(callCount, 1);
  assert.ok(!result.some(m => m.role === 'user' && m.content.includes('ZERO-MUTATION')));
  mock.mockRestore();
});

test('Agent.run does not count memory_write as a workspace mutation for the guard', async () => {
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

  // Mock the memory store so nothing touches ~/.sc-agent on disk.
  const { memoryWriteTool } = await import('../tools/memory-tools.js');
  const memSpy = vi.spyOn(memoryWriteTool, 'execute').mockResolvedValue('saved');

  let callCount = 0;
  const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        tool_calls: [{
          id: 'm1',
          type: 'function' as const,
          function: { name: 'memory_write', arguments: JSON.stringify({ key: 'note', content: 'v' }) },
        }],
      };
    }
    if (callCount === 2) {
      return { content: 'Recorded the preference for later sessions.' };
    }
    return { content: 'No changes required — only a note was stored.' };
  });

  const result = await agent.run('Update the stored user preference');

  // memory_write alone does not satisfy the workspace-mutation guard —
  // the turn is re-prompted once, then the verdict ends it.
  assert.equal(callCount, 3);
  assert.equal(result.filter(m => m.role === 'user' && m.content.includes('ZERO-MUTATION')).length, 1);

  mock.mockRestore();
  memSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Multi-model orchestration (#424) — phase lifecycle
// ---------------------------------------------------------------------------

function makeAgent(): Agent {
  return new Agent({
    workspaceRoot: process.cwd(),
    autoApprove: true,
    quiet: true,
    config: {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'http://test.api/v1',
        model: 'test-model',
      },
      roles: { executor: 'openai/gpt-4o-mini' },
    },
  });
}

test('Agent.run records a phase segment and scopes tokens to the role (#424)', async () => {
  const agent = makeAgent();
  const res = resolveRole(agent.options.config, 'executor');
  assert.equal(res.fallback, false);
  assert.equal(res.candidate.id, 'openai/gpt-4o-mini');

  vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => ({
    content: 'Applied the change.',
    usage: { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 },
  }));

  await agent.run('task', [], undefined, { routing: res, ...phasePolicy('executor') });

  const phases = agent.getPhases();
  assert.deepEqual(phases, [{ role: 'executor', provider: 'openai', model: 'gpt-4o-mini', iterations: 1 }]);
  assert.deepEqual(agent.getRoleFallbacks(), []);

  const roleUsage = agent.tokenTracker.getRoleUsage();
  // Provider-reported usage supersedes the chars/4 estimate (#424).
  assert.equal(roleUsage.executor.in, 500);
  assert.equal(roleUsage.executor.out, 40);
  assert.deepEqual(agent.tokenTracker.getUsage(), { inputTokens: 500, outputTokens: 40, totalTokens: 540 });
});

test('Agent.run fallback roles keep the default model and record role_fallback (#424)', async () => {
  const agent = makeAgent();
  // No planner mapping in makeAgent's config.roles → fallback to default.
  const res = resolveRole(agent.options.config, 'planner');
  assert.equal(res.fallback, true);

  vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => ({ content: '1. inspect\n2. edit\n3. verify' }));
  await agent.run('task', [], undefined, { routing: res, ...phasePolicy('planner') });

  assert.deepEqual(agent.getRoleFallbacks(), ['planner']);
  const phases = agent.getPhases();
  assert.equal(phases.length, 1);
  assert.equal(phases[0].role, 'planner');
  assert.equal(phases[0].model, 'test-model'); // default model served
  assert.equal(phases[0].provider, 'custom');
});

test('Agent.run read-only phases hide mutating tools from the schema (#424)', async () => {
  const agent = makeAgent();
  const res = resolveRole(agent.options.config, 'planner');

  let seenToolNames: string[] = [];
  vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async (options) => {
    seenToolNames = (options.tools ?? []).map(t => t.function.name);
    return { content: 'plan' };
  });

  await agent.run('task', [], undefined, { routing: res, ...phasePolicy('planner') });

  assert.ok(!seenToolNames.includes('write_file'));
  assert.ok(!seenToolNames.includes('edit_file'));
  assert.ok(!seenToolNames.includes('memory_write'));
  assert.ok(seenToolNames.includes('read_file'));
  // Dual-purpose tools stay — the dispatch gate covers them.
  assert.ok(seenToolNames.includes('run_shell'));
  assert.ok(seenToolNames.includes('git'));
});

test('Agent.run read-only phase denies a mutating call at dispatch (#424)', async () => {
  const agent = makeAgent();
  const res = resolveRole(agent.options.config, 'planner');
  const writeSpy = vi.spyOn(writeFileTool, 'execute').mockResolvedValue('written');

  let callCount = 0;
  vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      // The model hallucinated a write_file call despite it being absent
      // from the schema — the dispatch gate must reject it.
      return {
        content: '',
        tool_calls: [{
          id: 'w1',
          type: 'function' as const,
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'y' }) },
        }],
      };
    }
    return { content: 'Plan: do not write — step sequence follows.' };
  });

  const result = await agent.run('task', [], undefined, { routing: res, ...phasePolicy('planner') });

  assert.equal(writeSpy.mock.calls.length, 0);
  const denial = result.find(m => m.role === 'tool' && m.content.startsWith('Error: Tool call denied:'));
  assert.ok(denial, 'expected a read-only phase denial tool result');
  assert.ok(denial!.content.includes('write_file'));

  writeSpy.mockRestore();
});

test('Agent.run suppresses self-heal/livelock guards in prose phases (#424)', async () => {
  const agent = makeAgent();
  const res = resolveRole(agent.options.config, 'planner');

  let callCount = 0;
  vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
    callCount++;
    // Future-intention prose would normally trigger the self-heal re-prompt
    // in autoApprove mode; planner phases must end on it instead.
    return { content: 'I will inspect the repository layout first, then produce the step-by-step plan for the executor phase to implement the feature safely.' };
  });

  await agent.run('Fix the build errors', [], undefined, { routing: res, ...phasePolicy('planner') });

  assert.equal(callCount, 1);
});

test('Agent.run restores the default failover chain after a phase (#424)', async () => {
  const agent = makeAgent();
  const res = resolveRole(agent.options.config, 'executor');

  vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => ({ content: 'done' }));
  await agent.run('task', [], undefined, { routing: res, ...phasePolicy('executor') });

  // Back on the default chain: single candidate = configured model.
  assert.equal(agent.getPhases().length, 1);
  const res2 = resolveRole(agent.options.config, 'planner');
  await agent.run('plan task', [], undefined, { routing: res2, ...phasePolicy('planner') });
  assert.equal(agent.getPhases().length, 2);
});

// --- Context-spend accounting + injection budget guard (#422) ---

test('Agent.run enforces SC_CONTEXT_BUDGET_TOKENS and exposes per-source spend', async () => {
  const prev = process.env.SC_CONTEXT_BUDGET_TOKENS;
  process.env.SC_CONTEXT_BUDGET_TOKENS = '300';
  try {
    const agent = new Agent({
      workspaceRoot: process.cwd(),
      quiet: true,
      config: {
        model: {
          provider: 'openai-compatible',
          baseUrl: 'http://test.api/v1',
          model: 'test-model',
        }
      }
    });
    const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => ({ content: 'ok' }));
    const result = await agent.run('test');
    mock.mockRestore();

    const report = agent.getContextBudget();
    assert.ok(report, 'expected a context budget report after injection');
    assert.equal(report.budget_tokens, 300);
    assert.equal(report.over_budget, true);
    assert.ok(report.injected_tokens <= report.requested_tokens);
    for (const s of report.sources) {
      assert.ok(s.tokens_injected <= s.tokens_requested, `${s.source} injected must not exceed requested`);
    }

    // The system prompt is trimmed last — it still lands in history with
    // the visible trim marker (never silent).
    const sys = result.find(m => m.role === 'system');
    assert.ok(sys);
    assert.match(sys.content, /context source "system" trimmed/);
    assert.ok(estimateTokens(sys.content) <= 400);
  } finally {
    if (prev === undefined) delete process.env.SC_CONTEXT_BUDGET_TOKENS;
    else process.env.SC_CONTEXT_BUDGET_TOKENS = prev;
  }
});

test('Agent.run records per-source context spend without a cap configured', async () => {
  const prev = process.env.SC_CONTEXT_BUDGET_TOKENS;
  delete process.env.SC_CONTEXT_BUDGET_TOKENS;
  try {
    const agent = new Agent({
      workspaceRoot: process.cwd(),
      quiet: true,
      config: {
        model: {
          provider: 'openai-compatible',
          baseUrl: 'http://test.api/v1',
          model: 'test-model',
        }
      }
    });
    const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => ({ content: 'ok' }));
    const result = await agent.run('test');
    mock.mockRestore();

    const report = agent.getContextBudget();
    assert.ok(report, 'expected a context budget report after injection');
    assert.equal(report.budget_tokens, null);
    assert.equal(report.over_budget, false);
    assert.equal(report.injected_tokens, report.requested_tokens);
    assert.ok(report.sources.some(s => s.source === 'system'));
    assert.ok(report.sources.every(s => !s.truncated && !s.dropped));

    const sys = result.find(m => m.role === 'system');
    assert.ok(sys && sys.content.includes('helpful AI assistant'), 'system prompt passes through untrimmed');
  } finally {
    if (prev === undefined) delete process.env.SC_CONTEXT_BUDGET_TOKENS;
    else process.env.SC_CONTEXT_BUDGET_TOKENS = prev;
  }
});

test('Agent.run accounts tool output context spend in the budget report', async () => {
  const prev = process.env.SC_CONTEXT_BUDGET_TOKENS;
  delete process.env.SC_CONTEXT_BUDGET_TOKENS;
  try {
    const agent = new Agent({
      workspaceRoot: process.cwd(),
      quiet: true,
      config: {
        model: {
          provider: 'openai-compatible',
          baseUrl: 'http://test.api/v1',
          model: 'test-model',
        }
      }
    });

    const { readFileTool } = await import('../tools/read-file.js');
    const readSpy = vi.spyOn(readFileTool, 'execute').mockResolvedValue('x'.repeat(400));

    let callCount = 0;
    const mock = vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: '',
          tool_calls: [{
            id: 'r1',
            type: 'function' as const,
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'x.ts' }) },
          }],
        };
      }
      return { content: 'Done.' };
    });

    await agent.run('test');

    const toolOut = agent.getContextBudget()?.sources.find(s => s.source === 'tool_outputs');
    assert.ok(toolOut, 'expected a cumulative tool_outputs spend line');
    // 'x'.repeat(400) ≈ 100 est. tokens; injected ≥ requested (synthesis nudge appended).
    assert.ok(toolOut.tokens_requested >= 100);
    assert.ok(toolOut.tokens_injected >= toolOut.tokens_requested);
    assert.equal(toolOut.dropped, false);

    mock.mockRestore();
    readSpy.mockRestore();
  } finally {
    if (prev === undefined) delete process.env.SC_CONTEXT_BUDGET_TOKENS;
    else process.env.SC_CONTEXT_BUDGET_TOKENS = prev;
  }
});
