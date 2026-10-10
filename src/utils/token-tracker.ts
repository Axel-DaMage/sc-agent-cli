export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenCost {
  inputCostPer1K: number;
  outputCostPer1K: number;
}

/** Per-role token breakdown for the run manifest `tokens.byRole` (#424). */
export interface RoleTokenUsage {
  in: number;
  out: number;
  /** Prompt tokens served from provider cache — only present when reported. */
  cached?: number;
}

const MODEL_COSTS: Record<string, TokenCost> = {
  'gpt-4o': { inputCostPer1K: 0.0025, outputCostPer1K: 0.01 },
  'gpt-4o-mini': { inputCostPer1K: 0.00015, outputCostPer1K: 0.0006 },
  'claude-sonnet-4-6': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
  'claude-haiku-3-5': { inputCostPer1K: 0.0008, outputCostPer1K: 0.004 },
};

const DEFAULT_COST: TokenCost = { inputCostPer1K: 0.002, outputCostPer1K: 0.008 };
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(msg: { role: string; content: string }): number {
  let total = estimateTokens(msg.content);
  total += 4;
  return total;
}

export function getModelCost(modelName: string): TokenCost {
  for (const [key, cost] of Object.entries(MODEL_COSTS)) {
    if (modelName.toLowerCase().includes(key.toLowerCase())) {
      return cost;
    }
  }
  return DEFAULT_COST;
}

export function estimateCost(modelName: string, inputTokens: number, outputTokens: number): number {
  const cost = getModelCost(modelName);
  const inputCost = (inputTokens / 1000) * cost.inputCostPer1K;
  const outputCost = (outputTokens / 1000) * cost.outputCostPer1K;
  return inputCost + outputCost;
}

interface RoleBucket {
  input: number;
  output: number;
  cached: number;
  /** Serving model id for cost attribution (the role's resolved candidate). */
  model: string;
}

export class TokenTracker {
  private totalInput = 0;
  private totalOutput = 0;
  private totalCached = 0;
  private roleUsage = new Map<string, RoleBucket>();
  private activeRole: string | null = null;
  private modelName: string;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  /**
   * Attribute subsequent input/output/cached tokens to an orchestration
   * role (#424). `model` is the role's resolved serving model, used for
   * per-role cost attribution. Pass null to close role accounting — tokens
   * still accrue to the run totals.
   */
  setRole(role: string | null, model?: string): void {
    this.activeRole = role;
    if (role && !this.roleUsage.has(role)) {
      this.roleUsage.set(role, { input: 0, output: 0, cached: 0, model: model ?? this.modelName });
    }
  }

  private bucket(): RoleBucket | undefined {
    return this.activeRole ? this.roleUsage.get(this.activeRole) : undefined;
  }

  addInput(tokens: number): void {
    this.totalInput += tokens;
    const b = this.bucket();
    if (b) b.input += tokens;
  }

  addOutput(tokens: number): void {
    this.totalOutput += tokens;
    const b = this.bucket();
    if (b) b.output += tokens;
  }

  /** Provider-reported cached prompt tokens (#424) — no estimate exists. */
  addCached(tokens: number): void {
    this.totalCached += tokens;
    const b = this.bucket();
    if (b) b.cached += tokens;
  }

  getUsage(): TokenUsage {
    return {
      inputTokens: this.totalInput,
      outputTokens: this.totalOutput,
      totalTokens: this.totalInput + this.totalOutput,
    };
  }

  /** Provider-reported cached input tokens across the run (0 = unreported). */
  getCachedTokens(): number {
    return this.totalCached;
  }

  /**
   * Per-role token totals keyed by role name — only roles that ran appear.
   * `cached` is present only when the provider reported cached tokens.
   */
  getRoleUsage(): Record<string, RoleTokenUsage> {
    const out: Record<string, RoleTokenUsage> = {};
    for (const [role, u] of this.roleUsage) {
      out[role] = { in: u.input, out: u.output, ...(u.cached > 0 ? { cached: u.cached } : {}) };
    }
    return out;
  }

  getEstimatedCost(): number {
    if (this.roleUsage.size === 0) {
      return estimateCost(this.modelName, this.totalInput, this.totalOutput);
    }
    // Multi-model runs (#424): price each role at its serving model, then
    // price any unattributed remainder at the run's default model.
    let cost = 0;
    let roleInput = 0;
    let roleOutput = 0;
    for (const u of this.roleUsage.values()) {
      roleInput += u.input;
      roleOutput += u.output;
      cost += estimateCost(u.model, u.input, u.output);
    }
    const remInput = this.totalInput - roleInput;
    const remOutput = this.totalOutput - roleOutput;
    if (remInput > 0 || remOutput > 0) {
      cost += estimateCost(this.modelName, remInput, remOutput);
    }
    return cost;
  }

  formatUsage(): string {
    const usage = this.getUsage();
    const cost = this.getEstimatedCost();
    const totalK = (usage.totalTokens / 1000).toFixed(1);
    return `${totalK}K tokens · $${cost.toFixed(4)}`;
  }

  formatShort(): string {
    const usage = this.getUsage();
    const totalK = (usage.totalTokens / 1000).toFixed(1);
    const cost = this.getEstimatedCost();
    return `📊${totalK}k $${cost.toFixed(4)}`;
  }

  reset(): void {
    this.totalInput = 0;
    this.totalOutput = 0;
    this.totalCached = 0;
    this.roleUsage.clear();
    this.activeRole = null;
  }
}
