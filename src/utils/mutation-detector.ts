import { spawnSync } from 'node:child_process';
import type { Message } from '../core/types.js';

export interface WorkspaceGitState {
  status: string;
  head: string;
}

export interface MutationDetectionResult {
  hasMutations: boolean;
  mutatingToolCalls: number;
  worktreeChanged: boolean;
}

/**
 * Capture the git worktree status and HEAD revision of the workspace.
 * Returns null if the workspace is not a git repository or git fails.
 */
export function getWorkspaceGitState(workspaceRoot: string): WorkspaceGitState | null {
  try {
    const statusRes = spawnSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (statusRes.status !== 0) {
      return null;
    }

    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return {
      status: (statusRes.stdout || '').trim(),
      head: headRes.status === 0 ? (headRes.stdout || '').trim() : '',
    };
  } catch {
    return null;
  }
}

/**
 * Compare two workspace git states. Returns true if files or commits changed.
 */
export function hasWorktreeChanges(
  before: WorkspaceGitState | null,
  after: WorkspaceGitState | null,
): boolean {
  if (!before || !after) {
    return false;
  }
  return before.status !== after.status || before.head !== after.head;
}

/**
 * Known read-only git operations.
 */
const GIT_READ_ONLY_OPERATIONS = new Set(['status', 'diff', 'log', 'show', 'branch']);

/**
 * Known non-mutating / read-only tools.
 */
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_text',
  'code_query',
  'repo_probe',
  'mcp_validate',
  'web_fetch',
  'memory_read',
]);

/**
 * Test whether a shell command contains redirection or commands that mutate the workspace.
 */
export function isMutatingShellCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== 'string') return false;

  const trimmed = cmd.trim();
  if (!trimmed) return false;

  // 1. Check for file redirection (ignoring strings and harmless /dev/null or descriptor redirects)
  // Strip string literals to avoid matching '>' inside quotes like grep ">"
  const strippedStrings = trimmed.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');

  // Strip harmless redirects: /dev/null, /dev/zero, /dev/stdout, /dev/stderr, NUL, and fd duplicates (2>&1, 1>&2)
  const strippedHarmless = strippedStrings
    .replace(/[0-9]?&?>\s*\/dev\/(null|zero|stdout|stderr)\b/g, ' ')
    .replace(/[0-9]?&?>\s*NUL\b/gi, ' ')
    .replace(/[0-9]>&[0-9]/g, ' ')
    .replace(/[0-9]>&-[0-9]?/g, ' ');

  // Any remaining '>' or '>>' indicates output redirection to a file
  if (/[0-9]?&?>{1,2}/.test(strippedHarmless)) {
    return true;
  }

  // Pipe to tee (except tee to /dev/null or NUL)
  if (/\|\s*tee(\s+-[a-zA-Z]+)*\s+(?!\/dev\/null|NUL)\S+/i.test(strippedStrings)) {
    return true;
  }

  // 2. In-place stream editors and patchers
  if (/\bsed\s+.*(-i|--in-place)\b/.test(trimmed)) return true;
  if (/\bperl\s+.*-i\b/.test(trimmed)) return true;
  if (/\bawk\s+.*-i\b/.test(trimmed)) return true;
  if (/\bpatch\b/.test(trimmed)) return true;

  // 3. Filesystem mutating commands
  if (/\b(touch|rm|mv|cp|mkdir|rmdir|unlink|truncate|install)\b/.test(trimmed)) return true;
  if (/\bln\s+(-[a-zA-Z]*s[a-zA-Z]*\s+)?/.test(trimmed)) return true;
  if (/\b(chmod|chown|chgrp)\b/.test(trimmed)) return true;

  // 4. Archive extraction
  if (/\btar\s+.*(-[a-zA-Z]*[xX]|--extract)/.test(trimmed)) return true;
  if (/\b(unzip|gunzip|7z\s+x|unrar)\b/.test(trimmed)) return true;

  // 5. File download commands that write to disk
  if (/\bcurl\s+.*(-[a-zA-Z]*[oO]|--output)\b/.test(trimmed)) return true;
  if (/\bwget\b/.test(trimmed)) return true;

  // 6. Mutating git commands in shell
  if (/\bgit\s+(add|commit|apply|merge|rebase|cherry-pick|revert|reset|clean|pull|stash|init|clone)\b/.test(trimmed)) return true;
  if (/\bgit\s+(checkout|switch)\s+(-b|-c|--orphan)\b/.test(trimmed)) return true;
  if (/\bgit\s+branch\s+(-[dDmM]|--delete)\b/.test(trimmed)) return true;
  if (/\bgit\s+restore\b/.test(trimmed)) return true;

  // 7. Package managers and build mutations
  if (/\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|run\s+build|build)\b/.test(trimmed)) return true;
  if (/\b(pip|pip3|poetry|uv)\s+(install|uninstall|add|remove)\b/.test(trimmed)) return true;
  if (/\bcargo\s+(add|remove|build|install)\b/.test(trimmed)) return true;
  if (/\bgo\s+(get|install|build)\b/.test(trimmed)) return true;
  if (/\bcomposer\s+(require|install|update|remove)\b/.test(trimmed)) return true;
  if (/\b(mvn|gradle)\b/.test(trimmed)) return true;
  if (/\bdotnet\s+(add|build|publish|new)\b/.test(trimmed)) return true;
  if (/\b(make|cmake|gcc|g\+\+|clang|clang\+\+|rustc)\b/.test(trimmed)) return true;
  if (/\btsc\b/.test(trimmed) && !/--noEmit\b/.test(trimmed)) return true;
  if (/\beslint\s+.*--fix\b/.test(trimmed)) return true;
  if (/\bprettier\s+.*--write\b/.test(trimmed)) return true;

  // 8. Windows / PowerShell mutating commands
  if (/\b(copy|move|del|erase|ren|rename|md|rd)\b/i.test(trimmed)) return true;
  if (/\b(Out-File|Set-Content|Add-Content|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item)\b/i.test(trimmed)) return true;

  return false;
}

