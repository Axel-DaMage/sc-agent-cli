// Core types for the agent system

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // for tool responses
  name?: string; // for tool responses
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ModelConfig {
  provider: 'openai-compatible';
  baseUrl: string;
  apiKey?: string; // Optional for local models (Ollama, LM Studio)
  model: string;
  temperature?: number;
  maxTokens?: number | null; // null = no limit (let provider decide)
  stream?: boolean;
  top_p?: number;
  topP?: number;
  timeout?: number; // Connection timeout in ms (overrides provider default)
}

/**
 * Provider failure taxonomy for the failover contract (#425).
 * Every error thrown by the provider layer carries one of these classes so
 * retry, cascade, and exit-code decisions never depend on message sniffing.
 */
export type ProviderFailureClass =
  | 'rate_limit'  // HTTP 429 — retryable, cascade-eligible
  | 'server'      // HTTP 5xx — retryable, cascade-eligible
  | 'timeout'     // request deadline exceeded — retryable, cascade-eligible
  | 'network'     // transport failure (DNS, refused, reset) — retryable, cascade-eligible
  | 'auth'        // 401/403 — never retried; cascades only when configured
  | 'client'      // other 4xx — deterministic request error, never retried
  | 'aborted'     // caller cancellation — never retried, never cascaded
  | 'unknown';    // unclassified — retried within a provider, not cascaded

/** Bounded retry policy applied per provider before the cascade advances (#425). */
export interface RetryPolicyConfig {
  /** Retries after the first attempt, per provider (default 2). */
  maxRetries?: number;
  /** Delay before the first retry in ms (default 1000). */
  baseDelayMs?: number;
  /** Exponential multiplier applied per retry (default 2). */
  backoffMultiplier?: number;
  /** Upper bound for a single backoff delay in ms (default 30000). */
  maxDelayMs?: number;
}

/**
 * One failover cascade entry: a profile name (resolved against
 * `config.profiles`) or inline `ModelConfig` overrides merged over `model.*`.
 */
export type FailoverTarget = string | Partial<ModelConfig>;

/**
 * Provider failover contract (#425): every request has a timeout, transient
 * failures retry with bounded backoff, and persistent failures advance an
 * ordered provider/model cascade.
 */
export interface FailoverConfig {
  /** Ordered fallback chain tried when the active provider fails with a
   *  cascade-eligible error (see `cascadeOn`). */
  cascade?: FailoverTarget[];
  /** Bounded retry policy applied per provider before moving on. */
  retry?: RetryPolicyConfig;
  /** Failure classes that advance the cascade
   *  (default: rate_limit, server, timeout, network). */
  cascadeOn?: ProviderFailureClass[];
}

export type PermissionProfile = 'traditional' | 'blacklist';

export interface ThrottleConfig {
  enabled: boolean;
  minDelayMs: number;          // Minimum delay between API calls
  afterEmptyResponse: number;   // Extra delay after empty response
  afterError: number;           // Extra delay after API error
  maxDelayMs: number;           // Cap for exponential backoff
  mode: 'auto' | 'fixed' | 'exponential';
}

export interface ProjectConfig {
  model: ModelConfig;
  permissions?: {
    autoApprove?: string[]; // glob patterns for auto-approved tools
    denyPaths?: string[]; // paths to never access
    denyCommands?: string[]; // shell command patterns to never execute (hard block)
    denyGitMutation?: boolean; // hard-block git-mutating ops (orchestrators own git state)
    profile?: PermissionProfile; // Permission behavior profile
  };
  profiles?: Record<string, Partial<ModelConfig>>; // Named profiles
  activeProfile?: string;
  failover?: FailoverConfig; // Provider failover contract: timeouts, bounded retries, cascade (#425)
  mcp?: {
    servers?: Record<string, {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      timeoutMs?: number; // per-request timeout (default 30000)
    }>;
  }; // MCP servers to consume as tool providers (stdio transport)
  plugins?: string[]; // External tool modules to load (paths or package specifiers)
  settings?: {
    hud?: boolean; // Show HUD status line after responses (default: true)
    hudFields?: string[]; // Fields to show in HUD: model, profile, memories, messages, storage, permissions, tokens, iterations, cost
    maxReadFileBytes?: number; // Max bytes for read_file (default: 1MB)
    maxWriteFileBytes?: number; // Max bytes for write_file (default: 10MB)
    policyFile?: string; // Path to an external policy/doctrine file (e.g. ADEV.md) to inject as system context
    throttling?: Partial<ThrottleConfig>;
    formatters?: string[]; // Shell commands to run before git commit (auto-format)
  };
}

export interface StreamDelta {
  role?: MessageRole;
  content?: string;
  tool_calls?: ToolCallDelta[];
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string; // partial JSON
  };
}

/**
 * Agent Event Types for UI-agnostic callbacks
 */
export type AgentEventType = 'progress' | 'tool_start' | 'tool_complete' | 'tool_error' | 'log' | 'complete';

export interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
  data?: any;
}

export interface ToolEvent extends AgentEvent {
  type: 'tool_start' | 'tool_complete' | 'tool_error';
  data: {
    name: string;
    args?: any;
    result?: string;
    error?: string;
    duration?: number;
  };
}

export interface ProgressEvent extends AgentEvent {
  type: 'progress';
  data: {
    status: string;
    step?: number;
    total?: number;
  };
}

export interface LogEvent extends AgentEvent {
  type: 'log';
  data: {
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    args?: any[];
  };
}

export interface CompleteEvent extends AgentEvent {
  type: 'complete';
  data: {
    messages: Message[];
    toolsUsed: string[];
    iterations: number;
  };
}

/**
 * Callbacks for UI-agnostic agent interaction
 * Allows both CLI and Web to handle events differently
 */
export interface AgentCallbacks {
  /**
   * Called when agent progress updates (e.g., "thinking", "calling tools")
   */
  onProgress?: (event: ProgressEvent) => void;

  /**
   * Called when a tool execution starts
   */
  onToolStart?: (event: ToolEvent) => void;

  /**
   * Called when a tool execution completes successfully
   */
  onToolComplete?: (event: ToolEvent) => void;

  /**
   * Called when a tool execution fails
   */
  onToolError?: (event: ToolEvent) => void;

  /**
   * Called for log messages (replaces console.log in quiet mode)
   */
  onLog?: (event: LogEvent) => void;

  /**
   * Called when agent.run() completes
   */
  onComplete?: (event: CompleteEvent) => void;
}
