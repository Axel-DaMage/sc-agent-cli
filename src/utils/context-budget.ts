import { CHARS_PER_TOKEN, estimateTokens } from './token-tracker.js';
import { verbose } from './verbose-logger.js';

/**
 * Context-spend accounting + injection budget guard (#422).
 *
 * `SC_CONTEXT_BUDGET_TOKENS` caps the estimated size of the assembled
 * system-prompt injection — the base system prompt plus shell guide,
 * repo profile, project context, persistent memories, and the
 * non-interactive note. Token sizes use the shared chars/4 heuristic
 * from token-tracker (estimateTokens).
 *
 * When the assembly exceeds the cap, sources are trimmed
 * deterministically in ascending CONTEXT_SOURCE_PRIORITY order — the
 * lowest-priority source gives up tokens first, either by truncation
 * (head kept, marker appended) or by being dropped entirely when its
 * full size cannot cover the remaining overflow. The base `system`
 * prompt is trimmed last and is never fully dropped: in the degenerate
 * case it degrades to just the truncation marker so a `system` role
 * message is still sent.
 *
 * Truncation order (lowest priority → cut first):
 *   memory → repo_profile → project_context → shell → non_interactive → system
 */

export const CONTEXT_BUDGET_ENV_VAR = 'SC_CONTEXT_BUDGET_TOKENS';

/**
 * Truncation priority per injection source — lower numbers are trimmed
 * or dropped first when the budget is exceeded.
 */
export const CONTEXT_SOURCE_PRIORITY: Record<string, number> = {
  memory: 10,
  repo_profile: 20,
  project_context: 30,
  shell: 40,
  non_interactive: 50,
  // Sandbox boundary disclosure — policy-critical, trimmed last like system.
  sandbox: 90,
  system: 100,
};

/** Priority used for a source with no explicit entry in CONTEXT_SOURCE_PRIORITY. */
const DEFAULT_SOURCE_PRIORITY = 60;

/** The base system prompt is never dropped outright — only truncated. */
const NEVER_DROP_SOURCE = 'system';

export interface ContextSource {
  /** Injection source name (see CONTEXT_SOURCE_PRIORITY). */
  source: string;
  text: string;
}

export interface ContextSourceSpend {
  source: string;
  /** Estimated tokens before budget enforcement. */
  tokens_requested: number;
  /** Estimated tokens actually injected after enforcement. */
  tokens_injected: number;
  /** true when the source was trimmed or dropped to fit the budget. */
  truncated: boolean;
  /** true when the source was dropped entirely. */
  dropped: boolean;
}

/**
 * Per-source context spend for one run — emitted in the run manifest
 * `context_budget` block (#422). Besides the injection-assembly sources,
 * `sources` may carry a cumulative `tool_outputs` line (tool results
 * injected into the conversation during the run): it is not subject to
 * this cap — oversized results are trimmed by the >10KB auto-compressor
 * — but its spend is accounted the same way (truncated = compression
 * fired at least once).
 */
export interface ContextBudgetReport {
  /** Configured cap (SC_CONTEXT_BUDGET_TOKENS); null = uncapped. */
  budget_tokens: number | null;
  /** Total est. tokens requested for injection (assembly + tool outputs). */
  requested_tokens: number;
  /** Total est. tokens actually injected (after enforcement/compression). */
  injected_tokens: number;
  /** true when the cap forced a trim/drop on the system-prompt assembly. */
  over_budget: boolean;
  /** Per-source spend: assembly order, then cumulative tool_outputs. */
  sources: ContextSourceSpend[];
}

/**
 * Resolve the injection budget from the environment. Unset, empty,
 * non-numeric, or non-positive values mean "no cap" (invalid values are
 * logged via verbose, never silently ignored).
 */
export function resolveContextBudget(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[CONTEXT_BUDGET_ENV_VAR];
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    verbose(`${CONTEXT_BUDGET_ENV_VAR}="${raw}" ignored — expected a positive integer (estimated tokens)`);
    return null;
  }
  return parsed;
}

/**
 * Enforce the injection budget over a list of named context sources.
 * Returns the texts to inject (dropped sources removed) plus the
 * per-source spend report. With a null budget — or when the assembly
 * already fits — all texts pass through untouched.
 */
export function applyContextBudget(
  sources: ContextSource[],
  budgetTokens: number | null,
): { texts: string[]; report: ContextBudgetReport } {
  const spends: ContextSourceSpend[] = sources.map((s) => {
    const requested = estimateTokens(s.text);
    return {
      source: s.source,
      tokens_requested: requested,
      tokens_injected: requested,
      truncated: false,
      dropped: false,
    };
  });
  const requestedTotal = spends.reduce((n, s) => n + s.tokens_requested, 0);
  const report: ContextBudgetReport = {
    budget_tokens: budgetTokens,
    requested_tokens: requestedTotal,
    injected_tokens: requestedTotal,
    over_budget: false,
    sources: spends,
  };

  if (budgetTokens === null || requestedTotal <= budgetTokens) {
    return { texts: sources.map((s) => s.text), report };
  }

  report.over_budget = true;
  const texts = sources.map((s) => s.text);
  let overflow = requestedTotal - budgetTokens;

  // Lowest priority trimmed first; ties keep assembly order (stable).
  const trimOrder = sources
    .map((s, i) => ({ i, priority: CONTEXT_SOURCE_PRIORITY[s.source] ?? DEFAULT_SOURCE_PRIORITY }))
    .sort((a, b) => a.priority - b.priority || a.i - b.i);

  for (const { i } of trimOrder) {
    if (overflow <= 0) break;
    const spend = spends[i];

    if (spend.tokens_requested <= overflow && spend.source !== NEVER_DROP_SOURCE) {
      // The whole source fits inside the overflow — drop it entirely.
      texts[i] = '';
      spend.dropped = true;
      spend.truncated = true;
      spend.tokens_injected = 0;
      overflow -= spend.tokens_requested;
      continue;
    }

    // Partial trim: keep the head so section headers survive, then append
    // a visible marker so the model (and the transcript) can see the cut.
    const allowance = Math.max(0, spend.tokens_requested - overflow);
    const marker =
      `\n\n[... context source "${spend.source}" trimmed to ~${allowance} est. tokens ` +
      `(${CONTEXT_BUDGET_ENV_VAR}=${budgetTokens}) ...]`;
    const keepChars = Math.max(0, allowance * CHARS_PER_TOKEN - marker.length);
    const trimmed = texts[i].slice(0, keepChars) + marker;
    texts[i] = trimmed;
    spend.truncated = true;
    spend.tokens_injected = estimateTokens(trimmed);
    overflow -= spend.tokens_requested - spend.tokens_injected;
  }

  report.injected_tokens = spends.reduce((n, s) => n + s.tokens_injected, 0);
  return { texts: texts.filter((t) => t.length > 0), report };
}

/**
 * Compact one-line summary of the trimmed/dropped sources — used for
 * the user-visible warning and the audit event.
 */
export function formatContextBudgetTrims(report: ContextBudgetReport): string {
  return report.sources
    .filter((s) => s.truncated)
    .map((s) => (s.dropped ? `${s.source}(dropped)` : `${s.source} ${s.tokens_requested}→${s.tokens_injected}t`))
    .join(', ');
}
