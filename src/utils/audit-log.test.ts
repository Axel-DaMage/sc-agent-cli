import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogger } from './audit-log.js';

test('AuditLogger appends one JSON object per line with ts', () => {
  const dir = join(tmpdir(), `scc-audit-${Date.now()}`);
  const file = join(dir, 'run.jsonl');
  const log = new AuditLogger(file);

  log.emit({ type: 'llm_request', iteration: 1, model: 'm', messages: 3, est_tokens: 100 });
  log.emit({ type: 'tool_call', iteration: 1, name: 'run_shell', args_digest: { sha256: 'abc', bytes: 42 } });
  log.emit({ type: 'tool_result', iteration: 1, name: 'run_shell', success: true, duration_ms: 5 });

  const lines = readFileSync(file, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 3);
  const events = lines.map(l => JSON.parse(l));
  assert.equal(events[0].type, 'llm_request');
  assert.equal(events[1].type, 'tool_call');
  assert.equal(events[2].type, 'tool_result');
  assert.ok(events[0].ts);
  assert.equal(events[2].duration_ms, 5);
  rmSync(dir, { recursive: true, force: true });
});

test('AuditLogger creates parent dirs', () => {
  const dir = join(tmpdir(), `scc-audit-deep-${Date.now()}`);
  const file = join(dir, 'a', 'b', 'run.jsonl');
  const log = new AuditLogger(file);
  log.emit({ type: 'tool_call', name: 'x' });
  assert.ok(existsSync(file));
  rmSync(dir, { recursive: true, force: true });
});

test('AuditLogger.digest hashes args without leaking content', () => {
  const d = AuditLogger.digest({ command: 'echo secret-token-123', path: '/etc/x' });
  assert.equal(d.sha256.length, 12);
  assert.ok(d.bytes > 0);
  assert.equal(JSON.stringify(d).includes('secret-token'), false);
});
