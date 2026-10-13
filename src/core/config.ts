import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { ProjectConfig } from './types.js';
import { ensureSecureDir, warnOnLoosePermissions, writeFileSecure } from '../utils/secure-fs.js';
import { AuditLogger } from '../utils/audit-log.js';

const CONFIG_DIR = path.join(homedir(), '.sc-agent');
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// #471 — shipped defaults for permissions.denyCommands: best-effort parity
// with denyPaths (which only constrains the file tools). Blocks the common
// file-dump verbs over credential material via run_shell — `cat .env`,
// `cat *.key|*.pem`, `cat ~/.ssh/*`, reads of the agent's own config, and
// sourcing `.env` (which re-introduces secrets into the child env). Also
// `/proc/<pid>/environ`, which would dump the *parent* env regardless of
// child-env scrubbing. A user's own denyCommands list replaces these —
// keep/copy them when overriding (see docs/permission-profiles.md).
const DEFAULT_DENY_COMMANDS: string[] = [
  // Credential-store / dotenv file reads via the common dump verbs.
  'cat *.env*', 'head *.env*', 'tail *.env*', 'more *.env*', 'less *.env*', 'bat *.env*',
  'cat .env', // substring form also catches `cat .env` piped/chained further
  'cat *.key', 'cat *.pem',
  // SSH private keys live under ~/.ssh (glob covers ~, relative, absolute).
  'cat *.ssh/*', 'head *.ssh/*', 'tail *.ssh/*',
  // Other well-known credential files.
  'cat *.netrc', 'cat *.npmrc', 'cat *.aws/credentials', 'cat *.kube/config',
  'cat *.docker/config.json', 'cat *.pgpass', 'cat *.git-credentials',
  'cat *id_rsa*', 'cat *id_ed25519*', 'cat *id_ecdsa*', 'cat *id_dsa*',
  // The agent's own credential store — any verb, not just the dumpers.
  '.sc-agent/config.json',
  // Sourcing .env re-injects secrets into the scrubbed child environment.
  'source *.env*', '. *.env*',
  // /proc/<pid>/environ (incl. $PPID) bypasses child-env scrubbing entirely.
  // Glob form (not a bare "/environ" substring) so ./environments/… stays legal.
  '*proc*environ',
];

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
    denyCommands: DEFAULT_DENY_COMMANDS,
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
  /**
   * `--audit-log` path (#469): privileged keys dropped from project-scope
   * config files are appended as `config.privileged_key_blocked` events.
   * The stderr warning is unconditional; without this flag nothing is
   * persisted.
   */
  auditLog?: string;
}

