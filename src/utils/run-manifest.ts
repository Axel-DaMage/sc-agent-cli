import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Message } from '../core/types.js';
import { ProviderFailoverError, type CandidateAttempt } from '../core/failover.js';
import { EXIT_CODES, classifyError } from './exit-codes.js';
import type { DevcontainerRunInfo } from '../core/devcontainer.js';
import { verboseError } from './verbose-logger.js';

/**
 * Terminal reason for a non-interactive (batch) run. Part of the
 * machine-readable contract consumed by CI wrappers (#399) — values are
 * stable across releases.
 */
export type RunExitReason =
  | 'success'
  | 'error'
  | 'no_changes'
  | 'budget_exceeded'
  | 'interrupted';

/**
 * Machine-readable run manifest (#399). Emitted as the last stdout line of
 * every batch run — and the only stdout line under `--output-format json`,
 * where the human transcript and status markers go to stderr.
 */
// Maps the exit-code taxonomy (#409) to terminalResolution values (#425).
const TERMINAL_RESOLUTIONS: Record<number, string> = {
  [EXIT_CODES.PROVIDER_ERROR]: 'provider_error',
  [EXIT_CODES.PROVIDER_EXHAUSTED]: 'provider_error',
  [EXIT_CODES.AUTH_ERROR]: 'auth_error',
  [EXIT_CODES.LOOP_ABORT]: 'loop_abort',
};

export interface RunManifest {
  /** Manifest schema version. */
  v: 1;
  /** sc-agent-cli package version that produced the run. */
  version: string;
  /** true only when exit_reason === 'success'. */
  success: boolean;
  /** Model that served the run. */
  model: string;
  /** Session id — usable with `sc chat --resume <session_id>`. */
  session_id: string;
  exit_reason: RunExitReason;
  iterations: number;
  /** Per-tool invocation counts keyed by tool name. */
  tool_calls: Record<string, number>;
  tool_calls_total: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  duration_ms: number;
  /** Last non-empty assistant message (truncated) or null. */
  final_message: string | null;
  /** Path to the resumable checkpoint file when one exists. */
  checkpoint: string | null;
  /** Error description on failure exits, null otherwise. */
  error: string | null;
  /** Devcontainer exec path + in-container marker when `--devcontainer` was requested (#421). */
  devcontainer?: DevcontainerRunInfo;
  /** "provider/model" failover candidate that served the run (#425). */
  provider: string | null;
  /** Terminal resolution for machine consumers: 'completed' on success, else the exit reason. */
  resolution: string;
  /** Error classification on failure exits (provider_error|auth_error|loop_abort|error). */
  terminalResolution?: string;
  /** ProviderErrorClass + per-candidate attempt trace when the failover chain exhausted. */
  errorClass?: string;
  attempts?: CandidateAttempt[];
}

const FINAL_MESSAGE_MAX = 4000;

export interface RunManifestInput {
  exitReason: RunExitReason;
  error?: string;
  version: string;
  model: string;
  sessionId: string;
  history: Message[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: Record<string, number>;
  toolRunCount: number;
  iterations: number;
  durationMs: number;
  checkpointPath: string | null;
  devcontainer?: DevcontainerRunInfo;
  provider?: string | null;
  /** Raw run error — used to derive terminalResolution/errorClass/attempts. */
  errorObj?: unknown;
}

export function buildRunManifest(input: RunManifestInput): RunManifest {
  const lastAssistant = [...input.history].reverse().find(
    m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0
  );
  return {
    v: 1,
    version: input.version,
    success: input.exitReason === 'success',
    model: input.model,
    session_id: input.sessionId,
    exit_reason: input.exitReason,
    iterations: input.iterations,
    tool_calls: input.toolCalls,
    tool_calls_total: input.toolRunCount,
    tokens_in: input.inputTokens,
    tokens_out: input.outputTokens,
    estimated_cost_usd: input.costUsd,
    duration_ms: input.durationMs,
    final_message: lastAssistant ? String(lastAssistant.content).slice(0, FINAL_MESSAGE_MAX) : null,
    checkpoint: input.checkpointPath,
    error: input.error ?? null,
    ...(input.devcontainer ? { devcontainer: input.devcontainer } : {}),
    provider: input.provider ?? null,
    resolution: input.exitReason === 'success' ? 'completed' : input.exitReason,
    ...(input.errorObj ? errorFields(input.errorObj) : {}),
  };
}

function errorFields(err: unknown): Pick<RunManifest, 'terminalResolution' | 'errorClass' | 'attempts'> {
  if (err instanceof ProviderFailoverError) {
    return { terminalResolution: 'provider_error', errorClass: err.errorClass, attempts: err.attempts };
  }
  return { terminalResolution: TERMINAL_RESOLUTIONS[classifyError(err)] ?? 'error' };
}

/**
 * Persist the manifest to the requested file(s) — best-effort, failures are
 * reported via verboseError only — and write it as a single JSON line on
 * stdout. When `onStdoutFlushed` is provided it is passed as the write
 * callback, used by signal handlers that must flush stdout before exiting.
 */
export function emitRunManifest(
  manifest: RunManifest,
  options: { files?: Array<string | undefined>; onStdoutFlushed?: () => void } = {},
): void {
  for (const outPath of options.files ?? []) {
    if (!outPath) continue;
    try {
      writeFileSync(resolve(outPath), JSON.stringify(manifest, null, 2));
    } catch (e) {
      verboseError(`manifest write failed (${outPath}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const line = JSON.stringify(manifest) + '\n';
  if (options.onStdoutFlushed) {
    process.stdout.write(line, options.onStdoutFlushed);
  } else {
    process.stdout.write(line);
  }
}