/**
 * Check whether a tool invocation is mutating.
 */
export function isMutatingToolCall(toolName: string, args?: unknown): boolean {
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'memory_write') {
    return true;
  }

  if (READ_ONLY_TOOLS.has(toolName)) {
    return false;
  }

  let parsedArgs: Record<string, unknown> | null = null;
  if (typeof args === 'string') {
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      parsedArgs = null;
    }
  } else if (args && typeof args === 'object') {
    parsedArgs = args as Record<string, unknown>;
  }

  if (toolName === 'git') {
    const op = typeof parsedArgs?.operation === 'string' ? parsedArgs.operation.toLowerCase() : '';
    if (GIT_READ_ONLY_OPERATIONS.has(op)) {
      return false;
    }
    return true;
  }

  if (toolName === 'run_shell') {
    const cmd = typeof parsedArgs?.command === 'string' ? parsedArgs.command : '';
    return isMutatingShellCommand(cmd);
  }

  // Unknown tool - if tool name suggests mutation, treat as mutating
  if (/write|edit|delete|remove|create|patch|update|mutate|modify/i.test(toolName)) {
    return true;
  }

  return false;
}

/**
 * Workspace-scoped variant of {@link isMutatingToolCall}: `memory_write`
 * mutates the persistent memory store (~/.sc-agent), not the workspace,
 * so it does not count as a workspace mutation for the zero-mutation
 * completion guard (#448).
 */
export function isWorkspaceMutatingToolCall(toolName: string, args?: unknown): boolean {
  if (toolName === 'memory_write') return false;
  return isMutatingToolCall(toolName, args);
}

/**
 * Count mutating tool calls in a message history.
 */
export function countMutatingToolCalls(history: Message[]): number {
  let count = 0;
  for (const m of history) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (isMutatingToolCall(tc.function.name, tc.function.arguments)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Heuristic: does the user prompt request workspace changes? (#448)
 *
 * Used by the agent loop to decide whether a turn may legitimately
 * complete with zero mutating tool calls. Recall beats precision — a
 * false positive costs at most a bounded re-prompt, while a false
 * negative re-opens the zero-mutation failure signature.
 */
const MUTATION_INTENT_PATTERN = new RegExp(
  `\\b(${[
    'fix',
    'implement',
    'add',
    'creat',
    'writ',
    'edit',
    'updat',
    'refactor',
    'patch',
    'delet',
    'remov',
    'renam',
    'mov',
    'modif',
    'chang',
    'resolv',
    'migrat',
    'install',
    'uninstall',
    'commit',
    'apply',
    'insert',
    'append',
    'replac',
    'revert',
    'configur',
    'scaffold',
    'generat',
    'upgrad',
    'downgrad',
    'bump',
    'repair',
    'correct',
    'adjust',
    'rewrit',
    'extend',
    'introduc',
    'merg',
    'restor',
    'rework',
    'address',
    'handle',
    'deploy',
    'improv',
    'optimi',
    'set\\s+up',
    'clean\\s*up',
    'issue\\s*#?\\d+',
    'pr\\s*#?\\d+',
  ].join('|')})`,
  'i',
);

export function expectsWorkspaceMutation(prompt: string): boolean {
  if (!prompt || typeof prompt !== 'string') return false;
  return MUTATION_INTENT_PATTERN.test(prompt);
}

/**
 * Detect an explicit "no changes needed" verdict in an assistant
 * response (#448). When the model states the task is complete without
 * requiring file changes, the zero-mutation completion guard honors
 * the verdict instead of re-prompting pointlessly.
 */
const NO_CHANGES_VERDICT_PATTERN =
  /\b(?:no\s+(?:file\s+|code\s+|workspace\s+)?changes?\s+(?:is|are|was|were)?\s*(?:required|needed|necessary)|nothing\s+to\s+(?:change|modify|fix|commit|push|add|update|do)|already\s+(?:fixed|implemented|applied|present|done|resolved|covered|in\s+place|up\s+to\s+date|passes|works|exists|committed)|no\s+(?:modifications?|updates?|edits?)\s+(?:is|are|was|were)?\s*(?:required|needed|necessary|made)|does\s+not\s+require\s+(?:any\s+)?(?:changes?|modifications?|edits?)|no\s+files?\s+(?:were|was|needs?|required)\s+(?:to\s+be\s+)?(?:changed|modified|created|updated|edited))/i;

export function declaresNoChangesNeeded(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  return NO_CHANGES_VERDICT_PATTERN.test(content);
}

/**
 * Evaluate session mutations considering both git worktree state and tool call history.
 */
export function detectSessionMutations(
  history: Message[],
  beforeState: WorkspaceGitState | null,
  afterState: WorkspaceGitState | null,
): MutationDetectionResult {
  const mutatingToolCalls = countMutatingToolCalls(history);
  const worktreeChanged = hasWorktreeChanges(beforeState, afterState);
  const hasMutations = worktreeChanged || mutatingToolCalls > 0;
  return {
    hasMutations,
    mutatingToolCalls,
    worktreeChanged,
  };
}
