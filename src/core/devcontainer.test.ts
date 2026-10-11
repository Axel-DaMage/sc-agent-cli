import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInnerChatArgv,
  findOnPath,
  insideDevcontainerRunInfo,
  isInsideDevcontainer,
  orchestrateDevcontainer,
  planDevcontainerRun,
  AGENT_COMMAND_ENV_VAR,
  DEVCONTAINER_ENV_VAR,
} from './devcontainer.js';

function makeRepo(devcontainer: 'nested' | 'root' | 'none' = 'nested'): string {
  const root = mkdtempSync(join(tmpdir(), 'scc-dc-'));
  if (devcontainer === 'nested') {
    mkdirSync(join(root, '.devcontainer'), { recursive: true });
    writeFileSync(
      join(root, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({ image: 'mcr.microsoft.com/devcontainers/base:ubuntu' }),
    );
  } else if (devcontainer === 'root') {
    writeFileSync(join(root, '.devcontainer.json'), '{}');
  }
  return root;
}

function makePathEnv(...binNames: string[]): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'scc-dc-path-'));
  for (const name of binNames) {
    const file = join(dir, name);
    writeFileSync(file, '');
    try { chmodSync(file, 0o755); } catch { /* windows */ }
  }
  return { env: { PATH: dir }, dir };
}

function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

test('buildInnerChatArgv prepends chat and keeps --devcontainer for the in-container run', () => {
  assert.deepEqual(
    buildInnerChatArgv(['chat', '-yq', 'do x', '--devcontainer']),
    ['chat', '-yq', 'do x', '--devcontainer'],
  );
  assert.deepEqual(
    buildInnerChatArgv(['-yq', 'do x', '--devcontainer']),
    ['chat', '-yq', 'do x', '--devcontainer'],
  );
  assert.deepEqual(buildInnerChatArgv([]), ['chat']);
});

