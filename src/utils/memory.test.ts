import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentMemory, workspaceIdFor, memoryScopeTag } from './memory.js';

let tempDir: string;
let wsDirA: string;
let wsDirB: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'memory-test-'));
  wsDirA = mkdtempSync(path.join(tmpdir(), 'memory-ws-a-'));
  wsDirB = mkdtempSync(path.join(tmpdir(), 'memory-ws-b-'));
});

test('remember and recall a memory', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('test-key', 'test content', ['test']);
  const result = await mem.recall('test-key');
  assert.equal(result, 'test content');
});

test('recall returns null for missing key', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  const result = await mem.recall('nonexistent');
  assert.equal(result, null);
});

test('forget removes a memory', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('forget-me', 'content');
  const forgot = await mem.forget('forget-me');
  assert.ok(forgot);
  const result = await mem.recall('forget-me');
  assert.equal(result, null);
});

test('forget returns false for non-existent key', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  const result = await mem.forget('does-not-exist');
  assert.equal(result, false);
});

test('search finds matching memories', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('alpha', 'hello world');
  await mem.remember('beta', 'goodbye world');
  const results = await mem.search('hello');
  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'alpha');
});

test('search matches tags', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('tagged-item', 'content', ['important', 'urgent']);
  const results = await mem.search('urgent');
  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'tagged-item');
});

test('getSummary shows stored memories', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('summary-key', 'summary content');
  const summary = await mem.getSummary();
  assert.ok(summary.includes('summary-key'));
  assert.ok(summary.match(/1\s+total/));
});

test('getSummary returns empty message when no memories', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  const summary = await mem.getSummary();
  assert.equal(summary, 'No stored memories.');
});

test('clear removes all memories', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('k1', 'v1');
  await mem.remember('k2', 'v2');
  await mem.clear();
  const summary = await mem.getSummary();
  assert.equal(summary, 'No stored memories.');
});

test('remember updates existing key', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('key', 'original');
  await mem.remember('key', 'updated');
  const result = await mem.recall('key');
  assert.equal(result, 'updated');
});

test('getAll returns all entries sorted by timestamp descending', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('first', 'first content');
  await new Promise(r => setTimeout(r, 5));
  await mem.remember('second', 'second content');
  const all = await mem.getAll();
  assert.equal(all.length, 2);
  assert.ok(all[0].timestamp >= all[1].timestamp);
});

test('getContextString returns empty for no entries', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  const result = await mem.getContextString();
  assert.equal(result, '');
});

test('getContextString returns top 10 entries sorted by recency', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  for (let i = 0; i < 15; i++) {
    await mem.remember(`key-${i}`, `content-${i}`);
  }
  const result = await mem.getContextString();
  assert.ok(result.includes('key-14'));
  assert.ok(!result.includes('key-0'));
});

// #475: the memory store is sensitive state — file must be 0600, dir 0700.
const posix = test.skipIf(process.platform === 'win32');

posix('memory store is written with owner-only permissions', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('private-key', 'secret content');
  assert.equal(statSync(path.join(tempDir, 'memory.json')).mode & 0o777, 0o600);
  assert.equal(statSync(tempDir).mode & 0o777, 0o700);
});

// ── #476: workspace-scoped persistent memory ────────────────────────────────

test('workspaceIdFor hashes the realpath (12 hex chars) and is stable', async () => {
  const id = await workspaceIdFor(wsDirA);
  assert.ok(id);
  assert.match(id!, /^[0-9a-f]{12}$/);
  assert.equal(await workspaceIdFor(wsDirA), id);
  assert.notEqual(await workspaceIdFor(wsDirB), id);
});

test('workspaceIdFor returns null for an unresolvable root', async () => {
  const id = await workspaceIdFor(path.join(tempDir, 'does-not-exist-xyz'));
  assert.equal(id, null);
});

