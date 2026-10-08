import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../core/types.js';
import { redactDeep } from './secret-redaction.js';

/**
 * Session artifacts — ~/.sc-agent/sessions/<sessionId>/{session,status}.json.
 * `SC_SESSIONS_DIR` relocates the root (tests, sandboxed CI). Every write
 * passes through the shared redaction layer (#472) so secrets in message
 * history or error text never reach the on-disk trace.
 */
function sessionsRoot(): string {
  return process.env.SC_SESSIONS_DIR || join(homedir(), '.sc-agent', 'sessions');
}

export function writeSessionTrace(sessionId: string, msgs: Message[]): void {
  try {
    const sessionDir = join(sessionsRoot(), sessionId);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(redactDeep(msgs), null, 2));
  } catch {
    // Silent: logging is best-effort
  }
}

export function writeSessionStatus(sessionId: string, statusData: Record<string, unknown>): void {
  try {
    const sessionDir = join(sessionsRoot(), sessionId);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    writeFileSync(join(sessionDir, 'status.json'), JSON.stringify(redactDeep(statusData), null, 2));
  } catch {
    // Silent: best-effort
  }
}
