export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenCost {
  inputCostPer1K: number;
  outputCostPer1K: number;
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

export class TokenTracker {
  private totalInput = 0;
  private totalOutput = 0;
  private modelName: string;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  addInput(tokens: number): void {
    this.totalInput += tokens;
  }

  addOutput(tokens: number): void {
    this.totalOutput += tokens;
  }

  getUsage(): TokenUsage {
    return {
      inputTokens: this.totalInput,
      outputTokens: this.totalOutput,
      totalTokens: this.totalInput + this.totalOutput,
    };
  }

  getEstimatedCost(): number {
    return estimateCost(this.modelName, this.totalInput, this.totalOutput);
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
  }
}