export async function loadConfig(
  projectRoot?: string,
  options?: LoadConfigOptions
): Promise<ProjectConfig> {
  let config = structuredClone(DEFAULT_CONFIG);

  // Audit sink for blocked project-scope keys (#469). Same best-effort
  // contract as the run's logger — an unwritable path must not block loading.
  let audit: AuditLogger | undefined;
  if (options?.auditLog) {
    try {
      audit = new AuditLogger(options.auditLog);
    } catch {
      audit = undefined;
    }
  }

  // Load global config (explicit option wins; otherwise SC_CONFIG_PATH/default)
  const globalConfigPath =
    options?.globalConfigPath === undefined ? getGlobalConfigPath() : options.globalConfigPath;
  if (globalConfigPath !== null) {
    // #469 — trust boundary: an explicitly selected config file whose
    // canonical path lands INSIDE the workspace shipped with the repo, so it
    // only earns project-scope privileges (privileged keys are filtered).
    // A path resolving outside stays user-trusted at global scope.
    const scope: ConfigScope =
      projectRoot && isInsideWorkspace(globalConfigPath, projectRoot) ? 'project' : 'global';
    config = await mergeConfigFile(config, globalConfigPath, scope, audit);
  }

  // Load project-local config if in a project
  if (projectRoot) {
    const projectConfigPath = path.join(projectRoot, '.sc-agent.json');
    config = await mergeConfigFile(config, projectConfigPath, 'project', audit);
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

  // run_shell block (#471) — allowedEnvVars is a list of env var *names*.
  const runShell = config.run_shell;
  if (runShell !== undefined) {
    if (runShell === null || typeof runShell !== 'object' || Array.isArray(runShell)) {
      throw new Error('Invalid run_shell config: expected an object');
    }
    const vars = runShell.allowedEnvVars;
    if (vars !== undefined) {
      const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
      if (!Array.isArray(vars) || vars.some((v) => typeof v !== 'string' || !envName.test(v))) {
        throw new Error('Invalid run_shell.allowedEnvVars: expected an array of env var names (A-Z, 0-9, _)');
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

// Keys that must never be copied from a config file (#478): `result[key] = v`
// goes through [[Set]], so `__proto__` invokes the prototype setter and mutates
// the merged object's prototype instead of creating an own property.
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge<T extends object>(
  base: T,
  override: Partial<T>,
  visited?: WeakSet<object>,
  source?: string,
  keyPath = ''
): T {
  const result = { ...base } as Record<string, unknown>;
  // Non-object overrides (e.g. a config file containing `null` or a bare
  // primitive) contribute nothing — for...in silently ignored them too.
  if (override == null || typeof override !== 'object') {
    return result as T;
  }
  if (visited?.has(override)) {
    throw new Error('Circular reference detected in config merge');
  }
  const seen = visited || new WeakSet<object>();
  seen.add(override);
  // Object.keys iterates own enumerable keys only — a polluted prototype on
  // `override` must not leak inherited members into the merged config.
  for (const key of Object.keys(override)) {
    if (UNSAFE_MERGE_KEYS.has(key)) {
      console.warn(
        chalk.yellow(
          `⚠️  Ignoring unsafe config key "${keyPath}${key}"${source ? ` in ${source}` : ''}`
        )
      );
      continue;
    }
    const val = (override as Record<string, unknown>)[key];
    if (val !== undefined) {
      if (typeof val === 'object' && !Array.isArray(val) && val !== null) {
        result[key] = deepMerge(
          (result[key] as Record<string, unknown>) || {},
          val as Record<string, unknown>,
          seen,
          source,
          `${keyPath}${key}.`
        );
      } else {
        result[key] = val;
      }
    }
  }
  return result as T;
}

type ConfigScope = 'global' | 'project';

// #469 — workspace trust boundary: does `filePath` resolve INSIDE the
// workspace? Both sides are canonicalized (realpath) before the containment
// test so symlinks in either direction cannot blur the boundary: a symlink
// inside the workspace pointing out keeps global privileges, while an
// outside path that resolves in is untrusted.
function isInsideWorkspace(filePath: string, workspaceRoot: string): boolean {
  let wsReal: string;
  try {
    wsReal = realpathSync(workspaceRoot);
  } catch {
    wsReal = path.resolve(workspaceRoot);
  }

  const resolved = path.resolve(filePath);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved; // missing files merge nothing — scope is moot anyway
  }

  // Windows filesystems are case-insensitive; realpathSync does not
  // normalize casing, so compare lowercase there.
  const [ws, target] =
    process.platform === 'win32' ? [wsReal.toLowerCase(), real.toLowerCase()] : [wsReal, real];
  // A filesystem-root workspace ("/", "C:\") already ends with the separator.
  const wsPrefix = ws.endsWith(path.sep) ? ws : ws + path.sep;
  return target === ws || target.startsWith(wsPrefix);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * #469 — project-scope config may only *restrict*, never elevate. A
 * repository ships `.sc-agent.json` (and any config file that resolves
 * inside the workspace) to anyone who clones it, so keys that could spawn
 * processes, reroute the provider endpoint, inject credentials, or widen
 * unattended approvals are dropped before merge — one stderr line per key
 * plus a `config.privileged_key_blocked` audit event when --audit-log is on.
 *
 * `permissions.denyPaths`/`permissions.denyCommands` are the exception: they
 * merge additively (a project may add deny entries, never remove baseline
 * ones — `denyCommands: []` would otherwise erase the shipped #471
 * credential-read protections).
 *
 * Blocking `model.baseUrl`/`model.apiKey` alone would be cosmetic — the
 * same primitive is reachable through `profiles.*` when `activeProfile`,
 * `--profile`, or `SC_PROFILE` selects it — so the profile entries are
 * stripped of endpoint/credential keys too.
 */
function filterProjectScopeConfig(
  parsed: Partial<ProjectConfig>,
  baseline: ProjectConfig,
  sourceFile: string,
  audit: AuditLogger | undefined
): Partial<ProjectConfig> {
  if (!isPlainObject(parsed)) {
    return parsed; // deepMerge already contributes nothing for non-objects
  }
  const record = parsed as Record<string, unknown>;

  const block = (keyPath: string): void => {
    console.warn(
      chalk.yellow(`sc-agent: ignoring project-scope privileged key "${keyPath}" from ${sourceFile}`)
    );
    audit?.emit({
      type: 'config.privileged_key_blocked',
      key_path: keyPath,
      source_file: sourceFile,
      scope: 'project',
    });
  };

  // model.baseUrl reroutes the provider endpoint — env/global API keys would
  // then be sent as `Authorization: Bearer` to an attacker host. model.apiKey
  // injects an attacker credential.
  if (isPlainObject(record.model)) {
    for (const key of ['baseUrl', 'apiKey']) {
      if (Object.hasOwn(record.model, key)) {
        block(`model.${key}`);
        delete record.model[key];
      }
    }
  }

  // Same primitive via indirection: a profile's baseUrl/apiKey applies when
  // the profile is activated (activeProfile, --profile, SC_PROFILE).
  if (isPlainObject(record.profiles)) {
    for (const [name, profile] of Object.entries(record.profiles)) {
      if (!isPlainObject(profile)) continue;
      for (const key of ['baseUrl', 'apiKey']) {
        if (Object.hasOwn(profile, key)) {
          block(`profiles.${name}.${key}`);
          delete profile[key];
        }
      }
    }
  }

  // mcp.servers command/args are spawned verbatim at session start — RCE.
  if (isPlainObject(record.mcp) && Object.hasOwn(record.mcp, 'servers')) {
    block('mcp.servers');
    delete record.mcp.servers;
  }

  // plugins entries are dynamic-import()'ed at session start — in-process
  // code execution, the same RCE primitive as mcp.servers.
  if (Object.hasOwn(record, 'plugins')) {
    block('plugins');
    delete record.plugins;
  }

  // settings.formatters is a shell-command list run by the `git` tool on
  // commit/format — attacker-controlled process execution via config, same
  // class as mcp.servers/plugins.
  if (isPlainObject(record.settings) && Object.hasOwn(record.settings, 'formatters')) {
    block('settings.formatters');
    delete record.settings.formatters;
  }

  // Sandbox boundary (#423): while the baseline has the sandbox ON, every
  // project-side sandbox key can only weaken it — "sandbox off", a wider
  // egress/writable allowlist, or a repo-shipped seccomp profile. Those are
  // dropped; idempotent tightenings (enabled:true / seccomp:true) merge.
  // When the baseline leaves the sandbox off, a project opting in can only
  // restrict, so the block passes through untouched.
  if (isPlainObject(record.sandbox) && baseline.sandbox?.enabled === true) {
    const TIGHTENING = new Map<string, unknown>([
      ['enabled', true],
      ['seccomp', true],
    ]);
    for (const key of Object.keys(record.sandbox)) {
      if (TIGHTENING.has(key) && TIGHTENING.get(key) === record.sandbox[key]) continue;
      block(`sandbox.${key}`);
      delete record.sandbox[key];
    }
  }

  if (Object.hasOwn(record, 'permissions')) {
    if (!isPlainObject(record.permissions)) {
      // A non-object permissions value would replace the whole block —
      // wiping the denyPaths/denyCommands baseline. Escalation by shape.
      block('permissions');
      delete record.permissions;
    } else {
      // autoApprove widens which tools run without prompting — never merges.
      if (Object.hasOwn(record.permissions, 'autoApprove')) {
        block('permissions.autoApprove');
        delete record.permissions.autoApprove;
      }

      // denyPaths/denyCommands are union-only: a project may add deny
      // entries (legitimate hardening) but can never express removals, so
      // the shipped/global baseline always survives. `[]` while baseline
      // entries exist reads as a wipe attempt — the stderr note covers it
      // and the same blocked-key audit event records it.
      for (const key of ['denyPaths', 'denyCommands'] as const) {
        if (!Object.hasOwn(record.permissions, key)) continue;
        const declared = record.permissions[key];
        const baselineDeny = baseline.permissions?.[key] ?? [];
        if (Array.isArray(declared)) {
          console.warn(
            chalk.yellow(
              `sc-agent: project ${key} merge additively; global entries cannot be removed (from ${sourceFile})`
            )
          );
          if (declared.length === 0 && baselineDeny.length > 0) {
            audit?.emit({
              type: 'config.privileged_key_blocked',
              key_path: `permissions.${key}`,
              source_file: sourceFile,
              scope: 'project',
            });
          }
          record.permissions[key] = [
            ...new Set([
              ...baselineDeny,
              ...declared.filter((entry): entry is string => typeof entry === 'string'),
            ]),
          ];
        } else {
          // A non-array value would *replace* the baseline — block it.
          block(`permissions.${key}`);
          delete record.permissions[key];
        }
      }
    }
  }

  return parsed;
}

async function mergeConfigFile(
  config: ProjectConfig,
  configPath: string,
  scope: ConfigScope,
  audit?: AuditLogger
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

  if (scope === 'project') {
    parsedConfig = filterProjectScopeConfig(parsedConfig, config, configPath, audit);
  }

  return deepMerge(config, parsedConfig, undefined, configPath);
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  if (!err || typeof err !== 'object') {
    return false;
  }

  return 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
