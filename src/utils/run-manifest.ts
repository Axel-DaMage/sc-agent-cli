import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Message } from '../core/types.js';
import { ProviderFailoverError, type CandidateAttempt } from '../core/failover.js';
import { EXIT_CODES, classifyError } from './exit-codes.js';
import type { DevcontainerRunInfo } from '../core/devcontainer.js';
import type { SandboxRunInfo, SandboxViolation } from './sandbox.js';
import type { AgentRole, PhaseRecord, ReviewerVerdict } from '../core/roles.js';
import type { RoleTokenUsage } from './token-tracker.js';
import type { ResolutionResult } from './resolution-detector.js';
import type { ContextBudgetReport } from './context-budget.js';
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
  /**
   * #424 token breakdown — per-role usage plus run totals. `cached` is
   * included per role/total only when the provider reports cached prompt
   * tokens. Emitted whenever phases ran (or the tracker has role buckets).
   */
  tokens?: {
    byRole: Partial<Record<AgentRole, RoleTokenUsage>>;
    total: { in: number; out: number; cached?: number };
  };
  /**
   * #424 append-only phase segment log — each entry records the role,
   * serving provider/model, and completed LLM iterations. Retries and
   * mid-phase failover cascades append entries rather than overwriting.
   */
  phases?: PhaseRecord[];
  /** #424 roles that fell back to the run's default model (absent/invalid mapping). */
  role_fallback?: AgentRole[];
  /**
   * #462 reviewer/judge consensus outcome — present only when a reviewer
   * phase produced a verdict. `fix_rounds` counts executor rework passes
   * consumed by request_changes loops (bounded by `max_fixes` =
   * SC_ROLE_MAX_FIXES); `explicit` is false when the verdict was inferred
   * from prose instead of an explicit `VERDICT:` marker.
   */
  review?: {
    verdict: ReviewerVerdict;
    explicit: boolean;
    fix_rounds: number;
    max_fixes: number;
  };
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
  /** Human/machine reason for the terminal resolution (#446). */
  resolution_reason?: string;
  /** Files actually changed in the worktree: `git status --porcelain` diff plus
   *  HEAD-diff names from commits created during the run, excluding
   *  engine-owned artifacts. Tool-call records are only a fallback when the
   *  workspace is not a git repo (#464). */
  files_changed?: number;
  /** Resolved sandbox posture when sandbox.enabled (#423). */
  sandbox?: SandboxRunInfo;
  /** Structured sandbox violations {rule, target} observed during the run (#423). */
  sandbox_violations?: SandboxViolation[];
  /** Per-source context injection spend + SC_CONTEXT_BUDGET_TOKENS enforcement (#422). */
  context_budget?: ContextBudgetReport;
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
  /** #424 phase segments + role fallbacks + per-role token usage. */
  phases?: PhaseRecord[];
  roleFallbacks?: AgentRole[];
  roleTokens?: Partial<Record<AgentRole, RoleTokenUsage>>;
  cachedTokens?: number;
  /** #462 consensus outcome — terminal reviewer verdict + rework accounting. */
  review?: { verdict: ReviewerVerdict; explicit: boolean; fixRounds: number; maxFixes: number };
  /** Raw run error — used to derive terminalResolution/errorClass/attempts. */
  errorObj?: unknown;
  /** Detected terminal resolution (#446) — supersedes the exitReason mapping when present. */
  resolutionInfo?: ResolutionResult;
  /** Sandbox posture + violation list from the agent's SandboxRuntime (#423). */
  sandbox?: SandboxRunInfo;
  sandboxViolations?: SandboxViolation[];
  /** Context-spend accounting from the injection budget guard (#422). */
  contextBudget?: ContextBudgetReport | null;
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
    ...(((input.roleTokens && Object.keys(input.roleTokens).length > 0) || (input.phases?.length ?? 0) > 0) ? {
      tokens: {
        byRole: input.roleTokens ?? {},
        total: {
          in: input.inputTokens,
          out: input.outputTokens,
          ...(input.cachedTokens ? { cached: input.cachedTokens } : {}),
        },
      },
    } : {}),
    ...(input.phases?.length ? { phases: input.phases } : {}),
    ...(input.roleFallbacks?.length ? { role_fallback: input.roleFallbacks } : {}),
    ...(input.review
      ? {
          review: {
            verdict: input.review.verdict,
            explicit: input.review.explicit,
            fix_rounds: input.review.fixRounds,
            max_fixes: input.review.maxFixes,
          },
        }
      : {}),
    estimated_cost_usd: input.costUsd,
    duration_ms: input.durationMs,
    final_message: lastAssistant ? String(lastAssistant.content).slice(0, FINAL_MESSAGE_MAX) : null,
    checkpoint: input.checkpointPath,
    error: input.error ?? null,
    ...(input.devcontainer ? { devcontainer: input.devcontainer } : {}),
    provider: input.provider ?? null,
    resolution: input.resolutionInfo?.resolution ?? (input.exitReason === 'success' ? 'completed' : input.exitReason),
    ...(input.errorObj ? errorFields(input.errorObj) : {}),
    ...(input.resolutionInfo
      ? { resolution_reason: input.resolutionInfo.resolution_reason, files_changed: input.resolutionInfo.files_changed }
      : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    ...(input.sandboxViolations && input.sandboxViolations.length > 0
      ? { sandbox_violations: input.sandboxViolations }
      : {}),
    ...(input.contextBudget ? { context_budget: input.contextBudget } : {}),
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
