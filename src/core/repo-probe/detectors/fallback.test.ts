import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectUnknownEcosystem } from './fallback.js';
import { probeRepo } from '../probe.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>, subdirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-fb-'));
  for (const d of subdirs) mkdirSync(join(root, d), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  dirs.push(root);
  return root;
}

test('empty workspace → unknown ecosystem, low confidence, empty note', async () => {
  const root = repo({});
  const res = detectUnknownEcosystem(root);
  assert.deepEqual(res.ecosystems, ['unknown']);
  assert.equal(res.confidence, 'low');
  assert.ok(res.notes.some((n) => n.includes('empty')));
});

test('unreadable workspace root → low confidence with error note', () => {
  const parent = mkdtempSync(join(tmpdir(), 'sc-probe-fb-file-'));
  dirs.push(parent);
  const filePath = join(parent, 'f.txt');
  writeFileSync(filePath, 'x');
  const res = detectUnknownEcosystem(filePath); // readdirSync on a file throws
  assert.deepEqual(res.ecosystems, ['unknown']);
  assert.equal(res.confidence, 'low');
  assert.ok(res.notes.some((n) => n.startsWith('Could not read workspace root')));
});

test('script files map to install/build/test commands', () => {
  const root = repo({
    'setup.sh': '#!/bin/sh\n',
    'test.sh': '#!/bin/sh\nexit 0\n',
    'build.ps1': 'echo hi\n',
  });
  const res = detectUnknownEcosystem(root);
  assert.ok(res.findings.scriptFiles.includes('setup.sh'));
  assert.ok(res.findings.scriptFiles.includes('test.sh'));
  assert.ok(res.findings.scriptFiles.includes('build.ps1'));
  assert.equal(res.commands.install, './setup.sh');
  assert.equal(res.commands.test, './test.sh');
  // Non-.sh scripts are recorded but invoked by bare name.
  assert.equal(res.commands.build, 'build.ps1');
  assert.ok(res.notes.some((n) => n.includes('setup.sh')));
});

test('container/config files land in findings.configFiles', () => {
  const root = repo({
    'Dockerfile': 'FROM scratch\n',
    'docker-compose.yml': 'services: {}\n',
    'Vagrantfile': '',
    'justfile': '',
  });
  const res = detectUnknownEcosystem(root);
  assert.ok(res.findings.configFiles.includes('Dockerfile'));
  assert.ok(res.findings.configFiles.includes('docker-compose.yml'));
  assert.ok(res.findings.configFiles.includes('Vagrantfile'));
  assert.ok(res.findings.configFiles.includes('justfile'));
  assert.ok(res.notes.some((n) => n.includes('configuration/container')));
});

test('README build/test/install sections yield command snippets', () => {
  const root = repo({
    'README.md': [
      '# Project',
      '',
      '## Build',
      '',
      '```sh',
      'make all',
      '```',
      '',
      '## Test',
      '',
      '```',
      './run-suite.sh',
      '```',
      '',
      '## License',
      '',
      'MIT',
      '',
    ].join('\n'),
  });
  const res = detectUnknownEcosystem(root);
  assert.ok(res.findings.readmeSnippets, 'expected README snippets');
  assert.ok(res.findings.readmeSnippets!.some((s) => s.includes('make all')));
  assert.ok(res.findings.readmeSnippets!.some((s) => s.includes('./run-suite.sh')));
});

test('code blocks outside build/install/test headings are not mined', () => {
  const root = repo({
    // 'Architecture' is not in the relevant-heading allowlist.
    'README.md': ['# P', '', '## Architecture', '', '```', 'echo hi', '```', ''].join('\n'),
  });
  const res = detectUnknownEcosystem(root);
  assert.deepEqual(res.findings.readmeSnippets, []);
});

test('.git/node_modules noise is filtered from detectedFiles', () => {
  const root = repo({ 'real.txt': 'x' }, ['.git', 'node_modules', '.cache']);
  const res = detectUnknownEcosystem(root);
  assert.ok(res.findings.detectedFiles.includes('real.txt'));
  assert.ok(!res.findings.detectedFiles.includes('.git'));
  assert.ok(!res.findings.detectedFiles.includes('node_modules'));
});

test('root item count is reported in notes', () => {
  const root = repo({ 'a.txt': '', 'b.txt': '' });
  const res = detectUnknownEcosystem(root);
  assert.ok(res.notes.some((n) => n.includes('2 root items')));
});

test('probeRepo on an unrecognized tree surfaces unknown + low confidence', async () => {
  const root = repo({ 'weird.xyz': 'x' });
  const profile = await probeRepo(root, { useCache: false, saveCache: false });
  assert.ok(profile.ecosystems.includes('unknown'));
  assert.equal(profile.confidence, 'low');
  assert.ok(profile.rawFindings);
});
