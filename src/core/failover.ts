// Provider failover contract (#425) — bounded retry + ordered candidate cascade.
//
// Autonomous pipelines must not stall on a rate-limit or provider outage:
//
//   * Every request attempt is bounded by TWO timeouts — a connect timeout
//     (time until response headers, env SC_PROVIDER_CONNECT_TIMEOUT_MS,
//     default 30s) and a total-attempt timeout (headers + body, env
//     SC_PROVIDER_ATTEMPT_TIMEOUT_MS, default 120s). Expiry counts as a
//     retryable transport failure for that candidate.
//   * Transient failures retry with bounded backoff: max 3 retries after the
//     initial attempt (4 total per candidate), backoff 2s → 4s → 8s +20%
//     jitter, capped at 8s.
//   * Persistent or non-retryable failures cascade through an ordered list of
//     provider/model candidates: the configured model first, then each entry
//     of SC_FAILOVER (ordered csv of "provider/model" tokens) in declared
//     order. Empty SC_FAILOVER = single configured model, no cascade.
//   * When every candidate is exhausted the call fails with
//     ProviderFailoverError, which carries the per-candidate attempts array
//     (for the run manifest) and maps to EXIT_CODES.PROVIDER_EXHAUSTED (24).

import type { ModelConfig, ProjectConfig } from './types.js';
import { EXIT_CODES } from '../utils/exit-codes.js';

export const FAILOVER_ENV = 'SC_FAILOVER';
export const CONNECT_TIMEOUT_ENV = 'SC_PROVIDER_CONNECT_TIMEOUT_MS';
export const ATTEMPT_TIMEOUT_ENV = 'SC_PROVIDER_ATTEMPT_TIMEOUT_MS';

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;

// 1 initial attempt + 3 retries per candidate.
export const MAX_ATTEMPTS_PER_CANDIDATE = 4;

const RETRY_BASE_MS = 2_000;
const RETRY_FACTOR = 2;
const RETRY_MAX_DELAY_MS = 8_000;
const RETRY_JITTER_RATIO = 0.2;

// HTTP statuses classified as transient per the failover contract.
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

export type ProviderErrorClass =
  | 'timeout'       // connect/attempt deadline expired — retryable transport
  | 'transport'     // ECONNRESET/ETIMEDOUT/socket-level failure — retryable
  | 'rate_limit'    // HTTP 429 — retryable
  | 'server_error'  // HTTP 5xx — retryable for 500/502/503/504
  | 'auth'          // HTTP 401/403 — non-retryable, cascade
  | 'client'        // other HTTP 4xx (incl. unsupported model) — non-retryable
  | 'aborted'       // caller-cancelled — never retried, never cascaded
  | 'unknown';

export interface ProviderErrorInfo {
  errorClass: ProviderErrorClass;
  retryable: boolean;
  status?: number;
  message: string;
}

/** One failed HTTP attempt against a candidate — logged for the run manifest. */
export interface CandidateAttempt {
  candidate: string;         // "provider/model" label
  attempt: number;           // 1-based attempt index within that candidate
  errorClass: ProviderErrorClass;
  retryable: boolean;
  status?: number;           // HTTP status when the failure came from a response
  error: string;             // sanitized error message
  durationMs: number;
}

/** An ordered provider/model pair the cascade traverses. */
export interface FailoverCandidate {
  id: string;                // "provider/model" label used in logs + manifest
  model: ModelConfig;
}

/** HTTP-level failure carrying the response status for classification. */
export class ProviderHttpError extends Error {
  constructor(public readonly status: number, bodyText: string) {
    super(`API Error ${status}: ${bodyText.slice(0, 2000)}`);
    this.name = 'ProviderHttpError';
  }
}

