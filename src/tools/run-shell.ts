import { spawn } from 'node:child_process';
import type { Tool, ToolContext } from './tool.js';
import { requestPermission } from '../utils/permissions.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export const runShellTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Execute a shell command (requires explicit permission). Git-mutating commands (checkout, restore, reset, clean, stash, add, commit, push, ...) are refused in unattended mode — use the dedicated git tool for repo state.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 30000)',
          },
        },
        required: ['command'],
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const command = args.command as string;
    const timeout = (args.timeout as number) || 30000;

    if (!command) {
      throw new Error('Missing required argument: command');
    }

    // Reject null bytes to prevent injection via encoding tricks
    if (command.includes('\0')) {
      throw new Error('Command contains null bytes');
    }

    const approved = await requestPermission({
      toolName: 'run_shell',
      args,
      config: ctx.config,
      autoApprove: ctx.autoApprove,
    });

    if (!approved) {
      throw new Error('Permission denied by user');
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, [], {
        shell: true,
        cwd: ctx.workspaceRoot,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Give process 2s to exit gracefully, then force kill
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 2000);
      }, timeout);

      const appendOutput = (data: Buffer, target: 'stdout' | 'stderr') => {
        const buf = data.toString();
        if (target === 'stdout') {
          stdout += buf;
        } else {
          stderr += buf;
        }
        const total = Buffer.byteLength(stdout, 'utf-8') + Buffer.byteLength(stderr, 'utf-8');
        if (total > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM');
          clearTimeout(timer);
          reject(new Error(`Output exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MB limit`));
        }
      };

      child.stdout?.on('data', (data: Buffer) => appendOutput(data, 'stdout'));
      child.stderr?.on('data', (data: Buffer) => appendOutput(data, 'stderr'));

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          const trunc = (stdout + stderr).substring(0, 1000);
          reject(new Error(`Command timed out after ${timeout}ms\n${trunc}`));
          return;
        }
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
        if (code !== 0) {
          reject(new Error(`Command exited with code ${code}\n${output}`));
        } else {
          resolve(output || '(no output)');
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to execute command: ${err.message}`));
      });
    });
  },
};
