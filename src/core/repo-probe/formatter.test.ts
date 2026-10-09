import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { RepoProfile } from './types.js';

// Chalk is proxied to identity so the golden below is byte-exact regardless of
// the terminal color level of the machine running the tests.
vi.mock('chalk', () => {
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    get: () => proxy,
    apply: (_t, _thisArg, args) => (args[0] === undefined ? '' : String(args[0])),
  };
  const proxy = new Proxy(function () {}, handler);
  return { default: proxy };
});

import {
  formatRepoProfileJSON,
  formatRepoProfileForTerminal,
  formatRepoProfileForPrompt,
} from './formatter.js';

function nodeProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    version: '1.1.0',
    timestamp: 1700000000000,
    root: '/tmp/fixture',
    ecosystems: ['node', 'typescript'],
    confidence: 'high',
    toolchains: [{ name: 'node', version: '20.11.0', sourceFile: '.nvmrc' }],
    packageManagers: [{ name: 'npm', lockfile: 'package-lock.json', sourceFile: 'package-lock.json' }],
    frameworks: [{ name: 'vitest', category: 'test', version: '4.0.0', sourceFile: 'package.json' }],
    commands: { install: 'npm ci', build: 'npm run build', test: 'npm test' },
    ci: { providers: [], workflows: [], minedVerifyCommands: [] },
    devcontainer: false,
    manifests: ['package.json', 'package-lock.json', '.nvmrc'],
    ...overrides,
  };
}

const BAR = '─'.repeat(60);

// Golden: the exact terminal layout for the node+npm fixture profile.
test('formatRepoProfileForTerminal golden output (node + npm)', () => {
  const expected = [
    `┌${BAR}┐`,
    `│ ${'📦 REPOSITORY PROFILE & TOOLCHAIN'.padEnd(58)} │`,
    `├${BAR}┤`,
    `│ Root: /tmp/fixture`.padEnd(60),
    `│ Ecosystems: node, typescript (high confidence)`,
    `├${BAR}┤`,
    `│ 🔧 Toolchains & Runtimes:`,
    `│   • node: 20.11.0 [from .nvmrc]`,
    `├${BAR}┤`,
    `│ 📦 Package Managers:`,
    `│   • npm (lockfile: package-lock.json)`,
    `├${BAR}┤`,
    `│ 🧪 Frameworks & Tools:`,
    `│   • vitest (4.0.0) [test]`,
    `├${BAR}┤`,
    `│ ⚡ Discovered Commands:`,
    `│   • Install:   npm ci`,
    `│   • Build:     npm run build`,
    `│   • Test:      npm test`,
    `└${BAR}┘`,
  ].join('\n');

  assert.equal(formatRepoProfileForTerminal(nodeProfile()), expected);
});

test('formatRepoProfileForPrompt golden output (node + npm)', () => {
  const expected = [
    '## Repository Profile & Toolchain (Auto-detected)',
    '- **Ecosystems**: node, typescript (confidence: high)',
    '- **Toolchains**: node (20.11.0)',
    '- **Package Managers**: npm [lockfile: package-lock.json]',
    '- **Frameworks & Tools**: vitest (4.0.0) [test]',
    '- **Discovered Commands**:',
    '  • Install: `npm ci`',
    '  • Build: `npm run build`',
    '  • Test: `npm test`',
  ].join('\n');

  assert.equal(formatRepoProfileForPrompt(nodeProfile()), expected);
});

test('formatRepoProfileJSON is indented JSON round-trippable to the profile', () => {
  const profile = nodeProfile();
  const parsed = JSON.parse(formatRepoProfileJSON(profile));
  assert.deepEqual(parsed, profile);
});

test('terminal format: minimal profile shows unknown ecosystems + low confidence color slot', () => {
  const out = formatRepoProfileForTerminal(
    nodeProfile({
      ecosystems: [],
      confidence: 'low',
      toolchains: [],
      packageManagers: [],
      frameworks: [],
      commands: {},
    })
  );
  const lines = out.split('\n');
  assert.equal(lines[0], `┌${BAR}┐`);
  assert.ok(lines.some((l) => l.includes('Ecosystems:') && l.includes('unknown') && l.includes('low confidence')));
  assert.equal(lines.at(-1), `└${BAR}┘`);
  // No toolchains/managers/frameworks/commands blocks for the minimal profile.
  assert.ok(!out.includes('Toolchains & Runtimes'));
  assert.ok(!out.includes('Package Managers:'));
  assert.ok(!out.includes('Discovered Commands'));
});

