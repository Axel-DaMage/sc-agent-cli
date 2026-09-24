import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { probeRepo, type RepoProfile } from '../core/repo-probe/index.js';

export function generateAgentsMd(profile?: RepoProfile): string {
  const ecoStr = profile && profile.ecosystems.length > 0 && !profile.ecosystems.includes('unknown')
    ? profile.ecosystems.join(', ')
    : '[Describe your project here]';

  let buildAndTest = '[Explain how to build and test the project]';
  if (profile && (profile.commands.install || profile.commands.build || profile.commands.test || profile.commands.lint)) {
    const lines: string[] = ['```bash'];
    if (profile.commands.install) lines.push(`# Install dependencies\n${profile.commands.install}`);
    if (profile.commands.build) lines.push(`# Build\n${profile.commands.build}`);
    if (profile.commands.test) lines.push(`# Test\n${profile.commands.test}`);
    if (profile.commands.lint) lines.push(`# Lint\n${profile.commands.lint}`);
    if (profile.commands.typecheck) lines.push(`# Typecheck\n${profile.commands.typecheck}`);
    lines.push('```');
    buildAndTest = lines.join('\n');
  }

  return `# Agent Instructions

This file provides context to the SC-Agent when working in this project.

## Project Overview

${ecoStr}

## Key Files and Structure

[Explain important directories and files]

## Coding Guidelines

[List any coding standards, patterns, or preferences]

## Build and Test

${buildAndTest}
`;
}

export const DEFAULT_AGENTS_MD = generateAgentsMd();

export async function initProject(cwd: string, force = false): Promise<void> {
  const agentsPath = path.join(cwd, 'AGENTS.md');

  try {
    let agentsContent = DEFAULT_AGENTS_MD;
    try {
      const profile = await probeRepo(cwd);
      agentsContent = generateAgentsMd(profile);
    } catch {
      // Fallback to default template if probe fails
    }

    await writeFile(agentsPath, agentsContent, {
      encoding: 'utf-8',
      flag: force ? 'w' : 'wx',
    });

    const statusMessage = force ? `✓ Overwrote ${agentsPath}` : `✓ Created ${agentsPath}`;
    console.log(chalk.green(statusMessage));
    console.log(chalk.gray('  Edit this file to provide context for the agent'));
  } catch (err: unknown) {
    if (isFileAlreadyExistsError(err)) {
      console.log(chalk.yellow(`! AGENTS.md already exists at ${agentsPath}`));
      console.log(chalk.gray('  Re-run with "sc init --force" to overwrite it'));
      return;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`✗ Failed to create AGENTS.md: ${errorMsg}`));
  }
}

function isFileAlreadyExistsError(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST');
}
