import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const cliEntrypoint = path.join(projectRoot, 'bin', 'sc.js');

test('CLI shows contextual help after invalid root option errors', () => {
  const result = spawnSync(process.execPath, [cliEntrypoint, '--bogus'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /error: unknown option '--bogus'/);
  assert.match(result.stderr, /Usage: sc chat \[options\] \[prompt\]/);
  assert.match(result.stderr, /Start an interactive chat session/);
});

test('CLI shows profile help after invalid profile subcommands', () => {
  const result = spawnSync(process.execPath, [cliEntrypoint, 'profile', 'lts'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /error: unknown command 'lts'/);
  assert.match(result.stderr, /Usage: sc profile \[options\] \[command\]/);
  assert.match(result.stderr, /Manage model profiles/);
});

test('CLI --prompt-file rejects a missing file', () => {
  const result = spawnSync(process.execPath, [cliEntrypoint, '--prompt-file', '/nonexistent/definitely-missing.md'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read prompt file/);
});

test('CLI --prompt-file rejects combining with a prompt argument', () => {
  const promptFile = path.join(projectRoot, 'package.json');
  const result = spawnSync(process.execPath, [cliEntrypoint, 'inline prompt', '--prompt-file', promptFile], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot combine a \[prompt\] argument with --prompt-file/);
});

test('CLI --prompt-file rejects an empty file', () => {
  const emptyFile = path.join(os.tmpdir(), `sc-prompt-test-${process.pid}.md`);
  writeFileSync(emptyFile, '  \n');
  const result = spawnSync(process.execPath, [cliEntrypoint, '--prompt-file', emptyFile], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  unlinkSync(emptyFile);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /prompt file .* is empty/);
});
