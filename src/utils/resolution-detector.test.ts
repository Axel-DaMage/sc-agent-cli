import { test } from 'vitest';
import assert from 'node:assert/strict';
import { detectSessionResolution, countFilesChanged } from './resolution-detector.js';
import { EXIT_CODES } from './exit-codes.js';
import type { Message } from '../core/types.js';

test('detectSessionResolution: completed resolution when files_changed > 0', () => {
  const history: Message[] = [
    { role: 'user', content: 'Fix bug in auth' },
    {
      role: 'assistant',
      content: 'I fixed the auth module by updating the JWT validation. Note: if CI checks fail, human required for deploy.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/auth.ts' }) },
        },
      ],
    },
  ];

  const res = detectSessionResolution({
    history,
    beforeGitState: { status: '', head: 'head1' },
    afterGitState: { status: ' M src/auth.ts', head: 'head1' },
  });

  assert.equal(res.resolution, 'completed');
  assert.equal(res.files_changed, 1);
  assert.equal(res.exit_code, EXIT_CODES.SUCCESS);
});

test('detectSessionResolution: not_actionable when 0 files changed and text indicates repo-admin required', () => {
  const history: Message[] = [
    { role: 'user', content: 'Fix CI workflow error' },
    {
      role: 'assistant',
      content: 'The workflow failed because Actions are disabled on this repository. This task requires repo-admin privileges to enable Actions.',
    },
  ];

  const res = detectSessionResolution({
    history,
    beforeGitState: { status: '', head: 'head1' },
    afterGitState: { status: '', head: 'head1' },
  });

  assert.equal(res.resolution, 'not_actionable');
  assert.equal(res.files_changed, 0);
  assert.equal(res.exit_code, EXIT_CODES.NOT_ACTIONABLE);
  assert.ok(res.resolution_reason.includes('repo-admin'));
  assert.ok(res.stdout_marker?.startsWith('SCC_NOT_ACTIONABLE'));
});

test('detectSessionResolution: blocked when 0 files changed and text indicates blocked state', () => {
  const history: Message[] = [
    { role: 'user', content: 'Deploy to AWS' },
    {
      role: 'assistant',
      content: 'Task is blocked due to missing AWS credentials in the environment.',
    },
  ];

  const res = detectSessionResolution({
    history,
    beforeGitState: { status: '', head: 'head1' },
    afterGitState: { status: '', head: 'head1' },
  });

  assert.equal(res.resolution, 'blocked');
  assert.equal(res.files_changed, 0);
  assert.equal(res.exit_code, EXIT_CODES.NOT_ACTIONABLE);
  assert.ok(res.stdout_marker?.startsWith('SCC_BLOCKED'));
});

test('detectSessionResolution: explicit VERDICT: NOT_ACTIONABLE marker', () => {
  const history: Message[] = [
    { role: 'user', content: 'Fix branch protection' },
    {
      role: 'assistant',
      content: 'VERDICT: NOT_ACTIONABLE - Branch protection rule changes require org admin access',
    },
  ];

  const res = detectSessionResolution({ history });

  assert.equal(res.resolution, 'not_actionable');
  assert.equal(res.resolution_reason, 'Branch protection rule changes require org admin access');
  assert.equal(res.exit_code, EXIT_CODES.NOT_ACTIONABLE);
});

test('detectSessionResolution: explicit VERDICT: BLOCKED marker', () => {
  const history: Message[] = [
    { role: 'user', content: 'Run integration test' },
    {
      role: 'assistant',
      content: '[VERDICT: BLOCKED] Database service unavailable',
    },
  ];

  const res = detectSessionResolution({ history });

  assert.equal(res.resolution, 'blocked');
  assert.equal(res.resolution_reason, 'Database service unavailable');
  assert.equal(res.exit_code, EXIT_CODES.NOT_ACTIONABLE);
});

test('detectSessionResolution: no_changes when 0 files changed and no blocking/not_actionable indicators', () => {
  const history: Message[] = [
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '2+2 is 4.' },
  ];

  const res = detectSessionResolution({ history });

  assert.equal(res.resolution, 'no_changes');
  assert.equal(res.files_changed, 0);
  assert.equal(res.exit_code, EXIT_CODES.NO_CHANGES);
  assert.equal(res.stdout_marker, 'SCC_NO_CHANGES');
});

