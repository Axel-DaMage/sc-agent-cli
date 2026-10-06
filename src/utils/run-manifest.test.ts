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
