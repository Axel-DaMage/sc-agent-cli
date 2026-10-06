import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getGlobalConfigPath, loadConfig, validateConfig } from './config.js';
import type { ProjectConfig } from './types.js';

// Keep loadConfig() hermetic: on a dev machine the real
// ~/.sc-agent/config.json can carry an activeProfile/model that would
// silently override the fixtures below. Redirect homedir() to an empty temp
// dir so the global-config merge finds nothing (#424 quality gate).
vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>();
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const fakeHome = mkdtempSync(join(mod.tmpdir(), 'sc-agent-home-'));
  const mocked = { ...mod, homedir: () => fakeHome };
  return { ...mocked, default: mocked };
});

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
    () => loadConfig(projectRoot),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Invalid JSON in project config/);
      assert.match(err.message, new RegExp(escapeRegex(projectConfigPath)));
      assert.match(err.message, /sc config-init/);
      return true;
    }
  );
});

// Every env var loadConfig consults, plus HOME/USERPROFILE so the global
// config (~/.sc-agent/config.json) can be redirected to a scratch dir —
// otherwise a real global config (e.g. an activeProfile) leaks into the tests.
const ENV_KEYS = [
  'SC_BASE_URL',
  'SC_MODEL',
  'SC_PROFILE',
  'SC_API_KEY',
  'SC_POLICY_FILE',
  'SC_CONFIG_PATH',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NVIDIA_API_KEY',
  'HOME',
  'USERPROFILE',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  const fakeHome = await mkdtemp(path.join(tmpdir(), 'sc-agent-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  // Point the global config at a path guaranteed not to exist so loadConfig
  // never sees the machine's real ~/.sc-agent/config.json — an activeProfile
  // there would override merged model.* and break hermetic assertions.
  const isolatedDir = await mkdtemp(path.join(tmpdir(), 'sc-agent-no-global-'));
  process.env.SC_CONFIG_PATH = path.join(isolatedDir, 'config.json');
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

test('loadConfig: SC_BASE_URL overrides config file model.baseUrl', async () => {
  const projectRoot = await createProjectWithConfig({
    model: { baseUrl: 'http://project.example/v1', model: 'project-model' },
  });
  process.env.SC_BASE_URL = 'https://models.github.ai/inference';

  const config = await loadConfig(projectRoot);

  assert.equal(config.model.baseUrl, 'https://models.github.ai/inference');
  assert.equal(config.model.model, 'project-model');
});

test('loadConfig: invalid SC_BASE_URL fails with the same error as an invalid config file baseUrl', async () => {
  const envProject = await createProjectWithConfig({});
  process.env.SC_BASE_URL = 'not a url';
  await assert.rejects(
    () => loadConfig(envProject),
    /^Error: Invalid model\.baseUrl: "not a url" is not a valid URL$/
  );

  delete process.env.SC_BASE_URL;
  const fileProject = await createProjectWithConfig({ model: { baseUrl: 'not a url' } });
  await assert.rejects(
    () => loadConfig(fileProject),
    /^Error: Invalid model\.baseUrl: "not a url" is not a valid URL$/
  );
});

test('loadConfig: env overrides take precedence over the active profile', async () => {
  const projectRoot = await createProjectWithConfig({
    model: { baseUrl: 'http://project.example/v1' },
  });
  process.env.SC_PROFILE = 'openai';
  process.env.SC_API_KEY = 'test-key';

  const profileOnly = await loadConfig(projectRoot);
  assert.equal(profileOnly.activeProfile, 'openai');
  assert.equal(profileOnly.model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(profileOnly.model.model, 'gpt-4o');

  process.env.SC_BASE_URL = 'https://models.github.ai/inference';
  process.env.SC_MODEL = 'openai/gpt-4.1';

  const withEnv = await loadConfig(projectRoot);
  assert.equal(withEnv.activeProfile, 'openai');
  assert.equal(withEnv.model.baseUrl, 'https://models.github.ai/inference');
  assert.equal(withEnv.model.model, 'openai/gpt-4.1');
  assert.equal(withEnv.model.apiKey, 'test-key');
});

test('loadConfig: SC_CONFIG_PATH relocates the global config file', async () => {
  const globalDir = await mkdtemp(path.join(tmpdir(), 'sc-agent-global-'));
  const globalConfigPath = path.join(globalDir, 'config.json');
  await writeFile(globalConfigPath, JSON.stringify({ model: { model: 'global-model' } }), 'utf-8');
  process.env.SC_CONFIG_PATH = globalConfigPath;

  const projectRoot = await createProjectWithConfig({});
  const config = await loadConfig(projectRoot);

  assert.equal(getGlobalConfigPath(), globalConfigPath);
  assert.equal(config.model.model, 'global-model');
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
