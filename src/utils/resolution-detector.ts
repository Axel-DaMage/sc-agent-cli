import { spawnSync } from 'node:child_process';
import type { Message } from '../core/types.js';
import type { WorkspaceGitState, MutationDetectionResult } from './mutation-detector.js';
import { EXIT_CODES } from './exit-codes.js';

export type TaskResolution =
  | 'completed'
  | 'no_changes'
  | 'not_actionable'
  | 'blocked'
  | 'budget_exceeded'
  | 'error';

export interface ResolutionResult {
  resolution: TaskResolution;
  resolution_reason: string;
  files_changed: number;
  exit_code: number;
  stdout_marker?: string;
}

export interface DetectResolutionOptions {
  history: Message[];
  exitReason?: string;
  agentError?: unknown;
  budgetExceeded?: string | null;
  mutations?: MutationDetectionResult;
  beforeGitState?: WorkspaceGitState | null;
  afterGitState?: WorkspaceGitState | null;
  workspaceRoot?: string;
}

export function countFilesChanged(
  beforeGitState?: WorkspaceGitState | null,
  afterGitState?: WorkspaceGitState | null,
  history?: Message[],
  workspaceRoot?: string
): number {
  const changedFiles = new Set<string>();

  // 1. Git status after session
  if (afterGitState?.status) {
    const lines = afterGitState.status.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const match = line.slice(3).trim();
      if (match) {
        const file = match.includes('->') ? match.split('->').pop()!.trim() : match;
        changedFiles.add(file);
      }
    }
  }

  // 2. Git diff between before head and after head (if commits were created)
  if (beforeGitState?.head && afterGitState?.head && beforeGitState.head !== afterGitState.head) {
    try {
      const res = spawnSync('git', ['diff', '--name-only', beforeGitState.head, afterGitState.head], {
        cwd: workspaceRoot || process.cwd(),
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (res.status === 0 && res.stdout) {
        for (const file of res.stdout.split('\n')) {
          const trimmed = file.trim();
          if (trimmed) {
            changedFiles.add(trimmed);
          }
        }
      }
    } catch {
      // ignore git error
    }
  }

  // 3. Fallback / supplement: tool calls in history
  if (history) {
    for (const msg of history) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.name === 'write_file' || tc.function?.name === 'edit_file') {
            try {
              const args = JSON.parse(tc.function.arguments);
              if (args?.path) {
                changedFiles.add(args.path);
              }
            } catch {
              // ignore JSON error
            }
          }
        }
      }
    }
  }

  return changedFiles.size;
}

