import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
