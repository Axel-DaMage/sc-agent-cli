import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const cliEntrypoint = path.join(projectRoot, 'bin', 'sc.js');

// These tests spawn the built CLI (`bin/sc.js` imports `dist/cli.js`). `dist/`
// is gitignored and no npm lifecycle hook builds it, so a fresh checkout — or
// `npx vitest run` without a prior `npm run build` — fails every test below
// with ERR_MODULE_NOT_FOUND on ANY Node version (#509). Compile once, on
// demand, when the build output is missing.
beforeAll(() => {
  if (existsSync(path.join(projectRoot, 'dist', 'cli.js'))) return;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npmCmd, ['run', 'build'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(
    build.status,
    0,
    `dist/cli.js is missing and \`npm run build\` failed (status=${build.status} error=${build.error}):\n${build.stdout}\n${build.stderr}`
  );
}, 300_000);

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliEntrypoint, ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
}

function assertCliError(result: ReturnType<typeof runCli>, ...patterns: RegExp[]) {
  assert.equal(
    result.status,
    1,
    `expected exit 1 — got status=${result.status} signal=${result.signal} error=${result.error}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`
  );
  for (const pattern of patterns) {
    assert.match(result.stderr, pattern);
  }
}

test('CLI shows contextual help after invalid root option errors', () => {
  assertCliError(
    runCli(['--bogus']),
    /error: unknown option '--bogus'/,
    /Usage: sc chat \[options\] \[prompt\]/,
    /Start an interactive chat session/
  );
});

test('CLI shows profile help after invalid profile subcommands', () => {
  assertCliError(
    runCli(['profile', 'lts']),
    /error: unknown command 'lts'/,
    /Usage: sc profile \[options\] \[command\]/,
    /Manage model profiles/
  );
});

test('CLI --prompt-file rejects a missing file', () => {
  assertCliError(
    runCli(['--prompt-file', '/nonexistent/definitely-missing.md']),
    /cannot read prompt file/
  );
});

test('CLI --prompt-file rejects combining with a prompt argument', () => {
  const promptFile = path.join(projectRoot, 'package.json');
  assertCliError(
    runCli(['inline prompt', '--prompt-file', promptFile]),
    /cannot combine a \[prompt\] argument with --prompt-file/
  );
});

test('CLI --prompt-file rejects an empty file', () => {
  const emptyFile = path.join(os.tmpdir(), `sc-prompt-test-${process.pid}.md`);
  writeFileSync(emptyFile, '  \n');
  try {
    assertCliError(runCli(['--prompt-file', emptyFile]), /prompt file .* is empty/);
  } finally {
    unlinkSync(emptyFile);
  }
});

test('CLI --output-format rejects unknown formats', () => {
  assertCliError(
    runCli(['--output-format', 'yaml', 'hi']),
    /--output-format must be "text" or "json"/
  );
});

test('CLI --role rejects unknown role names (#424)', () => {
  assertCliError(
    runCli(['--role', 'wizard', 'hi']),
    /--role\/SC_ROLE must be one of: planner, executor, reviewer/
  );
});

test('CLI --output-format json requires a prompt', () => {
  assertCliError(
    runCli(['--output-format', 'json']),
    /--output-format json requires a prompt/
  );
});
