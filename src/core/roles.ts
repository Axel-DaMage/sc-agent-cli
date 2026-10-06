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

import type { AgentRole, ProjectConfig } from './types.js';
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
        `- Verdict required: state clearly whether the work is complete and correct, or list the concrete defects that remain.\n\n` +
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
