import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectNode } from './node.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Build a fixture repo; each key is a repo-relative file path. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-node-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  dirs.push(root);
  return root;
}

function pkgJson(pkg: Record<string, unknown>): string {
  return JSON.stringify(pkg);
}

test('no package.json → not detected', () => {
  const root = repo({ 'README.md': 'x' });
  const res = detectNode(root);
  assert.equal(res.detected, false);
  assert.deepEqual(res.ecosystems, []);
  assert.deepEqual(res.toolchains, []);
});

test('npm lockfile → npm package manager + npm ci install', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x', scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', start: 'node index.js', clean: 'rimraf dist' } }),
    'package-lock.json': '{}',
  });
  const res = detectNode(root);

  assert.equal(res.detected, true);
  assert.ok(res.ecosystems.includes('node'));
  assert.ok(res.manifests.includes('package.json'));
  assert.ok(res.manifests.includes('package-lock.json'));

  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'npm');
  assert.equal(pm.lockfile, 'package-lock.json');
  assert.equal(pm.sourceFile, 'package-lock.json');

  assert.equal(res.commands.install, 'npm ci');
  assert.equal(res.commands.build, 'npm run build');
  assert.equal(res.commands.test, 'npm test');
  assert.equal(res.commands.lint, 'npm run lint');
  assert.equal(res.commands.typecheck, 'npm run typecheck');
  assert.equal(res.commands.start, 'npm start');
  assert.equal(res.commands.clean, 'npm run clean');
});

test('no lockfile → npm install (not npm ci)', () => {
  const root = repo({ 'package.json': pkgJson({ name: 'x' }) });
  const res = detectNode(root);
  assert.equal(res.packageManagers[0].name, 'npm');
  assert.equal(res.packageManagers[0].lockfile, undefined);
  assert.equal(res.commands.install, 'npm install');
});

test('pnpm-lock.yaml → pnpm with frozen-lockfile install', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x', scripts: { build: 'tsc', test: 'vitest' } }),
    'pnpm-lock.yaml': '',
  });
  const res = detectNode(root);
  assert.equal(res.packageManagers[0].name, 'pnpm');
  assert.equal(res.packageManagers[0].lockfile, 'pnpm-lock.yaml');
  assert.equal(res.commands.install, 'pnpm install --frozen-lockfile');
  assert.equal(res.commands.test, 'pnpm test');
  assert.equal(res.commands.build, 'pnpm build');
});

test('yarn.lock → yarn', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x', scripts: { test: 'jest' } }),
    'yarn.lock': '',
  });
  const res = detectNode(root);
  assert.equal(res.packageManagers[0].name, 'yarn');
  assert.equal(res.commands.install, 'yarn install --frozen-lockfile');
  assert.equal(res.commands.test, 'yarn test');
});

test('bun.lockb and bun.lock → bun', () => {
  for (const lock of ['bun.lockb', 'bun.lock']) {
    const root = repo({
      'package.json': pkgJson({ name: 'x' }),
      [lock]: '',
    });
    const res = detectNode(root);
    assert.equal(res.packageManagers[0].name, 'bun');
    assert.equal(res.packageManagers[0].lockfile, lock);
    assert.equal(res.commands.install, 'bun install --frozen-lockfile');
  }
});

test('packageManager field sets name+version and wins when no lockfile', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x', packageManager: 'pnpm@9.1.0', scripts: { build: 'tsc' } }),
  });
  const res = detectNode(root);
  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'pnpm');
  assert.equal(pm.version, '9.1.0');
  assert.equal(pm.sourceFile, 'package.json');
  assert.equal(res.commands.install, 'pnpm install', 'no lockfile → non-frozen install');
  assert.equal(res.commands.build, 'pnpm build');
});

test('lockfile overrides packageManager field (pnpm-lock beats npm claim)', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x', packageManager: 'npm@10.0.0' }),
    'pnpm-lock.yaml': '',
  });
  const res = detectNode(root);
  assert.equal(res.packageManagers[0].name, 'pnpm');
  assert.equal(res.packageManagers[0].lockfile, 'pnpm-lock.yaml');
});

test('.nvmrc sets the node toolchain version', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x' }),
    '.nvmrc': '20.11.0\n',
  });
  const res = detectNode(root);
  const tc = res.toolchains.find((t) => t.name === 'node');
  assert.equal(tc?.version, '20.11.0');
  assert.equal(tc?.sourceFile, '.nvmrc');
  assert.ok(res.manifests.includes('.nvmrc'));
});

test('.node-version used when no .nvmrc', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x' }),
    '.node-version': '18.19.0',
  });
  const res = detectNode(root);
  assert.equal(res.toolchains[0].version, '18.19.0');
  assert.equal(res.toolchains[0].sourceFile, '.node-version');
});

