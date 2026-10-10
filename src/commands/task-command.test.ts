import { test, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask, listTasks, taskCommand } from './task-command.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sc-task-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

// Locks the dispatch contract (#482): create writes <cwd>/.sc-agent/tasks/
// <slug>.md and rejects on unknown templates; list/talent payloads are
// console output, not return values.

test('createTask writes a checklist markdown file under .sc-agent/tasks', async () => {
  const filePath = await createTask('add-endpoint', 'Create user API', cwd);

  assert.equal(filePath, join(cwd, '.sc-agent', 'tasks', 'create-user-api.md'));
  assert.ok(existsSync(filePath));

  const content = readFileSync(filePath, 'utf-8');
  assert.ok(content.startsWith('# Task: Create user API'));
  assert.ok(content.includes('**Template:** Add API Endpoint'));
  assert.ok(content.includes('## Checklist'));
  // add-endpoint template has 7 steps + 3 note checkboxes
  assert.equal((content.match(/- \[ \] /g) || []).length, 10);
  assert.ok(content.includes('- [ ] Define route and HTTP method'));
});

test('createTask creates the tasks directory when missing', async () => {
  const filePath = await createTask('fix-bug', 'Fix login crash', cwd);
  assert.ok(existsSync(join(cwd, '.sc-agent', 'tasks')));
  assert.ok(existsSync(filePath));
});

test('createTask slugifies the description (lowercase, dashes, trimmed)', async () => {
  const filePath = await createTask('audit', '  Weird   Title!!! With-Punct  ', cwd);
  assert.equal(filePath, join(cwd, '.sc-agent', 'tasks', 'weird-title-with-punct.md'));
});

test('createTask rejects unknown templates naming the bad subcommand arg', async () => {
  await assert.rejects(
    () => createTask('bogus-template', 'desc', cwd),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Unknown template: "bogus-template"/);
      assert.match(err.message, /Available templates/);
      assert.match(err.message, /add-endpoint/);
      assert.match(err.message, /fix-bug/);
      return true;
    }
  );
});

test('listTasks returns [] when the tasks dir does not exist', async () => {
  assert.deepEqual(await listTasks(cwd), []);
});

test('listTasks reports title and checkbox progress per file', async () => {
  await createTask('fix-bug', 'Fix the thing', cwd);
  writeFileSync(
    join(cwd, '.sc-agent', 'tasks', 'manual.md'),
    '# Task: Hand-written\n\n- [x] done step\n- [ ] open step\n'
  );
  writeFileSync(join(cwd, '.sc-agent', 'tasks', 'not-a-task.txt'), 'ignored');

  const tasks = await listTasks(cwd);
  assert.equal(tasks.length, 2);

  const manual = tasks.find((t) => t.startsWith('manual.md'))!;
  assert.match(manual, /manual\.md {2}- Hand-written \(1\/2 done\)/);

  const generated = tasks.find((t) => t.startsWith('fix-the-thing.md'))!;
  assert.match(generated, /Fix the thing \(0\/10 done\)/);
});

test('taskCommand.create prints the created path and file content', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await taskCommand.create('refactor', 'Extract helper', cwd);

  const out = log.mock.calls.map((c) => String(c[0])).join('\n');
  assert.match(out, /Task created: .*extract-helper\.md/);
  assert.match(out, /# Task: Extract helper/);
});

test('taskCommand.list prints tasks or the empty-state hint', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});

  await taskCommand.list(cwd);
  assert.match(log.mock.calls.map((c) => String(c[0])).join('\n'), /No tasks found/);

  log.mockClear();
  await createTask('add-test', 'Cover parser', cwd);
  await taskCommand.list(cwd);
  const out = log.mock.calls.map((c) => String(c[0])).join('\n');
  assert.match(out, /Tasks \(1\)/);
  assert.match(out, /Cover parser/);
});

test('taskCommand.templates prints every built-in template with step counts', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await taskCommand.templates();

  const out = log.mock.calls.map((c) => String(c[0])).join('\n');
  assert.match(out, /Available templates/);
  for (const key of ['add-endpoint', 'new-feature', 'refactor', 'fix-bug', 'add-test', 'audit']) {
    assert.ok(out.includes(key), `missing template ${key}`);
  }
  assert.match(out, /Steps: 7/);
});
