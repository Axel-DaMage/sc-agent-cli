import prompts from 'prompts';
import chalk from 'chalk';
import type { ProjectConfig } from '../core/types.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDangerousCommand, formatDangerousWarning } from './dangerous-commands.js';
import { boxHeader, boxFooter } from './box-drawing.js';

export interface PermissionContext {
  toolName: string;
  args: Record<string, unknown>;
  config: ProjectConfig;
  autoApprove?: boolean; // Override from CLI flag
}

// Track session-level permissions (reset when process ends)
const sessionAutoApprove = new Set<string>();

// Clear session permissions (used when switching to "always ask" mode)
export function clearSessionPermissions(): void {
  sessionAutoApprove.clear();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match a shell command against permissions.denyCommands patterns.
// Pattern semantics (case-sensitive, whitespace-normalized):
//   - contains '*': full-command glob, '*' matches any character sequence
//   - otherwise:    substring match anywhere in the command
// Returns the matching pattern, or null when the command is allowed.
export function matchDenyCommand(command: string, patterns: string[]): string | null {
  const normalized = command.trim().replace(/\s+/g, ' ');
  for (const raw of patterns) {
    const pattern = (raw || '').trim().replace(/\s+/g, ' ');
    if (!pattern) continue;
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
      if (re.test(normalized)) return raw;
    } else if (normalized.includes(pattern)) {
      return raw;
    }
  }
  return null;
}

// Git subcommands that mutate refs/index/worktree when run via run_shell.
// Listing forms (`git branch`, `git tag` with no extra args) stay allowed.
const GIT_MUTATING_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit',
  'fetch', 'init', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore',
  'revert', 'rm', 'stash', 'submodule', 'switch', 'worktree',
]);
const GIT_ARG_MUTATING_SUBCOMMANDS = new Set(['branch', 'tag']);

// Detect git-mutating invocations inside a shell command string.
// Finds every `git <subcmd>` occurrence (covers `cd x && git commit` chains);
// `git branch`/`git tag` only count as mutating when followed by more args.
export function isGitMutatingCommand(command: string): string | null {
  const gitRe = /\bgit\s+((?:-[A-Za-z]\s+\S+\s+)*)([a-z-]+)([^;&|]*)/g;
  let m: RegExpExecArray | null;
  while ((m = gitRe.exec(command)) !== null) {
    const sub = m[2];
    const rest = (m[3] || '').trim();
    if (GIT_MUTATING_SUBCOMMANDS.has(sub)) return `git ${sub}`;
    if (GIT_ARG_MUTATING_SUBCOMMANDS.has(sub) && rest.length > 0) return `git ${sub}`;
  }
  return null;
}

const GIT_MUTATION_DENIED =
  'Git mutations are managed externally (--no-commit / permissions.denyGitMutation). ' +
  'Make filesystem edits only — do not run git add/commit/checkout/push or any git-mutating command.';

