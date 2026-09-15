import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectFormatters, runFormatter } from './formatters.js';

test('detectFormatters returns empty array when no config files exist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fmt-test-'));
  const result = await detectFormatters(dir);
  assert.deepEqual(result, []);
});

test('detectFormatters finds prettier config', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fmt-test-'));
  await writeFile(path.join(dir, '.prettierrc'), '{}', 'utf-8');
  const result = await detectFormatters(dir);
  assert.ok(result.includes('npx prettier --write'));
});

test('detectFormatters does not duplicate commands', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fmt-test-'));
  await writeFile(path.join(dir, '.prettierrc'), '{}', 'utf-8');
  await writeFile(path.join(dir, '.prettierrc.json'), '{}', 'utf-8');
  const result = await detectFormatters(dir);
  const prettierCount = result.filter((c) => c.includes('prettier')).length;
  assert.equal(prettierCount, 1);
});

test('detectFormatters finds pom.xml for spotless', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fmt-test-'));
  await writeFile(path.join(dir, 'pom.xml'), '<project></project>', 'utf-8');
  const result = await detectFormatters(dir);
  assert.ok(result.includes('mvn spotless:apply'));
});

test('runFormatter returns non-modified result when formatter makes no changes', () => {
  const result = runFormatter('echo no-changes', process.cwd());
  assert.equal(result.ran, true);
  assert.equal(result.modified, false);
});