test('engines.node fills toolchain version + rawSpec when no version file', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x', engines: { node: '>=20.0.0' } }),
  });
  const res = detectNode(root);
  const tc = res.toolchains[0];
  assert.equal(tc.name, 'node');
  assert.equal(tc.version, '>=20.0.0');
  assert.equal(tc.rawSpec, '>=20.0.0');
  assert.equal(tc.sourceFile, 'package.json#engines.node');
});

test('tsconfig.json + typescript dep → typescript ecosystem + toolchain', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x', devDependencies: { typescript: '^5.4.2' } }),
    'tsconfig.json': '{}',
  });
  const res = detectNode(root);
  assert.ok(res.ecosystems.includes('typescript'));
  assert.ok(res.manifests.includes('tsconfig.json'));
  const ts = res.toolchains.find((t) => t.name === 'typescript');
  assert.equal(ts?.version, '5.4.2');
  assert.equal(ts?.rawSpec, '^5.4.2');
  assert.equal(ts?.sourceFile, 'tsconfig.json');
  // tsconfig without scripts gives npx fallbacks
  assert.equal(res.commands.build, 'npx tsc');
  assert.equal(res.commands.typecheck, 'npx tsc --noEmit');
});

test('typescript dep without tsconfig still detects ecosystem', () => {
  const root = repo({
    'package.json': pkgJson({ name: 'x', dependencies: { typescript: '5.0.0' } }),
  });
  const res = detectNode(root);
  assert.ok(res.ecosystems.includes('typescript'));
  const ts = res.toolchains.find((t) => t.name === 'typescript');
  assert.equal(ts?.sourceFile, 'package.json');
});

test('test framework fallbacks: vitest/jest/mocha deps without a test script', () => {
  for (const [dep, expected] of [
    ['vitest', 'npx vitest run'],
    ['jest', 'npx jest'],
    ['mocha', 'npx mocha'],
  ] as const) {
    const root = repo({
      'package.json': pkgJson({
        name: 'x',
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
        devDependencies: { [dep]: '^1.0.0' },
      }),
    });
    const res = detectNode(root);
    assert.equal(res.commands.test, expected, dep);
  }
});

test('lint fallback order: lint:fix → check → eslint dep → biome dep', () => {
  const lintFix = repo({ 'package.json': pkgJson({ name: 'x', scripts: { 'lint:fix': 'eslint --fix' } }) });
  assert.equal(detectNode(lintFix).commands.lint, 'npm run lint:fix');

  const check = repo({ 'package.json': pkgJson({ name: 'x', scripts: { check: 'eslint .' } }) });
  assert.equal(detectNode(check).commands.lint, 'npm run check');

  const eslint = repo({ 'package.json': pkgJson({ name: 'x', devDependencies: { eslint: '^9.0.0' } }) });
  assert.equal(detectNode(eslint).commands.lint, 'npx eslint .');

  const biome = repo({ 'package.json': pkgJson({ name: 'x', devDependencies: { '@biomejs/biome': '^1.0.0' } }) });
  assert.equal(detectNode(biome).commands.lint, 'npx @biomejs/biome check .');
});

test('type-check script alias maps to typecheck command', () => {
  const root = repo({ 'package.json': pkgJson({ name: 'x', scripts: { 'type-check': 'tsc' } }) });
  assert.equal(detectNode(root).commands.typecheck, 'npm run type-check');
});

test('frameworks: web vs build categorization + test/lint detection', () => {
  const root = repo({
    'package.json': pkgJson({
      name: 'x',
      dependencies: { react: '^18.0.0', express: '^4.0.0', vite: '^5.0.0' },
      devDependencies: { vitest: '^4.0.0', prettier: '^3.0.0' },
      peerDependencies: { vue: '^3.0.0' },
    }),
  });
  const res = detectNode(root);
  const byName = (n: string) => res.frameworks.find((f) => f.name === n);

  assert.equal(byName('react')?.category, 'web');
  assert.equal(byName('vue')?.category, 'web', 'peerDependencies participate');
  assert.equal(byName('express')?.category, 'web');
  assert.equal(byName('vite')?.category, 'build');
  assert.equal(byName('vitest')?.category, 'test');
  assert.equal(byName('vitest')?.version, '4.0.0');
  assert.equal(byName('prettier')?.category, 'lint');
});

test('custom (non-canonical) scripts land in commands.custom', () => {
  const root = repo({
    'package.json': pkgJson({
      name: 'x',
      scripts: { test: 'vitest', dev: 'vite dev', seed: 'node seed.js' },
    }),
  });
  const res = detectNode(root);
  assert.deepEqual(res.commands.custom, { dev: 'vite dev', seed: 'node seed.js' });
});

test('malformed package.json degrades to defaults without throwing', () => {
  const root = repo({ 'package.json': '{ "name": "x", broken' });
  const res = detectNode(root);
  assert.equal(res.detected, true);
  assert.equal(res.packageManagers[0].name, 'npm');
  assert.equal(res.commands.install, 'npm install');
  const tc = res.toolchains[0];
  assert.equal(tc.name, 'node');
  assert.equal(tc.version, undefined);
});
