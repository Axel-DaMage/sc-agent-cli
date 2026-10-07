import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectConfig } from './types.js';
import { resolveSafePath } from '../utils/path-security.js';

const CONTEXT_FILES = ['AGENTS.md', 'SC-AGENT.md', 'CLAUDE.md'];

// Cache to avoid re-reading context files in the same session
interface ContextCache {
  workspaceRoot: string;
  policyFile?: string;
  content: string | null;
}

let contextCache: ContextCache | null = null;

const MINIMAL_CONFIG: ProjectConfig = {
  model: { provider: 'openai-compatible', baseUrl: '', model: '' },
  permissions: { denyPaths: ['.env', '.env.*', '**/*.key', '**/*.pem'] },
};

export async function loadProjectContext(
  workspaceRoot: string,
  policyFile?: string
): Promise<string | null> {
  // Return cached content if same workspace and policy
  if (
    contextCache &&
    contextCache.workspaceRoot === workspaceRoot &&
    contextCache.policyFile === policyFile
  ) {
    return contextCache.content;
  }

  const parts: string[] = [];

  // Load project-level context files (AGENTS.md, CLAUDE.md, etc.)
  for (const filename of CONTEXT_FILES) {
    try {
      const safePath = resolveSafePath(filename, workspaceRoot, MINIMAL_CONFIG);
      const content = await readFile(safePath, 'utf-8');
      parts.push(`# ${filename}\n${content}`);
    } catch {
      // File doesn't exist or path denied — skip
    }
  }

  // Load external policy file if configured (e.g. ADEV.md as base doctrine)
  if (policyFile) {
    const policy = await loadPolicyFile(workspaceRoot, policyFile);
    if (policy) parts.push(policy);
  }

  const result = parts.length > 0 ? parts.join('\n\n---\n\n') : null;

  // Cache the result
  contextCache = { workspaceRoot, policyFile, content: result };

  return result;
}

/**
 * Load just the configured policy file (#461). In skeleton context mode the
 * auto-discovered context files (AGENTS.md & co.) are replaced by the repo
 * map, but an explicitly configured policyFile is operator doctrine and is
 * still injected — this loader backs that path. Best-effort: unreadable or
 * denied paths return null instead of throwing.
 */
export async function loadPolicyFile(
  workspaceRoot: string,
  policyFile: string
): Promise<string | null> {
  try {
    const safePath = resolveSafePath(policyFile, workspaceRoot, MINIMAL_CONFIG);
    const content = await readFile(safePath, 'utf-8');
    return `# Policy: ${path.basename(safePath)}\n${content}`;
  } catch {
    return null;
  }
}

// Clear cache (useful for testing or when workspace changes)
export function clearProjectContextCache(): void {
  contextCache = null;
}
