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
  timeout?: number; // Per-attempt total timeout in ms (overrides SC_PROVIDER_ATTEMPT_TIMEOUT_MS; connect bound: SC_PROVIDER_CONNECT_TIMEOUT_MS)
}

export type PermissionProfile = 'traditional' | 'blacklist';

/**
 * Sandboxed execution profile for `run_shell` (#423).
 *
 * Semantics (per operator contract):
 * - `enabled`: opt-in, default false. When unset the shell tool runs unsandboxed.
 * - `egressAllowlist`: `host` or `host:port` entries (`*.` prefix matches a
 *   domain and its subdomains; `*` allows all egress). Empty/absent list means
 *   block-all egress except loopback.
 * - `readOnlyPaths` / `writablePaths`: absolute (or workspace-relative) paths
 *   layered over the default policy — workspace writable, everything else
 *   read-only.
 * - `seccomp`: request syscall filtering; only applied when the platform
 *   supports it (Linux + bubblewrap). Optional `seccompProfile` points to a
 *   raw cBPF blob (as produced by `seccomp_export_bpf`) replacing the built-in
 *   denylist.
 *
 * Sandbox rules compose additively with `permissions.denyPaths` /
 * `permissions.denyCommands`; deny always wins.
 */
export interface SandboxConfig {
  enabled?: boolean;
  egressAllowlist?: string[];
  readOnlyPaths?: string[];
  writablePaths?: string[];
  seccomp?: boolean;
  seccompProfile?: string;
}

/**
 * Multi-model orchestration roles (#424). Each role maps to a
 * "provider/model" token resolved with the SC_FAILOVER alias semantics
 * (profile name → known provider → model id on the configured endpoint).
 */
export type AgentRole = 'planner' | 'executor' | 'reviewer';

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
  sandbox?: SandboxConfig; // Sandboxed execution for agent-spawned shell commands (#423)
  profiles?: Record<string, Partial<ModelConfig>>; // Named profiles
  activeProfile?: string;
  /**
   * Per-phase model routing for headless runs (#424): planner, executor and
   * reviewer/judge each map to a "provider/model" alias. All roles optional —
   * absent or invalid entries fall back to `model.*` (logged as
   * `role_fallback` in the run manifest).
   */
  roles?: Partial<Record<AgentRole, string>>;
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
