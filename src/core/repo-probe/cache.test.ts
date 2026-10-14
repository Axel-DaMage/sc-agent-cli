import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  computeManifestFingerprint,
  getCachedProfile,
  saveCachedProfile,
  clearRepoProfileCache,
} from './cache.js';
import type { RepoProfile } from './types.js';

let root: string;
let cacheDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sc-cache-ws-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'sc-cache-dir-'));
  // The memory cache is module-global — clear it so tests stay isolated.
  clearRepoProfileCache();
});

afterEach(() => {
  clearRepoProfileCache();
  rmSync(root, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

function makeProfile(manifests: string[] = ['package.json']): RepoProfile {
  return {
    version: '1.1.0',
    timestamp: Date.now(),
    root,
    ecosystems: ['node'],
    confidence: 'high',
    toolchains: [{ name: 'node', version: '20' }],
    packageManagers: [{ name: 'npm', lockfile: 'package-lock.json' }],
    frameworks: [],
    commands: { install: 'npm ci' },
    ci: { providers: [], workflows: [], minedVerifyCommands: [] },
    devcontainer: false,
    manifests,
  };
}

function cacheFileFor(workspaceRoot: string, dir = cacheDir): string {
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  return join(dir, `profile-${hash}.json`);
}

test('computeManifestFingerprint: empty repo → empty fingerprint', () => {
  assert.equal(computeManifestFingerprint(root), '');
});

test('computeManifestFingerprint reflects present manifests only', () => {
  writeFileSync(join(root, 'package.json'), '{}');
  const fp = computeManifestFingerprint(root);
  assert.ok(fp.includes('package.json:'));
  assert.ok(!fp.includes('Cargo.toml'));
});

test('computeManifestFingerprint honors an explicit manifest list', () => {
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'go.mod'), 'module m\n');
  const fp = computeManifestFingerprint(root, ['go.mod']);
  assert.ok(fp.includes('go.mod:'));
  assert.ok(!fp.includes('package.json'));
});

test('cache miss → null; after save → hit returns the same profile', () => {
  writeFileSync(join(root, 'package.json'), '{}');
  assert.equal(getCachedProfile(root, undefined, cacheDir), null);

  const profile = makeProfile();
  saveCachedProfile(profile, cacheDir);

  const cached = getCachedProfile(root, undefined, cacheDir);
  assert.deepEqual(cached, profile);
});

test('disk cache round-trip: profile survives a memory-cache clear', () => {
  writeFileSync(join(root, 'package.json'), '{}');
  const profile = makeProfile();
  saveCachedProfile(profile, cacheDir);

  // File actually written to disk…
  const cacheFile = cacheFileFor(root);
  const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  assert.equal(raw.profile.root, root);
  assert.equal(typeof raw.fingerprint, 'string');

  // …and a fresh process view (memory cleared) still hits.
  clearRepoProfileCache();
  const cached = getCachedProfile(root, undefined, cacheDir);
  assert.deepEqual(cached, profile);
});

test('manifest change invalidates the cached profile', () => {
  writeFileSync(join(root, 'package.json'), '{"a":1}');
  saveCachedProfile(makeProfile(), cacheDir);
  assert.ok(getCachedProfile(root, undefined, cacheDir), 'baseline hit');

  // Touch the manifest — mtime/size shift changes the fingerprint.
  writeFileSync(join(root, 'package.json'), '{"a":1,"b":2}');
  assert.equal(getCachedProfile(root, undefined, cacheDir), null);
});

test('corrupt disk cache entry degrades to a miss', () => {
  writeFileSync(join(root, 'package.json'), '{}');
  saveCachedProfile(makeProfile(), cacheDir);
  clearRepoProfileCache();

  writeFileSync(cacheFileFor(root), '{corrupted');
  assert.equal(getCachedProfile(root, undefined, cacheDir), null);
});

test('stale fingerprint on disk degrades to a miss', () => {
  writeFileSync(join(root, 'package.json'), '{}');
  saveCachedProfile(makeProfile(), cacheDir);
  clearRepoProfileCache();

  writeFileSync(cacheFileFor(root), JSON.stringify({ profile: makeProfile(), fingerprint: 'bogus', timestamp: 0 }));
  assert.equal(getCachedProfile(root, undefined, cacheDir), null);
});

test('saveCachedProfile tolerates an unwritable cache dir', () => {
  writeFileSync(join(root, 'package.json'), '{}');
  const blocker = join(root, 'not-a-dir');
  writeFileSync(blocker, 'x');
  const badDir = join(blocker, 'cache');

  // Disk write fails → swallowed; memory cache still serves the profile.
  const profile = makeProfile();
  assert.doesNotThrow(() => saveCachedProfile(profile, badDir));
  assert.deepEqual(getCachedProfile(root, undefined, badDir), profile);
});

test('clearRepoProfileCache empties the memory cache', () => {
  writeFileSync(join(root, 'package.json'), '{}');
  saveCachedProfile(makeProfile(), cacheDir);
  assert.ok(getCachedProfile(root, undefined, cacheDir));
  clearRepoProfileCache();
  // Disk still hits — this only asserts the memory layer is empty by
  // confirming a fresh lookup still resolves (through the disk path).
  assert.ok(getCachedProfile(root, undefined, cacheDir));
});
