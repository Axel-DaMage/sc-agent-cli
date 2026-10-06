import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool, ToolContext } from './tool.js';
import { requestPermission } from '../utils/permissions.js';
import { formatSandboxViolations } from '../utils/sandbox.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

interface SpawnSpec {
  file: string;
  argv: string[];
  shell: boolean;
  env?: NodeJS.ProcessEnv;
  /** stdio[3] carries the cBPF blob when a seccomp fd is in play. */
  seccompFd?: number;
  seccompBlob?: Buffer;
}

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

    // #423 — sandboxed execution. Failures preparing the sandbox fail closed:
    // the command is never silently run outside the requested boundary.
    const sandbox = ctx.sandbox?.enabled ? ctx.sandbox : undefined;
    let spec: SpawnSpec = { file: command, argv: [], shell: true };
    let violationMark = 0;
    if (sandbox) {
      violationMark = sandbox.violations.length;
      try {
        const plan = await sandbox.prepareSpawn(command);
        spec = {
          file: plan.file,
          argv: plan.argv,
          shell: plan.shell,
          env: plan.env,
          seccompFd: plan.seccompFd,
          seccompBlob: plan.seccompBlob,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[SANDBOX_VIOLATION] ${JSON.stringify({ rule: 'spawn', target: 'sandbox-setup' })}\n` +
            `Sandboxed execution unavailable: ${detail}\n` +
            `The command was NOT executed — the sandbox boundary could not be established.`,
        );
      }
    }

    return new Promise((resolve, reject) => {
      const child: ChildProcess = spec.shell
        ? spawn(spec.file, [], {
            shell: true,
            cwd: ctx.workspaceRoot,
            env: spec.env,
          })
        : spawn(spec.file, spec.argv, {
            cwd: ctx.workspaceRoot,
            env: spec.env,
            stdio: spec.seccompFd !== undefined ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
          });

      // Feed the cBPF program into the fd bwrap reads its seccomp rules from.
      if (spec.seccompFd !== undefined && spec.seccompBlob) {
        try {
          const fdStream = child.stdio?.[spec.seccompFd];
          if (fdStream && typeof fdStream === 'object' && 'write' in fdStream) {
            (fdStream as NodeJS.WritableStream).write(spec.seccompBlob);
            (fdStream as NodeJS.WritableStream).end();
          }
        } catch {
          // Spawn raced a failure — the 'error'/'close' handlers report it.
        }
      }

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

      const collectViolations = (): string => {
        if (!sandbox) return '';
        const stderrViolations = sandbox.collectStderrViolations(stderr);
        const newViolations = [...sandbox.violations.slice(violationMark), ...stderrViolations];
        // violations.slice(mark) already covers proxy events; stderr scan adds
        // fs/seccomp denials — dedupe identical rule+target pairs.
        const seen = new Set<string>();
        const unique = newViolations.filter((v) => {
          const k = `${v.rule}:${v.target}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        return formatSandboxViolations(unique);
      };

      child.on('close', (code) => {
        clearTimeout(timer);
        const violationBlock = collectViolations();
        if (timedOut) {
          const trunc = (stdout + stderr).substring(0, 1000);
          reject(new Error(`Command timed out after ${timeout}ms\n${trunc}${violationBlock ? `\n${violationBlock}` : ''}`));
          return;
        }
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
        if (code !== 0) {
          reject(new Error(`Command exited with code ${code}\n${output}${violationBlock ? `\n${violationBlock}` : ''}`));
        } else {
          resolve(
            (output || '(no output)') +
              (violationBlock ? `\n\n[SANDBOX] violation(s) observed during this command:\n${violationBlock}` : ''),
          );
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        const violationBlock = collectViolations();
        reject(new Error(`Failed to execute command: ${err.message}${violationBlock ? `\n${violationBlock}` : ''}`));
      });
    });
  },
};
