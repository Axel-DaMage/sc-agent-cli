import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TokenTracker, estimateCost } from './token-tracker.js';

test('TokenTracker: role buckets accumulate input/output/cached separately', () => {
  const t = new TokenTracker('test-model');
  t.setRole('planner', 'gpt-4o');
  t.addInput(100);
  t.addOutput(20);
  t.addCached(40);
  t.setRole('executor', 'gpt-4o-mini');
  t.addInput(50);
  t.addOutput(10);
  t.setRole(null);
  t.addInput(7); // unattributed remainder

  assert.deepEqual(t.getUsage(), { inputTokens: 157, outputTokens: 30, totalTokens: 187 });
  assert.equal(t.getCachedTokens(), 40);
  assert.deepEqual(t.getRoleUsage(), {
    planner: { in: 100, out: 20, cached: 40 },
    executor: { in: 50, out: 10 },
  });
});

test('TokenTracker: cached is omitted from role usage when unreported', () => {
  const t = new TokenTracker('test-model');
  t.setRole('reviewer', 'claude-x');
  t.addInput(5);
  t.addOutput(1);
  assert.deepEqual(t.getRoleUsage(), { reviewer: { in: 5, out: 1 } });
});

test('TokenTracker: per-role cost prices each role at its serving model', () => {
  const t = new TokenTracker('test-model');
  t.setRole('planner', 'gpt-4o');
  t.addInput(1000);
  t.addOutput(1000);
  t.setRole('executor', 'gpt-4o-mini');
  t.addInput(1000);
  t.addOutput(1000);
  t.setRole(null);
  t.addInput(1000); // remainder priced at the default model

  const expected =
    estimateCost('gpt-4o', 1000, 1000) +
    estimateCost('gpt-4o-mini', 1000, 1000) +
    estimateCost('test-model', 1000, 0);
  assert.ok(Math.abs(t.getEstimatedCost() - expected) < 1e-9);
});

test('TokenTracker: single-model run cost matches estimateCost', () => {
  const t = new TokenTracker('gpt-4o');
  t.addInput(2000);
  t.addOutput(500);
  assert.equal(t.getEstimatedCost(), estimateCost('gpt-4o', 2000, 500));
});

test('TokenTracker: reset clears role buckets', () => {
  const t = new TokenTracker('test-model');
  t.setRole('planner', 'gpt-4o');
  t.addInput(100);
  t.reset();
  assert.deepEqual(t.getUsage(), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(t.getCachedTokens(), 0);
  assert.deepEqual(t.getRoleUsage(), {});
});
