import type {
  Message,
  ModelConfig,
  ToolDefinition,
  StreamDelta,
  ToolCallDelta,
  ToolCall,
} from './types.js';
import { verboseApiRequest, verboseApiResponse, verbose, verboseError } from '../utils/verbose-logger.js';
import type { RetryPolicyConfig, ThrottleConfig } from './types.js';
import { sleep, calculateDelay } from '../utils/throttle.js';
import {
  ProviderError,
  classifyHttpStatus,
  classifyProviderError,
  isRetryableClass,
} from './provider-error.js';

export interface ChatCompletionOptions {
  messages: Message[];
  tools?: ToolDefinition[];
  stream?: boolean;
  signal?: AbortSignal;
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
}

export interface ChatCompletionResponse {
  content: string;
  tool_calls?: ToolCall[];
}

// Bounded retry policy (#425): defaults reproduce the pre-contract behavior
// (2 retries at 1s and 2s) while remaining fully configurable per provider.
export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
};

/** Hard bound for a server-provided Retry-After hint — keeps backoff bounded. */
const MAX_RETRY_AFTER_MS = 120000;

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

const PROVIDER_TIMEOUT_DEFAULTS: Record<string, number> = {
  nvidia: 180000,    // 3 min — NVIDIA API is slow
  anthropic: 60000,  // 1 min
  openai: 60000,     // 1 min
  ollama: 300000,    // 5 min — local models can be very slow
  groq: 30000,       // 30s — Groq is fast
  together: 60000,   // 1 min
  lmstudio: 120000,  // 2 min
};

function getTimeout(baseUrl: string, configTimeout?: number): number {
  if (configTimeout !== undefined) return configTimeout;
  const url = baseUrl.toLowerCase();
  for (const [key, ms] of Object.entries(PROVIDER_TIMEOUT_DEFAULTS)) {
    if (url.includes(key)) return ms;
  }
  return 60000; // default 60s
}