test('findOnPath locates executables and misses absent ones', () => {
  const { env, dir } = makePathEnv('devcontainer');
  try {
    assert.equal(findOnPath('devcontainer', env), join(dir, 'devcontainer'));
    assert.equal(findOnPath('docker', env), null);
    assert.equal(findOnPath('devcontainer', { PATH: '' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planDevcontainerRun falls back to host when no devcontainer config exists', () => {
  const root = makeRepo('none');
  try {
    const plan = planDevcontainerRun({ workspaceRoot: root, argv: ['chat', 'hi'], env: { PATH: '' } });
    assert.equal(plan.execPath, 'host');
    assert.equal(plan.reason, 'no_config');
    assert.equal(plan.configPath, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('planDevcontainerRun reports cli_missing then docker_missing', () => {
  const root = makeRepo('nested');
  const empty = makePathEnv();
  const withCli = makePathEnv('devcontainer');
  try {
    let plan = planDevcontainerRun({ workspaceRoot: root, argv: ['chat', 'hi'], env: empty.env });
    assert.equal(plan.execPath, 'host');
    assert.equal(plan.reason, 'cli_missing');
    assert.equal(plan.configPath, '.devcontainer/devcontainer.json');

    plan = planDevcontainerRun({ workspaceRoot: root, argv: ['chat', 'hi'], env: withCli.env });
    assert.equal(plan.execPath, 'host');
    assert.equal(plan.reason, 'docker_missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty.dir, { recursive: true, force: true });
    rmSync(withCli.dir, { recursive: true, force: true });
  }
});

test('planDevcontainerRun reports up_failed when devcontainer up fails', () => {
  const root = makeRepo('nested');
  const { env, dir } = makePathEnv('devcontainer', 'docker');
  try {
    const plan = planDevcontainerRun({
      workspaceRoot: root,
      argv: ['chat', 'hi'],
      env,
      runUp: () => ({ ok: false, detail: 'image build failed' }),
    });
    assert.equal(plan.execPath, 'host');
    assert.equal(plan.reason, 'up_failed');
    assert.equal(plan.detail, 'image build failed');
    assert.equal(plan.configPath, '.devcontainer/devcontainer.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planDevcontainerRun builds devcontainer exec argv with remote-env marker', () => {
  const root = makeRepo('nested');
  const { env, dir } = makePathEnv('devcontainer', 'docker');
  try {
    const plan = planDevcontainerRun({
      workspaceRoot: root,
      argv: ['-yq', '--devcontainer', 'implement the thing'],
      env,
      runUp: () => ({ ok: true }),
    });
    assert.equal(plan.execPath, 'devcontainer');
    assert.equal(plan.configPath, '.devcontainer/devcontainer.json');
    assert.deepEqual(plan.execArgv, [
      'exec',
      '--workspace-folder', root,
      '--remote-env', 'SC_DEVCONTAINER=1',
      'scc', 'chat', '-yq', '--devcontainer', 'implement the thing',
    ]);
    assert.ok(plan.display?.startsWith('devcontainer exec --workspace-folder'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planDevcontainerRun honors SC_DEVCONTAINER_AGENT_CMD override', () => {
  const root = makeRepo('root');
  const { env: pathEnv, dir } = makePathEnv('devcontainer', 'docker');
  const env = { ...pathEnv, [AGENT_COMMAND_ENV_VAR]: 'sc' };
  try {
    const plan = planDevcontainerRun({
      workspaceRoot: root,
      argv: ['chat', 'hi', '--devcontainer'],
      env,
      runUp: () => ({ ok: true }),
    });
    assert.equal(plan.execPath, 'devcontainer');
    assert.equal(plan.configPath, '.devcontainer.json');
    assert.equal(plan.execArgv?.[5], 'sc');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orchestrateDevcontainer runs inside the container, records exec path, propagates exit code', async () => {
  const root = makeRepo('nested');
  const { env, dir } = makePathEnv('devcontainer', 'docker');
  const auditFile = join(root, 'audit.jsonl');
  try {
    let seenArgv: string[] | undefined;
    const outcome = await orchestrateDevcontainer({
      workspaceRoot: root,
      argv: ['chat', '-yq', '--devcontainer', 'go'],
      env,
      auditLogPath: auditFile,
      quiet: true,
      runUp: () => ({ ok: true }),
      runExec: async (argv) => {
        seenArgv = argv;
        return { spawned: true, exitCode: 10 };
      },
    });
    if (!outcome.executed) assert.fail('expected in-container execution');
    assert.equal(outcome.exitCode, 10);
    assert.equal(seenArgv?.[0], 'exec');
    assert.ok(seenArgv?.includes('SC_DEVCONTAINER=1'));

    const events = readJsonl(auditFile).filter((e) => e.type === 'devcontainer');
    assert.ok(
      events.some(
        (e) => e.exec_path === 'devcontainer' && /devcontainer exec/.test(String(e.command)),
      ),
    );
    assert.ok(events.some((e) => e.exit_code === 10));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orchestrateDevcontainer classifies host fallback as devcontainer_unavailable', async () => {
  const root = makeRepo('nested');
  const { env, dir } = makePathEnv(); // nothing on PATH → cli_missing
  const auditFile = join(root, 'audit.jsonl');
  try {
    const outcome = await orchestrateDevcontainer({
      workspaceRoot: root,
      argv: ['chat', 'go', '--devcontainer'],
      env,
      auditLogPath: auditFile,
      quiet: true,
    });
    if (outcome.executed) assert.fail('expected host fallback');
    assert.equal(outcome.runInfo.status, 'devcontainer_unavailable');
    assert.equal(outcome.runInfo.exec_path, 'host');
    assert.equal(outcome.runInfo.reason, 'cli_missing');
    assert.equal(outcome.runInfo.config_path, '.devcontainer/devcontainer.json');

    const events = readJsonl(auditFile).filter((e) => e.type === 'devcontainer');
    assert.ok(
      events.some(
        (e) =>
          e.exec_path === 'host' &&
          e.status === 'devcontainer_unavailable' &&
          e.reason === 'cli_missing',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orchestrateDevcontainer falls back to host when the exec cannot be spawned', async () => {
  const root = makeRepo('nested');
  const { env, dir } = makePathEnv('devcontainer', 'docker');
  try {
    const outcome = await orchestrateDevcontainer({
      workspaceRoot: root,
      argv: ['chat', 'go', '--devcontainer'],
      env,
      quiet: true,
      runUp: () => ({ ok: true }),
      runExec: async () => ({ spawned: false, error: 'spawn devcontainer ENOENT' }),
    });
    if (outcome.executed) assert.fail('expected host fallback');
    assert.equal(outcome.runInfo.reason, 'exec_failed');
    assert.equal(outcome.runInfo.detail, 'spawn devcontainer ENOENT');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('insideDevcontainerRunInfo exposes the remote-env marker and container hostname', () => {
  const root = makeRepo('root');
  try {
    const env = { [DEVCONTAINER_ENV_VAR]: '1' };
    assert.equal(isInsideDevcontainer(env), true);
    assert.equal(isInsideDevcontainer({}), false);

    const info = insideDevcontainerRunInfo(root, env);
    assert.equal(info.exec_path, 'devcontainer');
    assert.equal(info.status, 'devcontainer');
    assert.equal(info.marker, 'SC_DEVCONTAINER=1');
    assert.ok(info.hostname && info.hostname.length > 0);
    assert.equal(info.config_path, '.devcontainer.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
