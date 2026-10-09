import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  applyContextBudget,
  formatContextBudgetTrims,
  resolveContextBudget,
  CONTEXT_BUDGET_ENV_VAR,
  type ContextSource,
} from './context-budget.js';
import { estimateTokens } from './token-tracker.js';

// 4 chars ≈ 1 token via the shared estimateTokens heuristic.
const src = (source: string, chars: number): ContextSource => ({ source, text: 'x'.repeat(chars) });

// --- resolveContextBudget ---

test('resolveContextBudget returns null when unset, empty, or invalid', () => {
  assert.equal(resolveContextBudget({}), null);
  assert.equal(resolveContextBudget({ [CONTEXT_BUDGET_ENV_VAR]: '' }), null);
  assert.equal(resolveContextBudget({ [CONTEXT_BUDGET_ENV_VAR]: '   ' }), null);
  assert.equal(resolveContextBudget({ [CONTEXT_BUDGET_ENV_VAR]: 'abc' }), null);
  assert.equal(resolveContextBudget({ [CONTEXT_BUDGET_ENV_VAR]: '0' }), null);
  assert.equal(resolveContextBudget({ [CONTEXT_BUDGET_ENV_VAR]: '-8' }), null);
});

test('resolveContextBudget parses a positive integer cap', () => {
  assert.equal(resolveContextBudget({ [CONTEXT_BUDGET_ENV_VAR]: '8000' }), 8000);
  assert.equal(resolveContextBudget({ [CONTEXT_BUDGET_ENV_VAR]: ' 4000 ' }), 4000);
});

// --- applyContextBudget: under-budget paths ---

test('applyContextBudget passes all sources through untouched under the cap', () => {
  const sources = [
    { source: 'system', text: 's'.repeat(400) }, // 100t
    { source: 'memory', text: 'm'.repeat(200) }, // 50t
  ];
  const { texts, report } = applyContextBudget(sources, 1000);

  assert.deepEqual(texts, sources.map(s => s.text));
  assert.equal(report.over_budget, false);
  assert.equal(report.budget_tokens, 1000);
  assert.equal(report.requested_tokens, 150);
  assert.equal(report.injected_tokens, 150);
  assert.deepEqual(report.sources, [
    { source: 'system', tokens_requested: 100, tokens_injected: 100, truncated: false, dropped: false },
    { source: 'memory', tokens_requested: 50, tokens_injected: 50, truncated: false, dropped: false },
  ]);
});

test('applyContextBudget is a no-op when no cap is configured', () => {
  const sources = [src('system', 4000), src('project_context', 4000)];
  const { texts, report } = applyContextBudget(sources, null);

  assert.deepEqual(texts, sources.map(s => s.text));
  assert.equal(report.budget_tokens, null);
  assert.equal(report.over_budget, false);
  assert.equal(report.requested_tokens, 2000);
  assert.equal(report.injected_tokens, 2000);
});

test('applyContextBudget reports sources in assembly order, not trim order', () => {
  const sources = [
    { source: 'memory', text: 'm'.repeat(40) },  // lowest priority, listed first
    { source: 'system', text: 's'.repeat(40) },  // highest priority, listed second
  ];
  const { report } = applyContextBudget(sources, 1000);
  assert.deepEqual(report.sources.map(s => s.source), ['memory', 'system']);
});

// --- applyContextBudget: over-budget paths ---

test('applyContextBudget trims the lowest-priority source first and keeps the head', () => {
  const sources = [
    { source: 'system', text: 's'.repeat(400) }, // 100t — highest priority
    { source: 'memory', text: 'm'.repeat(400) }, // 100t — lowest priority
  ];
  // requested 200t, cap 150 → overflow 50 → memory trimmed to ~50t.
  const { texts, report } = applyContextBudget(sources, 150);

  assert.equal(report.over_budget, true);
  assert.equal(texts.length, 2);
  assert.equal(texts[0], sources[0].text); // system untouched
  assert.ok(texts[1].startsWith('mmm'), 'trimmed source keeps its head');
  assert.ok(texts[1].includes('context source "memory" trimmed'), 'trim marker present');

  const mem = report.sources.find(s => s.source === 'memory')!;
  assert.equal(mem.truncated, true);
  assert.equal(mem.dropped, false);
  assert.equal(mem.tokens_injected, estimateTokens(texts[1]));
  assert.ok(mem.tokens_injected < mem.tokens_requested);
  assert.ok(report.injected_tokens <= 150);
});