/** Timeout expiry — 'connect' = no headers in time, 'attempt' = total deadline. */
export class ProviderTimeoutError extends Error {
  constructor(public readonly phase: 'connect' | 'attempt', public readonly timeoutMs: number) {
    super(phase === 'connect'
      ? `Provider connect timeout after ${timeoutMs}ms`
      : `Provider attempt timed out after ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

/**
 * Terminal failure: every candidate in the chain was exhausted (retry bound
 * reached or non-retryable error). Carries the structured attempts array for
 * the run manifest and declares its own exit code (24, provider fatal).
 */
export class ProviderFailoverError extends Error {
  readonly exitCode = EXIT_CODES.PROVIDER_EXHAUSTED;

  constructor(
    public readonly attempts: CandidateAttempt[],
    public readonly errorClass: ProviderErrorClass,
  ) {
    const last = attempts[attempts.length - 1];
    const candidates = new Set(attempts.map(a => a.candidate)).size;
    super(
      `All provider candidates exhausted (${candidates} candidate(s), ${attempts.length} attempt(s)). ` +
      `Last error [${last?.candidate ?? 'n/a'}]: ${last?.error ?? 'unknown'}`
    );
    this.name = 'ProviderFailoverError';
  }
}

/**
 * Classify a provider failure per the failover contract.
 * Retryable: timeouts, transport errors, 429, 500/502/503/504.
 * Non-retryable: 400/401/403 and other 4xx (incl. unsupported model) — these
 * advance the cascade to the next candidate immediately.
 */
export function classifyProviderError(err: unknown): ProviderErrorInfo {
  if (err instanceof ProviderHttpError) {
    const { status } = err;
    if (status === 429) {
      return { errorClass: 'rate_limit', retryable: true, status, message: err.message };
    }
    if (status === 401 || status === 403) {
      return { errorClass: 'auth', retryable: false, status, message: err.message };
    }
    if (status >= 500) {
      return { errorClass: 'server_error', retryable: TRANSIENT_HTTP_STATUSES.has(status), status, message: err.message };
    }
    return { errorClass: 'client', retryable: false, status, message: err.message };
  }

  if (err instanceof ProviderTimeoutError) {
    return { errorClass: 'timeout', retryable: true, message: err.message };
  }

  const message = err instanceof Error ? err.message : String(err);
  const errno = extractErrno(err);

  if (errno === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(message)) {
    return { errorClass: 'timeout', retryable: true, message };
  }
  if (errno || isTransportMessage(message)) {
    return { errorClass: 'transport', retryable: true, message };
  }
  if (/abort/i.test(message)) {
    return { errorClass: 'aborted', retryable: false, message };
  }
  return { errorClass: 'unknown', retryable: false, message };
}

function extractErrno(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const own = (err as { code?: unknown }).code;
  if (typeof own === 'string') return own;
  const cause = (err as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

function isTransportMessage(msg: string): boolean {
  return /fetch failed|econnreset|econnrefused|econnaborted|enotfound|ehostunreach|enetunreach|eai_again|epipe|socket hang|terminated|other side closed|headers timeout|body timeout|network|und_err/i.test(msg);
}

/**
 * Bounded exponential backoff between retries of the same candidate:
 * 2s → 4s → 8s with +20% jitter, hard-capped at 8s.
 * `retryIndex` is 0-based (0 = delay before the first retry).
 */
export function computeRetryDelay(retryIndex: number, rand: () => number = Math.random): number {
  const base = Math.min(RETRY_BASE_MS * Math.pow(RETRY_FACTOR, retryIndex), RETRY_MAX_DELAY_MS);
  const jittered = Math.round(base * (1 + rand() * RETRY_JITTER_RATIO));
  return Math.min(jittered, RETRY_MAX_DELAY_MS);
}

export interface ProviderTimeouts {
  /** Max time to wait for response headers per attempt. */
  connectMs: number;
  /** Max total time per attempt (headers + body). */
  attemptMs: number;
}

/**
 * Resolve the dual-timeout contract for one candidate.
 * Precedence: model.timeout (config/--timeout) > SC_PROVIDER_ATTEMPT_TIMEOUT_MS
 * > 120s default for the attempt bound; SC_PROVIDER_CONNECT_TIMEOUT_MS > 30s
 * default for the connect bound (never exceeding the attempt bound).
 */
export function resolveProviderTimeouts(model: ModelConfig): ProviderTimeouts {
  const attemptMs = positiveInt(model.timeout)
    ?? positiveInt(process.env[ATTEMPT_TIMEOUT_ENV])
    ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const connectMs = Math.min(
    positiveInt(process.env[CONNECT_TIMEOUT_ENV]) ?? DEFAULT_CONNECT_TIMEOUT_MS,
    attemptMs,
  );
  return { connectMs, attemptMs };
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Canonical base URLs for provider names that are not declared in profiles.
const KNOWN_PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
};

const PROVIDER_KEY_ENVS: ReadonlyArray<{ host: string; env: string }> = [
  { host: 'api.openai.com', env: 'OPENAI_API_KEY' },
  { host: 'api.anthropic.com', env: 'ANTHROPIC_API_KEY' },
  { host: 'integrate.api.nvidia.com', env: 'NVIDIA_API_KEY' },
];

/** Best-effort provider tag used to build candidate labels. */
function providerTag(baseUrl: string): string {
  const url = baseUrl.toLowerCase();
  if (url.includes('anthropic')) return 'anthropic';
  if (url.includes('openai')) return 'openai';
  if (url.includes('nvidia') || url.includes('nvcf')) return 'nvidia';
  if (url.includes('groq')) return 'groq';
  if (url.includes('together')) return 'together';
  if (url.includes('ollama') || url.includes('11434')) return 'ollama';
  if (url.includes('lmstudio') || url.includes('1234')) return 'lmstudio';
  return 'custom';
}

export function primaryCandidate(model: ModelConfig): FailoverCandidate {
  return { id: `${providerTag(model.baseUrl)}/${model.model}`, model: { ...model } };
}

function hostEnvKey(baseUrl: string): string | undefined {
  const rule = PROVIDER_KEY_ENVS.find(r => baseUrl.includes(r.host));
  return rule ? process.env[rule.env] : undefined;
}

function buildCandidateModel(
  base: ModelConfig,
  providerName: string,
  profile: Partial<ModelConfig> | undefined,
  modelId: string,
): ModelConfig {
  const merged: ModelConfig = { ...base, ...(profile ?? {}), model: modelId };
  if (!profile && providerName && KNOWN_PROVIDER_BASE_URLS[providerName]) {
    merged.baseUrl = KNOWN_PROVIDER_BASE_URLS[providerName];
  }
  if (merged.apiKey?.startsWith('<YOUR_')) merged.apiKey = undefined;

  // Credential isolation: never forward the primary key to a different host
  // unless the candidate brought its own key.
  const profileKey = profile?.apiKey && !profile.apiKey.startsWith('<YOUR_') ? profile.apiKey : undefined;
  if (merged.baseUrl !== base.baseUrl && !profileKey && merged.apiKey === base.apiKey) {
    merged.apiKey = undefined;
  }

  // Env keys follow the existing precedence: SC_API_KEY (global) then the
  // host-matched provider key.
  const envKey = process.env.SC_API_KEY ?? hostEnvKey(merged.baseUrl);
  if (envKey) merged.apiKey = envKey;

  return merged;
}

/**
 * Resolve a single "provider/model" alias token to a failover candidate —
 * the shared semantics behind SC_FAILOVER entries (#425) and `roles` role
 * mappings (#424):
 *
 *   * `provider` matches a name in `config.profiles` → that profile's
 *     baseUrl/apiKey/etc. merge over `base`, with `model` set to the token's
 *     model part.
 *   * `provider` matches a known provider name (openai, anthropic, nvidia,
 *     groq, together, ollama, lmstudio) → canonical base URL.
 *   * Otherwise — a token with no "/" or a prefix matching neither — the
 *     whole token is a model id on `base`'s endpoint (model ids may contain
 *     "/", e.g. "meta/llama-3.3-70b").
 *
 * Returns null for degenerate tokens (empty model part on a resolved
 * provider, or a trailing "/"). `base` defaults to the configured model;
 * role routing passes the role candidate's model so bare tokens and
 * credential isolation anchor to the role's endpoint.
 */
export function resolveModelToken(
  config: ProjectConfig,
  token: string,
  base: ModelConfig = config.model,
): FailoverCandidate | null {
  if (!token || token.endsWith('/')) return null;
  const slash = token.indexOf('/');
  const providerName = slash > 0 ? token.slice(0, slash).trim() : '';
  const profile = providerName ? config.profiles?.[providerName] : undefined;
  if (profile || KNOWN_PROVIDER_BASE_URLS[providerName]) {
    const modelId = token.slice(slash + 1).trim();
    if (!modelId) return null;
    return {
      id: `${providerName}/${modelId}`,
      model: buildCandidateModel(base, providerName, profile, modelId),
    };
  }
  return {
    id: `${providerTag(base.baseUrl)}/${token}`,
    model: { ...base, model: token },
  };
}

/**
 * Resolve the ordered failover chain: the configured model is always the
 * primary candidate, followed by each SC_FAILOVER entry in declared order.
 *
 * SC_FAILOVER is an ordered csv of "provider/model" tokens where `provider`
 * is resolved against config.profiles first, then against a built-in map of
 * known provider base URLs. A token whose prefix matches neither — or which
 * has no "/" at all — is treated as a model id on the configured endpoint
 * (model ids may themselves contain "/", e.g. "meta/llama-3.3-70b").
 * Duplicate baseUrl+model pairs collapse — SC_FAILOVER may repeat the
 * primary without causing a second identical candidate.
 *
 * `primary` (#424) overrides the chain head — used by role routing to pin a
 * phase to its resolved role model while keeping SC_FAILOVER as the cascade.
 */
export function resolveFailoverChain(config: ProjectConfig, primary?: FailoverCandidate): FailoverCandidate[] {
  const base = primary?.model ?? config.model;
  const chain: FailoverCandidate[] = [primary ?? primaryCandidate(config.model)];
  const raw = process.env[FAILOVER_ENV]?.trim();
  if (raw) {
    for (const token of raw.split(',').map(t => t.trim()).filter(Boolean)) {
      const candidate = resolveModelToken(config, token, base);
      if (candidate) chain.push(candidate);
    }
  }
  const seen = new Set<string>();
  return chain.filter(c => {
    const key = `${c.model.baseUrl}|${c.model.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
