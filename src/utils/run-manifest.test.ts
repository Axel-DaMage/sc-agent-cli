import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunManifest, emitRunManifest, type RunManifestInput } from './run-manifest.js';
import type { Message } from '../core/types.js';

function baseInput(overrides: Partial<RunManifestInput> = {}): RunManifestInput {
  return {
    exitReason: 'success',
    version: '0.4.2',
    model: 'gpt-4o',
    sessionId: 'test-session-1',
    history: [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'Done. Created src/x.ts' },
    ],
    inputTokens: 1000,
    outputTokens: 250,
    costUsd: 0.005,
    toolCalls: { read_file: 2, write_file: 1 },
    toolRunCount: 3,
    iterations: 4,
    durationMs: 1234,
    checkpointPath: '/tmp/checkpoints/test-session-1.json',
    ...overrides,
  };
}

test('buildRunManifest maps a successful run', () => {
  const m = buildRunManifest(baseInput());
  assert.equal(m.v, 1);
  assert.equal(m.version, '0.4.2');
  assert.equal(m.success, true);
  assert.equal(m.exit_reason, 'success');
  assert.equal(m.model, 'gpt-4o');
  assert.equal(m.session_id, 'test-session-1');
  assert.equal(m.iterations, 4);
  assert.deepEqual(m.tool_calls, { read_file: 2, write_file: 1 });
  assert.equal(m.tool_calls_total, 3);
  assert.equal(m.tokens_in, 1000);
  assert.equal(m.tokens_out, 250);
  assert.equal(m.estimated_cost_usd, 0.005);
  assert.equal(m.duration_ms, 1234);
  assert.equal(m.final_message, 'Done. Created src/x.ts');
  assert.equal(m.checkpoint, '/tmp/checkpoints/test-session-1.json');
  assert.equal(m.error, null);
});

test('buildRunManifest marks non-success exits as success:false and carries error', () => {
  for (const exitReason of ['error', 'no_changes', 'budget_exceeded', 'interrupted'] as const) {
    const m = buildRunManifest(baseInput({ exitReason, error: 'boom' }));
    assert.equal(m.success, false, exitReason);
    assert.equal(m.exit_reason, exitReason);
    assert.equal(m.error, 'boom');
  }
});

test('buildRunManifest picks the last non-empty assistant message', () => {
  const history: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'first reply' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '   ' },
  ];
  const m = buildRunManifest(baseInput({ history }));
  assert.equal(m.final_message, 'first reply');
});

test('buildRunManifest returns null final_message when no assistant text exists', () => {
  const m = buildRunManifest(baseInput({ history: [{ role: 'user', content: 'hi' }] }));
  assert.equal(m.final_message, null);
});

test('buildRunManifest truncates final_message at 4000 chars', () => {
  const history: Message[] = [{ role: 'assistant', content: 'x'.repeat(5000) }];
  const m = buildRunManifest(baseInput({ history }));
  assert.equal(m.final_message?.length, 4000);
});

test('buildRunManifest emits a single-line JSON-serializable object', () => {
  const m = buildRunManifest(baseInput({ history: [{ role: 'assistant', content: 'multi\nline\nreply' }] }));
  const json = JSON.stringify(m);
  assert.ok(!json.includes('\n'), 'manifest must serialize to one line');
  assert.deepEqual(JSON.parse(json).exit_reason, 'success');
});

test('buildRunManifest emits #424 phase routing + per-role token fields', () => {
  const m = buildRunManifest(baseInput({
    phases: [
      { role: 'planner', provider: 'openai', model: 'gpt-4o', iterations: 2 },
      { role: 'executor', provider: 'custom', model: 'test-model', iterations: 5 },
      { role: 'executor', provider: 'openai', model: 'gpt-4o-mini', iterations: 1 },
      { role: 'reviewer', provider: 'anthropic', model: 'claude-x', iterations: 1 },
    ],
    roleFallbacks: ['reviewer'],
    roleTokens: {
      planner: { in: 400, out: 100 },
      executor: { in: 500, out: 120, cached: 50 },
    },
    cachedTokens: 50,
  }));

  assert.equal(m.phases!.length, 4);
  assert.deepEqual(m.phases![0], { role: 'planner', provider: 'openai', model: 'gpt-4o', iterations: 2 });
  // Mid-phase cascades append a second segment for the same role (#424).
  assert.deepEqual(m.phases![2], { role: 'executor', provider: 'openai', model: 'gpt-4o-mini', iterations: 1 });
  assert.deepEqual(m.role_fallback, ['reviewer']);
  assert.deepEqual(m.tokens, {
    byRole: {
      planner: { in: 400, out: 100 },
      executor: { in: 500, out: 120, cached: 50 },
    },
    total: { in: 1000, out: 250, cached: 50 },
  });
});

test('buildRunManifest omits #424 fields when no roles ran (backward compat)', () => {
  const m = buildRunManifest(baseInput());
  assert.equal(m.phases, undefined);
  assert.equal(m.role_fallback, undefined);
  assert.equal(m.tokens, undefined);
});