test('terminal format: medium confidence renders', () => {
  const out = formatRepoProfileForTerminal(nodeProfile({ confidence: 'medium' }));
  assert.ok(out.includes('medium confidence'));
});

test('terminal format: toolchain rawSpec used when version absent; (unspecified) otherwise', () => {
  const out = formatRepoProfileForTerminal(
    nodeProfile({
      toolchains: [
        { name: 'go', rawSpec: 'go 1.22', sourceFile: 'go.mod' },
        { name: 'rust' },
      ],
    })
  );
  assert.ok(out.includes('go: go 1.22 [from go.mod]'));
  assert.ok(out.includes('rust: (unspecified)'));
});

test('terminal format: optional command keys + CI + devcontainer + notes + rawFindings blocks', () => {
  const out = formatRepoProfileForTerminal(
    nodeProfile({
      commands: { lint: 'make lint', typecheck: 'tsc', verify: 'make ci', clean: 'make clean', start: 'npm start' },
      ci: {
        providers: ['github-actions'],
        workflows: [
          { file: '.github/workflows/ci.yml', provider: 'github-actions', name: 'CI', jobs: ['b'], steps: [], verifyCommands: ['npm test'] },
        ],
        minedVerifyCommands: ['npm test'],
      },
      devcontainer: true,
      devcontainerPath: '.devcontainer/devcontainer.json',
      devcontainerInfo: {
        configFile: '.devcontainer/devcontainer.json',
        image: 'ubuntu',
        postCreateCommand: 'make setup',
      },
      ecosystems: ['unknown'],
      rawFindings: {
        detectedFiles: ['weird.xyz'],
        scriptFiles: ['build.sh'],
        configFiles: ['Dockerfile'],
        readmeSnippets: ['make all'],
        notes: [],
      },
      notes: ['hand-tuned layout'],
    })
  );

  assert.ok(out.includes('Lint:      make lint'));
  assert.ok(out.includes('Typecheck: tsc'));
  assert.ok(out.includes('Verify:    make ci'));
  assert.ok(out.includes('Clean:     make clean'));
  assert.ok(out.includes('Start:     npm start'));
  assert.ok(out.includes('CI Workflows & Mined Verification'));
  assert.ok(out.includes('Providers: github-actions'));
  assert.ok(out.includes('.github/workflows/ci.yml (1 verify commands)'));
  assert.ok(out.includes('npm test'));
  assert.ok(out.includes('Devcontainer:'));
  assert.ok(out.includes('.devcontainer/devcontainer.json'));
  assert.ok(out.includes('Image: ubuntu'));
  assert.ok(out.includes('postCreate: make setup'));
  assert.ok(out.includes('Raw Findings'));
  assert.ok(out.includes('Scripts: build.sh'));
  assert.ok(out.includes('Configs: Dockerfile'));
  assert.ok(out.includes('README Hints: 1 snippets found'));
  assert.ok(out.includes('Notes:'));
  assert.ok(out.includes('hand-tuned layout'));
});

test('prompt format: devcontainer + mined verify commands + raw findings', () => {
  const out = formatRepoProfileForPrompt(
    nodeProfile({
      ecosystems: ['unknown'],
      confidence: 'low',
      toolchains: [],
      packageManagers: [],
      frameworks: [],
      commands: {},
      ci: { providers: ['gitlab-ci'], workflows: [], minedVerifyCommands: ['make test'] },
      devcontainer: true,
      devcontainerPath: undefined,
      devcontainerInfo: { configFile: '.devcontainer.json', image: 'ubuntu' },
      rawFindings: {
        detectedFiles: [],
        scriptFiles: ['setup.sh'],
        configFiles: ['Procfile'],
        notes: [],
      },
    })
  );

  assert.ok(out.includes('- **Ecosystems**: unknown (confidence: low)'));
  assert.ok(out.includes('- **CI Mined Verification Commands (Ground Truth)**:'));
  assert.ok(out.includes('`make test`'));
  // devcontainerPath undefined → falls back to 'devcontainer.json' label
  assert.ok(out.includes('- **Devcontainer**: present (`devcontainer.json`), image: `ubuntu`'));
  assert.ok(out.includes('- **Discovered Scripts**: setup.sh'));
  assert.ok(out.includes('- **Discovered Configs**: Procfile'));
});

test('prompt format: package manager @version rendered', () => {
  const out = formatRepoProfileForPrompt(
    nodeProfile({ packageManagers: [{ name: 'pnpm', version: '9.1.0' }] })
  );
  assert.ok(out.includes('pnpm@9.1.0'));
});
