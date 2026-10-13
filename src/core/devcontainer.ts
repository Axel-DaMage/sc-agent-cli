// #421 — execute the agent loop inside the repo .devcontainer when present.
//
// Flow (host side, `sc chat --devcontainer …`):
//   1. detect `.devcontainer.json` or `.devcontainer/devcontainer.json`
//   2. require `devcontainer` and `docker` on PATH
//   3. `devcontainer up --workspace-folder <root>`
//   4. `devcontainer exec --workspace-folder <root> --remote-env SC_DEVCONTAINER=1 scc chat <argv>`
//
// Any failure before the exec spawns falls back to host execution and the run
// is classified `devcontainer_unavailable` (audit log + run manifest) — the
// devcontainer path must never hard-fail a run.

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { hostname } from 'node:os';
import chalk from 'chalk';
import { detectDevcontainer } from './repo-probe/detectors/devcontainer.js';
import { AuditLogger } from '../utils/audit-log.js';

/** Remote-env marker injected into the in-container run; doubles as the recursion guard. */
export const DEVCONTAINER_ENV_VAR = 'SC_DEVCONTAINER';

/** Command executed inside the container; overridable for nonstandard installs. */
export const DEFAULT_AGENT_COMMAND = 'scc';
export const AGENT_COMMAND_ENV_VAR = 'SC_DEVCONTAINER_AGENT_CMD';

export type DevcontainerUnavailableReason =
  | 'no_config'
  | 'cli_missing'
  | 'docker_missing'
  | 'up_failed'
  | 'exec_failed';

/** Serialized into the run manifest under `devcontainer` and mirrored in the audit log. */
export interface DevcontainerRunInfo {
  requested: boolean;
  exec_path: 'devcontainer' | 'host';
  status: 'devcontainer' | 'devcontainer_unavailable';
  reason?: DevcontainerUnavailableReason;
  detail?: string;
  config_path?: string;
  marker?: string;
  hostname?: string;
}

export interface DevcontainerPlan {
  execPath: 'devcontainer' | 'host';
  reason?: DevcontainerUnavailableReason;
  detail?: string;
  configPath?: string;
  /** argv for `spawn('devcontainer', execArgv)` when execPath === 'devcontainer'. */
  execArgv?: string[];
  /** Human-readable command line (audit log / verbose). */
  display?: string;
}

export interface DevcontainerUpResult {
  ok: boolean;
  detail?: string;
}

export interface DevcontainerExecResult {
  /** false when the devcontainer CLI itself could not be spawned. */
  spawned: boolean;
  exitCode?: number;
  error?: string;
}

export interface DevcontainerPlanOptions {
  workspaceRoot: string;
  /** process.argv.slice(2) — forwarded verbatim to the inner `chat` run. */
  argv: string[];
  /** Inner command name (default `scc`, env `SC_DEVCONTAINER_AGENT_CMD`). */
  agentCommand?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable `devcontainer up` runner (tests); defaults to spawnSync. */
  runUp?: (workspaceRoot: string, env: NodeJS.ProcessEnv) => DevcontainerUpResult;
}

export interface OrchestrateDevcontainerOptions extends DevcontainerPlanOptions {
  auditLogPath?: string;
  quiet?: boolean;
  /** Injectable exec runner (tests); defaults to spawn('devcontainer'). */
  runExec?: (execArgv: string[], env: NodeJS.ProcessEnv) => Promise<DevcontainerExecResult>;
}

export type OrchestrateDevcontainerResult =
  | { executed: true; exitCode: number }
  | { executed: false; runInfo: DevcontainerRunInfo };

/** true when running inside the container (remote-env marker set by `devcontainer exec`). */
export function isInsideDevcontainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[DEVCONTAINER_ENV_VAR]);
}

/** Locate an executable on PATH (cross-platform, no shell required). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const pathValue = pathKey ? env[pathKey] : undefined;
  if (!pathValue) return null;

  const exts =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // keep searching
      }
    }
  }
  return null;
}

// Default `devcontainer up` runner. stdout is suppressed — `up` prints a result
// blob that would pollute the `--output-format json` contract; stderr stays
// inherited so image builds/progress remain visible to the operator.
export function devcontainerUp(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env
): DevcontainerUpResult {
  try {
    const res = spawnSync('devcontainer', ['up', '--workspace-folder', workspaceRoot], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env,
      // devcontainer ships as a .cmd shim on Windows — needs a shell there.
      shell: process.platform === 'win32',
    });
    if (res.error) {
      return { ok: false, detail: res.error.message };
    }
    if (res.status !== 0) {
      const exit = res.status ?? res.signal ?? 'unknown';
      return { ok: false, detail: `devcontainer up exited with ${exit}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// The inner invocation keeps `--devcontainer`: the SC_DEVCONTAINER remote-env
// marker (not the flag) is what prevents re-orchestration, and keeping the
// flag lets the in-container run record its evidence in the run manifest.
export function buildInnerChatArgv(argv: string[]): string[] {
  return argv[0] === 'chat' ? argv.slice() : ['chat', ...argv];
}

/** Decide where the agent loop runs: inside the devcontainer or on the host. */
export function planDevcontainerRun(opts: DevcontainerPlanOptions): DevcontainerPlan {
  const env = opts.env ?? process.env;

  const detection = detectDevcontainer(opts.workspaceRoot);
  if (!detection.detected) {
    return { execPath: 'host', reason: 'no_config' };
  }
  const configPath = detection.configFile;

  if (!findOnPath('devcontainer', env)) {
    return { execPath: 'host', reason: 'cli_missing', configPath };
  }
  if (!findOnPath('docker', env)) {
    return { execPath: 'host', reason: 'docker_missing', configPath };
  }

  const runUp = opts.runUp ?? devcontainerUp;
  const up = runUp(opts.workspaceRoot, env);
  if (!up.ok) {
    return { execPath: 'host', reason: 'up_failed', detail: up.detail, configPath };
  }

  const agentCommand = opts.agentCommand ?? env[AGENT_COMMAND_ENV_VAR] ?? DEFAULT_AGENT_COMMAND;
  const execArgv = [
    'exec',
    '--workspace-folder', opts.workspaceRoot,
    '--remote-env', `${DEVCONTAINER_ENV_VAR}=1`,
    agentCommand,
    ...buildInnerChatArgv(opts.argv),
  ];
  return {
    execPath: 'devcontainer',
    configPath,
    execArgv,
    display: ['devcontainer', ...execArgv].join(' '),
  };
}