test('buildRunManifest omits cached token fields when the provider reports none', () => {
  const m = buildRunManifest(baseInput({
    phases: [{ role: 'executor', provider: 'custom', model: 'test-model', iterations: 3 }],
    roleTokens: { executor: { in: 10, out: 5 } },
    cachedTokens: 0,
  }));
  assert.deepEqual(m.tokens!.total, { in: 1000, out: 250 });
  assert.deepEqual(m.tokens!.byRole.executor, { in: 10, out: 5 });
});

test('buildRunManifest emits reviewer role usage + #462 consensus review block', () => {
  const m = buildRunManifest(baseInput({
    phases: [
      { role: 'executor', provider: 'openai', model: 'gpt-4o-mini', iterations: 4 },
      { role: 'reviewer', provider: 'anthropic', model: 'claude-sonnet-4-6', iterations: 2 },
      { role: 'executor', provider: 'openai', model: 'gpt-4o-mini', iterations: 2 },
      { role: 'reviewer', provider: 'anthropic', model: 'claude-sonnet-4-6', iterations: 1 },
    ],
    roleTokens: {
      executor: { in: 500, out: 120 },
      reviewer: { in: 260, out: 80 },
    },
    review: { verdict: 'request_changes', explicit: true, fixRounds: 3, maxFixes: 3 },
  }));

  // Role-scoped token usage lands under tokens.byRole.reviewer (#462).
  assert.deepEqual(m.tokens!.byRole.reviewer, { in: 260, out: 80 });
  assert.deepEqual(m.review, {
    verdict: 'request_changes',
    explicit: true,
    fix_rounds: 3,
    max_fixes: 3,
  });
});

test('buildRunManifest omits the review block when no reviewer verdict ran', () => {
  assert.ok(!('review' in buildRunManifest(baseInput())));
  assert.ok(!('review' in buildRunManifest(baseInput({
    phases: [{ role: 'planner', provider: 'openai', model: 'gpt-4o', iterations: 1 }],
  }))));
});

test('emitRunManifest writes the manifest file and stdout line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-manifest-'));
  const outFile = join(dir, 'run.json');
  const manifest = buildRunManifest(baseInput());

  const written: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    emitRunManifest(manifest, { files: [outFile] });
  } finally {
    process.stdout.write = origWrite;
  }

  assert.deepEqual(JSON.parse(readFileSync(outFile, 'utf-8')).session_id, 'test-session-1');
  assert.equal(written.length, 1);
  assert.deepEqual(JSON.parse(written[0]), JSON.parse(JSON.stringify(manifest)));

  rmSync(dir, { recursive: true, force: true });
});

test('buildRunManifest carries sandbox posture + violations (#423)', () => {
  const m = buildRunManifest(
    baseInput({
      sandbox: { exec_mode: 'bwrap', egress: 'allowlist', seccomp: 'on', violations: 1 },
      sandboxViolations: [{ rule: 'egress', target: 'evil.com:443' }],
    }),
  );
  assert.deepEqual(m.sandbox, { exec_mode: 'bwrap', egress: 'allowlist', seccomp: 'on', violations: 1 });
  assert.deepEqual(m.sandbox_violations, [{ rule: 'egress', target: 'evil.com:443' }]);
  // Manifest must still serialize to a single JSON line.
  assert.deepEqual(JSON.parse(JSON.stringify(m)).sandbox.exec_mode, 'bwrap');
});

test('buildRunManifest omits sandbox fields when sandboxing was not active', () => {
  const m = buildRunManifest(baseInput({ sandboxViolations: [] }));
  assert.equal(m.sandbox, undefined);
  assert.equal(m.sandbox_violations, undefined);
  assert.equal('sandbox' in m, false);
});

test('emitRunManifest skips unwritable file paths without breaking stdout', () => {
  const manifest = buildRunManifest(baseInput());
  const written: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    emitRunManifest(manifest, { files: ['/nonexistent-dir-xyz/deep/run.json', undefined] });
  } finally {
    process.stdout.write = origWrite;
  }
  assert.equal(written.length, 1);
});

test('buildRunManifest emits the context_budget block when provided (#422)', () => {
  const contextBudget = {
    budget_tokens: 100,
    requested_tokens: 130,
    injected_tokens: 100,
    over_budget: true,
    sources: [
      { source: 'system', tokens_requested: 100, tokens_injected: 100, truncated: false, dropped: false },
      { source: 'memory', tokens_requested: 30, tokens_injected: 0, truncated: true, dropped: true },
    ],
  };
  const m = buildRunManifest(baseInput({ contextBudget }));
  assert.deepEqual(m.context_budget, contextBudget);
  assert.equal(JSON.parse(JSON.stringify(m)).context_budget.budget_tokens, 100);
});

test('buildRunManifest omits context_budget when no report exists', () => {
  assert.ok(!('context_budget' in buildRunManifest(baseInput())));
  assert.ok(!('context_budget' in buildRunManifest(baseInput({ contextBudget: null }))));
});
