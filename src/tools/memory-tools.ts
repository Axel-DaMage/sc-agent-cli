import type { Tool, ToolContext } from './tool.js';
import { persistentMemory, memoryScopeTag } from '../utils/memory.js';
import type { MemoryWriteScope } from '../utils/memory.js';
import { requestPermission } from '../utils/permissions.js';

export const memoryReadTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_read',
      description: 'Read from persistent memory (cross-session). Use this to recall user preferences, project context, and information learned in previous sessions. Memories are scoped per workspace with an opt-in global tier.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Specific memory key to recall (exact match)',
          },
          query: {
            type: 'string',
            description: 'Search query to find relevant memories',
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const key = args.key as string | undefined;
    const query = args.query as string | undefined;

    if (!key && !query) {
      return await persistentMemory.getSummary(ctx.workspaceRoot);
    }

    if (key) {
      const entry = await persistentMemory.recallEntry(key, ctx.workspaceRoot);
      if (entry) {
        return `${memoryScopeTag(entry.scope)} [${entry.key}]\n${entry.content}`;
      }
      return `No memory found with key "${key}". Use memory_write to save information about this topic.`;
    }

    if (query) {
      const results = await persistentMemory.search(query, ctx.workspaceRoot);
      if (results.length === 0) {
        return `No memories found matching "${query}".`;
      }
      return results
        .map(r => `${memoryScopeTag(r.scope)} [${r.key}]\n${r.content.substring(0, 500)}${r.content.length > 500 ? '...' : ''}`)
        .join('\n\n---\n\n');
    }

    return 'No memory found.';
  },
};

export const memoryWriteTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_write',
      description: 'Save information to persistent memory for future sessions. Use for user preferences, project rules, important facts. This data persists across restarts. Default scope is "workspace" (visible only in this project); pass scope "global" to share across all workspaces. Re-writing an existing key in another scope re-files (moves) it.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Unique key (e.g., "user-name", "project-config", "coding-preferences")',
          },
          id: {
            type: 'string',
            description: 'Alias for key — e.g. re-file an existing memory with {id, scope} and no content',
          },
          content: {
            type: 'string',
            description: 'Detailed content to remember. Omit to just move an existing key to the given scope.',
          },
          tags: {
            type: 'string',
            description: 'Comma-separated tags (e.g., "user,preference")',
          },
          scope: {
            type: 'string',
            enum: ['workspace', 'global'],
            description: 'Storage scope: "workspace" (default — this project only) or "global" (all workspaces)',
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const key = (args.key ?? args.id) as string | undefined;
    const content = args.content as string | undefined;
    const tags = (args.tags as string || '').split(',').map(t => t.trim()).filter(Boolean);
    const scope = (args.scope as string | undefined) ?? 'workspace';

    if (!key) {
      throw new Error('Missing required argument: key (or id)');
    }
    if (scope !== 'workspace' && scope !== 'global') {
      throw new Error('Invalid scope: expected "workspace" or "global"');
    }
    const writeScope = scope as MemoryWriteScope;

    const approved = await requestPermission({
      toolName: 'memory_write',
      args,
      config: ctx.config,
      autoApprove: ctx.autoApprove,
    });

    if (!approved) {
      throw new Error('Permission denied by user');
    }

    // Move-only path: {key|id, scope} with no content re-files an existing
    // memory between tiers without rewriting it (#476).
    if (content === undefined || content === '') {
      const existing = await persistentMemory.recallEntry(key, ctx.workspaceRoot);
      if (!existing) {
        throw new Error('Missing required argument: content (required for new memories)');
      }
      const moved = await persistentMemory.move(key, writeScope, ctx.workspaceRoot);
      return `✓ Moved memory "${moved.key}" → ${moved.scope} scope`;
    }

    const entry = await persistentMemory.remember(key, content, tags, { scope: writeScope, workspaceRoot: ctx.workspaceRoot });
    return `✓ Saved to ${entry.scope} memory: "${entry.key}"${tags.length > 0 ? ` [${tags.join(', ')}]` : ''}`;
  },
};