/** `devcontainer exec …` with inherited stdio; forwards SIGINT/SIGTERM to the child. */
export function execInDevcontainer(
  execArgv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<DevcontainerExecResult> {
  const signalExitCodes: Record<string, number> = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  };
  return new Promise((resolve) => {
    const child = spawn('devcontainer', execArgv, {
      stdio: 'inherit',
      env,
      // devcontainer ships as a .cmd shim on Windows — needs a shell there.
      shell: process.platform === 'win32',
    });

    const onSigInt = () => { try { child.kill('SIGINT'); } catch { /* already gone */ } };
    const onSigTerm = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    const cleanup = () => {
      process.removeListener('SIGINT', onSigInt);
      process.removeListener('SIGTERM', onSigTerm);
    };

    child.on('error', (err) => {
      cleanup();
      resolve({ spawned: false, error: err.message });
    });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({ spawned: true, exitCode: code ?? signalExitCodes[signal ?? ''] ?? 1 });
    });
  });
}

/** Append a `devcontainer` event to the JSONL audit log (best-effort, never throws). */
export function auditDevcontainerEvent(
  auditLogPath: string | undefined,
  fields: Record<string, unknown>
): void {
  if (!auditLogPath) return;
  try {
    new AuditLogger(auditLogPath).emit({ type: 'devcontainer', ...fields });
  } catch {
    // Audit is best-effort — an unwritable path must never kill a run.
  }
}

/**
 * Run the agent inside the devcontainer when possible; otherwise classify the
 * run `devcontainer_unavailable` and hand back the info for host execution.
 */
export async function orchestrateDevcontainer(
  opts: OrchestrateDevcontainerOptions
): Promise<OrchestrateDevcontainerResult> {
  const env = opts.env ?? process.env;
  const plan = planDevcontainerRun(opts);

  if (plan.execPath === 'devcontainer' && plan.execArgv) {
    auditDevcontainerEvent(opts.auditLogPath, {
      phase: 'exec',
      exec_path: 'devcontainer',
      status: 'devcontainer',
      config_path: plan.configPath,
      command: plan.display,
    });
    const runExec = opts.runExec ?? execInDevcontainer;
    const res = await runExec(plan.execArgv, env);
    if (res.spawned) {
      // The in-container run owns the manifest/exit contract — propagate its code.
      auditDevcontainerEvent(opts.auditLogPath, {
        phase: 'exit',
        exec_path: 'devcontainer',
        exit_code: res.exitCode,
      });
      return { executed: true, exitCode: res.exitCode ?? 0 };
    }
    plan.reason = 'exec_failed';
    plan.detail = res.error;
  }

  const runInfo: DevcontainerRunInfo = {
    requested: true,
    exec_path: 'host',
    status: 'devcontainer_unavailable',
    reason: plan.reason,
    detail: plan.detail,
    config_path: plan.configPath,
  };
  auditDevcontainerEvent(opts.auditLogPath, {
    phase: 'decision',
    exec_path: 'host',
    status: 'devcontainer_unavailable',
    reason: plan.reason,
    detail: plan.detail,
    config_path: plan.configPath,
  });
  if (!opts.quiet) {
    const why = plan.detail ? `${plan.reason} — ${plan.detail}` : plan.reason;
    console.error(chalk.yellow(`⚠ devcontainer unavailable (${why}); running on host`));
  }
  return { executed: false, runInfo };
}

/** Evidence for a run already inside the devcontainer (remote-env marker + hostname). */
export function insideDevcontainerRunInfo(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env
): DevcontainerRunInfo {
  const detection = detectDevcontainer(workspaceRoot);
  return {
    requested: true,
    exec_path: 'devcontainer',
    status: 'devcontainer',
    marker: `${DEVCONTAINER_ENV_VAR}=${env[DEVCONTAINER_ENV_VAR] ?? '1'}`,
    hostname: hostname(),
    config_path: detection.configFile,
  };
}
