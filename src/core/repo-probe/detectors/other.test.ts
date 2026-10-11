import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectOtherEcosystems } from './other.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-other-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  dirs.push(root);
  return root;
}

test('no recognized manifests → not detected', () => {
  const res = detectOtherEcosystems(repo({ 'README.md': 'x' }));
  assert.equal(res.detected, false);
  assert.deepEqual(res.ecosystems, []);
});

test('Gemfile → ruby + bundler + rake test fallback', () => {
  const root = repo({ 'Gemfile': "source 'https://rubygems.org'\n" });
  const res = detectOtherEcosystems(root);
  assert.ok(res.ecosystems.includes('ruby'));
  assert.equal(res.packageManagers[0].name, 'bundler');
  assert.equal(res.commands.install, 'bundle install');
  assert.equal(res.commands.test, 'bundle exec rake test');
  assert.equal(res.toolchains[0].name, 'ruby');
});

test('Gemfile with rspec/rubocop + .ruby-version + lockfile', () => {
  const root = repo({
    'Gemfile': "source 'https://rubygems.org'\ngem 'rspec'\ngem 'rubocop'\n",
    'Gemfile.lock': 'lock',
    '.ruby-version': '3.3.0\n',
  });
  const res = detectOtherEcosystems(root);
  assert.equal(res.toolchains[0].version, '3.3.0');
  assert.equal(res.toolchains[0].sourceFile, '.ruby-version');
  assert.equal(res.packageManagers[0].lockfile, 'Gemfile.lock');
  assert.equal(res.commands.test, 'bundle exec rspec');
  assert.equal(res.commands.lint, 'bundle exec rubocop');
  assert.ok(res.frameworks.some((f) => f.name === 'rspec'));
  assert.ok(res.frameworks.some((f) => f.name === 'rubocop'));
});

test('composer.json → php + composer + phpunit default test', () => {
  const root = repo({
    'composer.json': JSON.stringify({ require: { php: '^8.2' } }),
    'composer.lock': '{}',
  });
  const res = detectOtherEcosystems(root);
  assert.ok(res.ecosystems.includes('php'));
  assert.equal(res.toolchains[0].name, 'php');
  assert.equal(res.toolchains[0].version, '8.2');
  assert.equal(res.toolchains[0].rawSpec, '^8.2');
  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'composer');
  assert.equal(pm.lockfile, 'composer.lock');
  assert.equal(res.commands.install, 'composer install');
  assert.equal(res.commands.test, 'vendor/bin/phpunit');
});

test('composer.json without lock → composer update; scripts.test honored', () => {
  const root = repo({
    'composer.json': JSON.stringify({ require: {}, scripts: { test: 'phpunit', lint: 'phpcs' } }),
  });
  const res = detectOtherEcosystems(root);
  assert.equal(res.commands.install, 'composer update');
  assert.equal(res.commands.test, 'composer test');
  assert.equal(res.commands.lint, 'composer lint');
});

test('deno.json and deno.jsonc → deno', () => {
  for (const name of ['deno.json', 'deno.jsonc']) {
    const root = repo({ [name]: '{}' });
    const res = detectOtherEcosystems(root);
    assert.ok(res.ecosystems.includes('deno'), name);
    assert.ok(res.manifests.includes(name));
    assert.equal(res.toolchains[0].name, 'deno');
    assert.equal(res.packageManagers[0].name, 'deno');
    assert.equal(res.commands.test, 'deno test');
    assert.equal(res.commands.lint, 'deno lint');
    assert.equal(res.commands.typecheck, 'deno check');
  }
});

test('mix.exs → elixir + mix', () => {
  const root = repo({ 'mix.exs': 'defmodule App.MixProject do\nend\n', 'mix.lock': '' });
  const res = detectOtherEcosystems(root);
  assert.ok(res.ecosystems.includes('elixir'));
  assert.equal(res.packageManagers[0].name, 'mix');
  assert.equal(res.packageManagers[0].lockfile, 'mix.lock');
  assert.equal(res.commands.install, 'mix deps.get');
  assert.equal(res.commands.build, 'mix compile');
  assert.equal(res.commands.test, 'mix test');
});

test('.csproj → dotnet + nuget + dotnet commands', () => {
  const root = repo({ 'App.csproj': '<Project></Project>' });
  const res = detectOtherEcosystems(root);
  assert.ok(res.ecosystems.includes('dotnet'));
  assert.ok(res.manifests.includes('App.csproj'));
  assert.equal(res.toolchains[0].name, 'dotnet');
  assert.equal(res.toolchains[0].sourceFile, 'App.csproj');
  assert.equal(res.packageManagers[0].name, 'nuget');
  assert.equal(res.commands.install, 'dotnet restore');
  assert.equal(res.commands.build, 'dotnet build');
  assert.equal(res.commands.test, 'dotnet test');
});

test('.sln → dotnet detection', () => {
  const root = repo({ 'App.sln': '' });
  const res = detectOtherEcosystems(root);
  assert.ok(res.ecosystems.includes('dotnet'));
  assert.ok(res.manifests.includes('App.sln'));
});

test('CMakeLists.txt → cmake + c/cpp', () => {
  const root = repo({ 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\n' });
  const res = detectOtherEcosystems(root);
  assert.ok(res.ecosystems.includes('cmake'));
  assert.ok(res.ecosystems.includes('c/cpp'));
  assert.equal(res.toolchains[0].name, 'cmake');
  assert.equal(res.commands.build, 'cmake -B build && cmake --build build');
  assert.equal(res.commands.test, 'ctest --test-dir build');
});

test('multiple ecosystems accumulate', () => {
  const root = repo({
    'Gemfile': "source 'x'\n",
    'deno.json': '{}',
    'App.csproj': '<Project/>',
  });
  const res = detectOtherEcosystems(root);
  assert.ok(res.ecosystems.includes('ruby'));
  assert.ok(res.ecosystems.includes('deno'));
  assert.ok(res.ecosystems.includes('dotnet'));
});
