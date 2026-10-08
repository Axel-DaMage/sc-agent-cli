import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { redactDeep } from './secret-redaction.js';

export interface AuditEvent {
  type: 'llm_request' | 'llm_response' | 'tool_call' | 'tool_result' | 'devcontainer' | 'sandbox_violation' | 'context_budget';
  [key: string]: unknown;
}

// Append-only JSONL audit log for headless forensics (#410).
// One sync write per event — survives crashes; never throws into the run.
export class AuditLogger {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  emit(event: AuditEvent): void {
    try {
      // #472: every string field crosses the redaction layer — error text
      // and violation targets can carry credentials or signed URLs.
      appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...redactDeep(event) }) + '\n');
    } catch {
      // Best-effort: an unwritable audit path must never kill a run.
    }
  }

  // Hash args instead of logging them — tool args can carry secrets/file content.
  static digest(args: Record<string, unknown>): { sha256: string; bytes: number } {
    const raw = JSON.stringify(args ?? {});
    return { sha256: createHash('sha256').update(raw).digest('hex').slice(0, 12), bytes: raw.length };
  }
}
