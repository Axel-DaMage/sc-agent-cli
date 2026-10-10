import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRust } from './rust.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-rust-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  dirs.push(root);
  return root;
}

test('no Cargo.toml → not detected', () => {
  assert.equal(detectRust(repo({ 'README.md': 'x' })).detected, false);
});

test('Cargo.toml → cargo toolchain + standard cargo commands', () => {
  const root = repo({
    'Cargo.toml': [
      '[package]',
      'name = "demo"',
      'version = "0.1.0"',
      'edition = "2021"',
      'rust-version = "1.70"',
      '',
    ].join('\n'),
    'Cargo.lock': '',
  });
  const res = detectRust(root);

  assert.equal(res.detected, true);
  assert.ok(res.ecosystems.includes('rust'));
  assert.ok(res.manifests.includes('Cargo.toml'));
  assert.ok(res.manifests.includes('Cargo.lock'));

  const tc = res.toolchains[0];
  assert.equal(tc.name, 'rust');
  assert.equal(tc.version, '1.70');
  assert.equal(tc.rawSpec, 'edition 2021');
  assert.equal(tc.sourceFile, 'Cargo.toml');

  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'cargo');
  assert.equal(pm.lockfile, 'Cargo.lock');

  assert.equal(res.commands.install, 'cargo fetch');
  assert.equal(res.commands.build, 'cargo build');
  assert.equal(res.commands.test, 'cargo test');
  assert.equal(res.commands.lint, 'cargo clippy');
  assert.equal(res.commands.typecheck, 'cargo check');
});

test('workspace manifest → --workspace command variants', () => {
  const root = repo({
    'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n',
  });
  const res = detectRust(root);
  assert.equal(res.commands.build, 'cargo build --workspace');
  assert.equal(res.commands.test, 'cargo test --workspace');
  assert.equal(res.commands.lint, 'cargo clippy --workspace');
  assert.equal(res.commands.typecheck, 'cargo check --workspace');
});

test('rust-toolchain.toml channel wins over Cargo.toml rust-version', () => {
  const root = repo({
    'Cargo.toml': '[package]\nname = "x"\nrust-version = "1.70"\n',
    'rust-toolchain.toml': '[toolchain]\nchannel = "nightly-2024-01-01"\n',
  });
  const res = detectRust(root);
  assert.equal(res.toolchains[0].version, 'nightly-2024-01-01');
  assert.equal(res.toolchains[0].sourceFile, 'rust-toolchain.toml');
  assert.ok(res.manifests.includes('rust-toolchain.toml'));
});

test('plain rust-toolchain file is honored', () => {
  const root = repo({
    'Cargo.toml': '[package]\nname = "x"\n',
    'rust-toolchain': 'stable\n',
  });
  const res = detectRust(root);
  assert.equal(res.toolchains[0].version, 'stable');
  assert.equal(res.toolchains[0].sourceFile, 'rust-toolchain');
});

test('dependency frameworks: tokio/axum/criterion/nextest', () => {
  const root = repo({
    'Cargo.toml': [
      '[package]',
      'name = "x"',
      '',
      '[dependencies]',
      'tokio = "1"',
      'axum = "0.7"',
      '',
      '[dev-dependencies]',
      'criterion = "0.5"',
      'cargo-nextest = "0.9"',
      '',
    ].join('\n'),
  });
  const res = detectRust(root);
  const names = res.frameworks.map((f) => f.name);
  assert.ok(names.includes('cargo-test'));
  assert.ok(names.includes('tokio'));
  assert.ok(names.includes('axum'));
  assert.ok(names.includes('criterion'));
  assert.ok(names.includes('cargo-nextest'));
});

test('workspace.dependencies participate in framework detection', () => {
  const root = repo({
    'Cargo.toml': '[workspace]\nmembers = ["a"]\n\n[workspace.dependencies]\nactix-web = "4"\n',
  });
  const res = detectRust(root);
  assert.ok(res.frameworks.some((f) => f.name === 'actix-web' && f.category === 'web'));
});

test('malformed Cargo.toml degrades without throwing', () => {
  const root = repo({ 'Cargo.toml': '[[[' });
  const res = detectRust(root);
  assert.equal(res.detected, true);
  assert.equal(res.packageManagers[0].name, 'cargo');
  assert.equal(res.commands.install, 'cargo fetch');
  assert.equal(res.toolchains[0].version, undefined);
});
