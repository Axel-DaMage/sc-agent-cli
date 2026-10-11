// Multi-model orchestration (#424) — planner/executor/reviewer role routing.
//
// Different phases of a headless run have different intelligence needs:
// planning wants the strongest model, mechanical edits can run on cheap/fast
// models, and review benefits from a different provider entirely
// (adversarial diversity). `config.roles` maps each role to a
// "provider/model" token resolved with the SC_FAILOVER alias semantics
// (profile name → known provider → model id on the configured endpoint).
//
// Absent or invalid role mappings are never fatal: the phase falls back to
// the run's default model and is reported as `role_fallback` in the run
// manifest. The manifest's `phases` array is an append-only segment log —
// phase retries and mid-phase provider cascades append entries rather than
// overwriting them — and `tokens.byRole` breaks usage down per role.
//
// #462 reviewer/judge consensus: the reviewer phase ends with a `VERDICT:`
// marker (approve | request_changes). On request_changes the reviewer
// comments loop back to the executor for a rework round, then the reviewer
// re-reviews — bounded by SC_ROLE_MAX_FIXES (default 3). When the reviewer
// resolves to the same provider+model as the executor the run warns once —
// a model grading its own work; diversity is recommended, not enforced.

import type { AgentRole, Message, ProjectConfig } from './types.js';
import { primaryCandidate, resolveModelToken } from './failover.js';
import type { FailoverCandidate } from './failover.js';
import { verbose } from '../utils/verbose-logger.js';

export type { AgentRole } from './types.js';

/** Canonical phase order for a fully orchestrated headless run. */
export const AGENT_ROLES: readonly AgentRole[] = ['planner', 'executor', 'reviewer'];

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value);
}

/** Outcome of resolving one role's configured mapping. */
export interface RoleResolution {
  role: AgentRole;
  /** The configured "provider/model" token, or null when the role is absent. */
  configured: string | null;
  /**
   * Candidate that will serve the phase: the resolved role model, or the
   * run's default model when the mapping is absent/invalid.
   */
  candidate: FailoverCandidate;
  /** true when the run's default model serves the phase (manifest `role_fallback`). */
  fallback: boolean;
}

/**
 * Resolve one role to its failover candidate. The token format is the
 * SC_FAILOVER "provider/model" alias. Absent, empty, or unresolvable
 * mappings fall back to `primaryCandidate(config.model)` — never throws.
 */
export function resolveRole(config: ProjectConfig, role: AgentRole): RoleResolution {
  const raw = config.roles?.[role];
  const token = typeof raw === 'string' ? raw.trim() : '';
  const candidate = token ? resolveModelToken(config, token) : null;
  if (candidate) {
    return { role, configured: token, candidate, fallback: false };
  }
  if (token) {
    verbose(`[roles] role "${role}" mapping "${token}" is invalid — falling back to the default model`);
  }
  return { role, configured: token || null, candidate: primaryCandidate(config.model), fallback: true };
}

/**
 * Ordered phase plan for a headless run. With `only`, the run is pinned to a
 * single role (`--role`/`SC_ROLE`); otherwise the full
 * planner → executor → reviewer pipeline is resolved. Every entry resolves
 * to a candidate — absent/invalid mappings are fallbacks, not errors.
 */
export function resolveRolePipeline(config: ProjectConfig, only?: AgentRole): RoleResolution[] {
  for (const key of Object.keys(config.roles ?? {})) {
    if (!isAgentRole(key)) {
      verbose(`[roles] ignoring unknown role "${key}" in config.roles (valid: ${AGENT_ROLES.join(', ')})`);
    }
  }
  const roles: readonly AgentRole[] = only ? [only] : AGENT_ROLES;
  return roles.map(role => resolveRole(config, role));
}

/** Per-phase execution policy applied inside the agent loop. */
export interface PhasePolicy {
  /**
   * Deny mutating tool calls (write_file/edit_file/memory_write are dropped
   * from the schema; git/run_shell/etc. calls classified as mutating are
   * rejected at dispatch). Planning and review inspect — they never write.
   */
  readOnly: boolean;
  /**
   * Suppress completion guards (self-heal re-prompts, zero-mutation guard,
   * prose-livelock abort). Planner/reviewer phases legitimately end with a
   * prose artifact — forcing tool calls would corrupt the pipeline.
   */
  suppressCompletionGuards: boolean;
}

