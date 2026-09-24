import type { Tool, ToolContext } from './tool.js';
import { resolveSafePath } from '../utils/path-security.js';
import { probeRepo, formatRepoProfileForPrompt, formatRepoProfileJSON } from '../core/repo-probe/index.js';

export const repoProbeTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'repo_probe',
      description:
        'Probe the repository to inspect manifests, detect toolchains, package managers, build/test/lint commands, CI workflows, and frameworks.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path to repository or directory to probe (relative to workspace root, default: workspace root).',
          },
          refresh: {
            type: 'boolean',
            description: 'Force fresh scan bypassing cache (default: false).',
          },
          format: {
            type: 'string',
            enum: ['json', 'summary'],
            description: 'Output format: "json" for structured profile or "summary" for markdown summary (default: "json").',
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
    const safePath = resolveSafePath(rawPath, ctx.workspaceRoot, ctx.config);
    const forceRefresh = Boolean(args.refresh);
    const format = args.format === 'summary' ? 'summary' : 'json';

    try {
      const profile = await probeRepo(safePath, {
        forceRefresh,
        useCache: !forceRefresh,
      });

      if (format === 'summary') {
        return formatRepoProfileForPrompt(profile);
      }

      return formatRepoProfileJSON(profile);
    } catch (err: any) {
      return `[ERROR] Failed to probe repository: ${err.message}`;
    }
  },
};
