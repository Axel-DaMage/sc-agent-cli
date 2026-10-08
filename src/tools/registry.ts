import type { Tool } from './tool.js';
import { requestPermission } from '../utils/permissions.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { listDirTool } from './list-dir.js';
import { searchTextTool } from './search-text.js';
import { runShellTool } from './run-shell.js';
import { webFetchTool } from './web-fetch.js';
import { memoryReadTool, memoryWriteTool } from './memory-tools.js';
import { gitTool } from './git-tool.js';
import { codeQueryTool } from './code-query.js';
import { mcpValidateTool } from './mcp-validate-tool.js';
import { repoProbeTool } from './repo-probe-tool.js';

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  searchTextTool,
  runShellTool,
  webFetchTool,
  memoryReadTool,
  memoryWriteTool,
  gitTool,
  codeQueryTool,
  mcpValidateTool,
  repoProbeTool,
];

export function getToolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.definition.function.name === name);
}

/**
 * Wrap an externally-sourced tool in the standard permission gate (#485).
 * Plugin modules (#400) and MCP server tools (#401) are arbitrary code that
 * cannot be trusted to self-gate, so the registry routes every external call
 * through requestPermission before the tool's own execute runs — identical
 * to how built-in tools self-gate: `permissions.autoApprove` entries,
 * -y / --permissions unlimited, and session grants approve silently, and
 * anything else prompts the user.
 */
function withPermissionGate(tool: Tool): Tool {
  const toolName = tool.definition.function.name;
  return {
    definition: tool.definition,
    async execute(args, ctx) {
      const approved = await requestPermission({
        toolName,
        args,
        config: ctx.config,
        autoApprove: ctx.autoApprove,
      });
      if (!approved) {
        throw new Error('Permission denied by user');
      }
      return tool.execute(args, ctx);
    },
  };
}

/**
 * Merge external plugin tools into the registry (#400). Name collisions
 * with built-ins or other plugins are skipped with a warning — plugin
 * tools can never shadow core tools. Every registered external tool is
 * wrapped with the permission gate.
 */
export function registerPluginTools(tools: Tool[]): void {
  for (const tool of tools) {
    const name = tool.definition.function.name;
    if (ALL_TOOLS.some((t) => t.definition.function.name === name)) {
      console.error(`⚠️  Plugin tool "${name}" conflicts with an existing tool — skipped.`);
      continue;
    }
    ALL_TOOLS.push(withPermissionGate(tool));
  }
}
