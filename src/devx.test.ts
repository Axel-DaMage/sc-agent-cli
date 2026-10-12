// DevX dotfiles drift guard (#502): `.nvmrc`, `.editorconfig`, and
// `.devcontainer/devcontainer.json` are part of the contributor contract.
// These tests fail on drift — e.g. the devcontainer image's Node major
// diverging from the `.nvmrc` pin, or the container setup no longer leaving
// `scc` on PATH for `sc chat --devcontainer` (#421).

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDevcontainer } from './core/repo-probe/detectors/devcontainer.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRootFile(name: string): string {
  return readFileSync(path.join(REPO_ROOT, name), 'utf-8');
}

function nvmrcMajor(): number {
  const pin = readRootFile('.nvmrc').trim();
  const major = Number(/^v?(\d+)/.exec(pin)?.[1]);
  assert.ok(Number.isInteger(major), `.nvmrc pin "${pin}" is not a Node major version`);
  return major;
}

test('.nvmrc pins a Node major satisfying the package.json engines contract', () => {
  const pkg = JSON.parse(readRootFile('package.json'));
  const floor = Number(/>=\s*(\d+)/.exec(pkg.engines?.node ?? '')?.[1]);
  assert.ok(Number.isInteger(floor), 'package.json engines.node does not declare a >= floor');
  assert.ok(nvmrcMajor() >= floor, '.nvmrc pin must satisfy engines.node');
});

test('.editorconfig declares the repo formatting contract', () => {
  const cfg = readRootFile('.editorconfig');
  assert.match(cfg, /^root\s*=\s*true$/m);
  assert.match(cfg, /^charset\s*=\s*utf-8$/m);
  assert.match(cfg, /^end_of_line\s*=\s*lf$/m);
  assert.match(cfg, /^indent_style\s*=\s*space$/m);
  assert.match(cfg, /^indent_size\s*=\s*2$/m);
});

test('repo devcontainer is detected and keeps the --devcontainer exec path working', () => {
  const detection = detectDevcontainer(REPO_ROOT);
  assert.equal(detection.detected, true, 'no devcontainer config detected at repo root');
  assert.equal(detection.configFile, '.devcontainer/devcontainer.json');

  const info = detection.devcontainer;
  assert.ok(info, 'devcontainer config must parse via the repo probe detector');
  assert.ok(info.image, 'devcontainer config must declare an image');
  const imageMajor = Number(/node:(?:\d+-)?(\d+)/.exec(info.image)?.[1]);
  assert.equal(imageMajor, nvmrcMajor(), 'devcontainer image Node major must match .nvmrc');

  // `sc chat --devcontainer` execs `scc` inside the container — the create
  // command must install deps, build dist/, and link the bins onto PATH.
  const postCreate = info.postCreateCommand ?? '';
  assert.match(postCreate, /npm ci/);
  assert.match(postCreate, /npm run build/);
  assert.match(postCreate, /npm link/);
});