test('applyContextBudget drops a low-priority source entirely when it fits inside the overflow', () => {
  const sources = [
    { source: 'system', text: 's'.repeat(400) }, // 100t
    { source: 'memory', text: 'm'.repeat(120) }, // 30t
  ];
  // requested 130t, cap 100 → overflow 30 → memory (30t) dropped outright.
  const { texts, report } = applyContextBudget(sources, 100);

  assert.equal(texts.length, 1);
  assert.equal(texts[0], sources[0].text);
  const mem = report.sources.find(s => s.source === 'memory')!;
  assert.equal(mem.dropped, true);
  assert.equal(mem.truncated, true);
  assert.equal(mem.tokens_injected, 0);
  assert.equal(report.injected_tokens, 100);
});

test('applyContextBudget enforces the documented priority order across multiple sources', () => {
  const sources = [
    { source: 'system', text: 's'.repeat(400) },          // 100t — trim last
    { source: 'shell', text: 'h'.repeat(160) },           // 40t
    { source: 'repo_profile', text: 'r'.repeat(160) },    // 40t
    { source: 'project_context', text: 'p'.repeat(160) }, // 40t
    { source: 'memory', text: 'm'.repeat(160) },          // 40t — trim first
  ];
  // requested 260t, cap 130 → overflow 130: memory + repo_profile +
  // project_context dropped (120t), then shell covers the last 10t (40→30t).
  const { texts, report } = applyContextBudget(sources, 130);

  assert.equal(texts.length, 2); // system + trimmed shell
  assert.equal(texts[0], sources[0].text);
  assert.ok(texts[1].includes('context source "shell" trimmed'));

  const byName = Object.fromEntries(report.sources.map(s => [s.source, s]));
  assert.equal(byName.memory.dropped, true);
  assert.equal(byName.repo_profile.dropped, true);
  assert.equal(byName.project_context.dropped, true);
  assert.equal(byName.shell.truncated, true);
  assert.equal(byName.shell.dropped, false);
  assert.equal(byName.system.truncated, false);
  assert.ok(report.injected_tokens <= 130);
});

test('applyContextBudget never drops the system source — degrades to the marker under a degenerate cap', () => {
  const sources = [
    { source: 'system', text: 's'.repeat(400) }, // 100t
    { source: 'memory', text: 'm'.repeat(160) }, // 40t
  ];
  const { texts, report } = applyContextBudget(sources, 5);

  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes('context source "system" trimmed'));
  const sys = report.sources.find(s => s.source === 'system')!;
  assert.equal(sys.truncated, true);
  assert.equal(sys.dropped, false);
  assert.equal(report.sources.find(s => s.source === 'memory')!.dropped, true);
});

test('applyContextBudget is deterministic — same inputs produce the same output', () => {
  const sources = () => [
    { source: 'system', text: 'sys '.repeat(100) },
    { source: 'memory', text: 'mem '.repeat(50) },
    { source: 'project_context', text: 'ctx '.repeat(80) },
  ];
  const a = applyContextBudget(sources(), 60);
  const b = applyContextBudget(sources(), 60);
  assert.deepEqual(a.texts, b.texts);
  assert.deepEqual(a.report, b.report);
});

test('formatContextBudgetTrims summarizes trimmed and dropped sources', () => {
  const sources = [
    { source: 'system', text: 's'.repeat(400) }, // 100t
    { source: 'memory', text: 'm'.repeat(120) }, // 30t
  ];
  const { report } = applyContextBudget(sources, 100);
  assert.equal(formatContextBudgetTrims(report), 'memory(dropped)');
});