export function detectSessionResolution(options: DetectResolutionOptions): ResolutionResult {
  const {
    history = [],
    exitReason,
    agentError,
    budgetExceeded,
    mutations,
    beforeGitState,
    afterGitState,
    workspaceRoot,
  } = options;

  const files_changed = countFilesChanged(beforeGitState, afterGitState, history, workspaceRoot);

  // 1. Unhandled agent / provider error
  if (agentError || exitReason === 'error') {
    const errorMsg =
      agentError instanceof Error
        ? agentError.message
        : typeof agentError === 'string'
        ? agentError
        : 'Agent run failed with error';
    return {
      resolution: 'error',
      resolution_reason: errorMsg,
      files_changed,
      exit_code: EXIT_CODES.ERROR,
    };
  }

  // 2. Budget exceeded
  if (budgetExceeded || exitReason === 'budget_exceeded') {
    const reason = budgetExceeded
      ? `Token or iteration budget limit reached (${budgetExceeded})`
      : 'Token or iteration budget limit reached';
    return {
      resolution: 'budget_exceeded',
      resolution_reason: reason,
      files_changed,
      exit_code: EXIT_CODES.BUDGET_EXCEEDED,
      stdout_marker: budgetExceeded ? `SC_BUDGET_EXCEEDED ${budgetExceeded}` : 'SC_BUDGET_EXCEEDED',
    };
  }

  // Extract last assistant message text
  const lastAssistantMsg = [...history].reverse().find(
    m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0
  );
  const text = lastAssistantMsg ? String(lastAssistantMsg.content) : '';

  // 3. Explicit Verdict Markers in assistant message
  const verdictMarkerRegex = /(?:\[|\b)(?:VERDICT|RESOLUTION)\s*:\s*(NOT_ACTIONABLE|BLOCKED|COMPLETED|NO_CHANGES)(?:\]|\b)[ \t]*[:\-]?\s*(.*)/i;
  const match = text.match(verdictMarkerRegex);
  if (match) {
    const verdictType = match[1].toUpperCase();
    const explicitReason = match[2] ? match[2].trim() : '';

    if (verdictType === 'NOT_ACTIONABLE') {
      const reason = explicitReason || 'Task failure is not actionable by code changes';
      return {
        resolution: 'not_actionable',
        resolution_reason: reason,
        files_changed,
        exit_code: EXIT_CODES.NOT_ACTIONABLE,
        stdout_marker: `SCC_NOT_ACTIONABLE ${reason}`.trim(),
      };
    }

    if (verdictType === 'BLOCKED') {
      const reason = explicitReason || 'Task execution is blocked by external constraints';
      return {
        resolution: 'blocked',
        resolution_reason: reason,
        files_changed,
        exit_code: EXIT_CODES.NOT_ACTIONABLE,
        stdout_marker: `SCC_BLOCKED ${reason}`.trim(),
      };
    }

    if (verdictType === 'NO_CHANGES') {
      const reason = explicitReason || 'No workspace modifications were required';
      return {
        resolution: 'no_changes',
        resolution_reason: reason,
        files_changed,
        exit_code: EXIT_CODES.NO_CHANGES,
        stdout_marker: 'SCC_NO_CHANGES',
      };
    }

    if (verdictType === 'COMPLETED') {
      const reason = explicitReason || 'Task completed successfully';
      return {
        resolution: 'completed',
        resolution_reason: reason,
        files_changed,
        exit_code: EXIT_CODES.SUCCESS,
      };
    }
  }

  const hasMutations = mutations?.hasMutations ?? (files_changed > 0);

  // 4. Zero-mutation / zero files changed heuristics
  if (files_changed === 0 && !hasMutations) {
    // Check for not_actionable indicators
    const notActionablePatterns = [
      /not actionable/i,
      /requires (?:repo-admin|repository admin|admin privileges|administrator privileges|repo admin)/i,
      /cannot be fixed (?:via|by|with) code/i,
      /no code changes can fix/i,
      /outside (?:the )?scope of code/i,
      /human intervention required/i,
      /manual intervention required/i,
      /requires human intervention/i,
      /requires manual intervention/i,
      /ci (?:workflow )?permission/i,
      /branch protection rule/i,
      /unactionable/i,
    ];

    for (const pat of notActionablePatterns) {
      if (pat.test(text)) {
        const sentence = extractMatchingSentence(text, pat) || 'Task is not actionable by code changes';
        return {
          resolution: 'not_actionable',
          resolution_reason: sentence,
          files_changed: 0,
          exit_code: EXIT_CODES.NOT_ACTIONABLE,
          stdout_marker: `SCC_NOT_ACTIONABLE ${sentence}`.trim(),
        };
      }
    }

    // Check for blocked indicators
    const blockedPatterns = [
      /task is blocked/i,
      /execution is blocked/i,
      /blocked by missing/i,
      /blocked due to/i,
    ];

    for (const pat of blockedPatterns) {
      if (pat.test(text)) {
        const sentence = extractMatchingSentence(text, pat) || 'Task execution is blocked';
        return {
          resolution: 'blocked',
          resolution_reason: sentence,
          files_changed: 0,
          exit_code: EXIT_CODES.NOT_ACTIONABLE,
          stdout_marker: `SCC_BLOCKED ${sentence}`.trim(),
        };
      }
    }

    // Default no_changes
    return {
      resolution: 'no_changes',
      resolution_reason: 'No code or workspace modifications were made during session',
      files_changed: 0,
      exit_code: EXIT_CODES.NO_CHANGES,
      stdout_marker: 'SCC_NO_CHANGES',
    };
  }

  // 5. Task completed with workspace modifications
  return {
    resolution: 'completed',
    resolution_reason: `Task completed with ${files_changed} file(s) changed`,
    files_changed,
    exit_code: EXIT_CODES.SUCCESS,
  };
}

function extractMatchingSentence(text: string, pattern: RegExp): string | null {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    if (pattern.test(s)) {
      const cleaned = s.replace(/\s+/g, ' ').trim();
      return cleaned.length > 200 ? cleaned.slice(0, 197) + '...' : cleaned;
    }
  }
  return null;
}
