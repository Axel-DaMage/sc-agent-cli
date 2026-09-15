import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from './init-command.js';

afterEach(() => vi.restoreAllMocks());

test('initProject creates AGENTS.md when missing', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sc-agent-init-'));
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await initProject(projectRoot);

  const content = await readFile(agentsPath, 'utf-8');
  assert.match(content, /# Agent Instructions/);
  assert.equal(log.mock.calls.length, 2);
  assert.match(String(log.mock.calls[0]?.[0]), /Created/);
});

test('initProject preserves an existing AGENTS.md by default', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sc-agent-init-'));
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const originalContent = '# Existing instructions\n';
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await writeFile(agentsPath, originalContent, 'utf-8');
  await initProject(projectRoot);

  assert.equal(await readFile(agentsPath, 'utf-8'), originalContent);
  assert.equal(log.mock.calls.length, 2);
  assert.match(String(log.mock.calls[0]?.[0]), /already exists/);
  assert.match(String(log.mock.calls[1]?.[0]), /--force/);
});

test('initProject overwrites an existing AGENTS.md when force is enabled', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sc-agent-init-'));
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await writeFile(agentsPath, '# Existing instructions\n', 'utf-8');
  await initProject(projectRoot, true);

  const content = await readFile(agentsPath, 'utf-8');
  assert.match(content, /# Agent Instructions/);
  assert.equal(log.mock.calls.length, 2);
  assert.match(String(log.mock.calls[0]?.[0]), /Overwrote/);
});
