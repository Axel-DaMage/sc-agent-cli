import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  AGENT_ROLES,
  PhaseTracker,
  buildPhasePrompt,
  isAgentRole,
  phasePolicy,
  resolveRole,
  resolveRolePipeline,
} from './roles.js';
import { primaryCandidate } from './failover.js';
import type { ProjectConfig } from './types.js';

const ENV_KEYS = [
  'SC_FAILOVER',
  'SC_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NVIDIA_API_KEY',
];

let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envBackup[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    model: {
      provider: 'openai-compatible',
      baseUrl: 'http://test.api/v1',
      model: 'test-model',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Role guard + pipeline shape
// ---------------------------------------------------------------------------

test('isAgentRole accepts the three roles and rejects everything else', () => {
  for (const role of AGENT_ROLES) assert.ok(isAgentRole(role), role);
  for (const bad of ['judge', 'planner ', '', 42, null, undefined]) {
    assert.equal(isAgentRole(bad), false, String(bad));
  }
});

test('resolveRolePipeline returns planner → executor → reviewer in order', () => {
  const pipeline = resolveRolePipeline(makeConfig({ roles: { executor: 'openai/gpt-4o-mini' } }));
  assert.deepEqual(pipeline.map(r => r.role), ['planner', 'executor', 'reviewer']);
});

test('resolveRolePipeline: `only` pins the pipeline to a single role', () => {
  const pipeline = resolveRolePipeline(makeConfig({ roles: { reviewer: 'openai/gpt-4o' } }), 'reviewer');
  assert.equal(pipeline.length, 1);
  assert.equal(pipeline[0].role, 'reviewer');
  assert.equal(pipeline[0].fallback, false);
});

// ---------------------------------------------------------------------------
// Role → candidate resolution
// ---------------------------------------------------------------------------

test('resolveRole maps a known provider alias to its canonical endpoint', () => {
  const res = resolveRole(makeConfig({ roles: { planner: 'openai/gpt-4o' } }), 'planner');
  assert.equal(res.fallback, false);
  assert.equal(res.configured, 'openai/gpt-4o');
  assert.equal(res.candidate.id, 'openai/gpt-4o');
  assert.equal(res.candidate.model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(res.candidate.model.model, 'gpt-4o');
});

test('resolveRole resolves a config.profiles name before known providers', () => {
  const res = resolveRole(makeConfig({
    roles: { executor: 'corp/their-model' },
    profiles: { corp: { baseUrl: 'http://corp.internal/v2', apiKey: 'corp-key' } },
  }), 'executor');
  assert.equal(res.fallback, false);
  assert.equal(res.candidate.model.baseUrl, 'http://corp.internal/v2');
  assert.equal(res.candidate.model.apiKey, 'corp-key');
});

test('resolveRole: bare model id stays on the configured endpoint', () => {
  const res = resolveRole(makeConfig({ roles: { executor: 'llama3.1' } }), 'executor');
  assert.equal(res.fallback, false);
  assert.equal(res.candidate.model.model, 'llama3.1');
  assert.equal(res.candidate.model.baseUrl, 'http://test.api/v1');
});

test('resolveRole: absent mapping falls back to the default model without throwing', () => {
  const res = resolveRole(makeConfig(), 'planner');
  assert.equal(res.fallback, true);
  assert.equal(res.configured, null);
  assert.deepEqual(res.candidate, primaryCandidate(makeConfig().model));
});

test('resolveRole: invalid mapping falls back to the default model, recording the token', () => {
  const res = resolveRole(makeConfig({ roles: { reviewer: 'openai/' } }), 'reviewer');
  assert.equal(res.fallback, true);
  assert.equal(res.configured, 'openai/');
  assert.equal(res.candidate.model.model, 'test-model');
});

test('resolveRole: empty-string mapping is treated as absent', () => {
  const res = resolveRole(makeConfig({ roles: { planner: '   ' } }), 'planner');
  assert.equal(res.fallback, true);
  assert.equal(res.configured, null);
});

test('resolveRole never leaks the primary apiKey to a different host', () => {
  const cfg = makeConfig({ roles: { planner: 'openai/gpt-x' } });
  cfg.model.apiKey = 'primary-secret';
  const res = resolveRole(cfg, 'planner');
  assert.equal(res.candidate.model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(res.candidate.model.apiKey, undefined);
});

// ---------------------------------------------------------------------------
// Phase policy + prompts
// ---------------------------------------------------------------------------

test('phasePolicy: executor mutates; planner/reviewer are read-only with guards suppressed', () => {
  assert.deepEqual(phasePolicy('executor'), { readOnly: false, suppressCompletionGuards: false });
  for (const role of ['planner', 'reviewer'] as const) {
    assert.deepEqual(phasePolicy(role), { readOnly: true, suppressCompletionGuards: true });
  }
});

test('buildPhasePrompt wraps the task with role-specific instructions', () => {
  for (const role of AGENT_ROLES) {
    const prompt = buildPhasePrompt(role, 'fix the bug');
    assert.match(prompt, /fix the bug/, role);
    assert.match(prompt, new RegExp(role.toUpperCase()), role);
  }
  assert.match(buildPhasePrompt('planner', 'x'), /MUST NOT modify/i);
  assert.match(buildPhasePrompt('reviewer', 'x'), /MUST NOT modify/i);
});

// ---------------------------------------------------------------------------
// PhaseTracker — append-only segment log
// ---------------------------------------------------------------------------

test('PhaseTracker records one segment per phase with iteration counts', () => {
  const t = new PhaseTracker();
  const c = { id: 'openai/gpt-4o', model: { provider: 'x', baseUrl: 'u', model: 'gpt-4o' } };
  t.begin('planner', c);
  t.noteServed('openai/gpt-4o');
  t.noteServed('openai/gpt-4o');
  t.end();
  t.begin('executor', { id: 'custom/test-model', model: { provider: 'x', baseUrl: 'u', model: 'test-model' } });
  t.noteServed('custom/test-model');
  t.end();

  assert.deepEqual(t.getPhases(), [
    { role: 'planner', provider: 'openai', model: 'gpt-4o', iterations: 2 },
    { role: 'executor', provider: 'custom', model: 'test-model', iterations: 1 },
  ]);
});

test('PhaseTracker: a mid-phase cascade appends a new segment instead of overwriting', () => {
  const t = new PhaseTracker();
  t.begin('executor', { id: 'ollama/a', model: { provider: 'x', baseUrl: 'u', model: 'a' } });
  t.noteServed('ollama/a');
  t.noteServed('ollama/a');
  // Cascade moved mid-phase → new segment for the same role.
  t.noteServed('openai/b');
  t.noteServed('openai/b');
  t.end();

  const phases = t.getPhases();
  assert.equal(phases.length, 2);
  assert.deepEqual(phases[0], { role: 'executor', provider: 'ollama', model: 'a', iterations: 2 });
  assert.deepEqual(phases[1], { role: 'executor', provider: 'openai', model: 'b', iterations: 2 });
});

test('PhaseTracker: model ids containing "/" survive provider/model splitting', () => {
  const t = new PhaseTracker();
  t.begin('executor', { id: 'custom/meta/llama-3.3-70b', model: { provider: 'x', baseUrl: 'u', model: 'meta/llama-3.3-70b' } });
  t.noteServed('custom/meta/llama-3.3-70b');
  t.end();
  assert.deepEqual(t.getPhases(), [
    { role: 'executor', provider: 'custom', model: 'meta/llama-3.3-70b', iterations: 1 },
  ]);
});
