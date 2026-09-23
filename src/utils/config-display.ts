import chalk from 'chalk';
import type { ProjectConfig } from '../core/types.js';
import { getTerminalWidth } from './box-drawing.js';
import { formatBytes } from './storage-limit.js';
import { checkStorageLimit } from './storage-limit.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
export interface ConfigDisplayOptions {
  permissionMode?: 'ask_once' | 'always_ask' | 'unlimited';
  historyLength?: number;
  memoryCount?: number;
}

function section(title: string): void {
  const tw = getTerminalWidth();
  const dashes = Math.max(2, tw - title.length - 6);
  console.log(chalk.cyan(`\n ┌─ ${title} ${'─'.repeat(dashes)}┐`));
}

function field(name: string, value: string, color: (s: string) => string = chalk.gray): void {
  console.log(` ${chalk.white(name.padEnd(18))} ${color(value)}`);
}

function list(name: string, items: string[]): void {
  if (items.length === 0) {
    console.log(` ${chalk.white(name.padEnd(18))} ${chalk.dim('(none)')}`);
    return;
  }
  console.log(` ${chalk.white(name.padEnd(18))} ${items.join(', ')}`);
}

export async function showConfig(
  config: ProjectConfig,
  opts: ConfigDisplayOptions = {}
): Promise<void> {
  const envApiKey = process.env.SC_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.NVIDIA_API_KEY;
  const envModel = process.env.SC_MODEL;
  const envProfile = process.env.SC_PROFILE;
  const envMaxIter = process.env.SC_MAX_ITERATIONS;
  const envMaxStorage = process.env.SC_MAX_STORAGE_GB;

  // ── Model ──
  section('Model');
  field('Active profile', config.activeProfile || 'none', chalk.green);
  field('Model', config.model.model, chalk.cyan);
  field('Provider', config.model.baseUrl);
  field('Temperature', `${config.model.temperature ?? 0.7}`);
  field('Max tokens', config.model.maxTokens === null ? 'unlimited' : `${config.model.maxTokens ?? 4096}`);
  field('Streaming', config.model.stream !== false ? 'enabled' : 'disabled', chalk.green);
  field('API key', config.model.apiKey ? 'configured' : 'not set',
    config.model.apiKey ? chalk.green : chalk.yellow);

  // ── Environment overrides ──
  const overrides: string[] = [];
  if (envApiKey) overrides.push('SC_API_KEY / OPENAI_API_KEY');
  if (envModel) overrides.push('SC_MODEL');
  if (envProfile) overrides.push('SC_PROFILE');
  if (envMaxIter) overrides.push('SC_MAX_ITERATIONS');
  if (envMaxStorage) overrides.push('SC_MAX_STORAGE_GB');

  if (overrides.length > 0) {
    section('Environment Overrides');
    overrides.forEach(v => field(v, 'active', chalk.yellow));
  }

  // ── Available profiles ──
  const profileNames = Object.keys(config.profiles || {});
  if (profileNames.length > 0) {
    section('Profiles');
    for (const name of profileNames) {
      const p = config.profiles![name];
      const active = name === config.activeProfile ? chalk.green(' ← active') : '';
      const label = `${name}${active}`;
      const details = `model: ${p?.model || config.model.model}, provider: ${p?.baseUrl || config.model.baseUrl}`;
      console.log(` ${chalk.cyan(label.padEnd(22))} ${chalk.gray(details)}`);
    }
  }

  // ── Permissions ──
  section('Permissions');
  field('Permission mode', opts.permissionMode || 'ask_once',
    opts.permissionMode === 'unlimited' ? chalk.yellow :
    opts.permissionMode === 'always_ask' ? chalk.green : chalk.cyan);
  field('Profile', config.permissions?.profile || 'traditional',
    config.permissions?.profile === 'blacklist' ? chalk.cyan : chalk.gray);
  list('Auto-approved', config.permissions?.autoApprove || []);
  list('Denied paths', config.permissions?.denyPaths || []);
  list('Denied commands', config.permissions?.denyCommands || []);

  // ── Tools ──
  section('Tools (10)');
  console.log(` ${chalk.gray('  read_file     list_dir      search_text  (auto-approved)')}`);
  console.log(` ${chalk.gray('  web_fetch     memory_read                (auto-approved)')}`);
  console.log(` ${chalk.gray('  write_file    edit_file     run_shell    (requires permission)')}`);
  console.log(` ${chalk.gray('  git           memory_write               (requires permission)')}`);

  const maxRead = config.settings?.maxReadFileBytes ?? 1 * 1024 * 1024;
  const maxWrite = config.settings?.maxWriteFileBytes ?? 10 * 1024 * 1024;
  field('Read limit', `${(maxRead / 1024 / 1024).toFixed(1)} MB`);
  field('Write limit', `${(maxWrite / 1024 / 1024).toFixed(1)} MB`);

  // ── Storage ──
  const configDir = join(homedir(), '.sc-agent');
  const storageInfo = checkStorageLimit(configDir);
  section('Storage');
  field('Usage', `${formatBytes(storageInfo.currentSize)} / ${formatBytes(storageInfo.maxSize)} (${storageInfo.usagePercent.toFixed(1)}%)`,
    storageInfo.usagePercent > 90 ? chalk.red :
    storageInfo.usagePercent > 80 ? chalk.yellow : chalk.gray);
  field('Limit', `${process.env.SC_MAX_STORAGE_GB || '1'} GB (set SC_MAX_STORAGE_GB)`, chalk.gray);

  // ── Shell ──
  section('Shell');
  field('Platform', process.platform);
  field('Shell', process.env.SHELL || process.env.COMSPEC || 'unknown');

  // ── Session ──
  section('Session');
  field('History', opts.historyLength != null ? `${opts.historyLength} messages` : '-');
  field('Workspace', process.cwd(), chalk.gray);
  field('Node', process.version);

  // ── Memory ──
  if (opts.memoryCount != null) {
    field('Persistent memories', `${opts.memoryCount} entries`, chalk.cyan);
  }

  // ── Config files ──
  section('Config Files');
  console.log(` ${chalk.gray('  Global:  ~/.sc-agent/config.json')}`);
  console.log(` ${chalk.gray('  Project: .sc-agent.json (if exists)')}`);
  console.log(` ${chalk.gray('  Memory:  ~/.sc-agent/memory/memory.json')}`);

  // ── Env vars reference ──
  section('Environment Variables');
  console.log(` ${chalk.white('SC_API_KEY'.padEnd(22))} ${chalk.gray('API key (overrides config)')}`);
  console.log(` ${chalk.white('SC_MODEL'.padEnd(22))} ${chalk.gray('Model name (overrides config)')}`);
  console.log(` ${chalk.white('SC_PROFILE'.padEnd(22))} ${chalk.gray('Active profile name')}`);
  console.log(` ${chalk.white('SC_MAX_ITERATIONS'.padEnd(22))} ${chalk.gray('Max agent loop iterations (default: 100)')}`);
  console.log(` ${chalk.white('SC_MAX_STORAGE_GB'.padEnd(22))} ${chalk.gray('Storage limit in GB (default: 1)')}`);

  console.log();
}
