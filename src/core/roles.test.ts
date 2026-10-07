import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  AGENT_ROLES,
  PhaseTracker,
  buildPhasePrompt,
  buildReworkPrompt,
  isAgentRole,
  parseReviewerVerdict,
  phasePolicy,
  resolveMaxRoleFixes,
  resolveRole,
  resolveRolePipeline,
  reviewerSharesExecutorCandidate,
  runRolePipeline,
} from './roles.js';
import type { AgentRole, RoleResolution } from './roles.js';
import { primaryCandidate } from './failover.js';
import type { Message, ProjectConfig } from './types.js';

const ENV_KEYS = [
  'SC_FAILOVER',
  'SC_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NVIDIA_API_KEY',
  'SC_ROLE_MAX_FIXES',
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

// ---------------------------------------------------------------------------
// #462 — reviewer verdicts, rework bound, provider diversity
// ---------------------------------------------------------------------------

test('buildPhasePrompt teaches the reviewer the VERDICT marker contract', () => {
  const prompt = buildPhasePrompt('reviewer', 'x');
  assert.match(prompt, /VERDICT: approve/);
  assert.match(prompt, /VERDICT: request_changes/);
});

test('parseReviewerVerdict reads explicit VERDICT markers', () => {
  const ok = parseReviewerVerdict('All checks pass.\nVERDICT: approve');
  assert.equal(ok.verdict, 'approve');
  assert.equal(ok.explicit, true);
  assert.match(ok.comments, /VERDICT: approve/);

  const rc = parseReviewerVerdict('Defects:\n- missing null check in parse()\nVERDICT: request_changes');
  assert.equal(rc.verdict, 'request_changes');
  assert.equal(rc.explicit, true);
  assert.match(rc.comments, /missing null check/);

  // Case-insensitive + markdown-decorated marker values.
  assert.equal(parseReviewerVerdict('verdict: **REQUEST_CHANGES**').verdict, 'request_changes');
  assert.equal(parseReviewerVerdict('VERDICT: rejected').verdict, 'request_changes');
  assert.equal(parseReviewerVerdict('VERDICT: `approved`').verdict, 'approve');
});

test('parseReviewerVerdict: the last classifiable marker wins', () => {
  const text = 'VERDICT: request_changes\n\n(author replied; re-checked)\nVERDICT: approve';
  assert.equal(parseReviewerVerdict(text).verdict, 'approve');
  // An unclassifiable marker does not mask an earlier valid one.
  assert.equal(parseReviewerVerdict('VERDICT: approve\nVERDICT: see above').verdict, 'approve');
});

test('parseReviewerVerdict falls back to prose signals, scanning bottom-up', () => {
  assert.equal(
    parseReviewerVerdict('Found defects:\n- build broken\nI cannot approve this.').verdict,
    'request_changes',
  );
  assert.equal(
    parseReviewerVerdict('Initially requested changes; now resolved.\nApproved.').verdict,
    'approve',
  );
  assert.equal(
    parseReviewerVerdict('The work is complete and correct.').verdict,
    'approve',
  );
});

test('parseReviewerVerdict defaults to approve on unparseable output (explicit=false)', () => {
  for (const t of [undefined, '', '   ', 'some inconclusive prose']) {
    const d = parseReviewerVerdict(t);
    assert.equal(d.verdict, 'approve', JSON.stringify(t));
    assert.equal(d.explicit, false);
  }
});

test('resolveMaxRoleFixes honors SC_ROLE_MAX_FIXES with default 3', () => {
  assert.equal(resolveMaxRoleFixes({}), 3);
  assert.equal(resolveMaxRoleFixes({ SC_ROLE_MAX_FIXES: '5' }), 5);
  assert.equal(resolveMaxRoleFixes({ SC_ROLE_MAX_FIXES: '0' }), 0);
  assert.equal(resolveMaxRoleFixes({ SC_ROLE_MAX_FIXES: 'nope' }), 3);
  assert.equal(resolveMaxRoleFixes({ SC_ROLE_MAX_FIXES: '-2' }), 0);
});

test('reviewerSharesExecutorCandidate detects same resolved provider+model', () => {
  const diverse = makeConfig({ roles: { executor: 'openai/gpt-4o-mini', reviewer: 'anthropic/claude-sonnet-4-6' } });
  assert.equal(
    reviewerSharesExecutorCandidate(resolveRole(diverse, 'executor'), resolveRole(diverse, 'reviewer')),
    false,
  );

  const same = makeConfig({ roles: { executor: 'openai/gpt-4o', reviewer: 'openai/gpt-4o' } });
  assert.equal(
    reviewerSharesExecutorCandidate(resolveRole(same, 'executor'), resolveRole(same, 'reviewer')),
    true,
  );

  // A profile alias resolving to the same endpoint+model still collides —
  // the comparison is on the serving identity, not the token label.
  const viaProfile = makeConfig({
    roles: { executor: 'openai/gpt-4o', reviewer: 'corp/gpt-4o' },
    profiles: { corp: { baseUrl: 'https://api.openai.com/v1' } },
  });
  assert.equal(
    reviewerSharesExecutorCandidate(resolveRole(viaProfile, 'executor'), resolveRole(viaProfile, 'reviewer')),
    true,
  );

  // Both roles falling back to the default model collide too.
  const bare = makeConfig();
  assert.equal(
    reviewerSharesExecutorCandidate(resolveRole(bare, 'executor'), resolveRole(bare, 'reviewer')),
    true,
  );
});

test('buildReworkPrompt carries reviewer comments, round bound, and the task', () => {
  const p = buildReworkPrompt('fix the bug', 'defects: bad null check\nVERDICT: request_changes', 2, 3);
  assert.match(p, /REWORK 2\/3/);
  assert.match(p, /bad null check/);
  assert.match(p, /fix the bug/);
});

// ---------------------------------------------------------------------------
// #462 — runRolePipeline consensus loop (scripted agent stub)
// ---------------------------------------------------------------------------

/** Scripted PhaseAgent: replays per-role responses, records every phase call. */
function makeScriptedAgent(
  script: Partial<Record<AgentRole, string[]>>,
  opts: { budgetExceededAfter?: number } = {},
) {
  const calls: Array<{
    role: AgentRole | undefined;
    prompt: string;
    readOnly?: boolean;
    suppressCompletionGuards?: boolean;
  }> = [];
  const queues = new Map<AgentRole, string[]>();
  for (const [k, v] of Object.entries(script)) queues.set(k as AgentRole, [...v]);
  return {
    calls,
    async run(
      prompt: string,
      history: Message[] = [],
      _signal?: AbortSignal,
      phase?: { routing?: RoleResolution; readOnly?: boolean; suppressCompletionGuards?: boolean },
    ): Promise<Message[]> {
      const role = phase?.routing?.role;
      calls.push({
        role,
        prompt,
        readOnly: phase?.readOnly,
        suppressCompletionGuards: phase?.suppressCompletionGuards,
      });
      const q = role ? queues.get(role) : undefined;
      const content = q && q.length > 0 ? q.shift()! : `${role ?? 'agent'} reply`;
      return [...history, { role: 'user', content: prompt }, { role: 'assistant', content }];
    },
    getStats() {
      return {
        budgetExceeded:
          opts.budgetExceededAfter !== undefined && calls.length > opts.budgetExceededAfter
            ? 'steps'
            : null,
      };
    },
  };
}

test('runRolePipeline: request_changes loops back to the executor, then approve ends it', async () => {
  const agent = makeScriptedAgent({
    planner: ['1. inspect\n2. edit'],
    executor: ['implemented v1', 'implemented v2'],
    reviewer: ['defects: missing null check\nVERDICT: request_changes', 'all fixed\nVERDICT: approve'],
  });
  const cfg = makeConfig({ roles: { executor: 'openai/gpt-4o-mini', reviewer: 'anthropic/claude-sonnet-4-6' } });
  const res = await runRolePipeline(agent, resolveRolePipeline(cfg), 'implement the fix');

  assert.deepEqual(agent.calls.map(c => c.role), ['planner', 'executor', 'reviewer', 'executor', 'reviewer']);
  assert.equal(res.fixRounds, 1);
  assert.equal(res.maxFixes, 3);
  assert.equal(res.decision?.verdict, 'approve');
  // The rework prompt carries the reviewer comments back to the executor.
  assert.match(agent.calls[3].prompt, /REWORK 1\/3/);
  assert.match(agent.calls[3].prompt, /missing null check/);
  assert.match(agent.calls[3].prompt, /implement the fix/);
  // The reviewer phase ran under its read-only/guard-suppressed policy.
  for (const call of agent.calls.filter(c => c.role === 'reviewer')) {
    assert.equal(call.readOnly, true);
    assert.equal(call.suppressCompletionGuards, true);
  }
});

test('runRolePipeline: rework loop is bounded by maxFixes (SC_ROLE_MAX_FIXES)', async () => {
  const agent = makeScriptedAgent({
    executor: ['v1', 'v2', 'v3'],
    reviewer: ['VERDICT: request_changes', 'VERDICT: request_changes', 'VERDICT: request_changes'],
  });
  const cfg = makeConfig({ roles: { executor: 'openai/gpt-4o-mini', reviewer: 'anthropic/claude-sonnet-4-6' } });
  const res = await runRolePipeline(agent, resolveRolePipeline(cfg), 'task', [], { maxFixes: 2 });

  // planner (fallback) + executor + [reviewer → rework] × 2 + final review.
  assert.deepEqual(
    agent.calls.map(c => c.role),
    ['planner', 'executor', 'reviewer', 'executor', 'reviewer', 'executor', 'reviewer'],
  );
  assert.equal(res.fixRounds, 2);
  assert.equal(res.decision?.verdict, 'request_changes'); // bound hit — findings unresolved
});

test('runRolePipeline: maxFixes=0 disables rework but still records the verdict', async () => {
  const agent = makeScriptedAgent({
    executor: ['impl'],
    reviewer: ['VERDICT: request_changes'],
  });
  const cfg = makeConfig({ roles: { executor: 'openai/gpt-4o-mini', reviewer: 'anthropic/claude-sonnet-4-6' } });
  const res = await runRolePipeline(agent, resolveRolePipeline(cfg), 'task', [], { maxFixes: 0 });

  assert.deepEqual(agent.calls.map(c => c.role), ['planner', 'executor', 'reviewer']);
  assert.equal(res.fixRounds, 0);
  assert.equal(res.decision?.verdict, 'request_changes');
});

test('runRolePipeline: an approve verdict runs the pipeline straight through', async () => {
  const agent = makeScriptedAgent({
    executor: ['impl'],
    reviewer: ['looks complete\nVERDICT: approve'],
  });
  const cfg = makeConfig({ roles: { executor: 'openai/gpt-4o-mini', reviewer: 'anthropic/claude-sonnet-4-6' } });
  const res = await runRolePipeline(agent, resolveRolePipeline(cfg), 'task');

  assert.deepEqual(agent.calls.map(c => c.role), ['planner', 'executor', 'reviewer']);
  assert.equal(res.fixRounds, 0);
  assert.equal(res.decision?.verdict, 'approve');
});

test('runRolePipeline: a pinned --role reviewer run records the verdict but never loops', async () => {
  const agent = makeScriptedAgent({ reviewer: ['VERDICT: request_changes'] });
  const cfg = makeConfig({
    roles: { executor: 'openai/gpt-4o-mini', reviewer: 'anthropic/claude-sonnet-4-6' },
  });
  const res = await runRolePipeline(agent, resolveRolePipeline(cfg, 'reviewer'), 'task');

  assert.deepEqual(agent.calls.map(c => c.role), ['reviewer']);
  assert.equal(res.decision?.verdict, 'request_changes');
  assert.equal(res.fixRounds, 0);
});

test('runRolePipeline warns once when reviewer shares the executor provider+model', async () => {
  const warns: string[] = [];
  const cfg = makeConfig({ roles: { executor: 'openai/gpt-4o', reviewer: 'openai/gpt-4o' } });
  await runRolePipeline(makeScriptedAgent({}), resolveRolePipeline(cfg), 'task', [], {
    warn: l => warns.push(l),
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /same provider\+model/);
});

test('runRolePipeline: no diversity warning when the reviewer uses another provider', async () => {
  const warns: string[] = [];
  const cfg = makeConfig({ roles: { executor: 'openai/gpt-4o-mini', reviewer: 'anthropic/claude-sonnet-4-6' } });
  await runRolePipeline(makeScriptedAgent({}), resolveRolePipeline(cfg), 'task', [], {
    warn: l => warns.push(l),
  });
  assert.equal(warns.length, 0);
});

test('runRolePipeline: a budget hit stops later phases and rework rounds', async () => {
  const agent = makeScriptedAgent({}, { budgetExceededAfter: 1 });
  const res = await runRolePipeline(
    agent,
    resolveRolePipeline(makeConfig({ roles: { executor: 'openai/gpt-4o-mini' } })),
    'task',
  );
  assert.deepEqual(agent.calls.map(c => c.role), ['planner', 'executor']);
  assert.equal(res.decision, null);
});
