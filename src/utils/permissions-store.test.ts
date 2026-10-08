import { test, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// permissions-store resolves PERMS_FILE from homedir() at module load — the
// tests stub HOME and re-import a fresh module graph pointed at a temp dir.
// POSIX-only: Node's homedir() reads $HOME there; on Windows it uses a
// different resolution path.
const posix = test.skipIf(process.platform === 'win32');

let tempDir: string;
let fakeHome: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sc-permstore-'));
  fakeHome = join(tempDir, 'home');
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(tempDir, { recursive: true, force: true });
});

async function importStore() {
  vi.stubEnv('HOME', fakeHome);
  vi.resetModules();
  return await import('./permissions-store.js');
}

function permsFile(): string {
  return join(fakeHome, '.sc-agent', 'permissions.json');
}

posix('loadPermissions returns defaults when the file is missing', async () => {
  const store = await importStore();
  const perms = store.loadPermissions();
  assert.equal(perms.mode, 'ask_once');
  assert.deepEqual(perms.sessionTools, []);
  assert.equal(perms.restoreOnStart, false);
  assert.equal(typeof perms.updated, 'number');
});

posix('savePermissions writes the persisted JSON shape and load round-trips it', async () => {
  const store = await importStore();
  store.savePermissions({ mode: 'unlimited', sessionTools: ['run_shell', 'git'], restoreOnStart: true });

  const file = permsFile();
  assert.ok(existsSync(file));
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  assert.equal(raw.mode, 'unlimited');
  assert.deepEqual(raw.sessionTools, ['run_shell', 'git']);
  assert.equal(raw.restoreOnStart, true);
  assert.equal(typeof raw.updated, 'number');

  const loaded = store.loadPermissions();
  assert.equal(loaded.mode, 'unlimited');
  assert.deepEqual(loaded.sessionTools, ['run_shell', 'git']);
  assert.equal(loaded.restoreOnStart, true);
  assert.equal(loaded.updated, raw.updated);
});

posix('savePermissions merges partial updates over the stored state', async () => {
  const store = await importStore();
  store.savePermissions({ mode: 'always_ask' });
  store.savePermissions({ restoreOnStart: true });

  const loaded = store.loadPermissions();
  assert.equal(loaded.mode, 'always_ask', 'first save must persist');
  assert.equal(loaded.restoreOnStart, true, 'second save merges over it');
});

posix('loadPermissions falls back to defaults on a corrupt file', async () => {
  const store = await importStore();
  mkdirSync(join(fakeHome, '.sc-agent'), { recursive: true });
  writeFileSync(permsFile(), '{corrupt!!');

  const perms = store.loadPermissions();
  assert.equal(perms.mode, 'ask_once');
  assert.deepEqual(perms.sessionTools, []);
  assert.equal(perms.restoreOnStart, false);
});

posix('loadPermissions merges a partial file over defaults', async () => {
  const store = await importStore();
  mkdirSync(join(fakeHome, '.sc-agent'), { recursive: true });
  writeFileSync(permsFile(), JSON.stringify({ mode: 'unlimited' }));

  const perms = store.loadPermissions();
  assert.equal(perms.mode, 'unlimited');
  assert.deepEqual(perms.sessionTools, []);
  assert.equal(perms.restoreOnStart, false);
});