test('detectSessionResolution: budget_exceeded', () => {
  const history: Message[] = [{ role: 'user', content: 'Do work' }];

  const res = detectSessionResolution({
    history,
    budgetExceeded: 'iterations:50',
    exitReason: 'budget_exceeded',
  });

  assert.equal(res.resolution, 'budget_exceeded');
  assert.equal(res.exit_code, EXIT_CODES.BUDGET_EXCEEDED);
  assert.ok(res.stdout_marker?.includes('SC_BUDGET_EXCEEDED'));
});

test('detectSessionResolution: error', () => {
  const history: Message[] = [{ role: 'user', content: 'Do work' }];

  const res = detectSessionResolution({
    history,
    agentError: new Error('Network failed'),
  });

  assert.equal(res.resolution, 'error');
  assert.equal(res.resolution_reason, 'Network failed');
  assert.equal(res.exit_code, EXIT_CODES.ERROR);
});

test('countFilesChanged: counts real git diffs, not tool-call artifacts (#464)', () => {
  const history: Message[] = [
    {
      role: 'assistant',
      content: 'Updating files',
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts' }) },
        },
        {
          id: '2',
          type: 'function',
          function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/b.ts' }) },
        },
      ],
    },
  ];

  const count = countFilesChanged(
    { status: '', head: 'h1' },
    { status: ' M src/a.ts\n M src/c.ts', head: 'h1' },
    history
  );

  // src/a.ts and src/c.ts appear in the real worktree diff; src/b.ts is a
  // session artifact (no matching diff — e.g. the edit was reverted) and is
  // not counted.
  assert.equal(count, 2);
});

test('countFilesChanged: a run whose edits were self-reverted reports 0 (#464)', () => {
  // Dogfood failure shape: edit_file succeeded, then `git checkout -- .` left
  // a clean tree — files_changed must be 0, not the count of tool-call paths.
  const history: Message[] = [
    {
      role: 'assistant',
      content: 'Applying the fix',
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/a.ts' }) },
        },
        {
          id: '2',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/new.ts' }) },
        },
      ],
    },
  ];

  const count = countFilesChanged(
    { status: '', head: 'h1' },
    { status: '', head: 'h1' },
    history,
    '/repo'
  );

  assert.equal(count, 0);
});

test('countFilesChanged: excludes engine session artifacts from the diff (#464)', () => {
  // --audit-log / --summary-file paths written inside the worktree are engine
  // artifacts, not repo diffs.
  const count = countFilesChanged(
    { status: '', head: 'h1', root: '/repo' },
    { status: '?? audit.jsonl\n?? run.json\n M src/app.ts', head: 'h1', root: '/repo' },
    undefined,
    '/repo',
    ['/repo/audit.jsonl', '/repo/run.json']
  );

  assert.equal(count, 1); // only src/app.ts
});

test('countFilesChanged: falls back to tool-call paths when git state is unavailable', () => {
  const history: Message[] = [
    {
      role: 'assistant',
      content: 'Writing files',
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/x.ts' }) },
        },
        {
          id: '2',
          type: 'function',
          function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/y.ts' }) },
        },
      ],
    },
  ];

  // Non-git workspace: no git state captured, tool calls are the only signal.
  const count = countFilesChanged(null, null, history, '/repo');
  assert.equal(count, 2);
});

test('detectSessionResolution: reports no_changes when only engine artifacts differ (#464)', () => {
  const history: Message[] = [
    { role: 'user', content: 'Summarize the repo' },
    { role: 'assistant', content: 'This is a provider-agnostic CLI agent.' },
  ];

  const res = detectSessionResolution({
    history,
    beforeGitState: { status: '', head: 'h1', root: '/repo' },
    afterGitState: { status: '?? run-manifest.json', head: 'h1', root: '/repo' },
    workspaceRoot: '/repo',
    excludePaths: ['/repo/run-manifest.json'],
  });

  assert.equal(res.files_changed, 0);
  assert.equal(res.resolution, 'no_changes');
  assert.equal(res.exit_code, EXIT_CODES.NO_CHANGES);
});