export function phasePolicy(role: AgentRole): PhasePolicy {
  return role === 'executor'
    ? { readOnly: false, suppressCompletionGuards: false }
    : { readOnly: true, suppressCompletionGuards: true };
}

/** Tools dropped from the schema entirely during read-only phases. */
export const READ_ONLY_PHASE_DENIED_TOOLS = new Set(['write_file', 'edit_file', 'memory_write']);

/** The phase-specific instruction prepended around the user task. */
export function buildPhasePrompt(role: AgentRole, task: string): string {
  switch (role) {
    case 'planner':
      return (
        `[PHASE — PLANNER]\n` +
        `You are the planning phase of a multi-model agent pipeline (planner → executor → reviewer).\n` +
        `Analyze the task below and produce a concrete, step-by-step execution plan.\n` +
        `- You may inspect the workspace with read-only tools (read_file, list_dir, search_text, git status/diff/log, web_fetch).\n` +
        `- You MUST NOT modify files, run mutating commands, or commit anything — mutating tools are disabled in this phase.\n` +
        `- Output ONLY the plan: numbered steps with exact file paths, key implementation decisions, and how to verify the result.\n\n` +
        `TASK:\n${task}`
      );
    case 'executor':
      return (
        `[PHASE — EXECUTOR]\n` +
        `You are the execution phase of a multi-model agent pipeline. A plan may have been produced earlier in this conversation — follow it when present.\n` +
        `Implement the task below NOW using the tools (write_file / edit_file / run_shell / git). Do not stop at describing the changes — apply them.\n\n` +
        `TASK:\n${task}`
      );
    case 'reviewer':
      return (
        `[PHASE — REVIEWER]\n` +
        `You are the review phase of a multi-model agent pipeline. Review the work performed so far against the task below.\n` +
        `- Inspect the actual workspace state with read-only tools (read_file, git diff/status, run tests or type-checks via run_shell).\n` +
        `- You MUST NOT modify files — mutating tools are disabled in this phase.\n` +
        `- List concrete defects first, then end your review with EXACTLY ONE verdict line:\n` +
        `    VERDICT: approve           — the work is complete and correct\n` +
        `    VERDICT: request_changes   — defects remain; your findings loop back to the executor for a bounded rework round, then you re-review\n\n` +
        `TASK:\n${task}`
      );
  }
}

/**
 * One manifest `phases` entry — a contiguous run segment served under one
 * role by one provider/model.
 */
export interface PhaseRecord {
  role: AgentRole;
  /** Provider tag that served the segment ("openai", "ollama", "custom", …). */
  provider: string;
  /** Model id that served the segment. */
  model: string;
  /** Completed LLM iterations attributed to this segment. */
  iterations: number;
}

function splitCandidateLabel(id: string): { provider: string; model: string } {
  const slash = id.indexOf('/');
  return slash > 0
    ? { provider: id.slice(0, slash), model: id.slice(slash + 1) }
    : { provider: 'custom', model: id };
}

/**
 * Append-only phase log backing the manifest's `phases` array. Opening a
 * phase appends an entry; when the provider cascade moves mid-phase the
 * segment splits into a new entry for the same role — retries and cascades
 * append rather than overwrite (#424).
 */
export class PhaseTracker {
  private records: Array<PhaseRecord & { label: string }> = [];
  private openIdx = -1;

  begin(role: AgentRole, candidate: FailoverCandidate): void {
    const { provider, model } = splitCandidateLabel(candidate.id);
    this.records.push({ role, provider, model, iterations: 0, label: candidate.id });
    this.openIdx = this.records.length - 1;
  }

  /**
   * Account one served LLM call to the open segment. `candidateId` is the
   * "provider/model" label of the failover candidate that actually served —
   * when it differs from the open segment, the cascade moved and a new
   * segment for the same role is appended.
   */
  noteServed(candidateId: string | null): void {
    const open = this.openIdx >= 0 ? this.records[this.openIdx] : undefined;
    if (!open) return;
    if (candidateId && candidateId !== open.label) {
      const { provider, model } = splitCandidateLabel(candidateId);
      this.records.push({ role: open.role, provider, model, iterations: 0, label: candidateId });
      this.openIdx = this.records.length - 1;
    }
    this.records[this.openIdx].iterations++;
  }