export class OpenAICompatibleProvider {
  private throttleConfig: ThrottleConfig = {
    enabled: false, minDelayMs: 0, afterEmptyResponse: 0, afterError: 0, maxDelayMs: 30000, mode: 'fixed',
  };
  private retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY };
  private lastApiCallTime = 0;
  private consecutiveEmpty = 0;
  private lastCallWasError = false;

  constructor(private config: ModelConfig) {}

  setThrottleConfig(config: ThrottleConfig): void {
    this.throttleConfig = config;
  }

  /** Apply a bounded retry policy (#425). Absent fields keep defaults. */
  setRetryPolicy(policy: RetryPolicyConfig): void {
    this.retryPolicy = {
      maxRetries: Math.max(0, Math.min(policy.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries, 10)),
      baseDelayMs: Math.max(0, policy.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs),
      backoffMultiplier: Math.max(1, policy.backoffMultiplier ?? DEFAULT_RETRY_POLICY.backoffMultiplier),
      maxDelayMs: Math.max(0, policy.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs),
    };
  }

  setConsecutiveEmpty(count: number): void {
    this.consecutiveEmpty = count;
  }

  setLastCallWasError(err: boolean): void {
    this.lastCallWasError = err;
  }

  async chatCompletion(
    options: ChatCompletionOptions,
    onChunk?: (delta: StreamDelta) => void
  ): Promise<ChatCompletionResponse> {
    const rawBase = this.config.baseUrl.replace(/\/+$/, '');
    let baseUrl: string;
    try {
      baseUrl = new URL(rawBase).href.replace(/\/+$/, '');
    } catch {
      throw new Error(`Invalid baseUrl: "${this.config.baseUrl}" is not a valid URL`);
    }
    const url = `${baseUrl}/chat/completions`;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: options.messages,
      temperature: this.config.temperature ?? 0.7,
      stream: options.stream ?? this.config.stream ?? true,
      tools: options.tools,
    };

    // Only send max_tokens if explicitly set (null/undefined = no limit, let provider decide)
    if (this.config.maxTokens !== null && this.config.maxTokens !== undefined) {
      body.max_tokens = this.config.maxTokens;
    }

    if (options.tool_choice) {
      body.tool_choice = options.tool_choice;
    }

    const timeout = getTimeout(this.config.baseUrl, this.config.timeout);
    const policy = this.retryPolicy;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
      const abortController = new AbortController();
      const timeoutTimer = setTimeout(() => abortController.abort(new Error('Connection timed out')), timeout);
      let onAbort: (() => void) | null = null;

      try {
        if (options.signal) {
          if (options.signal.aborted) {
            clearTimeout(timeoutTimer);
            throw options.signal.reason || new Error('Aborted');
          }
          onAbort = () => {
            clearTimeout(timeoutTimer);
            abortController.abort(options.signal!.reason || new Error('Aborted'));
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        verbose(`Timeout: ${timeout}ms (config: ${this.config.timeout ?? 'auto-detect'}, provider: ${this.config.baseUrl})`, 2);

        // Apply throttling delay before API call
        if (this.throttleConfig.enabled) {
          const delay = calculateDelay(
            this.throttleConfig,
            this.lastApiCallTime,
            this.consecutiveEmpty,
            this.lastCallWasError
          );
          if (delay > 0) {
            verbose(`Throttling: waiting ${delay}ms before API call (minDelay: ${this.throttleConfig.minDelayMs}ms, consecutiveEmpty: ${this.consecutiveEmpty}, lastError: ${this.lastCallWasError})`, 1);
            await sleep(delay, options.signal);
          }
        }

        verboseApiRequest(url, body);

        const requestStart = Date.now();
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abortController.signal,
        });
        const responseDuration = Date.now() - requestStart;
        this.lastApiCallTime = Date.now();

        verboseApiResponse(response.status, responseDuration);

        if (!response.ok) {
          const errorText = await response.text();
          throw new ProviderError(
            `API Error ${response.status}: ${errorText}`,
            classifyHttpStatus(response.status),
            response.status,
            parseRetryAfterMs(response.headers?.get?.('retry-after') ?? null)
          );
        }

        if (options.stream && response.body) {
          return await this.handleStreamResponse(response.body, onChunk);
        } else {
          return await this.handleNonStreamResponse(response);
        }
      } catch (err: unknown) {
        clearTimeout(timeoutTimer);
        if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);

        if (err instanceof Error) {
          if (options.signal?.aborted) throw err;
          const failureClass = classifyProviderError(err);
          verboseError(`API call failed (attempt ${attempt + 1}/${policy.maxRetries + 1}): ${err.message}`);
          if (attempt >= policy.maxRetries || !isRetryableClass(failureClass)) throw err;
          lastError = err;
          await this.delay(this.retryDelayMs(attempt, err), options.signal);
        } else {
          throw err;
        }
      } finally {
        // fetch resolves at headers; retain cancellation through body reads.
        clearTimeout(timeoutTimer);
        if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Bounded backoff for retry `attempt` (0-based). Exponential from
   * `baseDelayMs`, capped at `maxDelayMs`; a server Retry-After hint raises
   * the delay but stays bounded by MAX_RETRY_AFTER_MS.
   */
  private retryDelayMs(attempt: number, err: unknown): number {
    const backoff = Math.min(
      this.retryPolicy.baseDelayMs * Math.pow(this.retryPolicy.backoffMultiplier, attempt),
      this.retryPolicy.maxDelayMs
    );
    if (err instanceof ProviderError && err.retryAfterMs !== undefined) {
      return Math.max(backoff, Math.min(err.retryAfterMs, MAX_RETRY_AFTER_MS));
    }
    return backoff;
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return sleep(ms, signal);
  }

  private async handleNonStreamResponse(response: Response): Promise<ChatCompletionResponse> {
    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('No choices in response');
    }

    return {
      content: choice.message?.content || '',
      tool_calls: choice.message?.tool_calls,
    };
  }

  private async handleStreamResponse(
    body: ReadableStream<Uint8Array>,
    onChunk?: (delta: StreamDelta) => void
  ): Promise<ChatCompletionResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let partialData = ''; // Buffers JSON from data: lines split across TCP chunks
    let fullContent = '';
    const accumulatedToolCalls: Map<number, ToolCall> = new Map();

    function processChunk(data: string): boolean {
      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) return true;

        if (delta.content) fullContent += delta.content;

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls as ToolCallDelta[]) {
            const existing = accumulatedToolCalls.get(tc.index);
            if (!existing) {
              accumulatedToolCalls.set(tc.index, {
                id: tc.id || '',
                type: 'function',
                function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' },
              });
            } else {
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            }
          }
        }

        if (onChunk) onChunk({ role: delta.role, content: delta.content, tool_calls: delta.tool_calls });
        return true;
      } catch {
        return false;
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const raw of lines) {
          const line = raw.trimEnd();
          if (!line || line === 'data: [DONE]') {
            partialData = '';
            continue;
          }

          // Lines starting with "data: " carry JSON payload
          if (line.startsWith('data: ')) {
            partialData = line.slice(6); // Replace any partial with the latest data line
          } else if (partialData && !line.startsWith('{') && !line.startsWith('[')) {
            // Continuation of JSON from a previous partial that was split mid-chunk
            partialData += line;
          } else {
            continue;
          }

          if (processChunk(partialData)) partialData = '';
        }
      }

      // Flush any remaining partial data
      if (partialData) processChunk(partialData);
    } finally {
      reader.releaseLock();
    }

    const toolCalls = Array.from(accumulatedToolCalls.values());
    return {
      content: fullContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}
