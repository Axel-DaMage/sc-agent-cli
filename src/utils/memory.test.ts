import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentMemory } from './memory.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'memory-test-'));
});

test('remember and recall a memory', async () => {
  const mem = new PersistentMemory(tempDir);
  await mem.remember('test-key', 'test content', ['test']);
  const result = await mem.recall('test-key');
  assert.equal(result, 'test content');
});

test('recall returns null for missing key', async () => {
  const mem = new PersistentMemory(tempDir);
  const result = await mem.recall('nonexistent');
  assert.equal(result, null);
});

test('forget removes a memory', async () => {
  const mem = new PersistentMemory(tempDir);
  await mem.remember('forget-me', 'content');
  const forgot = await mem.forget('forget-me');
  assert.ok(forgot);
  const result = await mem.recall('forget-me');
  assert.equal(result, null);
});

test('forget returns false for non-existent key', async () => {
  const mem = new PersistentMemory(tempDir);
  const result = await mem.forget('does-not-exist');
  assert.equal(result, false);
});

test('search finds matching memories', async () => {
  const mem = new PersistentMemory(tempDir);
  await mem.remember('alpha', 'hello world');
  await mem.remember('beta', 'goodbye world');
  const results = await mem.search('hello');
  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'alpha');
});

test('search matches tags', async () => {
  const mem = new PersistentMemory(tempDir);
  await mem.remember('tagged-item', 'content', ['important', 'urgent']);
  const results = await mem.search('urgent');
  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'tagged-item');
});

test('getSummary shows stored memories', async () => {
  const mem = new PersistentMemory(tempDir);
  await mem.remember('summary-key', 'summary content');
  const summary = await mem.getSummary();
  assert.ok(summary.includes('summary-key'));
  assert.ok(summary.match(/1\s+total/));
});

test('getSummary returns empty message when no memories', async () => {
  const mem = new PersistentMemory(tempDir);
  const summary = await mem.getSummary();
  assert.equal(summary, 'No stored memories.');
});

test('clear removes all memories', async () => {
  const mem = new PersistentMemory(tempDir);
  await mem.remember('k1', 'v1');
  await mem.remember('k2', 'v2');
  await mem.clear();
  const summary = await mem.getSummary();
  assert.equal(summary, 'No stored memories.');
});

test('remember updates existing key', async () => {
  const mem = new PersistentMemory(tempDir);
  await mem.remember('key', 'original');
  await mem.remember('key', 'updated');
  const result = await mem.recall('key');
  assert.equal(result, 'updated');
});

test('getAll returns all entries sorted by timestamp descending', async () => {
  const mem = new PersistentMemory(tempDir);
  await mem.remember('first', 'first content');
  await new Promise(r => setTimeout(r, 5));
  await mem.remember('second', 'second content');
  const all = await mem.getAll();
  assert.equal(all.length, 2);
  assert.ok(all[0].timestamp >= all[1].timestamp);
});

test('getContextString returns empty for no entries', async () => {
  const mem = new PersistentMemory(tempDir);
  const result = await mem.getContextString();
  assert.equal(result, '');
});

test('getContextString returns top 10 entries sorted by recency', async () => {
  const mem = new PersistentMemory(tempDir);
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
  const mem = new PersistentMemory(tempDir);
  await mem.remember('private-key', 'secret content');
  assert.equal(statSync(path.join(tempDir, 'memory.json')).mode & 0o777, 0o600);
  assert.equal(statSync(tempDir).mode & 0o777, 0o700);
});
