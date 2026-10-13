import { test, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  findLatestCheckpoint,
  cleanOldCheckpoints,
  printCheckpointInfo,
} from './checkpoint.js';
import type { CheckpointData } from './checkpoint.js';
import type { Message } from '../core/types.js';

// SC_CHECKPOINT_DIR relocates the checkpoint root — each test gets a fresh
// tmpdir so the real ~/.sc-agent is never touched.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-checkpoint-'));
  vi.stubEnv('SC_CHECKPOINT_DIR', dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function makeInput(overrides: Partial<Omit<CheckpointData, 'version' | 'timestamp'>> = {}) {
  const history: Message[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ];
  return {
    sessionId: 'sess-1',
    workspaceRoot: '/workspace/repo',
    history,
    inputHistory: ['hello'],
    iterations: 7,
    toolRunCount: 3,
    ...overrides,
  };
}

test('saveCheckpoint writes a versioned JSON file and returns its path', () => {
  const filePath = saveCheckpoint(makeInput());
  assert.equal(filePath, join(dir, 'sess-1.json'));
  assert.ok(existsSync(filePath));

  const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.timestamp, 'number');
  assert.equal(parsed.sessionId, 'sess-1');
  assert.equal(parsed.workspaceRoot, '/workspace/repo');
  assert.equal(parsed.iterations, 7);
  assert.equal(parsed.toolRunCount, 3);
  assert.equal(parsed.history.length, 2);
  assert.deepEqual(parsed.inputHistory, ['hello']);
});

test('save→load round-trip restores the full persisted object', () => {
  const input = makeInput();
  saveCheckpoint(input);

  const loaded = loadCheckpoint('sess-1');
  assert.ok(loaded);
  assert.equal(loaded!.version, 1);
  assert.equal(loaded!.sessionId, input.sessionId);
  assert.equal(loaded!.workspaceRoot, input.workspaceRoot);
  assert.deepEqual(loaded!.history, input.history);
  assert.deepEqual(loaded!.inputHistory, input.inputHistory);
  assert.equal(loaded!.iterations, input.iterations);
  assert.equal(loaded!.toolRunCount, input.toolRunCount);
});

test('save→load→save is byte-stable', () => {
  const filePath = saveCheckpoint(makeInput());
  const loaded = loadCheckpoint('sess-1');
  assert.ok(loaded);

  const before = readFileSync(filePath, 'utf-8');
  // `loaded` carries version+timestamp; the save spread folds them back in
  // unchanged, so re-serializing must produce identical bytes.
  const secondPath = saveCheckpoint(loaded!);
  assert.equal(secondPath, filePath);
  assert.equal(readFileSync(filePath, 'utf-8'), before);
});

test('loadCheckpoint returns null for a missing session', () => {
  assert.equal(loadCheckpoint('never-saved'), null);
});

test('loadCheckpoint returns null for invalid JSON (corrupt file)', () => {
  writeFileSync(join(dir, 'broken.json'), '{ this is not json');
  assert.equal(loadCheckpoint('broken'), null);
});

test('loadCheckpoint returns null for a truncated file', () => {
  const filePath = saveCheckpoint(makeInput({ sessionId: 'trunc' }));
  const full = readFileSync(filePath, 'utf-8');
  writeFileSync(filePath, full.slice(0, Math.floor(full.length / 2)));
  assert.equal(loadCheckpoint('trunc'), null);
});

test('loadCheckpoint rejects a mismatched version field', () => {
  const good = JSON.parse(readFileSync(saveCheckpoint(makeInput({ sessionId: 'v2' })), 'utf-8'));

  for (const badVersion of [2, 0, '1', null]) {
    writeFileSync(join(dir, 'v2.json'), JSON.stringify({ ...good, version: badVersion }));
    assert.equal(loadCheckpoint('v2'), null, `version=${String(badVersion)}`);
  }
});

test('saveCheckpoint redacts secrets from persisted history', () => {
  const filePath = saveCheckpoint(
    makeInput({
      sessionId: 'secret',
      history: [{ role: 'user', content: 'here is api_key=topsecretvalue123 ok' }],
      inputHistory: ['export api_key=topsecretvalue123'],
    })
  );
  const raw = readFileSync(filePath, 'utf-8');
  assert.ok(!raw.includes('topsecretvalue123'), 'secret value must not reach disk');
  assert.ok(raw.includes('[REDACTED]'));
});

test('listCheckpoints returns parsed entries and skips corrupt files', () => {
  saveCheckpoint(makeInput({ sessionId: 'a' }));
  saveCheckpoint(makeInput({ sessionId: 'b' }));
  writeFileSync(join(dir, 'corrupt.json'), 'not json at all');
  writeFileSync(join(dir, 'not-a-checkpoint.txt'), 'ignored by extension');

  const all = listCheckpoints();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((c) => c.sessionId).sort(),
    ['a', 'b']
  );
});

