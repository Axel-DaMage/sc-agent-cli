import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineCiWorkflows } from './ci-mining.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-ci-'));
  for (const [name, content] of Object.entries(files)) {
    const p = join(root, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  dirs.push(root);
  return root;
}

test('no CI files → not detected, empty report', () => {
  const res = mineCiWorkflows(repo({ 'README.md': 'x' }));
  assert.equal(res.detected, false);
  assert.deepEqual(res.ci.providers, []);
  assert.deepEqual(res.ci.workflows, []);
  assert.deepEqual(res.ci.minedVerifyCommands, []);
});

test('github workflow: providers, jobs, mined verify commands, toolchains', () => {
  const root = repo({
    '.github/workflows/ci.yml': [
      'name: CI',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: '20'",
      '      - run: npm ci',
      '      - run: npm run build && npm test',
      '      - run: git status',
      '      - run: echo hello',
      '',
    ].join('\n'),
  });
  const res = mineCiWorkflows(root);

  assert.equal(res.detected, true);
  assert.deepEqual(res.ci.providers, ['github-actions']);
  assert.ok(res.manifests.includes('.github/workflows/ci.yml'));

  const wf = res.ci.workflows[0];
  assert.equal(wf.file, '.github/workflows/ci.yml');
  assert.equal(wf.provider, 'github-actions');
  assert.equal(wf.name, 'CI');
  assert.deepEqual(wf.jobs, ['build']);
  assert.ok(wf.steps.some((s) => s.uses === 'actions/setup-node@v4'));

  assert.ok(res.ci.minedVerifyCommands.includes('npm ci'));
  assert.ok(res.ci.minedVerifyCommands.includes('npm run build'));
  assert.ok(res.ci.minedVerifyCommands.includes('npm test'));
  assert.ok(!res.ci.minedVerifyCommands.includes('git status'), 'setup commands excluded');
  assert.ok(!res.ci.minedVerifyCommands.includes('echo hello'), 'echo filtered');

  assert.ok(
    res.discoveredToolchains.some((t) => t.name === 'node' && t.version === '20' && t.sourceFile === '.github/workflows/ci.yml')
  );
});

test('multi-line run block joins steps with &&', () => {
  const root = repo({
    '.github/workflows/test.yaml': [
      'jobs:',
      '  test:',
      '    steps:',
      '      - name: suite',
      '        run: |',
      '          npm test',
      '          npm run lint',
      '',
    ].join('\n'),
  });
  const res = mineCiWorkflows(root);
  assert.ok(res.ci.minedVerifyCommands.includes('npm test'));
  assert.ok(res.ci.minedVerifyCommands.includes('npm run lint'));
});

test('setup-* actions mine python/go/java/rust toolchains', () => {
  const root = repo({
    '.github/workflows/matrix.yml': [
      'jobs:',
      '  m:',
      '    steps:',
      '      - uses: actions/setup-python@v5',
      '        with:',
      "          python-version: '3.12'",
      '      - uses: actions/setup-go@v5',
      '        with:',
      "          go-version: '1.22'",
      '      - uses: actions/setup-java@v4',
      '        with:',
      "          java-version: '21'",
      '      - uses: dtolnay/rust-toolchain@stable',
      '        with:',
      "          toolchain: 'nightly'",
      '',
    ].join('\n'),
  });
  const res = mineCiWorkflows(root);
  const names = res.discoveredToolchains.map((t) => `${t.name}@${t.version}`);
  assert.ok(names.includes('python@3.12'));
  assert.ok(names.includes('go@1.22'));
  assert.ok(names.includes('java@21'));
  assert.ok(names.includes('rust@nightly'));
});

test('step-name hint mines script invocations', () => {
  const root = repo({
    '.github/workflows/ci.yml': [
      'jobs:',
      '  t:',
      '    steps:',
      '      - name: Run tests',
      '        run: ./scripts/verify.sh',
      '',
    ].join('\n'),
  });
  const res = mineCiWorkflows(root);
  assert.ok(res.ci.minedVerifyCommands.includes('./scripts/verify.sh'));
});

test('commands excluded by the setup-command denylist are not mined', () => {
  const root = repo({
    '.github/workflows/ci.yml': [
      'jobs:',
      '  b:',
      '    steps:',
      '      - run: export FOO=1',
      '      - run: set -e',
      '      - run: mkdir out',
      '      - run: cd subdir',
      '      - run: curl https://x.sh',
      '      - run: wget https://x.sh',
      '      - run: "true"',
      '      - run: cargo build',
      '',
    ].join('\n'),
  });
  const res = mineCiWorkflows(root);
  assert.deepEqual(res.ci.minedVerifyCommands, ['cargo build']);
});

test('.gitlab-ci.yml → gitlab-ci provider with mined script lines', () => {
  const root = repo({
    '.gitlab-ci.yml': [
      'stages:',
      '  - test',
      '',
      'test-job:',
      '  script:',
      '    - npm ci',
      '    - npm test',
      '',
    ].join('\n'),
  });
  const res = mineCiWorkflows(root);
  assert.equal(res.detected, true);
  assert.ok(res.ci.providers.includes('gitlab-ci'));
  assert.ok(res.manifests.includes('.gitlab-ci.yml'));
  const wf = res.ci.workflows.find((w) => w.provider === 'gitlab-ci')!;
  assert.equal(wf.file, '.gitlab-ci.yml');
  assert.ok(wf.verifyCommands.includes('npm test'));
});

test('.circleci/config.yml → circleci provider', () => {
  const root = repo({
    '.circleci/config.yml': [
      'name: circle',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: go test ./...',
      '',
    ].join('\n'),
  });
  const res = mineCiWorkflows(root);
  assert.ok(res.ci.providers.includes('circleci'));
  const wf = res.ci.workflows.find((w) => w.provider === 'circleci')!;
  assert.equal(wf.file, '.circleci/config.yml');
  assert.ok(wf.verifyCommands.includes('go test ./...'));
});

test('azure-pipelines.yml → azure-pipelines provider', () => {
  const root = repo({
    'azure-pipelines.yml': [
      'jobs:',
      '  b:',
      '    steps:',
      '      - run: dotnet test',
      '',
    ].join('\n'),
  });
  const res = mineCiWorkflows(root);
  assert.ok(res.ci.providers.includes('azure-pipelines'));
  assert.ok(res.manifests.includes('azure-pipelines.yml'));
  assert.ok(res.ci.minedVerifyCommands.includes('dotnet test'));
});

test('empty .github/workflows dir does not register the provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-ci-empty-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  dirs.push(root);
  const res = mineCiWorkflows(root);
  assert.equal(res.detected, false);
  assert.deepEqual(res.ci.providers, []);
});

test('multiple providers accumulate and verify commands dedupe', () => {
  const root = repo({
    '.github/workflows/ci.yml': [
      'jobs:',
      '  b:',
      '    steps:',
      '      - run: npm test',
      '      - run: npm test',
      '',
    ].join('\n'),
    '.gitlab-ci.yml': 'j:\n  script:\n    - npm test\n',
  });
  const res = mineCiWorkflows(root);
  assert.ok(res.ci.providers.includes('github-actions'));
  assert.ok(res.ci.providers.includes('gitlab-ci'));
  assert.deepEqual(res.ci.minedVerifyCommands, ['npm test']);
});
