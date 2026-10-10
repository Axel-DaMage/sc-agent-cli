import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Tool, ToolContext } from './tool.js';
import { requestPermission } from '../utils/permissions.js';
import { buildChildEnv } from '../utils/env-scrub.js';

interface McpInitializeResult {
  serverInfo?: { name: string; version: string };
  capabilities?: string[];
  tools?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
  error?: string;
}

function callMcpInitialize(command: string, args: string[], timeoutMs: number): Promise<McpInitializeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
      // #471 — model-supplied command: never hand it provider credentials.
      env: buildChildEnv(process.env),
    });

    const chunks: Buffer[] = [];
    let initialized = false;
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      child.kill();
      resolve({ error: `Timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      chunks.push(data);
      const output = Buffer.concat(chunks).toString('utf-8');
      if (!initialized && output.includes('initialize')) {
        initialized = true;
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      chunks.push(data);
    });

    const initializeMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'initialize',
      params: {
        protocolVersion: '0.1.0',
        capabilities: {},
        clientInfo: { name: 'sc-agent', version: '0.4.2' },
      },
    }) + '\n';

    child.stdin?.write(initializeMsg);

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf-8');
      if (initialized || output.includes('serverInfo') || output.includes('tools')) {
        try {
          const parsed = JSON.parse(output);
          const result: McpInitializeResult = {};
          if (parsed.result) {
            result.serverInfo = parsed.result.serverInfo;
            result.capabilities = parsed.result.capabilities ? Object.keys(parsed.result.capabilities) : [];
            result.tools = parsed.result.tools || [];
          }
          resolve(result);
        } catch {
          resolve({
            serverInfo: { name: path.basename(command), version: 'unknown' },
            capabilities: [],
            tools: [],
          });
        }
      } else {
        const msg = code !== null
          ? `Process exited with code ${code}`
          : 'Process did not respond to initialize';
        resolve({ error: msg, serverInfo: { name: path.basename(command), version: 'unknown' } });
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ error: `Failed to start: ${err.message}` });
    });
  });
}

export const mcpValidateTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'mcp_validate',
      description: 'Test an MCP server by connecting and validating the initialize handshake. Returns server info, capabilities, and available tools.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Command to start the MCP server (e.g., "node server.js", "python mcp_server.py")',
          },
          args: {
            type: 'string',
            description: 'Space-separated arguments for the command',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 10000)',
          },
        },
        required: ['command'],
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const command = args.command as string;
    const argsStr = (args.args as string) || '';
    const timeout = (args.timeout as number) || 10000;
    const cmdArgs = argsStr ? argsStr.split(/\s+/).filter(Boolean) : [];

    const approved = await requestPermission({
      toolName: 'mcp_validate',
      args,
      config: ctx.config,
      autoApprove: ctx.autoApprove,
    });

    if (!approved) {
      throw new Error('Permission denied by user');
    }

    const result = await callMcpInitialize(command, cmdArgs, timeout);
    const lines: string[] = [];

    if (result.error) {
      lines.push(`⚠ MCP Server test failed:`);
      lines.push(`  Error: ${result.error}`);
      return lines.join('\n');
    }

    lines.push(`✓ MCP Server responded:`);
    if (result.serverInfo) {
      lines.push(`  Name:    ${result.serverInfo.name}`);
      lines.push(`  Version: ${result.serverInfo.version || 'unknown'}`);
    }
    if (result.capabilities && result.capabilities.length > 0) {
      lines.push(`  Capabilities: ${result.capabilities.join(', ')}`);
    }
    if (result.tools && result.tools.length > 0) {
      lines.push(`  Tools (${result.tools.length}):`);
      for (const t of result.tools) {
        const schema = t.inputSchema ? ` (${Object.keys(t.inputSchema).length} params)` : '';
        lines.push(`    • ${t.name}${schema}`);
        if (t.description) {
          lines.push(`      ${t.description}`);
        }
      }
    } else {
      lines.push(`  Tools: none detected (or not advertised)`);
    }

    return lines.join('\n');
  },
};
