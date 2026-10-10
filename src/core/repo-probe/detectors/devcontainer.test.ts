import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectDevcontainer } from './devcontainer.js';
import { probeRepo } from '../probe.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-dc-'));
  for (const [name, content] of Object.entries(files)) {
    const p = join(root, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  dirs.push(root);
  return root;
}

test('no devcontainer config → not detected', () => {
  const res = detectDevcontainer(repo({ 'README.md': 'x' }));
  assert.equal(res.detected, false);
  assert.equal(res.configFile, undefined);
  assert.deepEqual(res.manifests, []);
});

test('.devcontainer/devcontainer.json → detected with parsed config', () => {
  const root = repo(
    {
      '.devcontainer/devcontainer.json': JSON.stringify({
        image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
        features: { 'ghcr.io/devcontainers/features/node:1': {} },
        postCreateCommand: 'npm install',
        updateContentCommand: 'npm ci',
        postStartCommand: 'npm run dev',
        customizations: { vscode: { extensions: ['dbaeumer.vscode-eslint'] } },
        build: { dockerfile: 'Dockerfile' },
      }),
    },
  );
  const res = detectDevcontainer(root);

  assert.equal(res.detected, true);
  assert.equal(res.configFile, '.devcontainer/devcontainer.json');
  assert.ok(res.manifests.includes('.devcontainer/devcontainer.json'));

  const dc = res.devcontainer!;
  assert.equal(dc.configFile, '.devcontainer/devcontainer.json');
  assert.equal(dc.image, 'mcr.microsoft.com/devcontainers/base:ubuntu');
  assert.equal(dc.dockerfile, 'Dockerfile');
  assert.equal(dc.postCreateCommand, 'npm install');
  assert.equal(dc.updateContentCommand, 'npm ci');
  assert.equal(dc.postStartCommand, 'npm run dev');
  assert.deepEqual(dc.customizations, { vscode: { extensions: ['dbaeumer.vscode-eslint'] } });
  assert.ok(dc.features && 'ghcr.io/devcontainers/features/node:1' in dc.features);
});

test('root-level .devcontainer.json → detected with .devcontainer.json path', () => {
  const root = repo({ '.devcontainer.json': JSON.stringify({ image: 'ubuntu' }) });
  const res = detectDevcontainer(root);
  assert.equal(res.detected, true);
  assert.equal(res.configFile, '.devcontainer.json');
  assert.equal(res.devcontainer?.image, 'ubuntu');
});

test('nested config wins over root-level config', () => {
  const root = repo({
    '.devcontainer/devcontainer.json': JSON.stringify({ image: 'nested' }),
    '.devcontainer.json': JSON.stringify({ image: 'root' }),
  });
  const res = detectDevcontainer(root);
  assert.equal(res.configFile, '.devcontainer/devcontainer.json');
  assert.equal(res.devcontainer?.image, 'nested');
});

test('object postCreateCommand is serialized to JSON', () => {
  const root = repo({
    '.devcontainer.json': JSON.stringify({ postCreateCommand: { install: 'npm ci', build: 'npm run build' } }),
  });
  const res = detectDevcontainer(root);
  assert.equal(res.detected, true);
  assert.equal(
    res.devcontainer?.postCreateCommand,
    JSON.stringify({ install: 'npm ci', build: 'npm run build' })
  );
});

test('unparseable config → detected but devcontainerInfo absent', () => {
  const root = repo({ '.devcontainer.json': 'not json{{{' });
  const res = detectDevcontainer(root);
  assert.equal(res.detected, true);
  assert.equal(res.configFile, '.devcontainer.json');
  assert.equal(res.devcontainer, undefined);
});

test('JSONC comments in devcontainer.json are tolerated', () => {
  const root = repo({
    '.devcontainer.json': [
      '// comment line',
      '{',
      '  "image": "ubuntu:24.04", // trailing comment',
      '  "postCreateCommand": "apt-get update",',
      '}',
      '',
    ].join('\n'),
  });
  const res = detectDevcontainer(root);
  assert.equal(res.devcontainer?.image, 'ubuntu:24.04');
  assert.equal(res.devcontainer?.postCreateCommand, 'apt-get update');
});

test('probeRepo maps postCreateCommand to commands.install when nothing else provides one', async () => {
  const root = repo({
    '.devcontainer.json': JSON.stringify({ image: 'ubuntu', postCreateCommand: 'make setup' }),
  });
  const profile = await probeRepo(root, { useCache: false, saveCache: false });
  assert.equal(profile.devcontainer, true);
  assert.equal(profile.commands.install, 'make setup');
});
