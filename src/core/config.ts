import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from './types.js';
import { ensureSecureDir, warnOnLoosePermissions, writeFileSecure } from '../utils/secure-fs.js';

const CONFIG_DIR = path.join(homedir(), '.sc-agent');
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

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

export interface LoadConfigOptions {
  /**
   * Override the global config file (`~/.sc-agent/config.json`). `null` skips
   * the global layer entirely — tests rely on this so a developer's real
   * global config (e.g. an activeProfile) cannot leak into assertions.
   */
  globalConfigPath?: string | null;
}

export async function loadConfig(
  projectRoot?: string,
  options?: LoadConfigOptions
): Promise<ProjectConfig> {
  let config = structuredClone(DEFAULT_CONFIG);

  // Load global config (explicit option wins; otherwise SC_CONFIG_PATH/default)
  const globalConfigPath =
    options?.globalConfigPath === undefined ? getGlobalConfigPath() : options.globalConfigPath;
  if (globalConfigPath !== null) {
    config = await mergeConfigFile(config, globalConfigPath, 'global');
  }

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

  // Override base URL from environment variable (validated in validateConfig)
  const envBaseUrl = process.env.SC_BASE_URL;
  if (envBaseUrl) {
    config.model.baseUrl = envBaseUrl;
  }

  // Override policy file from environment variable
  const envPolicyFile = process.env.SC_POLICY_FILE;
  if (envPolicyFile) {
    if (!config.settings) config.settings = {};
    config.settings.policyFile = envPolicyFile;
  }

  // Override sandbox enablement (#423). SC_SANDBOX wins over config so CI
  // runners can force the boundary on (or off) without editing config files.
  const envSandbox = process.env.SC_SANDBOX;
  if (envSandbox !== undefined && envSandbox.trim() !== '') {
    const v = envSandbox.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(v)) {
      config.sandbox = { ...config.sandbox, enabled: true };
    } else if (['0', 'false', 'off', 'no'].includes(v)) {
      config.sandbox = { ...config.sandbox, enabled: false };
    } else {
      throw new Error(`Invalid SC_SANDBOX value "${envSandbox}" (expected on/off, true/false, 1/0)`);
    }
  }

  // Context injection mode (#461): SC_CONTEXT_MODE wins over
  // `context.mode` in config so CI/headless runs can force the repo-map
  // skeleton without editing files.
  const envContextMode = process.env.SC_CONTEXT_MODE;
  if (envContextMode !== undefined && envContextMode.trim() !== '') {
    const v = envContextMode.trim().toLowerCase();
    if (v === 'full' || v === 'skeleton') {
      config.context = { ...config.context, mode: v };
    } else {
      throw new Error(`Invalid SC_CONTEXT_MODE value "${envContextMode}" (expected 'full' or 'skeleton')`);
    }
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

  // Sandbox profile shape (#423). Semantics (host:port parsing) are enforced
  // again at sandbox resolve time; here we fail fast on malformed structure.
  const sandbox = config.sandbox;
  if (sandbox !== undefined) {
    if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
      throw new Error('Invalid sandbox config: expected an object');
    }
    if (sandbox.enabled !== undefined && typeof sandbox.enabled !== 'boolean') {
      throw new Error('Invalid sandbox.enabled: expected a boolean');
    }
    if (sandbox.seccomp !== undefined && typeof sandbox.seccomp !== 'boolean') {
      throw new Error('Invalid sandbox.seccomp: expected a boolean');
    }
    if (sandbox.seccompProfile !== undefined && typeof sandbox.seccompProfile !== 'string') {
      throw new Error('Invalid sandbox.seccompProfile: expected a file path string');
    }
    for (const key of ['egressAllowlist', 'readOnlyPaths', 'writablePaths'] as const) {
      const list = sandbox[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((e) => typeof e !== 'string' || !e.trim())) {
        throw new Error(`Invalid sandbox.${key}: expected an array of non-empty strings`);
      }
    }
    for (const entry of sandbox.egressAllowlist ?? []) {
      // host | host:port | [v6] | [v6]:port | *.domain[:port] | *
      const body = entry.trim();
      if (/[\s/@]/.test(body)) {
        throw new Error(`Invalid sandbox.egressAllowlist entry "${entry}": expected host or host:port`);
      }
      const portPart = /^\[[0-9a-fA-F:]+\]:(\d+)$/.exec(body)?.[1]
        ?? (/^[^[\]]*:(\d+)$/.test(body) ? body.slice(body.lastIndexOf(':') + 1) : undefined);
      if (portPart !== undefined) {
        const port = Number(portPart);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid sandbox.egressAllowlist entry "${entry}": port must be 1-65535`);
        }
      } else if (body.includes(':') && !body.startsWith('[') && (body.match(/:/g) ?? []).length === 1) {
        throw new Error(`Invalid sandbox.egressAllowlist entry "${entry}": malformed port`);
      }
    }
  }

  // Context injection mode block (#461).
  const context = config.context;
  if (context !== undefined) {
    if (context === null || typeof context !== 'object' || Array.isArray(context)) {
      throw new Error('Invalid context config: expected an object');
    }
    if (context.mode !== undefined && context.mode !== 'full' && context.mode !== 'skeleton') {
      throw new Error(`Invalid context.mode: "${context.mode}" (expected 'full' or 'skeleton')`);
    }
  }

  // web_fetch egress policy (#470). Entries share the sandbox.egressAllowlist
  // grammar (host | host:port | [v6][:port] | *.domain[:port] | *); matching
  // semantics are enforced at fetch time.
  const webFetch = config.webFetch;
  if (webFetch !== undefined) {
    if (webFetch === null || typeof webFetch !== 'object' || Array.isArray(webFetch)) {
      throw new Error('Invalid webFetch config: expected an object');
    }
    if (webFetch.allowPrivateHosts !== undefined && typeof webFetch.allowPrivateHosts !== 'boolean') {
      throw new Error('Invalid webFetch.allowPrivateHosts: expected a boolean');
    }
    if (webFetch.maxBytes !== undefined) {
      if (
        typeof webFetch.maxBytes !== 'number' ||
        !Number.isFinite(webFetch.maxBytes) ||
        webFetch.maxBytes < 1024
      ) {
        throw new Error('Invalid webFetch.maxBytes: expected a number >= 1024 (bytes)');
      }
    }
    if (webFetch.allowlist !== undefined) {
      if (!Array.isArray(webFetch.allowlist) || webFetch.allowlist.some((e) => typeof e !== 'string' || !e.trim())) {
        throw new Error('Invalid webFetch.allowlist: expected an array of non-empty strings');
      }
      for (const entry of webFetch.allowlist) {
        const body = entry.trim();
        if (/[\s/@]/.test(body)) {
          throw new Error(`Invalid webFetch.allowlist entry "${entry}": expected host or host:port`);
        }
        const portPart = /^\[[0-9a-fA-F:]+\]:(\d+)$/.exec(body)?.[1]
          ?? (/^[^\[\]]*:(\d+)$/.test(body) ? body.slice(body.lastIndexOf(':') + 1) : undefined);
        if (portPart !== undefined) {
          const port = Number(portPart);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid webFetch.allowlist entry "${entry}": port must be 1-65535`);
          }
        } else if (body.includes(':') && !body.startsWith('[') && (body.match(/:/g) ?? []).length === 1) {
          throw new Error(`Invalid webFetch.allowlist entry "${entry}": malformed port`);
        }
      }
    }
  }
}

