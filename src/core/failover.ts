// Provider failover contract (#425): an ordered provider/model cascade that
// survives rate-limits and outages. Each provider gets its own bounded
// retry budget (see provider.ts); persistent failures advance the cascade.
//
// Contract summary:
//   - Every request is deadline-bound (provider.ts timeout).
//   - Transient failures (429/5xx/timeout/network) retry with bounded backoff.
//   - On persistent failure the next cascade target takes over — the hop is
//     sticky, so a 100-iteration run does not re-pay the retry cost each call.
//   - Auth/client/abort errors fail fast by default (configurable via
//     failover.cascadeOn); a lone provider always rethrows its original error.
//   - Total work per call is bounded: at most N providers × (1 + maxRetries).

import { OpenAICompatibleProvider } from './provider.js';
import type { ChatCompletionOptions, ChatCompletionResponse } from './provider.js';
import {
  ProviderCascadeError,
  classifyProviderError,
} from './provider-error.js';
import type { CascadeAttempt } from './provider-error.js';
import type {
  ModelConfig,
  ProjectConfig,
  ProviderFailureClass,
  RetryPolicyConfig,
  StreamDelta,
  ThrottleConfig,
} from './types.js';
import { verboseError } from '../utils/verbose-logger.js';

/** Failure classes that advance the cascade unless configured otherwise. */
export const DEFAULT_CASCADE_CLASSES: readonly ProviderFailureClass[] = [
  'rate_limit',
  'server',
  'timeout',
  'network',
];

/** One link in the failover chain: a label plus a fully-resolved ModelConfig. */
export interface FailoverEntry {
  label: string;
  config: ModelConfig;
}

export interface FailoverOptions {
  /** Bounded retry policy applied to every provider in the chain. */
  retry?: RetryPolicyConfig;
  /** Failure classes that advance the cascade (default: DEFAULT_CASCADE_CLASSES). */
  cascadeOn?: ProviderFailureClass[];
  /** Called when the active provider is abandoned for the next target. */
  onFailover?: (
    from: FailoverEntry,
    to: FailoverEntry,
    error: Error,
    failureClass: ProviderFailureClass
  ) => void;
}

/** Host-specific API-key env vars, mirroring config.ts API_KEY_REQUIREMENTS. */
const FALLBACK_KEY_ENV: ReadonlyArray<{ hostPattern: string; envVar: string }> = [
  { hostPattern: 'api.openai.com', envVar: 'OPENAI_API_KEY' },
  { hostPattern: 'api.anthropic.com', envVar: 'ANTHROPIC_API_KEY' },
  { hostPattern: 'integrate.api.nvidia.com', envVar: 'NVIDIA_API_KEY' },
];

function definedProps<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return a === b;
  }
}

/**
 * Resolve `failover.cascade` entries into concrete provider configs.
 * String entries name profiles; object entries are inline ModelConfig
 * overrides merged over `config.model`.
 *
 * Credential safety: a fallback on a different host never inherits the
 * primary's apiKey — it must declare its own key or resolve one from the
 * provider-specific env var (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...).
 */
export function resolveCascadeTargets(config: ProjectConfig): FailoverEntry[] {
  const targets = config.failover?.cascade ?? [];
  const resolved: FailoverEntry[] = [];

  for (const target of targets) {
    const overrides = typeof target === 'string' ? config.profiles?.[target] : target;
    if (!overrides) {
      throw new Error(`failover.cascade references unknown profile "${String(target)}"`);
    }

    const declared = definedProps(overrides);
    const merged: ModelConfig = { ...config.model, ...declared, provider: 'openai-compatible' };

    // Never leak the primary's credential to a different host.
    if (declared.apiKey === undefined && !sameHost(merged.baseUrl, config.model.baseUrl)) {
      merged.apiKey = undefined;
    }
    if (merged.apiKey?.startsWith('<YOUR_')) {
      merged.apiKey = undefined;
    }
    if (!merged.apiKey) {
      const envVar = FALLBACK_KEY_ENV.find(r => merged.baseUrl.includes(r.hostPattern))?.envVar;
      const envKey = envVar ? process.env[envVar] : undefined;
      if (envKey) merged.apiKey = envKey;
    }

    const label = typeof target === 'string'
      ? target
      : (declared.model ?? `fallback-${resolved.length + 1}`);
    resolved.push({ label, config: merged });
  }

  return resolved;
}

