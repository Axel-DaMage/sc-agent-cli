import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRepo } from './probe.js';

function makeNodeRepo(setup: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'scc-probe-dc-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'vitest run' } }),
  );
  setup(root);
  return root;
}

test('probeRepo documents .devcontainer/devcontainer.json presence', async () => {
  const root = makeNodeRepo((r) => {
    mkdirSync(join(r, '.devcontainer'), { recursive: true });
    writeFileSync(
      join(r, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({ image: 'mcr.microsoft.com/devcontainers/base:ubuntu' }),
    );
  });
  try {
    const profile = await probeRepo(root, { useCache: false });
    assert.equal(profile.devcontainer, true);
    assert.equal(profile.devcontainerPath, '.devcontainer/devcontainer.json');
    assert.equal(profile.devcontainerInfo?.image, 'mcr.microsoft.com/devcontainers/base:ubuntu');
    assert.ok(profile.manifests.includes('.devcontainer/devcontainer.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeRepo documents a root-level .devcontainer.json', async () => {
  const root = makeNodeRepo((r) => {
    writeFileSync(join(r, '.devcontainer.json'), '{}');
  });
  try {
    const profile = await probeRepo(root, { useCache: false });
    assert.equal(profile.devcontainer, true);
    assert.equal(profile.devcontainerPath, '.devcontainer.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeRepo reports devcontainer false when no config exists', async () => {
  const root = makeNodeRepo(() => {});
  try {
    const profile = await probeRepo(root, { useCache: false });
    assert.equal(profile.devcontainer, false);
    assert.equal(profile.devcontainerPath, undefined);
    assert.equal(profile.devcontainerInfo, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeRepo still flags devcontainer presence when the config cannot be parsed', async () => {
  const root = makeNodeRepo((r) => {
    writeFileSync(join(r, '.devcontainer.json'), 'this is { not json');
  });
  try {
    const profile = await probeRepo(root, { useCache: false });
    assert.equal(profile.devcontainer, true);
    assert.equal(profile.devcontainerPath, '.devcontainer.json');
    assert.equal(profile.devcontainerInfo, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
