import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from './types.js';

const CONFIG_DIR = path.join(homedir(), '.sc-agent');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: ProjectConfig = {
  model: {
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1', // Ollama default
    model: 'llama3.2',
    temperature: 0.7,
    maxTokens: 4096,
    stream: true,
  },
  permissions: {
    autoApprove: ['read_file', 'list_dir', 'search_text', 'web_fetch', 'memory_read', 'code_query', 'repo_probe'],
    denyPaths: ['.env', '.env.*', '**/*.key', '**/*.pem'],
  },
  profiles: {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '<YOUR_OPENAI_KEY>',
      model: 'gpt-4o',
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: '<YOUR_ANTHROPIC_KEY>',
      model: 'claude-sonnet-4-6',
    },
    nvidia: {
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: '<YOUR_NVIDIA_KEY>',
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      temperature: 1,
      top_p: 0.95,
      maxTokens: 16384,
    },
    'llama-3.3-70b': {
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: '<YOUR_NVIDIA_KEY>',
      model: 'meta/llama-3.3-70b-instruct',
      temperature: 0.2,
      maxTokens: 1024,
    },
  },
  // No default activeProfile: model.* above already holds the Ollama
  // defaults, and an implicit profile would silently override any
  // user-configured model.baseUrl/model (see #398).
};

const API_KEY_REQUIREMENTS = [
  {
    hostPattern: 'api.openai.com',
    providerName: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
  },
  {
    hostPattern: 'api.anthropic.com',
    providerName: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
  },
  {
    hostPattern: 'integrate.api.nvidia.com',
    providerName: 'NVIDIA',
    envVar: 'NVIDIA_API_KEY',
  },
] as const;

export async function loadConfig(projectRoot?: string): Promise<ProjectConfig> {
  let config = structuredClone(DEFAULT_CONFIG);

  // Load global config
  config = await mergeConfigFile(config, CONFIG_PATH, 'global');

  // Load project-local config if in a project
  if (projectRoot) {
    const projectConfigPath = path.join(projectRoot, '.sc-agent.json');
    config = await mergeConfigFile(config, projectConfigPath, 'project');
  }

  // Override active profile from environment variable if set
  const envProfile = process.env.SC_PROFILE;
  if (envProfile && config.profiles?.[envProfile]) {
    config.activeProfile = envProfile;
  }

  // Apply active profile if set
  if (config.activeProfile && config.profiles?.[config.activeProfile]) {
    const profile = config.profiles[config.activeProfile];
    config.model = { ...config.model, ...profile };
  }

  // Replace placeholder API keys with undefined (for local models)
  if (config.model.apiKey?.startsWith('<YOUR_')) {
    config.model.apiKey = undefined;
  }

  // Override API key from environment variable if available
  // Priority: SC_API_KEY > provider-specific env vars
  const envApiKey = process.env.SC_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.NVIDIA_API_KEY;

  if (envApiKey) {
    config.model.apiKey = envApiKey;
  }

  // Override model from environment variable if set (highest priority)
  const envModel = process.env.SC_MODEL;
  if (envModel) {
    config.model.model = envModel;
  }

  // Override policy file from environment variable
  const envPolicyFile = process.env.SC_POLICY_FILE;
  if (envPolicyFile) {
    if (!config.settings) config.settings = {};
    config.settings.policyFile = envPolicyFile;
  }

  // Validate required fields
  validateConfig(config);

  return config;
}

export function validateConfig(config: ProjectConfig): void {
  if (!config.model.baseUrl) {
    throw new Error('Missing model.baseUrl in config');
  }

  try {
    new URL(config.model.baseUrl);
  } catch {
    throw new Error(`Invalid model.baseUrl: "${config.model.baseUrl}" is not a valid URL`);
  }

  if (!config.model.model) {
    throw new Error('Missing model.model in config');
  }

  const missingApiKeyRule = API_KEY_REQUIREMENTS.find(
    (rule) => config.model.baseUrl.includes(rule.hostPattern) && !config.model.apiKey
  );

  if (missingApiKeyRule) {
    throw new Error(
      `${missingApiKeyRule.providerName} API requires an API key. ` +
      `Set model.apiKey in config, ${missingApiKeyRule.envVar}, or SC_API_KEY.`
    );
  }
}

export function getGlobalConfigPath(): string {
  return CONFIG_PATH;
}

export async function saveConfig(config: ProjectConfig, global = true): Promise<void> {
  const targetPath = global ? CONFIG_PATH : path.join(process.cwd(), '.sc-agent.json');

  if (global) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }

  await writeFile(targetPath, JSON.stringify(config, null, 2), 'utf-8');
}

export async function initConfig(force = false): Promise<void> {
  // Check if config exists and don't overwrite unless force=true
  if (!force) {
    try {
      const fs = await import('fs');
      if (fs.existsSync(CONFIG_PATH)) {
        throw new Error(`Config already exists at ${CONFIG_PATH}. Use --force to overwrite.`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  await saveConfig(DEFAULT_CONFIG, true);
}

function deepMerge<T extends object>(base: T, override: Partial<T>, visited?: WeakSet<object>): T {
  if (visited?.has(override)) {
    throw new Error('Circular reference detected in config merge');
  }
  const seen = visited || new WeakSet<object>();
  seen.add(override);
  const result = { ...base };
  for (const key in override) {
    const val = override[key];
    if (val !== undefined) {
      if (typeof val === 'object' && !Array.isArray(val) && val !== null) {
        result[key] = deepMerge(
          (result[key] as Record<string, unknown>) || {},
          val as Record<string, unknown>,
          seen
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = val as T[Extract<keyof T, string>];
      }
    }
  }
  return result;
}

type ConfigScope = 'global' | 'project';

async function mergeConfigFile(
  config: ProjectConfig,
  configPath: string,
  scope: ConfigScope
): Promise<ProjectConfig> {
  let data: string;

  try {
    data = await readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    if (isMissingFileError(err)) {
      return config;
    }

    throw new Error(
      `Could not read ${scope} config at ${configPath}. ` +
      `Check file permissions and try again.`,
      { cause: err }
    );
  }

  let parsedConfig: Partial<ProjectConfig>;
  try {
    parsedConfig = JSON.parse(data) as Partial<ProjectConfig>;
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : 'Invalid JSON';
    throw new Error(
      `Invalid JSON in ${scope} config at ${configPath}: ${details}. ` +
      `Fix the file or re-run "sc config-init" to recreate the default config.`,
      { cause: err }
    );
  }

  return deepMerge(config, parsedConfig);
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  if (!err || typeof err !== 'object') {
    return false;
  }

  return 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