export async function requestPermission(ctx: PermissionContext): Promise<boolean> {
  // Hard deny first: permissions.denyCommands is a non-interactive blocklist
  // that applies to run_shell in every mode — including -y/autoApprove.
  if (ctx.toolName === 'run_shell') {
    const command = (ctx.args.command as string) || '';
    const denied = matchDenyCommand(command, ctx.config.permissions?.denyCommands || []);
    if (denied) {
      throw new Error(
        `Command denied by permissions.denyCommands rule "${denied}": ${command}\n` +
        `This is a hard block — adjust the deny list in your config to allow it.`
      );
    }
  }

  // Hard deny: permissions.denyGitMutation blocks git-mutating operations in
  // every mode — orchestrators (ai-sdlc workers) own git state externally.
  if (ctx.config.permissions?.denyGitMutation) {
    if (ctx.toolName === 'git') {
      const op = (ctx.args.operation as string) || '';
      if (op === 'add' || op === 'commit') {
        throw new Error(`git ${op} denied. ${GIT_MUTATION_DENIED}`);
      }
    }
    if (ctx.toolName === 'run_shell') {
      const command = (ctx.args.command as string) || '';
      const gitOp = isGitMutatingCommand(command);
      if (gitOp) {
        throw new Error(`${gitOp} denied. ${GIT_MUTATION_DENIED}`);
      }
    }
  }

  // Auto-approve if explicitly set in context
  if (ctx.autoApprove) return true;

  // Check permission profile
  const permissionProfile = ctx.config.permissions?.profile || 'traditional';

  // BLACKLIST MODE: Only ask for dangerous commands
  if (permissionProfile === 'blacklist' && ctx.toolName === 'run_shell') {
    const command = (ctx.args.command as string) || '';
    const dangerCheck = isDangerousCommand(command);

    if (!dangerCheck.isDangerous) {
      // Safe command - auto-approve
      return true;
    }

    // Dangerous command - show warning and ask
    console.log(chalk.gray(`\n${boxHeader('Dangerous Command Alert', 2)}`));
    console.log(chalk.gray(`  │ ${chalk.red('⚠️')}  Tool: ${ctx.toolName}`));
    console.log(chalk.gray(`  │    Command: ${command}`));
    console.log(chalk.gray('  │'));

    const warning = formatDangerousWarning(dangerCheck.matches);
    warning.split('\n').forEach(line => {
      console.log(chalk.gray(`  │    ${chalk.yellow(line)}`));
    });

    console.log(chalk.gray(boxFooter(2)));

    const response = await prompts({
      type: 'confirm',
      name: 'approved',
      message: chalk.red('This command is potentially dangerous. Allow anyway?'),
      initial: false,
    });

    if (response.approved === false) {
      console.log(chalk.gray(`\n   ℹ️  Action denied. The agent will try another approach.\n`));
      return false;
    }

    return response.approved ?? false;
  }

  // TRADITIONAL MODE: Continue with normal permission flow
  // Check session-level auto-approve
  if (sessionAutoApprove.has(ctx.toolName)) {
    return true;
  }

  // Check auto-approve list in config
  const autoApproveList = ctx.config.permissions?.autoApprove || [];
  if (autoApproveList.includes(ctx.toolName)) {
    return true;
  }

  // Ask user with helpful context (redact sensitive fields)
  const SENSITIVE_KEYS = new Set([
    'apiKey', 'api_key', 'api-key',
    'password', 'passwd', 'pass',
    'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token',
    'secret', 'secretKey', 'secret_key', 'clientSecret', 'client_secret',
    'auth', 'authorization', 'authToken', 'auth_token',
    'key', 'privateKey', 'private_key', 'publicKey', 'public_key',
    'credential', 'credentials',
    'jwt', 'jwt_token', 'sessionKey', 'session_key',
    'sshKey', 'ssh_key', 'sshPrivateKey',
  ]);
  const redactedArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.args)) {
    redactedArgs[k] = SENSITIVE_KEYS.has(k) ? '***' : v;
  }
  console.log(chalk.gray(`\n${boxHeader('Permission', 2)}`));
  console.log(chalk.gray(`  │ ${chalk.yellow('🔐')} Tool: ${ctx.toolName}`));
  console.log(chalk.gray(`  │    Args: ${JSON.stringify(redactedArgs)}`));
  console.log(chalk.gray(boxFooter(2)));

  const response = await prompts({
    type: 'select',
    name: 'choice',
    message: 'Allow this action?',
    choices: [
      { title: 'Yes (once)', value: 'yes', description: 'Allow this time only' },
      { title: 'Always (save to config)', value: 'always', description: 'Auto-approve forever' },
      { title: 'Session (until exit)', value: 'session', description: 'Auto-approve this session' },
      { title: 'No (deny)', value: 'no', description: 'Deny this action' },
    ],
    initial: 0, // Default to "Yes (once)"
  });

  const choice = response.choice;

  if (!choice || choice === 'no') {
    console.log(chalk.gray(`\n   ℹ️  Action denied. The agent will try another approach.\n`));
    return false;
  }

  if (choice === 'always') {
    // Save to config permanently AND update in-memory config to avoid re-prompting
    try {
      const configDir = path.join(homedir(), '.sc-agent');
      const configPath = path.join(configDir, 'config.json');

      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }

      let configContent: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        const fileContent = readFileSync(configPath, 'utf-8');
        configContent = JSON.parse(fileContent);
      }

      const permissions = (configContent.permissions as { autoApprove?: string[]; profile?: string; denyPaths?: string[] }) || {};
      if (!permissions.autoApprove) {
        permissions.autoApprove = [];
      }
      if (!permissions.autoApprove.includes(ctx.toolName)) {
        permissions.autoApprove.push(ctx.toolName);
        configContent.permissions = permissions;
        writeFileSync(configPath, JSON.stringify(configContent, null, 2));
      }

      // Also update in-memory config for immediate effect in this session
      const configPermissions = ctx.config.permissions;
      if (configPermissions) {
        if (!configPermissions.autoApprove) {
          configPermissions.autoApprove = [];
        }
        if (!configPermissions.autoApprove.includes(ctx.toolName)) {
          configPermissions.autoApprove.push(ctx.toolName);
        }
      }

      console.log(chalk.gray(`\n   ✓ "${ctx.toolName}" auto-approved for this and future sessions\n`));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(chalk.gray(`\n   ⚠️  Could not save to config: ${errorMsg}`));
      console.log(chalk.gray(`   Approved for this session only\n`));
      sessionAutoApprove.add(ctx.toolName);
    }
    return true;
  }

  if (choice === 'session') {
    sessionAutoApprove.add(ctx.toolName);
    console.log(chalk.gray(`\n   ✓ "${ctx.toolName}" auto-approved for this session\n`));
    return true;
  }

  // choice === 'yes'
  return true;
}