import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { loadConfig, getGlobalConfigPath } from '../core/config.js';
import type { ProjectConfig } from '../core/types.js';

interface DoctorOptions {
  profile?: string;
  permissions?: string;
}

interface CheckResult {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
  fix?: string;
}

const KNOWN_AUTH_HOSTS: Array<{ hostPattern: string; providerName: string; envVar: string }> = [
  { hostPattern: 'api.openai.com', providerName: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { hostPattern: 'api.anthropic.com', providerName: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { hostPattern: 'integrate.api.nvidia.com', providerName: 'NVIDIA', envVar: 'NVIDIA_API_KEY' },
];

const VALID_PERMISSION_MODES = ['ask_once', 'always_ask', 'unlimited'];

function statusLabel(status: CheckResult['status']): string {
  if (status === 'PASS') return chalk.green('PASS');
  if (status === 'WARN') return chalk.yellow('WARN');
  return chalk.red('FAIL');
}

const PROBE_TIMEOUT_MS = 8000;

function probeHeaders(config: ProjectConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.model.apiKey) headers['Authorization'] = `Bearer ${config.model.apiKey}`;
  return headers;
}

async function probeChatCompletions(baseUrl: string, config: ProjectConfig): Promise<Response> {
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...probeHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
}

export async function probeProviderEndpoint(config: ProjectConfig): Promise<CheckResult> {
  const baseUrl = config.model.baseUrl.replace(/\/+$/, '');
  const modelsUrl = `${baseUrl}/models`;
  let res: Response;
  try {
    res = await fetch(modelsUrl, { headers: probeHeaders(config), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    return {
      name: 'provider endpoint',
      status: 'FAIL',
      detail: `${modelsUrl} unreachable: ${err instanceof Error ? err.message : err}`,
      fix: 'Check baseUrl, network connectivity, and that the provider is running.',
    };
  }
  if (res.ok) {
    return { name: 'provider endpoint', status: 'PASS', detail: `${modelsUrl} → ${res.status}` };
  }
  if (res.status !== 401 && res.status !== 403) {
    return {
      name: 'provider endpoint',
      status: 'WARN',
      detail: `${modelsUrl} → ${res.status} (reachable, but /models did not return 2xx)`,
    };
  }
  // /models rejected auth — distinguish a bad key from an admin-protected
  // /models on an inference-capable gateway by probing a real completion.
  try {
    const probe = await probeChatCompletions(baseUrl, config);
    if (probe.ok) {
      return {
        name: 'provider endpoint',
        status: 'PASS',
        detail: `${modelsUrl} → ${res.status} (admin-protected) but /chat/completions accepted auth → inference OK`,
      };
    }
    if (probe.status === 401 || probe.status === 403) {
      return config.model.apiKey
        ? {
            name: 'provider endpoint',
            status: 'FAIL',
            detail: `auth rejected (/models → ${res.status}, /chat/completions → ${probe.status})`,
            fix: 'Verify the API key is valid for this provider.',
          }
        : {
            name: 'provider endpoint',
            status: 'WARN',
            detail: `${modelsUrl} → ${res.status}; /chat/completions → ${probe.status} — endpoint requires auth but no apiKey is configured`,
          };
    }
    return {
      name: 'provider endpoint',
      status: 'WARN',
      detail: `${modelsUrl} → ${res.status}; /chat/completions probe → ${probe.status} (inconclusive)`,
    };
  } catch (err) {
    return {
      name: 'provider endpoint',
      status: 'WARN',
      detail: `${modelsUrl} → ${res.status} (auth rejected); /chat/completions probe failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const results: CheckResult[] = [];
  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = join(process.cwd(), '.sc-agent.json');

  // 1. Config files exist and parse
  let sawConfigFile = false;
  for (const [scope, configPath] of [['global', globalConfigPath], ['project', projectConfigPath]] as const) {
    if (!existsSync(configPath)) {
      if (scope === 'global') {
        results.push({
          name: `config file (${scope})`,
          status: 'WARN',
          detail: `${configPath} not found — built-in defaults will be used`,
          fix: 'Run "sc config-init" to create a config file.',
        });
      }
      continue;
    }
    sawConfigFile = true;
    try {
      JSON.parse(readFileSync(configPath, 'utf-8'));
      results.push({ name: `config file (${scope})`, status: 'PASS', detail: `${configPath} parses` });
    } catch (err) {
      results.push({
        name: `config file (${scope})`,
        status: 'FAIL',
        detail: `${configPath} contains invalid JSON: ${err instanceof Error ? err.message : err}`,
        fix: 'Fix the file or re-run "sc config-init --force" to recreate defaults.',
      });
    }
  }
  if (!sawConfigFile && !existsSync(projectConfigPath)) {
    // global WARN already covers the missing-file report
  }

  // 2. Effective config validates (schema, baseUrl, model, api-key rules)
  let config: ProjectConfig | undefined;
  try {
    config = await loadConfig(process.cwd());
    results.push({
      name: 'effective config',
      status: 'PASS',
      detail: `model=${config.model.model} baseUrl=${config.model.baseUrl}`,
    });
  } catch (err) {
    results.push({
      name: 'effective config',
      status: 'FAIL',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Review model.baseUrl / model.model / model.apiKey in your config.',
    });
  }

  // 3. Active profile resolution (+ flag/env overrides)
  if (config) {
    const rawGlobal = existsSync(globalConfigPath)
      ? (JSON.parse(readFileSync(globalConfigPath, 'utf-8')) as Partial<ProjectConfig>)
      : {};
    const declaredProfile = options.profile ?? process.env.SC_PROFILE ?? rawGlobal.activeProfile;
    if (declaredProfile) {
      if (config.profiles?.[declaredProfile]) {
        const src = options.profile ? 'CLI flag --profile' : process.env.SC_PROFILE ? 'env SC_PROFILE' : 'config activeProfile';
        results.push({
          name: 'active profile',
          status: 'PASS',
          detail: `"${declaredProfile}" resolves (source: ${src}) → model=${config.model.model}`,
        });
      } else {
        results.push({
          name: 'active profile',
          status: 'FAIL',
          detail: `profile "${declaredProfile}" is referenced but not defined in profiles`,
          fix: `Add a "${declaredProfile}" entry under profiles, or unset activeProfile/SC_PROFILE.`,
        });
      }
    } else {
      results.push({ name: 'active profile', status: 'PASS', detail: 'none set — using model.* directly' });
    }

    // CLI flag override warning — the classic silent-override failure
    if (options.profile && rawGlobal.activeProfile && options.profile !== rawGlobal.activeProfile) {
      results.push({
        name: 'profile override',
        status: 'WARN',
        detail: `--profile ${options.profile} overrides config activeProfile "${rawGlobal.activeProfile}"`,
      });
    }
  }

  // 4. API key presence
  if (config) {
    const keyRule = KNOWN_AUTH_HOSTS.find((r) => config.model.baseUrl.includes(r.hostPattern));
    const envKey = process.env.SC_API_KEY || process.env.OPENAI_API_KEY
      || process.env.ANTHROPIC_API_KEY || process.env.NVIDIA_API_KEY;
    if (keyRule && !config.model.apiKey) {
      results.push({
        name: 'provider API key',
        status: 'FAIL',
        detail: `${keyRule.providerName} endpoint requires an API key but none is configured`,
        fix: `Set model.apiKey in config, ${keyRule.envVar}, or SC_API_KEY.`,
      });
    } else if (config.model.apiKey) {
      const src = envKey && config.model.apiKey === envKey ? 'env var' : 'config file';
      results.push({ name: 'provider API key', status: 'PASS', detail: `present (source: ${src})` });
    } else {
      results.push({
        name: 'provider API key',
        status: 'WARN',
        detail: 'no apiKey configured — assuming an unauthenticated/local provider',
      });
    }
  }

  // 5. Provider endpoint reachable + auth accepted (cheap /models ping; on auth
  //    rejection fall back to a real /chat/completions probe — some gateways
  //    admin-protect /models while the inference key remains valid, see #441)
  if (config) {
    results.push(await probeProviderEndpoint(config));
  }

  // 6. Effective permissions report (+ CLI-flag override warning)
  if (config) {
    const perms = config.permissions ?? {};
    const autoApprove = perms.autoApprove?.length ?? 0;
    const denyPaths = perms.denyPaths?.length ?? 0;
    const denyCommands = perms.denyCommands?.length ?? 0;
    results.push({
      name: 'permissions (config)',
      status: 'PASS',
      detail: `autoApprove=[${autoApprove} patterns] denyPaths=[${denyPaths}] denyCommands=[${denyCommands}]`,
    });
    if (options.permissions !== undefined) {
      if (VALID_PERMISSION_MODES.includes(options.permissions)) {
        results.push({
          name: 'permissions override',
          status: 'WARN',
          detail: `--permissions ${options.permissions} would override config.json for chat runs — tool prompts may behave differently than configured`,
        });
      } else {
        results.push({
          name: 'permissions override',
          status: 'FAIL',
          detail: `invalid --permissions mode "${options.permissions}"`,
          fix: `Use one of: ${VALID_PERMISSION_MODES.join(', ')}.`,
        });
      }
    }
  }

  // Report
  console.log(chalk.cyan('\n  scc doctor — preflight checks\n'));
  let failures = 0;
  for (const r of results) {
    if (r.status === 'FAIL') failures++;
    console.log(`  ${statusLabel(r.status)}  ${r.name}: ${chalk.gray(r.detail)}`);
    if (r.fix) console.log(`       ${chalk.gray('→ fix:')} ${r.fix}`);
  }
  console.log();
  if (failures > 0) {
    console.log(chalk.red(`  ${failures} check(s) failed.\n`));
    process.exit(1);
  }
  console.log(chalk.green('  All checks passed.\n'));
}
