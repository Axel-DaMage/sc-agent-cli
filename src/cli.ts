#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';

// Force color support for markdown rendering and UI
if (chalk.level < 2) chalk.level = 2;
import { createRequire } from 'node:module';
import { loadConfig, initConfig, getGlobalConfigPath } from './core/config.js';
import { startChatSession } from './commands/chat-session.js';
import { listProfiles, addProfile, useProfile, removeProfile } from './commands/profile.js';
import { initProject } from './commands/init-command.js';
import { showConfig } from './utils/config-display.js';
import { setVerboseLevel, verbose } from './utils/verbose-logger.js';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('sc')
  .description('Provider-agnostic CLI agent with tool use')
  .version(packageVersion)
  .showHelpAfterError();

// Chat command (default)
program
  .command('chat', { isDefault: true })
  .description('Start an interactive chat session')
  .argument('[prompt]', 'Optional prompt for non-interactive mode')
  .option('-y, --yes', 'Auto-approve all tool executions (use with caution)')
  .option('-q, --quiet', 'Suppress UI decorations (for non-interactive use)')
  .option('--clear', 'Clear conversation history for this workspace before starting')
  .option('-m, --profile <profile>', 'Model profile to use for this session')
  .option('--permissions <mode>', 'Permissions mode: ask_once, always_ask, or unlimited')
  .option('-v, --verbose', 'Verbose debug logging (use -v, -vv, -vvv for level)')
  .option('--max-tokens <tokens>', 'Max response tokens (number or "unlimited"). Overrides config.')
  .option('--throttle <delay>', 'Enable throttling with min delay in ms (e.g. --throttle 2000) or "auto"')
  .option('--timeout <ms>', 'Connection timeout in ms (e.g. --timeout 180000 for 3 min). Overrides config and provider default.')
  .option('--no-commit', 'Hard-block git mutations inside the session (for orchestrators that own git state)')
  .action(async (prompt: string | undefined, options) => {
    try {
      // Count -v flags from raw argv
      const verboseCount = (() => {
        let count = 0;
        for (const arg of process.argv) {
          if (arg === '-v' || arg === '--verbose') count++;
          else if (/^-v{2,}$/.test(arg)) count += arg.length - 1;
        }
        return Math.min(count, 3);
      })();
      setVerboseLevel(verboseCount as any);

      let config = await loadConfig(process.cwd());

      // If a profile option is provided, override the active profile in config
      if (options.profile) {
        if (!config.profiles?.[options.profile]) {
          console.error(chalk.red(`Error: Profile "${options.profile}" not found`));
          process.exit(1);
        }
        config.activeProfile = options.profile;
        const profile = config.profiles[options.profile];
        config.model = {
          ...config.model,
          ...profile,
        };

        // Clean placeholder key
        if (config.model.apiKey?.startsWith('<YOUR_')) {
          config.model.apiKey = undefined;
        }

        // Re-apply environment variable overrides
        const envApiKey = process.env.SC_API_KEY
          || process.env.OPENAI_API_KEY
          || process.env.ANTHROPIC_API_KEY
          || process.env.NVIDIA_API_KEY;
        if (envApiKey) {
          config.model.apiKey = envApiKey;
        }
      }

      // Apply --max-tokens override
      if (options.maxTokens !== undefined) {
        if (options.maxTokens === 'unlimited' || options.maxTokens === 'null') {
          config.model.maxTokens = null;
          verbose('Max tokens set to UNLIMITED (null). Provider/model will determine response length.');
        } else {
          const parsed = parseInt(options.maxTokens, 10);
          if (isNaN(parsed) || parsed < 1) {
            console.error(chalk.red('Error: --max-tokens must be a positive number or "unlimited"'));
            process.exit(1);
          }
          config.model.maxTokens = parsed;
          verbose(`Max tokens set to ${parsed}`);
        }
      }

      // Apply --throttle override
      if (options.throttle !== undefined) {
        if (!config.settings) config.settings = {};
        const val = options.throttle.toLowerCase();
        if (val === 'auto') {
          config.settings.throttling = { enabled: true, mode: 'auto' };
        } else {
          if (!/^\d+$/.test(val)) {
            console.error(chalk.red('Error: --throttle must be a positive integer (ms) or "auto"'));
            process.exit(1);
          }
          const parsed = parseInt(val, 10);
          if (isNaN(parsed) || parsed < 0) {
            console.error(chalk.red('Error: --throttle must be a positive integer (ms) or "auto"'));
            process.exit(1);
          }
          config.settings.throttling = { enabled: true, minDelayMs: parsed, mode: 'fixed' };
        }
      }

      // Apply --timeout override
      if (options.timeout !== undefined) {
        if (!/^\d+$/.test(options.timeout)) {
          console.error(chalk.red('Error: --timeout must be a positive integer (ms)'));
          process.exit(1);
        }
        const parsed = parseInt(options.timeout, 10);
        if (isNaN(parsed) || parsed < 1000) {
          console.error(chalk.red('Error: --timeout must be at least 1000 (1 second)'));
          process.exit(1);
        }
        config.model.timeout = parsed;
      }

      // --no-commit: orchestrators own git state — hard-block mutations in-session
      if (options.commit === false) {
        config.permissions = { ...config.permissions, denyGitMutation: true };
      }

      // Permissions mode mapping
      let permMode: 'ask_once' | 'always_ask' | 'unlimited' | undefined = options.yes ? 'unlimited' : undefined;
      if (options.permissions) {
        if (!['ask_once', 'always_ask', 'unlimited'].includes(options.permissions)) {
          console.error(chalk.red(`Error: Invalid permissions mode. Choose ask_once, always_ask, or unlimited`));
          process.exit(1);
        }
        permMode = options.permissions as 'ask_once' | 'always_ask' | 'unlimited';
      }

      await startChatSession({
        workspaceRoot: process.cwd(),
        config,
        autoApprove: permMode === 'unlimited',
        initialPrompt: prompt,
        quiet: options.quiet,
        clearHistory: options.clear,
        permissionMode: permMode,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${errorMsg}`));
      process.exit(1);
    }
  });

// Profile management
const profileCommand = program.command('profile').description('Manage model profiles');

profileCommand
  .command('list')
  .description('List all available profiles')
  .action(listProfiles);

profileCommand
  .command('add [name]')
  .description('Add a new profile')
  .option('--api-url <url>', 'Base API URL for the provider')
  .option('--model <model>', 'Model identifier')
  .option('--api-key <key>', 'API key for the provider')
  .action(addProfile);

profileCommand
  .command('use [name]')
  .description('Switch to a profile')
  .action(useProfile);

profileCommand
  .command('remove [name]')
  .description('Remove a profile')
  .action(removeProfile);

// Init command
program
  .command('init')
  .description('Initialize a new project with AGENTS.md')
  .option('-f, --force', 'Overwrite an existing AGENTS.md file')
  .action(async (options) => {
    await initProject(process.cwd(), options.force);
  });

// Resume command
program
  .command('resume')
  .description('Resume the last interrupted session from a checkpoint')
  .action(async () => {
    const { resumeSession } = await import('./commands/resume-command.js');
    await resumeSession(process.cwd());
  });

// Task management
const taskCommand = program.command('task').description('Manage task templates and checklists');

taskCommand
  .command('create <template> <description>')
  .description('Create a task from a template with description')
  .action(async (template, description) => {
    const { taskCommand } = await import('./commands/task-command.js');
    await taskCommand.create(template, description, process.cwd());
  });

taskCommand
  .command('list')
  .description('List all tasks in the current project')
  .action(async () => {
    const { taskCommand } = await import('./commands/task-command.js');
    await taskCommand.list(process.cwd());
  });

taskCommand
  .command('templates')
  .description('List available task templates')
  .action(async () => {
    const { taskCommand } = await import('./commands/task-command.js');
    await taskCommand.templates();
  });

// Show current configuration
program
  .command('config')
  .description('Show current full configuration')
  .action(async () => {
    try {
      const config = await loadConfig(process.cwd());
      await showConfig(config);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${errorMsg}`));
      process.exit(1);
    }
  });

// Config init
program
  .command('config-init')
  .description('Initialize global config with default profiles')
  .option('-f, --force', 'Overwrite an existing global config file')
  .action(async (options) => {
    try {
      await initConfig(options.force);
      console.log(chalk.green(`✓ Config initialized at ${getGlobalConfigPath()}`));
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${errorMsg}`));
      process.exit(1);
    }
  });

program.parse();
