import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRepo } from './probe.js';

function makeNodeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'scc-probe-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      engines: { node: '>=20.0.0' },
      scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .' },
      devDependencies: { typescript: '^5.4.0', vitest: '^4.0.0' },
    }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github/workflows/ci.yml'),
    [
      'name: ci',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: npm ci',
      '      - run: npm run build',
      '      - run: npm test',
      '',
    ].join('\n'),
  );
  return root;
}

test('probeRepo: detects node ecosystem, toolchain, package manager, commands', async () => {
  const root = makeNodeRepo();
  try {
    const profile = await probeRepo(root, { useCache: false });
    assert.ok(profile.ecosystems.includes('node'), `ecosystems: ${profile.ecosystems}`);
    assert.ok(profile.packageManagers.some((p) => p.name === 'npm'));
    assert.equal(profile.commands.install, 'npm ci');
    assert.equal(profile.commands.build, 'npm run build');
    assert.equal(profile.commands.test, 'npm test');
    assert.equal(profile.confidence, 'high');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeRepo: mines CI workflow verify commands', async () => {
  const root = makeNodeRepo();
  try {
    const profile = await probeRepo(root, { useCache: false });
    assert.ok(profile.ci.providers.includes('github-actions'));
    assert.ok(profile.ci.minedVerifyCommands.includes('npm run build'));
    assert.ok(profile.ci.minedVerifyCommands.includes('npm test'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeRepo: empty directory degrades gracefully instead of throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scc-probe-empty-'));
  try {
    const profile = await probeRepo(root, { useCache: false });
    // Fallback detector reports what it found rather than staying silent
    assert.notEqual(profile.confidence, 'high');
    assert.ok(Array.isArray(profile.notes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeRepo: cache round-trip returns equivalent profile', async () => {
  const root = makeNodeRepo();
  try {
    const first = await probeRepo(root, { useCache: false, saveCache: true, cacheDir: join(root, '.cache') });
    const second = await probeRepo(root, { useCache: true, cacheDir: join(root, '.cache') });
    assert.equal(second.ecosystems.join(), first.ecosystems.join());
    assert.equal(second.commands.test, first.commands.test);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
