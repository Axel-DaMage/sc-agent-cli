import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig } from './config.js';
import type { ProjectConfig } from './types.js';

function createConfig(baseUrl: string, apiKey?: string): ProjectConfig {
  return {
    model: {
      provider: 'openai-compatible',
      baseUrl,
      model: 'test-model',
      apiKey,
    },
  };
}

test('validateConfig explains missing OpenAI API key', () => {
  assert.throws(
    () => validateConfig(createConfig('https://api.openai.com/v1')),
    /OpenAI API requires an API key\. Set model\.apiKey in config, OPENAI_API_KEY, or SC_API_KEY\./
  );
});

test('validateConfig explains missing Anthropic API key', () => {
  assert.throws(
    () => validateConfig(createConfig('https://api.anthropic.com/v1')),
    /Anthropic API requires an API key\. Set model\.apiKey in config, ANTHROPIC_API_KEY, or SC_API_KEY\./
  );
});

test('validateConfig explains missing NVIDIA API key', () => {
  assert.throws(
    () => validateConfig(createConfig('https://integrate.api.nvidia.com/v1')),
    /NVIDIA API requires an API key\. Set model\.apiKey in config, NVIDIA_API_KEY, or SC_API_KEY\./
  );
});

test('validateConfig allows known remote providers when apiKey is present', () => {
  assert.doesNotThrow(() => validateConfig(createConfig('https://api.openai.com/v1', 'test-key')));
  assert.doesNotThrow(() => validateConfig(createConfig('https://api.anthropic.com/v1', 'test-key')));
  assert.doesNotThrow(() => validateConfig(createConfig('https://integrate.api.nvidia.com/v1', 'test-key')));
});

test('validateConfig does not require apiKey for local OpenAI-compatible providers', () => {
  assert.doesNotThrow(() => validateConfig(createConfig('http://localhost:11434/v1')));
});

test('loadConfig surfaces invalid project config JSON with file path and recovery hint', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sc-agent-config-'));
  const projectConfigPath = path.join(projectRoot, '.sc-agent.json');

  await writeFile(projectConfigPath, '{"model":', 'utf-8');

  await assert.rejects(
    () => loadIsolated(projectRoot),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Invalid JSON in project config/);
      assert.match(err.message, new RegExp(escapeRegex(projectConfigPath)));
      assert.match(err.message, /sc config-init/);
      return true;
    }
  );
});

const ENV_KEYS = ['SC_BASE_URL', 'SC_MODEL', 'SC_PROFILE', 'SC_API_KEY', 'SC_SANDBOX', 'SC_CONTEXT_MODE'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function createProjectWithConfig(config: unknown): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sc-agent-config-'));
  await writeFile(path.join(projectRoot, '.sc-agent.json'), JSON.stringify(config), 'utf-8');
  return projectRoot;
}

// Isolate from the machine's real global config: on a host where sc-agent is
// already installed, ~/.sc-agent/config.json (e.g. an activeProfile) would
// otherwise merge in and override the values under test.
const loadIsolated = (projectRoot?: string) =>
  loadConfig(projectRoot, { globalConfigPath: null });

test('loadConfig: SC_BASE_URL overrides config file model.baseUrl', async () => {
  const projectRoot = await createProjectWithConfig({
    model: { baseUrl: 'http://project.example/v1', model: 'project-model' },
  });
  process.env.SC_BASE_URL = 'https://models.github.ai/inference';

  const config = await loadIsolated(projectRoot);

  assert.equal(config.model.baseUrl, 'https://models.github.ai/inference');
  assert.equal(config.model.model, 'project-model');
});

test('loadConfig: invalid SC_BASE_URL fails with the same error as an invalid config file baseUrl', async () => {
  const envProject = await createProjectWithConfig({});
  process.env.SC_BASE_URL = 'not a url';
  await assert.rejects(
    () => loadIsolated(envProject),
    /^Error: Invalid model\.baseUrl: "not a url" is not a valid URL$/
  );

  delete process.env.SC_BASE_URL;
  const fileProject = await createProjectWithConfig({ model: { baseUrl: 'not a url' } });
  await assert.rejects(
    () => loadIsolated(fileProject),
    /^Error: Invalid model\.baseUrl: "not a url" is not a valid URL$/
  );
});