/**
 * Ordered provider chain with per-provider bounded retries. Presents the
 * same surface as OpenAICompatibleProvider so the agent layer is unchanged.
 */
export class FailoverProvider {
  private entries: Array<FailoverEntry & { provider: OpenAICompatibleProvider }>;
  private activeIndex = 0;
  private cascadeOn: ReadonlySet<ProviderFailureClass>;
  private onFailover?: FailoverOptions['onFailover'];
  private _lastAttempts: CascadeAttempt[] = [];

  constructor(entries: FailoverEntry[], options: FailoverOptions = {}) {
    if (entries.length === 0) {
      throw new Error('FailoverProvider requires at least one provider entry');
    }
    this.entries = entries.map(entry => {
      const provider = new OpenAICompatibleProvider(entry.config);
      if (options.retry) provider.setRetryPolicy(options.retry);
      return { ...entry, provider };
    });
    this.cascadeOn = new Set(options.cascadeOn ?? DEFAULT_CASCADE_CLASSES);
    this.onFailover = options.onFailover;
  }

  get size(): number {
    return this.entries.length;
  }

  /** The provider entry that served (or is about to serve) the last call. */
  get activeEntry(): FailoverEntry {
    return this.entries[this.activeIndex];
  }

  get activeModel(): string {
    return this.activeEntry.config.model;
  }

  get activeBaseUrl(): string {
    return this.activeEntry.config.baseUrl;
  }

  /** Attempt log of the most recent chatCompletion call (empty on clean runs). */
  get lastAttempts(): readonly CascadeAttempt[] {
    return this._lastAttempts;
  }

  setThrottleConfig(config: ThrottleConfig): void {
    for (const entry of this.entries) entry.provider.setThrottleConfig(config);
  }

  setConsecutiveEmpty(count: number): void {
    for (const entry of this.entries) entry.provider.setConsecutiveEmpty(count);
  }

  setLastCallWasError(err: boolean): void {
    for (const entry of this.entries) entry.provider.setLastCallWasError(err);
  }

  async chatCompletion(
    options: ChatCompletionOptions,
    onChunk?: (delta: StreamDelta) => void
  ): Promise<ChatCompletionResponse> {
    const n = this.entries.length;
    const attempts: CascadeAttempt[] = [];

    for (let k = 0; k < n; k++) {
      const idx = (this.activeIndex + k) % n;
      const entry = this.entries[idx];
      try {
        const response = await entry.provider.chatCompletion(options, onChunk);
        this.activeIndex = idx; // sticky: keep using the provider that worked
        this._lastAttempts = attempts;
        return response;
      } catch (err: unknown) {
        // Caller cancellation aborts the whole request — never cascades.
        if (options.signal?.aborted) throw err;

        const failureClass = classifyProviderError(err);
        attempts.push({
          label: entry.label,
          model: entry.config.model,
          baseUrl: entry.config.baseUrl,
          failureClass,
          error: err instanceof Error ? err.message : String(err),
        });

        const canCascade = n > 1 && this.cascadeOn.has(failureClass);
        const isLast = k === n - 1;
        if (!canCascade || isLast) {
          this._lastAttempts = attempts;
          // Preserve the original error when no cascade hop happened — a lone
          // provider or a deterministic failure keeps its identity (and its
          // message) so existing error handling stays byte-for-byte identical.
          if (attempts.length === 1) throw err;
          throw new ProviderCascadeError(attempts);
        }

        const next = this.entries[(idx + 1) % n];
        verboseError(
          `Provider "${entry.label}" failed (${failureClass}): ${attempts[attempts.length - 1].error} — failing over to "${next.label}"`
        );
        this.onFailover?.(entry, next, err instanceof Error ? err : new Error(String(err)), failureClass);
      }
    }

    // Unreachable: the loop always throws or returns. Satisfies noImplicitReturns.
    throw new ProviderCascadeError(attempts);
  }
}
