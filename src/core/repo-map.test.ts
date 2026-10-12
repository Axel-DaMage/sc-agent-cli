import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateRepoMap } from './repo-map.js';
import { Agent } from './agent.js';
import { estimateTokens } from '../utils/token-tracker.js';
import { applyContextBudget } from '../utils/context-budget.js';
import type { ProjectConfig } from './types.js';

const TEST_CONFIG: ProjectConfig = {
  model: { provider: 'openai-compatible', baseUrl: 'http://test.api/v1', model: 'test-model' },
  permissions: { denyPaths: ['.env', '.env.*', '**/*.key', '**/*.pem'] },
};

/** Build a fixture workspace: TS + Python + Go sources, docs, noise dirs. */
async function makeFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sc-repo-map-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'cmd'), { recursive: true });
  await mkdir(path.join(root, 'db'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true });

  await writeFile(
    path.join(root, 'src', 'index.ts'),
    [
      `import { helper } from './helper.js';`,
      `import path from 'node:path';`,
      ``,
      `export const VERSION = '1.0.0';`,
      ``,
      `export function main(argv: string[]): number {`,
      `  if (argv.length === 0) {`,
      `    return 0;`,
      `  }`,
      `  return helper(argv).length;`,
      `}`,
      ``,
      `export class Runner {`,
      `  async start(): Promise<void> {`,
      `    await Promise.resolve();`,
      `  }`,
      `  stop() {}`,
      `}`,
    ].join('\n')
  );

  await writeFile(
    path.join(root, 'src', 'helper.py'),
    [
      `import os`,
      `from typing import Any`,
      ``,
      `DEFAULT_LIMIT = 10`,
      ``,
      `class Helper:`,
      `    def run(self, x: int) -> int:`,
      `        return x`,
      ``,
      `def helper(argv):`,
      `    return argv`,
    ].join('\n')
  );

  await writeFile(
    path.join(root, 'cmd', 'main.go'),
    [
      `package main`,
      ``,
      `import (`,
      `\t"fmt"`,
      `\t"os"`,
      `)`,
      ``,
      `func main() {`,
      `\tfmt.Println(os.Args)`,
      `}`,
      ``,
      `func runTask(id int) error {`,
      `\treturn nil`,
      `}`,
    ].join('\n')
  );

  await writeFile(
    path.join(root, 'db', 'schema.sql'),
    [`CREATE TABLE users (`, `  id INTEGER PRIMARY KEY,`, `  name TEXT NOT NULL`, `);`, ``, `CREATE INDEX idx_users_name ON users(name);`].join('\n')
  );

  // Large doc file — what "full" mode would inject verbatim.
  await writeFile(
    path.join(root, 'AGENTS.md'),
    `# Fixture Agent Docs\n\n${'Project documentation line with guidance text.\n'.repeat(400)}`
  );

  // Noise / excluded files.
  await writeFile(path.join(root, 'node_modules', 'junk', 'index.js'), `export function junk() {}\n`);
  await writeFile(path.join(root, '.env'), `SECRET_TOKEN=hunter2\n`);
  await writeFile(path.join(root, 'package.json'), `{"name":"fixture","version":"1.0.0"}\n`);

  return root;
}

function agentFor(root: string, mode?: 'full' | 'skeleton'): Agent {
  return new Agent({
    workspaceRoot: root,
    quiet: true,
    autoApprove: true,
    livelockThreshold: 0, // disable livelock abort so the reprompt cap is the limiter
    config: {
      model: { provider: 'openai-compatible', baseUrl: 'http://test.api/v1', model: 'test-model' },
      permissions: { denyPaths: ['.env', '.env.*', '**/*.key', '**/*.pem'] },
      ...(mode ? { context: { mode } } : {}),
    },
  });
}

async function systemPromptOf(agent: Agent): Promise<string> {
  vi.spyOn(agent.provider, 'chatCompletion').mockImplementation(async () => ({ content: 'done' }));
  const result = await agent.run('Fix the bug in src/index.ts');
  const sys = result.find((m) => m.role === 'system');
  assert.ok(sys, 'expected a system message after injection');
  return sys.content;
}

// --- generateRepoMap ---

test('generateRepoMap emits paths, import edges and signatures per file', async () => {
  const root = await makeFixtureRepo();
  const map = await generateRepoMap(root, TEST_CONFIG);
  assert.ok(map, 'expected a repo map for the fixture');

  // Paths are precise and workspace-relative — read_file can resolve them.
  assert.match(map!, /^src\/index\.ts$/m);
  assert.match(map!, /^cmd\/main\.go$/m);
  assert.match(map!, /^src\/helper\.py$/m);

  // Import edges.
  assert.ok(map!.includes('./helper.js'), 'ts import edge');
  assert.ok(map!.includes('node:path'), 'ts bare specifier');
  assert.ok(map!.includes('os'), 'python import edge');
  assert.ok(map!.includes('fmt'), 'go import edge');

  // Symbols / signatures.
  assert.ok(map!.includes('export function main(argv: string[]): number'), 'ts function signature');
  assert.ok(map!.includes('export class Runner'), 'ts class');
  assert.ok(map!.includes('export const VERSION'), 'ts const');
  assert.ok(map!.includes('async start(): Promise<void>'), 'indented method sig');
  assert.ok(map!.includes('class Helper'), 'py class');
  assert.ok(map!.includes('def helper(argv)'), 'py function');
  assert.ok(map!.includes('func runTask(id int) error'), 'go function');
  assert.match(map!, /create table users/i, 'sql create table');

  // The agent is told how to pull bodies.
  assert.match(map!, /read_file/);
});