test('listCheckpoints on an empty directory returns []', () => {
  assert.deepEqual(listCheckpoints(), []);
});

test('deleteCheckpoint removes an existing file and reports false for a missing one', () => {
  saveCheckpoint(makeInput({ sessionId: 'del' }));
  assert.equal(deleteCheckpoint('del'), true);
  assert.ok(!existsSync(join(dir, 'del.json')));
  assert.equal(deleteCheckpoint('del'), false);
});

test('findLatestCheckpoint picks the newest checkpoint for the workspace only', () => {
  const write = (sessionId: string, workspaceRoot: string, timestamp: number) =>
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({ version: 1, timestamp, sessionId, workspaceRoot, history: [], inputHistory: [], iterations: 0, toolRunCount: 0 })
    );

  write('old', '/ws/a', 1000);
  write('new', '/ws/a', 2000);
  write('other-ws', '/ws/b', 3000);

  const latest = findLatestCheckpoint('/ws/a');
  assert.ok(latest);
  assert.equal(latest!.sessionId, 'new');

  assert.equal(findLatestCheckpoint('/ws/none'), null);
});

test('cleanOldCheckpoints removes corrupt files and entries older than 7 days', () => {
  const fresh = JSON.stringify({ version: 1, timestamp: Date.now(), sessionId: 'fresh', workspaceRoot: '/w', history: [], inputHistory: [], iterations: 0, toolRunCount: 0 });
  const stale = JSON.stringify({ version: 1, timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, sessionId: 'stale', workspaceRoot: '/w', history: [], inputHistory: [], iterations: 0, toolRunCount: 0 });
  writeFileSync(join(dir, 'fresh.json'), fresh);
  writeFileSync(join(dir, 'stale.json'), stale);
  writeFileSync(join(dir, 'corrupt.json'), '{nope');

  cleanOldCheckpoints();

  assert.ok(existsSync(join(dir, 'fresh.json')));
  assert.ok(!existsSync(join(dir, 'stale.json')), 'stale checkpoint must be removed');
  assert.ok(!existsSync(join(dir, 'corrupt.json')), 'corrupt checkpoint must be removed');
});

test('cleanOldCheckpoints enforces the 20-checkpoint cap (oldest evicted)', () => {
  // All timestamps are fresh (< 7 days old) so only the count cap applies:
  // s00 is the oldest, s24 the newest.
  const base = Date.now();
  for (let i = 0; i < 25; i++) {
    writeFileSync(
      join(dir, `s${String(i).padStart(2, '0')}.json`),
      JSON.stringify({ version: 1, timestamp: base - (24 - i) * 1000, sessionId: `s${i}`, workspaceRoot: '/w', history: [], inputHistory: [], iterations: 0, toolRunCount: 0 })
    );
  }

  cleanOldCheckpoints();

  const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(remaining.length, 20);
  // The five oldest (s00..s04) must be gone; the newest survive.
  for (let i = 0; i < 5; i++) {
    assert.ok(!remaining.includes(`s${String(i).padStart(2, '0')}.json`));
  }
  assert.ok(remaining.includes('s24.json'));
});

test('checkpoint root falls back to ~/.sc-agent/checkpoints when SC_CHECKPOINT_DIR is unset', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'sc-home-'));
  try {
    vi.stubEnv('SC_CHECKPOINT_DIR', '');
    vi.stubEnv('HOME', fakeHome);
    // os.homedir() ignores HOME on win32 — USERPROFILE is the lookup there.
    // tmpdir may hand us a short-name (win32) or symlinked (macOS /var→/private/var)
    // path, so compare both sides through realpath.
    vi.stubEnv('USERPROFILE', fakeHome);
    const filePath = saveCheckpoint(makeInput({ sessionId: 'home-dflt' }));
    assert.equal(realpathSync(filePath), join(realpathSync(fakeHome), '.sc-agent', 'checkpoints', 'home-dflt.json'));
    assert.ok(existsSync(filePath));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('printCheckpointInfo prints session metadata', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  printCheckpointInfo({
    version: 1,
    timestamp: 1700000000000,
    sessionId: 'sess-x',
    workspaceRoot: '/ws',
    history: [{ role: 'user', content: 'a' }],
    inputHistory: ['a'],
    iterations: 4,
    toolRunCount: 2,
  });
  const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  assert.match(out, /Checkpoint found/);
  assert.match(out, /sess-x/);
  assert.match(out, /Messages:\s+1/);
  assert.match(out, /Iterations:\s+4/);
  assert.match(out, /Tools run:\s+2/);
});
