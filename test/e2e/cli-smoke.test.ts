// E2E smoke — offline CLI paths (#483).
//
// Spawns the built bin (`node bin/sc.js`) for commands that need no live
// model: --version, --help, and `sc doctor` (reachable + unreachable
// provider through the local mock). Requires `npm run build` first.

import { afterEach, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DIST_ENTRY,
  REPO_ROOT,
  chatEnv,
  describeRun,
  makeWorkspace,
  runCli,
} from './helpers/run-cli.js';
import { startMockProvider } from './helpers/mock-provider.js';

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

beforeAll(() => {
  assert.ok(
    existsSync(DIST_ENTRY),
    'dist/cli.js not found — run `npm run build` before `npm run test:e2e`.',
  );
});

describe('offline CLI paths', () => {
  test('--version prints the package version and exits 0', async () => {
    const result = await runCli({ args: ['--version'], cwd: REPO_ROOT });

    assert.equal(result.code, 0, describeRun(result));
    assert.equal(result.stdout.trim(), pkg.version);
  });

  test('--help lists the command surface and exits 0', async () => {
    const result = await runCli({ args: ['--help'], cwd: REPO_ROOT });

    assert.equal(result.code, 0, describeRun(result));
    assert.match(result.stdout, /Usage: sc/);
    assert.match(result.stdout, /\bchat\b/);
    assert.match(result.stdout, /\bdoctor\b/);
  });

  test('doctor exits 0 when the provider endpoint answers', async () => {
    const provider = await startMockProvider(() => ({ kind: 'message', content: 'ok' }));
    cleanups.push(provider.close);
    const ws = await makeWorkspace({ baseUrl: provider.baseUrl });
    cleanups.push(() => rm(ws, { recursive: true, force: true }));

    const result = await runCli({ args: ['doctor'], cwd: ws, env: chatEnv(ws) });

    assert.equal(result.code, 0, describeRun(result));
    assert.match(result.stdout, /provider endpoint/);
    assert.match(result.stdout, /All checks passed/);
    assert.ok(
      provider.requests.some((r) => r.url.endsWith('/models')),
      'doctor never probed GET /models on the mock',
    );
  });

  test('doctor exits non-zero when the provider is unreachable', async () => {
    const provider = await startMockProvider(() => ({ kind: 'message', content: 'ok' }));
    const deadBaseUrl = provider.baseUrl;
    await provider.close(); // released ephemeral port → guaranteed ECONNREFUSED

    const ws = await makeWorkspace({ baseUrl: deadBaseUrl });
    cleanups.push(() => rm(ws, { recursive: true, force: true }));

    const result = await runCli({ args: ['doctor'], cwd: ws, env: chatEnv(ws) });

    assert.equal(result.code, 1, describeRun(result));
    assert.match(result.stdout, /provider endpoint/);
    assert.match(result.stdout, /check\(s\) failed/);
  });
});