/**
 * Resolve the global config file path. `SC_CONFIG_PATH` relocates it (useful
 * for tests, CI, and containers that must not touch the host's
 * `~/.sc-agent/config.json`); unset or blank falls back to the default.
 * Resolved at call time so every entry point — `loadConfig`, `saveConfig`,
 * `config-init`, `/profile` "save as default" — honors the override.
 */
export function getGlobalConfigPath(): string {
  const envPath = process.env.SC_CONFIG_PATH?.trim();
  return envPath ? envPath : DEFAULT_CONFIG_PATH;
}

export async function saveConfig(config: ProjectConfig, global = true): Promise<void> {
  const targetPath = global ? getGlobalConfigPath() : path.join(process.cwd(), '.sc-agent.json');

  if (global) {
    await ensureSecureDir(path.dirname(targetPath));
  }

  // Config files can carry API keys — owner-only mode in both scopes (#475).
  await writeFileSecure(targetPath, JSON.stringify(config, null, 2));
}

export async function initConfig(force = false): Promise<void> {
  const configPath = getGlobalConfigPath();
  // Check if config exists and don't overwrite unless force=true.
  // (existsSync never throws ENOENT — a plain throw inside a try/catch that
  // filters on `code` would swallow the "already exists" guard entirely.)
  if (!force) {
    const fs = await import('fs');
    if (fs.existsSync(configPath)) {
      throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
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

  // The global config holds credentials — flag + repair loose modes (#475).
  if (scope === 'global') {
    warnOnLoosePermissions(configPath, 'Global config');
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