test('generateRepoMap excludes deps dirs and denyPaths-listed files', async () => {
  const root = await makeFixtureRepo();
  const map = await generateRepoMap(root, TEST_CONFIG)!;
  assert.ok(!map!.includes('node_modules'), 'node_modules never indexed');
  assert.ok(!map!.includes('junk'), 'deps not indexed');
  assert.ok(!map!.includes('SECRET_TOKEN'), '.env content never leaks');
  assert.ok(!map!.includes('.env'), 'deny-listed path not even listed');
});

test('generateRepoMap bounds each file block (~60 lines cap)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sc-repo-map-cap-'));
  const fns = Array.from({ length: 120 }, (_, i) => `export function fn${i}(x: number): number { return x + ${i}; }`);
  await writeFile(path.join(root, 'big.ts'), fns.join('\n'));

  const map = await generateRepoMap(root, TEST_CONFIG, { maxLinesPerFile: 60 });
  assert.ok(map);
  const block = map!.split('\n').filter((l) => l.includes('fn'));
  assert.ok(block.length <= 59, `per-file symbols capped (got ${block.length})`);
  assert.match(map!, /\+\d+ more symbols/, 'overflow marker present');
});

test('generateRepoMap bounds the repo (file count + total lines)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sc-repo-map-repo-'));
  for (let i = 0; i < 10; i++) {
    await writeFile(path.join(root, `m${i}.ts`), `export const c${i} = ${i};\n`);
  }

  const byFiles = await generateRepoMap(root, TEST_CONFIG, { maxFiles: 4 });
  assert.equal((byFiles!.match(/^m\d\.ts$/gm) ?? []).length, 4, 'maxFiles bound');
  assert.match(byFiles!, /repo map truncated/, 'omission marker');

  const byLines = await generateRepoMap(root, TEST_CONFIG, { maxTotalLines: 5 });
  assert.ok(byLines);
  const fileLines = byLines!.split('\n').filter((l) => /^m\d\.ts$/.test(l)).length;
  assert.ok(fileLines <= 5, `total line bound respected (got ${fileLines})`);
});

test('generateRepoMap returns null for an empty workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sc-repo-map-empty-'));
  assert.equal(await generateRepoMap(root, TEST_CONFIG), null);
});

// --- budget integration (#422) ---

test('repo_map is a named budget source — trimmed after project_context', () => {
  const { report } = applyContextBudget(
    [
      { source: 'system', text: 's'.repeat(400) },          // 100t
      { source: 'repo_map', text: 'r'.repeat(120) },        // 30t
      { source: 'project_context', text: 'p'.repeat(120) }, // 30t
    ],
    130 // overflow 30 → project_context (prio 30) drops before repo_map (35)
  );
  const byName = Object.fromEntries(report.sources.map((s) => [s.source, s]));
  assert.equal(byName.project_context.dropped, true);
  assert.equal(byName.repo_map.dropped, false);
  assert.equal(byName.system.truncated, false);
});

// --- agent integration ---

test('Agent.run skeleton mode injects the repo map instead of file contents', async () => {
  const root = await makeFixtureRepo();
  const agent = agentFor(root, 'skeleton');
  const sys = await systemPromptOf(agent);

  assert.match(sys, /# Repository Skeleton/, 'skeleton header injected');
  assert.ok(sys.includes('src/index.ts'), 'workspace file paths named precisely');
  assert.ok(!sys.includes('Project documentation line'), 'AGENTS.md body NOT injected in skeleton mode');

  const report = agent.getContextBudget();
  assert.ok(report, 'context budget report exists');
  assert.ok(report.sources.some((s) => s.source === 'repo_map'), 'repo_map source accounted');
  assert.ok(!report.sources.some((s) => s.source === 'project_context'), 'project_context replaced');
});

test('Agent.run skeleton mode produces a smaller prompt than full mode', async () => {
  const root = await makeFixtureRepo();
  const skeleton = await systemPromptOf(agentFor(root, 'skeleton'));
  const full = await systemPromptOf(agentFor(root)); // default = full

  assert.ok(full.includes('Project documentation line'), 'full mode injects AGENTS.md body');
  assert.ok(
    estimateTokens(skeleton) < estimateTokens(full),
    `skeleton (~${estimateTokens(skeleton)}t) should be smaller than full (~${estimateTokens(full)}t)`
  );
});

test('Agent.run skeleton mode names paths read_file can pull', async () => {
  const root = await makeFixtureRepo();
  const sys = await systemPromptOf(agentFor(root, 'skeleton'));

  // The injected skeleton names exact workspace-relative paths and tells the
  // model to pull bodies via the existing read_file tool (no new tool).
  assert.match(sys, /call\s+read_file|read_file/);
  assert.ok(sys.includes('src/helper.py'));
  assert.ok(sys.includes('db/schema.sql'));
});