  end(): void {
    this.openIdx = -1;
  }

  /** Manifest-safe records (internal candidate label stripped). */
  getPhases(): PhaseRecord[] {
    return this.records.map(({ role, provider, model, iterations }) => ({ role, provider, model, iterations }));
  }
}

// ---------------------------------------------------------------------------
// #462 — reviewer/judge verdicts + bounded executor rework (consensus loop)
// ---------------------------------------------------------------------------

/** Reviewer verdicts: approve ends the pipeline; request_changes loops the
 *  reviewer comments back to the executor for a bounded rework round. */
export type ReviewerVerdict = 'approve' | 'request_changes';

export interface ReviewerDecision {
  verdict: ReviewerVerdict;
  /** The reviewer output fed back to the executor on request_changes. */
  comments: string;
  /** true when the verdict came from an explicit `VERDICT:` marker line. */
  explicit: boolean;
}

export const ROLE_MAX_FIXES_ENV = 'SC_ROLE_MAX_FIXES';
export const DEFAULT_ROLE_MAX_FIXES = 3;

/**
 * Executor rework bound for the reviewer consensus loop. Env override
 * follows the SC_ZERO_MUTATION_REPROMPTS convention: absent/invalid →
 * default 3, 0 disables rework (the review still runs once and its verdict
 * is recorded).
 */
export function resolveMaxRoleFixes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env[ROLE_MAX_FIXES_ENV] ?? '', 10);
  return Number.isNaN(raw) ? DEFAULT_ROLE_MAX_FIXES : Math.max(0, raw);
}

// Verdict marker contract (taught to the reviewer via buildPhasePrompt):
// `VERDICT: approve` or `VERDICT: request_changes`. The LAST classifiable
// marker wins — reviewers may restate a verdict after summarizing. Leading
// markdown decoration (`**`, `_`, backticks) is tolerated.
const VERDICT_REQUEST_VALUE_RE = /^[*_`\s]*(requests?[\s_-]*changes?|changes?[\s_-]*(requested|required|needed)|rework|reject(?:ed)?|needs?[\s_-]*(?:work|changes?|fix\w*|rework))\b/i;
const VERDICT_APPROVE_VALUE_RE = /^[*_`\s]*(approve[ds]?|accepted?|lgtm|pass(?:ed)?|ship[\s_-]*it)\b/i;

// Prose fallbacks for reviewers that ignore the marker contract. Scanned
// bottom-up — conclusions live at the end of a review.
const REQUEST_CHANGES_LINE_RE = /\brequest(?:ing|ed|s)?[\s_-]+changes\b|\bchanges?\s+(?:is|are|were|remain)\s+(?:requested|required|needed)\b|\bneeds?\s+(?:rework|changes?|fixes?)\b|\bmust\s+be\s+(?:fixed|corrected|changed|reworked)\b|\bblock(?:ing|er)\s+(?:issues?|defects?|problems?|bugs?)\b|\b(?:can(?:not|'t)|do(?:es)?\s+not|don't|won't|should\s+not|shouldn't)\s+(?:be\s+)?(?:able\s+to\s+)?approve[ds]?\b|\brejected?\b/i;
const APPROVE_LINE_RE = /\bapproved?\b|\blgtm\b|\blooks?\s+good\b|\bno\s+(?:remaining|outstanding|further|blocking)\s+(?:issues?|defects?|blockers?|concerns?|problems?)\b|\bcomplete\s+and\s+correct\b|\bready\s+to\s+(?:merge|ship)\b|\bship\s*it\b/i;

/**
 * Parse reviewer output into a verdict. Explicit `VERDICT:` markers win
 * (last classifiable marker). Without a marker, lines are scanned
 * bottom-up for request-changes/approve signals — on a same-line tie the
 * defect signal wins, since rework is bounded while an unwarranted
 * approval is not recoverable. Fully unparseable output defaults to
 * `approve` with `explicit: false`: rework is never forced without
 * affirmative defect evidence.
 */
export function parseReviewerVerdict(text: string | null | undefined): ReviewerDecision {
  const comments = (text ?? '').trim();
  let verdict: ReviewerVerdict | null = null;
  for (const m of comments.matchAll(/\bverdict\s*[:=]\s*([^\n]+)/gi)) {
    const value = m[1];
    if (VERDICT_REQUEST_VALUE_RE.test(value)) verdict = 'request_changes';
    else if (VERDICT_APPROVE_VALUE_RE.test(value)) verdict = 'approve';
  }
  if (verdict) return { verdict, comments, explicit: true };
  const lines = comments.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (REQUEST_CHANGES_LINE_RE.test(line)) return { verdict: 'request_changes', comments, explicit: false };
    if (APPROVE_LINE_RE.test(line)) return { verdict: 'approve', comments, explicit: false };
  }
  return { verdict: 'approve', comments, explicit: false };
}

