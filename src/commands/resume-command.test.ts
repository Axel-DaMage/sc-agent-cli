import { test, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCheckpoint } from '../utils/checkpoint.js';
import {
  resumeSession,
  findResumeCheckpoint,
  resolveCheckpointRef,
  formatResumeContext,
} from './resume-command.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-resume-'));
  vi.stubEnv('SC_CHECKPOINT_DIR', dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function writeCp(sessionId: string, workspaceRoot: string, timestamp = Date.now()) {
  writeFileSync(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      version: 1,
      timestamp,
      sessionId,
      workspaceRoot,
      history: [{ role: 'user', content: 'hi' }],
      inputHistory: ['hi'],
      iterations: 4,
      toolRunCount: 2,
    })
  );
}

test('resumeSession returns null + prints a hint when no checkpoint exists', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const res = await resumeSession('/ws/nothing');
  assert.equal(res, null);
  assert.match(log.mock.calls.map((c) => String(c[0])).join('\n'), /No checkpoint found/);
});

test('resumeSession returns the latest workspace checkpoint and prints its info', async () => {
  writeCp('old', '/ws/a', 1000);
  writeCp('new', '/ws/a', 2000);
  writeCp('other', '/ws/b', 3000);

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const cp = await resumeSession('/ws/a');

  assert.ok(cp);
  assert.equal(cp!.sessionId, 'new');
  assert.equal(cp!.workspaceRoot, '/ws/a');
  assert.match(log.mock.calls.map((c) => String(c[0])).join('\n'), /Checkpoint found/);
});

test('findResumeCheckpoint mirrors findLatestCheckpoint', async () => {
  assert.equal(await findResumeCheckpoint('/ws/a'), null);
  writeCp('x', '/ws/a', 500);
  assert.equal((await findResumeCheckpoint('/ws/a'))!.sessionId, 'x');
});

test('resolveCheckpointRef: "latest" and true pick the newest for the workspace', () => {
  writeCp('old', '/ws/a', 100);
  writeCp('new', '/ws/a', 200);

  assert.equal(resolveCheckpointRef('latest', '/ws/a')!.sessionId, 'new');
  assert.equal(resolveCheckpointRef(true, '/ws/a')!.sessionId, 'new');
});

test('resolveCheckpointRef: bare session id loads from the checkpoint dir', () => {
  writeCp('sess-42', '/ws/a', 999);
  const cp = resolveCheckpointRef('sess-42', '/ws/a');
  assert.equal(cp!.sessionId, 'sess-42');
  assert.equal(resolveCheckpointRef('missing-id', '/ws/a'), null);
});

test('resolveCheckpointRef: a .json path is loaded directly from disk', () => {
  const external = join(dir, 'elsewhere.json');
  writeFileSync(
    external,
    JSON.stringify({ version: 1, timestamp: 5, sessionId: 'ext', workspaceRoot: '/w', history: [], inputHistory: [], iterations: 0, toolRunCount: 0 })
  );
  const cp = resolveCheckpointRef(external, '/ws/a');
  assert.equal(cp!.sessionId, 'ext');
});

test('resolveCheckpointRef: path refs reject missing/corrupt/wrong-version files', () => {
  assert.equal(resolveCheckpointRef(join(dir, 'nope.json'), '/ws/a'), null);

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(resolveCheckpointRef(bad, '/ws/a'), null);

  writeFileSync(bad, JSON.stringify({ version: 2, history: [] }));
  assert.equal(resolveCheckpointRef(bad, '/ws/a'), null, 'version != 1 rejected');

  writeFileSync(bad, JSON.stringify({ version: 1, history: 'not-array' }));
  assert.equal(resolveCheckpointRef(bad, '/ws/a'), null, 'non-array history rejected');
});

test('resolveCheckpointRef: slash-bearing refs resolve as paths, not session ids', () => {
  // 'sub/sess' contains '/' → routed to the filesystem-path branch, where a
  // nonexistent file yields null rather than a checkpoint-dir lookup.
  assert.equal(resolveCheckpointRef('sub/sess', '/ws/a'), null);
});

test('formatResumeContext renders the resumed-session block', () => {
  writeCp('fmt', '/ws/a', 1700000000000);
  const cp = resolveCheckpointRef('fmt', '/ws/a')!;
  const out = formatResumeContext(cp);

  assert.match(out, /## Resumed Session/);
  assert.match(out, /resumed from a checkpoint/);
  assert.match(out, /4 iterations and used 2 tool calls/);
  assert.match(out, /Continue the previous task/);
});

test('saveCheckpoint + resumeSession round-trip through the real store', async () => {
  saveCheckpoint({
    sessionId: 'rt',
    workspaceRoot: '/ws/rt',
    history: [{ role: 'user', content: 'hello' }],
    inputHistory: ['hello'],
    iterations: 3,
    toolRunCount: 1,
  });
  const cp = await resumeSession('/ws/rt');
  assert.equal(cp!.sessionId, 'rt');
  assert.equal(readFileSync(join(dir, 'rt.json'), 'utf-8').includes('"sessionId": "rt"'), true);
});
