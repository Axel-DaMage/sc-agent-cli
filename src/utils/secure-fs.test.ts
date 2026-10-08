import { test, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
  appendFileSecureSync,
  ensureSecureDir,
  ensureSecureDirSync,
  warnOnLoosePermissions,
  writeFileSecure,
  writeFileSecureSync,
} from './secure-fs.js';

// POSIX mode bits don't exist on Windows — the helpers intentionally no-op
// there, so permission assertions only run on POSIX platforms.
const posix = test.skipIf(process.platform === 'win32');

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'sc-secure-fs-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tempDir, { recursive: true, force: true });
});

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

posix('writeFileSecureSync creates files with mode 0600', () => {
  const file = path.join(tempDir, 'secret.json');
  writeFileSecureSync(file, '{"k":1}');
  assert.equal(mode(file), SECURE_FILE_MODE);
});

posix('writeFileSecureSync tightens a pre-existing loose file', () => {
  const file = path.join(tempDir, 'loose.json');
  writeFileSync(file, 'old');
  chmodSync(file, 0o644); // set explicitly — umask-independent
  assert.equal(mode(file), 0o644);
  writeFileSecureSync(file, 'new');
  assert.equal(mode(file), SECURE_FILE_MODE);
  assert.equal(statSync(file).size > 0, true);
});

posix('writeFileSecure (async) creates 0600 and tightens loose files', async () => {
  const file = path.join(tempDir, 'async.json');
  await writeFileSecure(file, 'x');
  assert.equal(mode(file), SECURE_FILE_MODE);

  chmodSync(file, 0o664);
  await writeFileSecure(file, 'y');
  assert.equal(mode(file), SECURE_FILE_MODE);
});

posix('appendFileSecureSync creates 0600 and keeps it across appends', () => {
  const file = path.join(tempDir, 'audit.jsonl');
  appendFileSecureSync(file, '{"a":1}\n');
  assert.equal(mode(file), SECURE_FILE_MODE);

  chmodSync(file, 0o644);
  appendFileSecureSync(file, '{"a":2}\n');
  assert.equal(mode(file), SECURE_FILE_MODE);
});

posix('ensureSecureDirSync creates nested dirs with 0700', () => {
  const dir = path.join(tempDir, 'a', 'b', 'c');
  ensureSecureDirSync(dir);
  assert.equal(mode(dir), SECURE_DIR_MODE);
  assert.equal(mode(path.join(tempDir, 'a', 'b')), SECURE_DIR_MODE);
  assert.equal(mode(path.join(tempDir, 'a')), SECURE_DIR_MODE);
});

posix('ensureSecureDirSync tightens a pre-existing loose dir', () => {
  const dir = path.join(tempDir, 'loose-dir');
  mkdirSync(dir);
  chmodSync(dir, 0o755); // set explicitly — umask-independent
  ensureSecureDirSync(dir);
  assert.equal(mode(dir), SECURE_DIR_MODE);
});

posix('ensureSecureDir (async) creates dirs with 0700', async () => {
  const dir = path.join(tempDir, 'async-dir');
  await ensureSecureDir(dir);
  assert.equal(mode(dir), SECURE_DIR_MODE);
});

posix('warnOnLoosePermissions warns and repairs to 0600', () => {
  const file = path.join(tempDir, 'config.json');
  writeFileSync(file, '{}');
  chmodSync(file, 0o644);

  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  warnOnLoosePermissions(file, 'Global config');

  assert.equal(mode(file), SECURE_FILE_MODE);
  assert.equal(spy.mock.calls.length, 1);
  assert.match(String(spy.mock.calls[0][0]), /loose permissions \(644\)/);
  assert.match(String(spy.mock.calls[0][0]), /repaired to 600/);
});

posix('warnOnLoosePermissions is silent for tight or missing files', () => {
  const tight = path.join(tempDir, 'tight.json');
  writeFileSync(tight, '{}');
  chmodSync(tight, 0o600);

  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  warnOnLoosePermissions(tight);
  warnOnLoosePermissions(path.join(tempDir, 'missing.json'));
  assert.equal(spy.mock.calls.length, 0);
});

// ── Integration: modules with fixed ~/.sc-agent paths ─────────────────────
// These resolve their target dir from homedir() at module load, so the tests
// stub HOME and re-import a fresh module graph pointed at the temp dir.

async function importWithHome<T>(spec: string, fakeHome: string): Promise<T> {
  vi.stubEnv('HOME', fakeHome);
  vi.resetModules();
  return (await import(spec)) as T;
}

posix('ensureSecureDirSync tightens the ~/.sc-agent chain up to the root', async () => {
  // Point ~/.sc-agent at a temp home, pre-create it loose, then write a
  // nested dir — the helper must repair the root too.
  const fakeHome = path.join(tempDir, 'home');
  const stateRoot = path.join(fakeHome, '.sc-agent');
  mkdirSync(stateRoot, { recursive: true });
  chmodSync(stateRoot, 0o755); // simulate a legacy loose install
  assert.equal(mode(stateRoot), 0o755);

  const secureFs = await importWithHome<typeof import('./secure-fs.js')>('./secure-fs.js', fakeHome);
  const nested = path.join(stateRoot, 'memory', 'workspaces');
  secureFs.ensureSecureDirSync(nested);

  assert.equal(mode(nested), SECURE_DIR_MODE);
  assert.equal(mode(path.join(stateRoot, 'memory')), SECURE_DIR_MODE);
  assert.equal(mode(stateRoot), SECURE_DIR_MODE, 'loose ~/.sc-agent root must be repaired');
});

posix('saveConfig writes ~/.sc-agent/config.json as 0600 under a 0700 dir', async () => {
  const fakeHome = path.join(tempDir, 'home-config');
  const config = await importWithHome<typeof import('../core/config.js')>('../core/config.js', fakeHome);

  await config.saveConfig(
    { model: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'm', apiKey: 'sk-test' } },
    true
  );

  const stateRoot = path.join(fakeHome, '.sc-agent');
  const configPath = path.join(stateRoot, 'config.json');
  assert.equal(mode(stateRoot), SECURE_DIR_MODE);
  assert.equal(mode(configPath), SECURE_FILE_MODE);
});

posix('saveCheckpoint writes checkpoint files with 0600', async () => {
  const fakeHome = path.join(tempDir, 'home-checkpoint');
  const checkpoint = await importWithHome<typeof import('./checkpoint.js')>('./checkpoint.js', fakeHome);

  const filePath = checkpoint.saveCheckpoint({
    sessionId: 'sess-1',
    workspaceRoot: '/tmp/ws',
    history: [],
    inputHistory: [],
    iterations: 1,
    toolRunCount: 0,
  });

  assert.equal(mode(filePath), SECURE_FILE_MODE);
  assert.equal(mode(path.join(fakeHome, '.sc-agent', 'checkpoints')), SECURE_DIR_MODE);
  assert.equal(mode(path.join(fakeHome, '.sc-agent')), SECURE_DIR_MODE);
});

posix('savePermissions writes permissions.json with 0600', async () => {
  const fakeHome = path.join(tempDir, 'home-perms');
  const store = await importWithHome<typeof import('./permissions-store.js')>('./permissions-store.js', fakeHome);

  store.savePermissions({ mode: 'unlimited' });

  const file = path.join(fakeHome, '.sc-agent', 'permissions.json');
  assert.ok(existsSync(file));
  assert.equal(mode(file), SECURE_FILE_MODE);
  assert.equal(mode(path.join(fakeHome, '.sc-agent')), SECURE_DIR_MODE);
});
