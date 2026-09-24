import type { Tool } from '../tools/tool.js';
import { McpClient, McpServerSpec } from './client.js';
import { verboseError, verbose } from '../utils/verbose-logger.js';

/**
 * Wrap MCP server tools as local Tool instances (#401).
 *
 * Config:
 *   "mcp": { "servers": { "context7": { "command": "npx", "args": [...] } } }
 *
 * Remote tools surface as `mcp__<server>__<tool>` and flow through the
 * existing permission system like built-ins. A server that fails to spawn,
 * times out, or crashes mid-session degrades to per-call errors — it never
 * kills the agent loop.
 */

const liveClients: McpClient[] = [];

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function connectMcpServers(
  servers: Record<string, McpServerSpec>,
): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const [serverName, spec] of Object.entries(servers)) {
    const client = new McpClient(serverName, spec);
    try {
      const remote = await client.connect();
      liveClients.push(client);
      for (const rt of remote) {
        const localName = `mcp__${sanitizeName(serverName)}__${sanitizeName(rt.name)}`;
        const remoteName = rt.name;
        tools.push({
          definition: {
            type: 'function',
            function: {
              name: localName,
              description: rt.description ?? `MCP tool ${remoteName} (server: ${serverName})`,
              parameters: rt.inputSchema ?? { type: 'object', properties: {} },
            },
          },
          async execute(args) {
            return client.callTool(remoteName, args);
          },
        });
      }
      verbose(`MCP server "${serverName}": ${remote.length} tool(s) registered`);
    } catch (e) {
      verboseError(`MCP server "${serverName}" failed: ${e instanceof Error ? e.message : String(e)} — skipped.`);
      client.kill();
    }
  }
  return tools;
}

/** Kill every connected MCP server (call on CLI shutdown). */
export function shutdownMcpServers(): void {
  for (const c of liveClients) c.kill();
  liveClients.length = 0;
}
