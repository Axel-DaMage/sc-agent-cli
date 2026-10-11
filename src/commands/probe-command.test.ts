import { test, vi, beforeEach, afterEach, type Mock } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoProfile } from '../core/repo-probe/index.js';
import { probeRepo } from '../core/repo-probe/index.js';
import { probeCommand } from './probe-command.js';

// probeRepo is mocked (importOriginal keeps the real formatters): the
// command-level contract under test is option dispatch + payload + the
// error/exit path — probing itself is covered in core/repo-probe tests.
vi.mock('../core/repo-probe/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/repo-probe/index.js')>();
  return { ...actual, probeRepo: vi.fn() };
});

const probeRepoMock = probeRepo as unknown as Mock;

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function fixtureProfile(root: string): RepoProfile {
  return {
    version: '1.1.0',
    timestamp: 1700000000000,
    root,
    ecosystems: ['node'],
    confidence: 'high',
    toolchains: [{ name: 'node', version: '20' }],
    packageManagers: [{ name: 'npm', lockfile: 'package-lock.json' }],
    frameworks: [],
    commands: { install: 'npm ci', test: 'npm test' },
    ci: { providers: [], workflows: [], minedVerifyCommands: [] },
    devcontainer: false,
    manifests: ['package.json'],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-probecmd-'));
  probeRepoMock.mockReset().mockResolvedValue(fixtureProfile(dir));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // process.exit must not actually exit the test worker — throw instead.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

test('default invocation renders the terminal profile', async () => {
  await probeCommand(dir);
  assert.equal(probeRepoMock.mock.calls.length, 1);
  assert.deepEqual(probeRepoMock.mock.calls[0][0], dir);

  const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  assert.match(out, /REPOSITORY PROFILE & TOOLCHAIN/);
  assert.match(out, /node/);
  assert.equal(errSpy.mock.calls.length, 0);
  assert.equal(exitSpy.mock.calls.length, 0);
});

test('--json prints the JSON profile payload', async () => {
  await probeCommand(dir, { json: true });
  const payload = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(''));
  assert.equal(payload.root, dir);
  assert.deepEqual(payload.ecosystems, ['node']);
  assert.equal(payload.commands.install, 'npm ci');
});

test('--prompt prints the markdown prompt block', async () => {
  await probeCommand(dir, { prompt: true });
  const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  assert.match(out, /## Repository Profile & Toolchain \(Auto-detected\)/);
  assert.match(out, /Package Managers.*npm/);
});

test('--quiet suppresses output', async () => {
  await probeCommand(dir, { quiet: true });
  assert.equal(logSpy.mock.calls.length, 0);
});

test('--save writes .sc-agent/repo-profile.json into the workspace', async () => {
  await probeCommand(dir, { save: true });
  const saved = join(dir, '.sc-agent', 'repo-profile.json');
  assert.ok(existsSync(saved));
  assert.equal(JSON.parse(readFileSync(saved, 'utf-8')).root, dir);
  assert.match(logSpy.mock.calls.map((c) => String(c[0])).join('\n'), /Repo profile saved/);
});

test('--save --quiet writes the file without the saved notice', async () => {
  await probeCommand(dir, { save: true, quiet: true });
  assert.ok(existsSync(join(dir, '.sc-agent', 'repo-profile.json')));
  assert.equal(logSpy.mock.calls.length, 0);
});

test('cache option toggles useCache/forceRefresh passed to probeRepo', async () => {
  await probeCommand(dir, { cache: false });
  assert.deepEqual(probeRepoMock.mock.calls[0][1], { useCache: false, forceRefresh: true });

  probeRepoMock.mockClear();
  await probeCommand(dir);
  assert.deepEqual(probeRepoMock.mock.calls[0][1], { useCache: true, forceRefresh: false });
});

test('probe failure exits(1) and reports via console.error', async () => {
  probeRepoMock.mockRejectedValueOnce(new Error('probe exploded'));
  await assert.rejects(() => probeCommand(dir), /process\.exit\(1\)/);
  assert.match(errSpy.mock.calls.map((c) => String(c[0])).join('\n'), /probe exploded/);
});

test('probe failure under --json prints the error payload instead', async () => {
  probeRepoMock.mockRejectedValueOnce(new Error('probe exploded'));
  await assert.rejects(() => probeCommand(dir, { json: true }), /process\.exit\(1\)/);
  const payload = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(''));
  assert.equal(payload.error, 'probe exploded');
});

test('no targetPath probes the process cwd', async () => {
  await probeCommand();
  assert.equal(probeRepoMock.mock.calls[0][0], process.cwd());
});
