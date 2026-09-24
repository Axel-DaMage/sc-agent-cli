import type { Tool } from './tool.js';
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
 * Merge external plugin tools into the registry (#400). Name collisions
 * with built-ins or other plugins are skipped with a warning — plugin
 * tools can never shadow core tools.
 */
export function registerPluginTools(tools: Tool[]): void {
  for (const tool of tools) {
    const name = tool.definition.function.name;
    if (ALL_TOOLS.some((t) => t.definition.function.name === name)) {
      console.error(`⚠️  Plugin tool "${name}" conflicts with an existing tool — skipped.`);
      continue;
    }
    ALL_TOOLS.push(tool);
  }
}