test('loadConfig: env overrides take precedence over the active profile', async () => {
  const projectRoot = await createProjectWithConfig({
    model: { baseUrl: 'http://project.example/v1' },
  });
  process.env.SC_PROFILE = 'openai';
  process.env.SC_API_KEY = 'test-key';

  const profileOnly = await loadIsolated(projectRoot);
  assert.equal(profileOnly.activeProfile, 'openai');
  assert.equal(profileOnly.model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(profileOnly.model.model, 'gpt-4o');

  process.env.SC_BASE_URL = 'https://models.github.ai/inference';
  process.env.SC_MODEL = 'openai/gpt-4.1';

  const withEnv = await loadIsolated(projectRoot);
  assert.equal(withEnv.activeProfile, 'openai');
  assert.equal(withEnv.model.baseUrl, 'https://models.github.ai/inference');
  assert.equal(withEnv.model.model, 'openai/gpt-4.1');
  assert.equal(withEnv.model.apiKey, 'test-key');
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- sandbox config (#423) ---------------------------------------------------

test('validateConfig accepts a well-formed sandbox block', () => {
  const cfg = createConfig('http://localhost:11434/v1');
  cfg.sandbox = {
    enabled: true,
    egressAllowlist: ['api.github.com:443', '*.corp.internal', '[::1]:8080', '*'],
    writablePaths: ['/var/tmp/cache'],
    readOnlyPaths: ['/usr/share/fixtures'],
    seccomp: true,
  };
  assert.doesNotThrow(() => validateConfig(cfg));
});

test('validateConfig rejects malformed sandbox values', () => {
  const base = () => createConfig('http://localhost:11434/v1');
  for (const mutate of [
    (c: ProjectConfig) => { c.sandbox = { enabled: 'yes' as unknown as boolean }; },
    (c: ProjectConfig) => { c.sandbox = { enabled: true, egressAllowlist: 'api.github.com' as unknown as string[] }; },
    (c: ProjectConfig) => { c.sandbox = { enabled: true, egressAllowlist: ['api.github.com:99999'] }; },
    (c: ProjectConfig) => { c.sandbox = { enabled: true, egressAllowlist: ['api.github.com:notaport'] }; },
    (c: ProjectConfig) => { c.sandbox = { enabled: true, egressAllowlist: ['has space.example'] }; },
    (c: ProjectConfig) => { c.sandbox = { enabled: true, writablePaths: [42 as unknown as string] }; },
    (c: ProjectConfig) => { c.sandbox = { enabled: true, seccomp: 'yes' as unknown as boolean }; },
    (c: ProjectConfig) => { c.sandbox = [] as unknown as ProjectConfig['sandbox']; },
  ]) {
    const cfg = base();
    mutate(cfg);
    assert.throws(() => validateConfig(cfg), /sandbox/i);
  }
});

test('loadConfig: SC_SANDBOX env overrides sandbox.enabled', async () => {
  const projectRoot = await createProjectWithConfig({
    sandbox: { enabled: false, egressAllowlist: ['api.github.com'] },
  });
  process.env.SC_SANDBOX = '1';
  const enabled = await loadIsolated(projectRoot);
  assert.equal(enabled.sandbox?.enabled, true);
  assert.deepEqual(enabled.sandbox?.egressAllowlist, ['api.github.com']);

  process.env.SC_SANDBOX = 'off';
  const disabled = await loadIsolated(projectRoot);
  assert.equal(disabled.sandbox?.enabled, false);

  process.env.SC_SANDBOX = 'maybe';
  await assert.rejects(() => loadIsolated(projectRoot), /Invalid SC_SANDBOX/);
});

test('loadConfig: project config sandbox block flows through deepMerge', async () => {
  const projectRoot = await createProjectWithConfig({
    sandbox: { enabled: true, egressAllowlist: ['api.github.com:443'], writablePaths: ['cache'] },
  });
  const config = await loadIsolated(projectRoot);
  assert.equal(config.sandbox?.enabled, true);
  assert.deepEqual(config.sandbox?.egressAllowlist, ['api.github.com:443']);
  assert.deepEqual(config.sandbox?.writablePaths, ['cache']);
});

// --- context injection mode (#461) -------------------------------------------

test('loadConfig: context.mode from project config and SC_CONTEXT_MODE env override', async () => {
  const projectRoot = await createProjectWithConfig({ context: { mode: 'skeleton' } });

  const fromFile = await loadIsolated(projectRoot);
  assert.equal(fromFile.context?.mode, 'skeleton');

  process.env.SC_CONTEXT_MODE = 'full';
  const overridden = await loadIsolated(projectRoot);
  assert.equal(overridden.context?.mode, 'full', 'env wins over the config file');

  process.env.SC_CONTEXT_MODE = ' SKELETON ';
  const normalized = await loadIsolated(projectRoot);
  assert.equal(normalized.context?.mode, 'skeleton', 'env value is trimmed/lowercased');

  process.env.SC_CONTEXT_MODE = 'weird';
  await assert.rejects(() => loadIsolated(projectRoot), /Invalid SC_CONTEXT_MODE/);
});

test('validateConfig rejects malformed context block values', async () => {
  const base = () => createConfig('http://localhost:11434/v1');
  for (const mutate of [
    (c: ProjectConfig) => { c.context = { mode: 'tree-sitter' as never }; },
    (c: ProjectConfig) => { c.context = 'skeleton' as unknown as ProjectConfig['context']; },
    (c: ProjectConfig) => { c.context = [] as unknown as ProjectConfig['context']; },
  ]) {
    const cfg = base();
    mutate(cfg);
    assert.throws(() => validateConfig(cfg), /context/i);
  }
  assert.doesNotThrow(() => validateConfig(base()));
  const ok = base();
  ok.context = { mode: 'skeleton' };
  assert.doesNotThrow(() => validateConfig(ok));
});