/**
 * Provider diversity check (#462): a reviewer served by the same
 * provider+model as the executor grades its own work. Compares the
 * resolved endpoint + model — the actual serving identity — so a known
 * provider alias and a profile pointing at the same host still collide.
 * Used to warn once; diversity is recommended, not enforced.
 */
export function reviewerSharesExecutorCandidate(executor: RoleResolution, reviewer: RoleResolution): boolean {
  const normalizeUrl = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  const e = executor.candidate.model;
  const r = reviewer.candidate.model;
  return normalizeUrl(e.baseUrl) === normalizeUrl(r.baseUrl) && e.model === r.model;
}

/**
 * Executor rework prompt (#462): a request_changes verdict sends the
 * reviewer comments back to the executor for a bounded fix round.
 */
export function buildReworkPrompt(task: string, reviewComments: string, round: number, maxRounds: number): string {
  return (
    `[PHASE — EXECUTOR · REWORK ${round}/${maxRounds}]\n` +
    `The reviewer phase rejected the implementation (verdict: request_changes).\n` +
    `Address EVERY reviewer finding below, then re-verify the result before finishing.\n\n` +
    `REVIEWER FEEDBACK:\n${reviewComments || '(no reviewer comments)'}\n\n` +
    `ORIGINAL TASK:\n${task}`
  );
}

function lastAssistantText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
}

/**
 * Minimal agent surface the pipeline driver needs — `Agent` satisfies it
 * structurally; tests substitute a scripted stub. The `phase` argument
 * mirrors `AgentRunPhaseOptions` (declared inline to keep roles.ts free of
 * an agent.ts import cycle).
 */
export interface PhaseAgent {
  run(
    userMessage: string,
    history?: Message[],
    signal?: AbortSignal,
    phase?: { routing?: RoleResolution; readOnly?: boolean; suppressCompletionGuards?: boolean },
  ): Promise<Message[]>;
  getStats(): { budgetExceeded: string | null };
}

export interface RolePipelineHooks {
  /** Human progress lines (phase banners, verdicts). Caller gates quiet/json. */
  log?: (line: string) => void;
  /** One-time warnings (e.g. reviewer/executor same provider) — stderr-safe. */
  warn?: (line: string) => void;
}

export interface RolePipelineResult {
  history: Message[];
  /**
   * Terminal reviewer decision — set whenever a reviewer phase produced
   * output (including a pinned `--role reviewer` run; null when the
   * reviewer never completed, e.g. a budget hit mid-phase).
   */
  decision: ReviewerDecision | null;
  /** Executor rework rounds consumed by request_changes loops. */
  fixRounds: number;
  /** The SC_ROLE_MAX_FIXES bound in effect. */
  maxFixes: number;
}

/**
 * Drive a resolved role pipeline (#424 + #462). Phases run in canonical
 * order. When the pipeline contains an executor followed by a reviewer
 * (the full pipeline — a `--role`/`SC_ROLE` pin is single-phase and never
 * loops), a reviewer `request_changes` verdict loops back to the executor
 * with the review comments, then re-reviews — bounded by
 * SC_ROLE_MAX_FIXES (default 3). A same provider+model reviewer emits a
 * one-time diversity warning. A budget hit ends the run: later phases and
 * rework rounds never start.
 */
