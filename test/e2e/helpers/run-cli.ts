// Child-process + workspace helpers for the e2e suite (#483).
//
// `runCli` spawns the *built* bin (`node bin/sc.js ...`) — never ts-node or
// vitest's module graph — so the suite fails on a broken bin entry, missing
// dist/ output, or a packaging miss instead of shipping green.
//
// Hermeticity contract per spawned run:
//   * env is a sanitized copy of process.env — every SC_* override and
//     provider key (OPENAI_*, ANTHROPIC_*, NVIDIA_*, ...) is stripped so the
//     developer's real configuration cannot leak into assertions;
//   * HOME/USERPROFILE point at the temp workspace, so ~/.sc-agent state
//     (history, sessions, checkpoints, memory) is written inside the
//     workspace and deleted with it;
//   * the workspace carries a `.sc-agent.json` plus `prompt.md`; the provider
//     endpoint reaches the child via the SC_BASE_URL env (callers pass it in
//     `env`) because `model.baseUrl` is a privileged key a project-scope
//     config can no longer set (#469) — nothing but loopback is contacted.

import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CLI_BIN = join(REPO_ROOT, 'bin', 'sc.js');
export const DIST_ENTRY = join(REPO_ROOT, 'dist', 'cli.js');

// Every var the CLI reads for provider/config routing must come from the
// test, never the developer's shell. SC_* is a blanket strip; provider keys
// follow the same convention used by loadConfig/provider failover.
const STRIPPED_ENV_RE =
  /^(?:SC_|OPENAI_|ANTHROPIC_|NVIDIA_|GROQ_|TOGETHER_|MISTRAL_|COHERE_|DEEPSEEK_|XAI_|AZURE_|OLLAMA_)/;

export function cleanEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENV_RE.test(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Env overrides for a hermetic headless run inside `ws` as HOME. */
export function chatEnv(ws: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HOME: ws,
    USERPROFILE: ws,
    SC_API_KEY: 'e2e-test-key',
    ...extra,
  };
}

export interface CliRunResult {
  /** Exit code, or null when the child died by signal (e.g. spawn timeout). */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCliOptions {
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Written to child stdin before closing it (covers `--prompt-file -`). */
  input?: string;
  /** Spawn watchdog — SIGKILL after this many ms. Default 30s. */
  timeoutMs?: number;
  /** Called synchronously with the live child right after spawn — lets tests
   *  signal it mid-run (e.g. SIGTERM → exit 143). */
  onSpawn?: (child: ChildProcess) => void;
}

// CSI escape sequences (chalk emits SGR, the agent loop emits line-erases) —
// strip them so assertions match the text, not the styling.
const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI_BIN, ...options.args],
      {
        cwd: options.cwd,
        env: cleanEnv(options.env),
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        resolvePromise({
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          signal: typeof error?.signal === 'string' ? error.signal : null,
          stdout: stripAnsi(stdout ?? ''),
          stderr: stripAnsi(stderr ?? ''),
          timedOut: Boolean(error?.killed),
        });
      },
    );
    options.onSpawn?.(child);
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
    }
    child.stdin?.end();
  });
}

/** One-line debug dump for assertion failures. */
export function describeRun(result: CliRunResult): string {
  return (
    `code=${result.code} signal=${result.signal} timedOut=${result.timedOut}\n` +
    `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );
}

export interface WorkspaceOptions {
  baseUrl: string;
  /** model.stream in .sc-agent.json — default false (plain JSON replies). */
  stream?: boolean;
  /** Contents of prompt.md, written next to .sc-agent.json. */
  prompt?: string;
  /** Extra top-level keys merged into .sc-agent.json. */
  extraConfig?: Record<string, unknown>;
}

/**
 * Temp workspace: `.sc-agent.json` with the mock model settings plus a
 * `prompt.md` consumable via `--prompt-file prompt.md`. The `baseUrl` key is
 * still written — post-#469 it is ignored as a project-scope privileged key
 * (the stderr warning doubles as coverage); routing actually comes from the
 * SC_BASE_URL env the caller must pass (see `chatEnv` overrides).
 * The caller owns cleanup (`rm -rf` — see the cleanups pattern in the test files).
 */
export async function makeWorkspace(options: WorkspaceOptions): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-e2e-'));
  const config = {
    model: {
      provider: 'openai-compatible',
      baseUrl: options.baseUrl,
      model: 'e2e-mock',
      temperature: 0,
      maxTokens: 1024,
      stream: options.stream ?? false,
    },
    ...(options.extraConfig ?? {}),
  };
  await writeFile(join(dir, '.sc-agent.json'), JSON.stringify(config, null, 2));
  await writeFile(join(dir, 'prompt.md'), options.prompt ?? 'Say hello briefly.');
  return dir;
}

/** Subset of the run manifest fields asserted by this suite (#399). */
export interface RunManifestShape {
  v?: number;
  success?: boolean;
  exit_reason?: string;
  terminalResolution?: string;
  errorClass?: string;
  error?: string | null;
  tool_calls?: Record<string, number>;
  tool_calls_total?: number;
  iterations?: number;
  attempts?: Array<Record<string, unknown>>;
  final_message?: string | null;
  /** Terminal resolution from the detector (#446): completed | no_changes |
   *  not_actionable | blocked | budget_exceeded | error. */
  resolution?: string;
  resolution_reason?: string;
  files_changed?: number;
}

/**
 * The run manifest is always the last stdout line of a batch run (#399):
 * parse it. Throws a descriptive error when the contract is broken.
 */
export function lastManifest(stdout: string): RunManifestShape {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  try {
    return JSON.parse(last) as RunManifestShape;
  } catch {
    throw new Error(`last stdout line is not a JSON manifest: ${last.slice(0, 300)}\nfull stdout:\n${stdout.slice(0, 4000)}`);
  }
}
