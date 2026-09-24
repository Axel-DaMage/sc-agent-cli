import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import {
  probeRepo,
  formatRepoProfileForTerminal,
  formatRepoProfileForPrompt,
  formatRepoProfileJSON,
} from '../core/repo-probe/index.js';

export interface ProbeCommandOptions {
  json?: boolean;
  save?: boolean;
  cache?: boolean;
  quiet?: boolean;
  prompt?: boolean;
}

export async function probeCommand(
  targetPath?: string,
  options: ProbeCommandOptions = {}
): Promise<void> {
  const root = targetPath ? targetPath : process.cwd();
  const useCache = options.cache !== false;

  try {
    const profile = await probeRepo(root, {
      useCache,
      forceRefresh: !useCache,
    });

    if (options.save) {
      const scAgentDir = join(profile.root, '.sc-agent');
      if (!existsSync(scAgentDir)) {
        mkdirSync(scAgentDir, { recursive: true });
      }
      const saveFile = join(scAgentDir, 'repo-profile.json');
      writeFileSync(saveFile, formatRepoProfileJSON(profile), 'utf-8');
      if (!options.quiet && !options.json) {
        console.log(chalk.green(`✓ Repo profile saved to ${saveFile}`));
      }
    }

    if (options.json) {
      console.log(formatRepoProfileJSON(profile));
      return;
    }

    if (options.prompt) {
      console.log(formatRepoProfileForPrompt(profile));
      return;
    }

    if (!options.quiet) {
      console.log(formatRepoProfileForTerminal(profile));
    }
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`Error probing repository: ${err.message}`));
    }
    process.exit(1);
  }
}
