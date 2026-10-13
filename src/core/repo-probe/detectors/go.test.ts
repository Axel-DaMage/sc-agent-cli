import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGo } from './go.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-go-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  dirs.push(root);
  return root;
}

test('no go.mod → not detected', () => {
  const res = detectGo(repo({ 'README.md': 'x' }));
  assert.equal(res.detected, false);
});

test('go.mod → go toolchain, gomod commands', () => {
  const root = repo({
    'go.mod': 'module example.com/demo\n\ngo 1.22\n\nrequire github.com/stretchr/testify v1.9.0\n',
    'go.sum': 'hash\n',
  });
  const res = detectGo(root);

  assert.equal(res.detected, true);
  assert.ok(res.ecosystems.includes('go'));
  assert.ok(res.manifests.includes('go.mod'));
  assert.ok(res.manifests.includes('go.sum'));

  const tc = res.toolchains[0];
  assert.equal(tc.name, 'go');
  assert.equal(tc.version, '1.22');
  assert.equal(tc.rawSpec, 'go 1.22');
  assert.equal(tc.sourceFile, 'go.mod');

  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'go');
  assert.equal(pm.lockfile, 'go.sum');
  assert.equal(pm.sourceFile, 'go.mod');

  assert.equal(res.commands.install, 'go mod download');
  assert.equal(res.commands.test, 'go test ./...');
  assert.equal(res.commands.build, 'go build ./...');
  assert.equal(res.commands.lint, 'go vet ./...');
  assert.equal(res.commands.typecheck, 'go vet ./...');

  assert.ok(res.frameworks.some((f) => f.name === 'go-test'));
  assert.ok(res.frameworks.some((f) => f.name === 'testify'));
});

test('toolchain directive overrides the go directive', () => {
  const root = repo({
    'go.mod': 'module example.com/demo\n\ngo 1.21\n\ntoolchain go1.23.1\n',
  });
  const res = detectGo(root);
  assert.equal(res.toolchains[0].version, '1.23.1');
});

test('go.work recorded as manifest; ginkgo/echo/gin frameworks detected', () => {
  const root = repo({
    'go.mod': 'module example.com/demo\n\ngo 1.22\n\nrequire (\n\tgithub.com/onsi/ginkgo v2.0.0\n\tgithub.com/labstack/echo v4.0.0\n)\n',
    'go.work': 'go 1.22\n',
  });
  const res = detectGo(root);
  assert.ok(res.manifests.includes('go.work'));
  assert.ok(res.frameworks.some((f) => f.name === 'ginkgo'));
  assert.ok(res.frameworks.some((f) => f.name === 'echo' && f.category === 'web'));
});

test('gin dependency detected as web framework', () => {
  const root = repo({
    'go.mod': 'module m\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.0\n',
  });
  const res = detectGo(root);
  assert.ok(res.frameworks.some((f) => f.name === 'gin' && f.category === 'web'));
});

test('.golangci.yml switches lint to golangci-lint', () => {
  const root = repo({
    'go.mod': 'module m\n\ngo 1.22\n',
    '.golangci.yml': 'linters:\n  enable: []\n',
  });
  const res = detectGo(root);
  assert.equal(res.commands.lint, 'golangci-lint run');
});

test('empty go.mod still detects with no version', () => {
  const root = repo({ 'go.mod': 'module m\n' });
  const res = detectGo(root);
  assert.equal(res.detected, true);
  assert.equal(res.toolchains[0].version, undefined);
  assert.equal(res.toolchains[0].rawSpec, undefined);
});
