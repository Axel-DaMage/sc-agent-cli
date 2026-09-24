import type { ToolCall } from '../core/types.js';

/**
 * Harmony markup recovery (#417).
 *
 * Some OpenAI-compatible providers route Harmony-trained models (gpt-oss,
 * Nemotron family) whose tool invocations leak into assistant `content` as
 * channel markup instead of the structured `tool_calls` field:
 *
 *   <|channel|>commentary to=functions.read_file<|message|>{"path":"a.ts"}
 *   <|channel|>commentary<|message|>{"path":"a.ts","offset":10}
 *
 * Left unhandled, the agent loop treats that text as the final answer and
 * ends the turn with zero changes — a silent no-op for headless callers.
 */

const HARMONY_BLOCK_RE = /<\|channel\|>([^<]*?)<\|message\|>([\s\S]*?)(?=<\||$)/g;

export function hasHarmonyMarkup(content: string | undefined | null): boolean {
  return typeof content === 'string' && content.includes('<|channel|>');
}

/**
 * Extract a tool name from the channel descriptor, e.g.
 * `commentary to=functions.read_file` -> `read_file`.
 */
function toolNameFromChannel(channel: string): string | null {
  const m = channel.match(/to\s*=\s*(?:functions\.)?([A-Za-z_][\w.-]*)/);
  return m ? m[1] : null;
}

/**
 * Parse the `<|message|>` payload into a JSON arguments string.
 * Non-JSON payloads are wrapped as `{ input: <raw> }` so the model still
 * sees a structured argument set; empty payloads yield no call.
 */
function argsFromPayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return JSON.stringify({ input: trimmed });
  }
}

/**
 * Recover every tool call embedded as Harmony markup in `content`.
 * Blocks without an identifiable `to=` target are skipped (they are
 * reasoning/analysis channels, not tool invocations).
 */
export function recoverHarmonyToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  if (!hasHarmonyMarkup(content)) return calls;

  for (const m of content.matchAll(HARMONY_BLOCK_RE)) {
    const name = toolNameFromChannel(m[1] ?? '');
    if (!name) continue;
    const args = argsFromPayload(m[2] ?? '');
    if (args === null) continue;
    calls.push({
      id: `harmony_${calls.length}_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name, arguments: args },
    });
  }
  return calls;
}