test('workspace memories do not leak into another workspace session', async () => {
  const memA = new PersistentMemory(tempDir, wsDirA);
  await memA.remember('repo-a-secret', 'repo A credential detail');

  // A second session in workspace B shares the same store file but must not
  // see workspace A's entries on any read path.
  const memB = new PersistentMemory(tempDir, wsDirB);
  assert.equal(await memB.recall('repo-a-secret'), null);
  assert.equal((await memB.search('credential')).length, 0);
  assert.equal((await memB.getAll()).length, 0);
  assert.ok(!(await memB.getContextString()).includes('repo-a-secret'));

  // …while workspace A still sees it.
  const ctxA = await memA.getContextString();
  assert.ok(ctxA.includes('repo-a-secret'));
  assert.ok(ctxA.includes('[memory:workspace]'));
});

test('global tier is visible in every workspace with [memory:global] provenance', async () => {
  const memA = new PersistentMemory(tempDir, wsDirA);
  await memA.remember('shared-pref', 'use pnpm', [], { scope: 'global' });

  const memB = new PersistentMemory(tempDir, wsDirB);
  assert.equal(await memB.recall('shared-pref'), 'use pnpm');
  const ctxB = await memB.getContextString();
  assert.ok(ctxB.includes('shared-pref'));
  assert.ok(ctxB.includes('[memory:global]'));
  assert.ok(!ctxB.includes('[memory:workspace]'));
});

test('writes default to the workspace scope', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  const entry = await mem.remember('plain', 'no scope given');
  assert.equal(entry.scope, 'workspace');
  assert.equal(entry.workspaceId, await workspaceIdFor(wsDirA));
  // resolveWorkspacePath uses the async realpath — on Windows the sync
  // non-native variant can keep 8.3 short-name segments (e.g. RUNNER~1 in
  // %TEMP%) while the async call returns the canonical long form.
  assert.equal(entry.workspacePath, await realpath(wsDirA));
});

test('injection cap is shared — workspace entries win, global fills the rest', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  for (let i = 0; i < 8; i++) await mem.remember(`ws-${i}`, `ws content ${i}`);
  for (let i = 0; i < 5; i++) await mem.remember(`g-${i}`, `global content ${i}`, [], { scope: 'global' });
  const ctx = await mem.getContextString();
  const lineCount = ctx.split('\n').filter(l => l.startsWith('[memory:')).length;
  assert.equal(lineCount, 10);
  for (let i = 0; i < 8; i++) assert.ok(ctx.includes(`ws-${i}`));
  // Only the two most recent global entries make the cut.
  assert.ok(ctx.includes('g-4'));
  assert.ok(ctx.includes('g-3'));
  assert.ok(!ctx.includes('g-2'));
});

test('unresolvable workspace loads only global + legacy; workspace writes fail', async () => {
  const badRoot = path.join(tempDir, 'nonexistent-workspace');
  const memA = new PersistentMemory(tempDir, wsDirA);
  await memA.remember('a-only', 'ws A entry');
  await memA.remember('everywhere', 'global entry', [], { scope: 'global' });

  const orphan = new PersistentMemory(tempDir, badRoot);
  assert.equal(await orphan.recall('a-only'), null);
  assert.equal(await orphan.recall('everywhere'), 'global entry');
  const ctx = await orphan.getContextString();
  assert.ok(ctx.includes('everywhere'));
  assert.ok(!ctx.includes('a-only'));
  await assert.rejects(orphan.remember('x', 'y'), /workspace/i);
  // Global writes still work without a workspace.
  await orphan.remember('g2', 'ok', [], { scope: 'global' });
});

test('pre-scoping entries migrate to the legacy tier — never auto-injected', async () => {
  // Hand-write a v1 store (entries with no `scope` field).
  const v1 = {
    entries: [
      { key: 'old-note', content: 'pre-scoping memory', timestamp: Date.now(), tags: [] },
    ],
    created: Date.now(),
    updated: Date.now(),
    version: 1,
  };
  writeFileSync(path.join(tempDir, 'memory.json'), JSON.stringify(v1));

  const mem = new PersistentMemory(tempDir, wsDirA);
  // On-demand recall still works (legacy is loadable)…
  assert.equal(await mem.recall('old-note'), 'pre-scoping memory');
  // …but it is never injected into the system prompt…
  assert.equal(await mem.getContextString(), '');
  // …hidden from the default listing…
  assert.equal((await mem.getAll()).length, 0);
  // …and visible via the --all view.
  const all = await mem.getAll({ includeLegacy: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].scope, 'legacy');
  const summary = await mem.getSummary(wsDirA, { all: true });
  assert.ok(summary.includes('[legacy]'));

  // Migration persisted to disk with a pristine backup of the v1 file.
  const migrated = JSON.parse(readFileSync(path.join(tempDir, 'memory.json'), 'utf-8'));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.entries[0].scope, 'legacy');
  assert.ok(existsSync(path.join(tempDir, 'memory.json.pre-v2.bak')));
});