export async function runRolePipeline(
  agent: PhaseAgent,
  pipeline: RoleResolution[],
  task: string,
  history: Message[] = [],
  opts: { maxFixes?: number } & RolePipelineHooks = {},
): Promise<RolePipelineResult> {
  const maxFixes = opts.maxFixes ?? resolveMaxRoleFixes();
  const executor = pipeline.find(r => r.role === 'executor');
  const reviewer = pipeline.find(r => r.role === 'reviewer');
  const consensus = !!executor && !!reviewer && pipeline.indexOf(reviewer) > pipeline.indexOf(executor);

  if (consensus && reviewerSharesExecutorCandidate(executor!, reviewer!)) {
    const msg =
      `role "reviewer" resolves to the same provider+model as "executor" (${reviewer!.candidate.id}) — ` +
      `a model grading its own work. Route the reviewer to a different provider for adversarial diversity (recommended, not enforced).`;
    verbose(`[roles] ${msg}`);
    opts.warn?.(msg);
  }

  let decision: ReviewerDecision | null = null;
  let fixRounds = 0;

  const runPhase = async (res: RoleResolution, prompt: string): Promise<void> => {
    const policy = phasePolicy(res.role);
    verbose(`[roles] phase ${res.role} → ${res.candidate.id}${res.fallback ? ' (default-model fallback)' : ''}`);
    opts.log?.(`  │ 🎭 Phase ${res.role} → ${res.candidate.id}${res.fallback ? ' (fallback)' : ''}`);
    history = await agent.run(prompt, history, undefined, {
      routing: res,
      readOnly: policy.readOnly,
      suppressCompletionGuards: policy.suppressCompletionGuards,
    });
  };

  // Run the reviewer phase and parse its verdict from the last assistant
  // message. Returns null when a budget hit ends the phase early — stale
  // history must not be parsed as a verdict.
  const runReview = async (res: RoleResolution, reviewTask: string): Promise<ReviewerDecision | null> => {
    await runPhase(res, buildPhasePrompt('reviewer', reviewTask));
    if (agent.getStats().budgetExceeded) return null;
    const d = parseReviewerVerdict(lastAssistantText(history));
    verbose(`[roles] reviewer verdict: ${d.verdict}${d.explicit ? '' : ' (inferred — no VERDICT: marker)'}`);
    opts.log?.(`  │ ⚖️  Reviewer verdict: ${d.verdict}`);
    return d;
  };

  for (const res of pipeline) {
    if (res === reviewer && consensus) {
      // Consensus loop: review → request_changes → executor rework → re-review.
      for (;;) {
        const reviewTask = fixRounds === 0
          ? task
          : `${task}\n\n[RE-REVIEW ${fixRounds}/${maxFixes}] The executor applied rework addressing your previous feedback — re-verify the current workspace state, then issue a fresh verdict.`;
        const d = await runReview(res, reviewTask);
        if (!d) break;
        decision = d;
        if (d.verdict === 'approve') break;
        if (fixRounds >= maxFixes) {
          verbose(`[roles] rework bound reached (${ROLE_MAX_FIXES_ENV}=${maxFixes}) — unresolved reviewer findings remain`);
          opts.log?.(`  │ ⚖️  Rework bound reached (${ROLE_MAX_FIXES_ENV}=${maxFixes}) — unresolved reviewer findings remain`);
          break;
        }
        fixRounds++;
        await runPhase(executor!, buildReworkPrompt(task, d.comments, fixRounds, maxFixes));
        if (agent.getStats().budgetExceeded) break;
      }
    } else if (res.role === 'reviewer') {
      // Standalone/pinned review — the verdict is still parsed for the
      // manifest `review` block; no rework follows a single-phase run.
      const d = await runReview(res, task);
      if (d) decision = d;
    } else {
      await runPhase(res, buildPhasePrompt(res.role, task));
    }
    // A budget hit ends the whole run — later phases must not start.
    if (agent.getStats().budgetExceeded) break;
  }

  return { history, decision, fixRounds, maxFixes };
}
