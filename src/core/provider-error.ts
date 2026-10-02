// Structured provider-failure taxonomy (#425). Every error thrown by the
// provider layer carries a `failureClass` so retry, cascade, and exit-code
// decisions never depend on regex-parsing message strings.

import type { ProviderFailureClass } from './types.js';

/** One failed cascade hop, recorded for structured reporting (#425). */
export interface CascadeAttempt {
  /** 'primary', the active profile name, or the fallback entry label. */
  label: string;
  model: string;
  baseUrl: string;
  failureClass: ProviderFailureClass;
  error: string;
}

export class ProviderError extends Error {
  readonly failureClass: ProviderFailureClass;
  /** HTTP status when the failure came from a response (429, 503, ...). */
  readonly status?: number;
  /** Server-provided Retry-After hint in ms; bounds the next backoff. */
  readonly retryAfterMs?: number;

  constructor(message: string, failureClass: ProviderFailureClass, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
    this.failureClass = failureClass;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thrown when every provider in the failover cascade failed (or a
 * non-cascade-eligible error interrupted the chain after it had progressed).
 * Carries the ordered attempt log so callers get per-provider forensics.
 */
export class ProviderCascadeError extends Error {
  readonly attempts: CascadeAttempt[];
  /** Class of the terminal failure — drives exit-code classification. */
  readonly failureClass: ProviderFailureClass;

  constructor(attempts: CascadeAttempt[]) {
    const detail = attempts
      .map(a => `${a.label} (${a.model} @ ${a.baseUrl}) → ${a.failureClass}: ${a.error}`)
      .join('; ');
    super(`Provider failover chain failed (${attempts.length} target${attempts.length === 1 ? '' : 's'}): ${detail}`);
    this.name = 'ProviderCascadeError';
    this.attempts = attempts;
    this.failureClass = attempts[attempts.length - 1]?.failureClass ?? 'unknown';
  }
}

/** Map an HTTP response status onto the failure taxonomy. */
export function classifyHttpStatus(status: number): ProviderFailureClass {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500 && status <= 599) return 'server';
  if (status >= 400 && status <= 499) return 'client';
  return 'unknown';
}

/** Best-effort classification for errors without a structured class. */
export function classifyProviderError(err: unknown): ProviderFailureClass {
  if (err instanceof ProviderError || err instanceof ProviderCascadeError) {
    return err.failureClass;
  }

  const name = err instanceof Error ? err.name : '';
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Caller cancellation — checked before retryable classes so an abort never
  // retries or cascades.
  if (name === 'AbortError' || name === 'TimeoutError' || /\babort|cancell?ed\b/.test(msg)) {
    return 'aborted';
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|authentication/.test(msg)) return 'auth';
  if (/\b429\b|rate.?limit|too many requests/.test(msg)) return 'rate_limit';
  if (/\b5\d\d\b/.test(msg)) return 'server';
  if (/\b4\d\d\b|invalid|bad request/.test(msg)) return 'client';
  if (/timed?\s?out|deadline/.test(msg)) return 'timeout';
  if (/fetch failed|econnrefused|econnreset|enotfound|socket hang|network|dns/.test(msg)) {
    return 'network';
  }
  return 'unknown';
}

/**
 * Whether the error may be retried against the same provider. Mirrors the
 * pre-#425 semantics: transient and unclassified errors retry; auth, client
 * (4xx), and abort errors do not.
 */
export function isRetryableClass(failureClass: ProviderFailureClass): boolean {
  return failureClass !== 'auth' && failureClass !== 'client' && failureClass !== 'aborted';
}