test('move re-files entries between scopes — legacy → workspace becomes injectable', async () => {
  const v1 = {
    entries: [
      { key: 'claimable', content: 'worth keeping', timestamp: Date.now(), tags: [] },
    ],
    created: Date.now(),
    updated: Date.now(),
    version: 1,
  };
  writeFileSync(path.join(tempDir, 'memory.json'), JSON.stringify(v1));

  const mem = new PersistentMemory(tempDir, wsDirA);
  const moved = await mem.move('claimable', 'workspace');
  assert.equal(moved.scope, 'workspace');
  assert.equal(moved.workspaceId, await workspaceIdFor(wsDirA));
  const ctx = await mem.getContextString();
  assert.ok(ctx.includes('claimable'));
  assert.ok(ctx.includes('[memory:workspace]'));
});

test('move workspace → global and back', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('roaming', 'fact');
  const g = await mem.move('roaming', 'global');
  assert.equal(g.scope, 'global');
  assert.equal(g.workspaceId, undefined);
  const back = await mem.move('roaming', 'workspace');
  assert.equal(back.scope, 'workspace');
  assert.ok(back.workspaceId);
});

test('move reports unknown keys and rejects unresolvable workspace targets', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await assert.rejects(mem.move('nope', 'global'), /No memory found/);
  const orphan = new PersistentMemory(tempDir, path.join(tempDir, 'gone-xyz'));
  await orphan.remember('g', 'v', [], { scope: 'global' });
  await assert.rejects(orphan.move('g', 'workspace'), /workspace/i);
});

test('memory_write upsert with a different scope re-files the entry', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('note', 'first in workspace');
  const refiled = await mem.remember('note', 'now global', [], { scope: 'global' });
  assert.equal(refiled.scope, 'global');
  assert.equal((await mem.getAll()).length, 1);
  assert.equal((await mem.getAll({ includeLegacy: true })).length, 1);
});

test('a same-named key in another workspace is never overwritten', async () => {
  const memA = new PersistentMemory(tempDir, wsDirA);
  await memA.remember('prefs', 'A uses tabs');
  const memB = new PersistentMemory(tempDir, wsDirB);
  await memB.remember('prefs', 'B uses spaces');
  assert.equal(await memA.recall('prefs'), 'A uses tabs');
  assert.equal(await memB.recall('prefs'), 'B uses spaces');
});

test('forget and clear cannot touch another workspace’s entries', async () => {
  const memA = new PersistentMemory(tempDir, wsDirA);
  await memA.remember('a-keep', 'repo A memory');
  const memB = new PersistentMemory(tempDir, wsDirB);
  await memB.remember('b-keep', 'repo B memory');

  // forget by foreign key is a no-op in B's session
  assert.equal(await memB.forget('a-keep'), false);
  // clear in B wipes B + shared tiers but leaves A's entries intact
  await memB.clear();
  assert.equal(await memA.recall('a-keep'), 'repo A memory');
  const ctxB = await memB.getContextString();
  assert.equal(ctxB, '');
});

test('recallEntry exposes the scope for provenance display', async () => {
  const mem = new PersistentMemory(tempDir, wsDirA);
  await mem.remember('scoped', 'v', [], { scope: 'global' });
  const entry = await mem.recallEntry('scoped');
  assert.equal(entry?.scope, 'global');
  assert.equal(memoryScopeTag(entry!.scope), '[memory:global]');
});
