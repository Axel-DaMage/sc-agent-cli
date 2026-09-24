#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';

// Force color support for markdown rendering and UI
if (chalk.level < 2) chalk.level = 2;
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, initConfig, getGlobalConfigPath } from './core/config.js';
import { startChatSession } from './commands/chat-session.js';
import { listProfiles, addProfile, useProfile, removeProfile } from './commands/profile.js';
import { initProject } from './commands/init-command.js';
import { probeCommand } from './commands/probe-command.js';
import { runDoctor } from './commands/doctor.js';
import { showConfig } from './utils/config-display.js';
import { setVerboseLevel, verbose } from './utils/verbose-logger.js';
import { classifyError } from './utils/exit-codes.js';

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
  .option('--resume [ref]', 'Resume a checkpoint: session id, .json path, or "latest" (default when flag is bare)')
  .option('--audit-log <path>', 'Append a JSONL audit event per LLM call and tool execution (headless forensics)')
  .option('--livelock-threshold <n>', 'Abort after N consecutive responses without tool calls (default: 3 with -y, 0 disables)')
  .option('--summary-file <path>', 'Write the JSON run manifest to this file on exit (headless mode)')
  .option('--output-file <path>', 'Alias of --summary-file (headless mode)')
  .option('--output-format <format>', 'Batch stdout format: "text" (default) or "json" (manifest only)')
  .option('--max-steps <n>', 'Stop gracefully after N tool executions (env: SC_MAX_STEPS)')
  .option('--max-seconds <n>', 'Stop gracefully after N seconds of wall-clock time (env: SC_MAX_SECONDS)')
  .option('--max-total-tokens <n>', 'Stop gracefully when estimated session tokens exceed N (env: SC_MAX_TOTAL_TOKENS)')
  .option('--no-commit', 'Hard-block git mutations inside the session (for orchestrators that own git state)')
  .option('--prompt-file <path>', 'Read the prompt from a file (use "-" to read from stdin). Mutually exclusive with the prompt argument.')
  .action(async (prompt: string | undefined, options) => {
    try {
      // --prompt-file: load the prompt from a file instead of argv (#413).
      // Large prompts passed as argv hit shell quoting/escaping issues and
      // ARG_MAX limits; a file (or stdin) avoids both.
      if (options.promptFile !== undefined) {
        if (prompt !== undefined) {
          console.error(chalk.red('Error: cannot combine a [prompt] argument with --prompt-file'));
          process.exit(1);
        }
        try {
          prompt = options.promptFile === '-'
            ? readFileSync(0, 'utf-8')
            : readFileSync(resolve(options.promptFile), 'utf-8');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: cannot read prompt file "${options.promptFile}": ${msg}`));
          process.exit(1);
        }
        if (!prompt.trim()) {
          console.error(chalk.red(`Error: prompt file "${options.promptFile}" is empty`));
          process.exit(1);
        }
      }

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

      // --resume: resolve checkpoint ref (latest | sessionId | .json path)
      let resumeCheckpoint;
      if (options.resume !== undefined) {
        const { resolveCheckpointRef } = await import('./commands/resume-command.js');
        resumeCheckpoint = resolveCheckpointRef(options.resume, process.cwd());
        if (!resumeCheckpoint) {
          console.error(chalk.red(`Error: no checkpoint found for "${options.resume === true ? 'latest' : options.resume}" in this workspace`));
          process.exit(1);
        }
      }

      let livelockThreshold: number | undefined;
      if (options.livelockThreshold !== undefined) {
        livelockThreshold = parseInt(options.livelockThreshold, 10);
        if (isNaN(livelockThreshold) || livelockThreshold < 0) {
          console.error(chalk.red(`Error: --livelock-threshold must be a non-negative integer`));
          process.exit(1);
        }
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

      // MCP servers (#401): connect stdio servers and register their tools
      // as mcp__<server>__<tool>. Failure isolates per-server.
      if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
        const { connectMcpServers, shutdownMcpServers } = await import('./mcp/server-tools.js');
        const { registerPluginTools } = await import('./tools/registry.js');
        registerPluginTools(await connectMcpServers(config.mcp.servers));
        process.on('exit', shutdownMcpServers);
      }
      // External tool plugins (#400): load before session so tools appear
      // in the schema. Warn-and-skip on failure — never crash the CLI.
      if (Array.isArray(config.plugins) && config.plugins.length > 0) {
        const { loadPluginTools } = await import('./tools/plugin-loader.js');
        const { registerPluginTools } = await import('./tools/registry.js');
        registerPluginTools(await loadPluginTools(config.plugins, process.cwd()));
      }
      const outputFormat = options.outputFormat ?? 'text';
      if (outputFormat !== 'text' && outputFormat !== 'json') {
        console.error(chalk.red(`Error: --output-format must be "text" or "json", got "${outputFormat}"`));
        process.exit(1);
      }
      // Execution budgets: flag > env var; must be positive integers
      const budgetOpt = (flag: string | undefined, env: string | undefined, name: string): number | undefined => {
        const raw = flag ?? env;
        if (raw === undefined) return undefined;
        const n = parseInt(raw, 10);
        if (isNaN(n) || n <= 0) {
          console.error(chalk.red(`Error: ${name} must be a positive integer`));
          process.exit(1);
        }
        return n;
      };

      await startChatSession({
        workspaceRoot: process.cwd(),
        config,
        autoApprove: permMode === 'unlimited',
        initialPrompt: prompt,
        quiet: options.quiet || outputFormat === 'json',
        clearHistory: options.clear,
        permissionMode: permMode,
        sessionId: resumeCheckpoint?.sessionId,
        resumeCheckpoint,
        auditLog: options.auditLog,
        livelockThreshold,
        summaryFile: options.summaryFile,
        outputFile: options.outputFile,
        outputFormat,
        maxSteps: budgetOpt(options.maxSteps, process.env.SC_MAX_STEPS, '--max-steps'),
        maxSeconds: budgetOpt(options.maxSeconds, process.env.SC_MAX_SECONDS, '--max-seconds'),
        maxTotalTokens: budgetOpt(options.maxTotalTokens, process.env.SC_MAX_TOTAL_TOKENS, '--max-total-tokens'),
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${errorMsg}`));
      process.exit(classifyError(err));
    }
  });

// Doctor: preflight diagnostics for headless/automation use
program
  .command('doctor')
  .description('Diagnose config, provider connectivity, API key, and effective permissions')
  .option('-m, --profile <profile>', 'Check a specific profile as if passed to chat')
  .option('--permissions <mode>', 'Check a permissions override as if passed to chat')
  .action(async (options) => {
    await runDoctor(options);
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

// Probe repository profile
program
  .command('probe [path]')
  .alias('repo-profile')
  .alias('repo-probe')
  .description('Auto-detect toolchain, package manager, and build/test/lint commands for a repository')
  .option('-j, --json', 'Output repository profile as JSON')
  .option('-s, --save', 'Save profile to .sc-agent/repo-profile.json')
  .option('--no-cache', 'Bypass cache and force a fresh repository probe')
  .option('-q, --quiet', 'Suppress terminal output')
  .option('--prompt', 'Output formatted markdown for system prompt injection')
  .action(async (targetPath, options) => {
    await probeCommand(targetPath, options);
  });

program.parse();
