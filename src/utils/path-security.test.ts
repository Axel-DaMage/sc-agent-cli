import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSafePath } from './path-security.js';
import type { ProjectConfig } from '../core/types.js';

const config: ProjectConfig = {
  model: {
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
  },
  permissions: {
    denyPaths: ['.env'],
  },
};

test('resolveSafePath denies access when workspace root does not exist', () => {
  assert.throws(
    () => resolveSafePath('some-file', 'C:\\nonexistent-workspace', config),
    /cannot resolve workspace root/
  );
});

test('resolveSafePath rejects paths outside workspace', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'sc-agent-ws-'));
  assert.throws(
    () => resolveSafePath('../etc/passwd', ws, config),
    /outside the workspace/
  );
});

test('resolveSafePath rejects deny-listed files', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'sc-agent-ws-'));
  await writeFile(path.join(ws, '.env'), 'SECRET=value');
  assert.throws(
    () => resolveSafePath('.env', ws, config),
    /matches a deny pattern/
  );
});

test('resolveSafePath allows files within workspace', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'sc-agent-ws-'));
  await writeFile(path.join(ws, 'safe.txt'), 'hello');
  const result = resolveSafePath('safe.txt', ws, config);
  // resolveSafePath returns canonical real paths — normalize the tmpdir
  // workspace the same way before comparing (macOS: /var → /private/var
  // symlink; Windows: 8.3 short names in %TEMP%, e.g. RUNNER~1).
  assert.equal(result, path.join(realpathSync(ws), 'safe.txt'));
});

test('resolveSafePath denies nested files matched by deny globs on any separator', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'sc-agent-ws-'));
  await mkdir(path.join(ws, 'secrets'), { recursive: true });
  await writeFile(path.join(ws, 'secrets', 'api.key'), 'SECRET=x');
  const nestedDeny: ProjectConfig = {
    ...config,
    permissions: { denyPaths: ['secrets/**'] },
  };
  // Windows emits `secrets\api.key` from path.relative — the matcher must see
  // forward slashes or the deny glob silently misses (#484).
  assert.throws(
    () => resolveSafePath('secrets/api.key', ws, nestedDeny),
    /matches a deny pattern/
  );
});

test('resolveSafePath denies symlink aliases that mask deny-listed targets', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'sc-agent-ws-'));
  const secretsDir = path.join(ws, 'secrets');
  await mkdir(secretsDir, { recursive: true });
  await writeFile(path.join(secretsDir, 'api.key'), 'SECRET=x');
  // 'junction' is the no-admin symlink form for directories on Windows;
  // POSIX ignores the type flag. Junction targets must be absolute.
  await symlink(realpathSync(secretsDir), path.join(ws, 'alias'), 'junction');
  const nestedDeny: ProjectConfig = {
    ...config,
    permissions: { denyPaths: ['secrets/**'] },
  };
  // The logical path 'alias/api.key' does not textually match 'secrets/**' —
  // only the realpath does. Matching must apply to both.
  assert.throws(
    () => resolveSafePath('alias/api.key', ws, nestedDeny),
    /matches a deny pattern/
  );
});
