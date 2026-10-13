import type { ToolDefinition, ProjectConfig } from '../core/types.js';
import type { SandboxRuntime } from '../utils/sandbox.js';

export interface ToolContext {
  workspaceRoot: string;
  config: ProjectConfig;
  autoApprove?: boolean;
  /** Sandboxed execution runtime (#423) — present when `sandbox.enabled`. */
  sandbox?: SandboxRuntime;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
