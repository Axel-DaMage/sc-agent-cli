import chalk from 'chalk';
import type { RepoProfile } from './types.js';

/**
 * Format repository profile as formatted JSON.
 */
export function formatRepoProfileJSON(profile: RepoProfile): string {
  return JSON.stringify(profile, null, 2);
}

/**
 * Format repository profile for human-friendly terminal display.
 */
export function formatRepoProfileForTerminal(profile: RepoProfile): string {
  const lines: string[] = [];

  const width = 60;
  const header = '📦 REPOSITORY PROFILE & TOOLCHAIN';
  lines.push(chalk.cyan.bold(`┌${'─'.repeat(width)}┐`));
  lines.push(chalk.cyan.bold(`│ ${header.padEnd(width - 2)} │`));
  lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));

  // Root & Ecosystems
  lines.push(
    `│ ${chalk.bold('Root:')} ${profile.root}`.padEnd(width + (chalk.bold('').length ? 9 : 0))
  );

  const ecoStr = profile.ecosystems.length > 0 ? profile.ecosystems.join(', ') : 'unknown';
  const confColor =
    profile.confidence === 'high'
      ? chalk.green
      : profile.confidence === 'medium'
      ? chalk.yellow
      : chalk.red;
  lines.push(`│ ${chalk.bold('Ecosystems:')} ${chalk.cyan(ecoStr)} (${confColor(profile.confidence)} confidence)`);

  // Toolchains
  if (profile.toolchains.length > 0) {
    lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));
    lines.push(`│ ${chalk.yellow.bold('🔧 Toolchains & Runtimes:')}`);
    for (const tc of profile.toolchains) {
      const ver = tc.version ? chalk.green(tc.version) : tc.rawSpec ? chalk.green(tc.rawSpec) : chalk.dim('(unspecified)');
      const src = tc.sourceFile ? chalk.dim(` [from ${tc.sourceFile}]`) : '';
      lines.push(`│   • ${chalk.bold(tc.name)}: ${ver}${src}`);
    }
  }

  // Package Managers
  if (profile.packageManagers.length > 0) {
    lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));
    lines.push(`│ ${chalk.yellow.bold('📦 Package Managers:')}`);
    for (const pm of profile.packageManagers) {
      const lock = pm.lockfile ? chalk.dim(` (lockfile: ${pm.lockfile})`) : '';
      const ver = pm.version ? chalk.green(`@${pm.version}`) : '';
      lines.push(`│   • ${chalk.bold(pm.name)}${ver}${lock}`);
    }
  }

  // Frameworks
  if (profile.frameworks.length > 0) {
    lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));
    lines.push(`│ ${chalk.yellow.bold('🧪 Frameworks & Tools:')}`);
    for (const fw of profile.frameworks) {
      const ver = fw.version ? chalk.green(` (${fw.version})`) : '';
      const cat = chalk.dim(`[${fw.category}]`);
      lines.push(`│   • ${chalk.bold(fw.name)}${ver} ${cat}`);
    }
  }

  // Commands
  const cmds = profile.commands;
  const hasCommands =
    cmds.install || cmds.build || cmds.test || cmds.lint || cmds.typecheck || cmds.verify || cmds.clean;
  if (hasCommands) {
    lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));
    lines.push(`│ ${chalk.yellow.bold('⚡ Discovered Commands:')}`);
    if (cmds.install) lines.push(`│   • ${chalk.bold('Install:')}   ${chalk.green(cmds.install)}`);
    if (cmds.build) lines.push(`│   • ${chalk.bold('Build:')}     ${chalk.green(cmds.build)}`);
    if (cmds.test) lines.push(`│   • ${chalk.bold('Test:')}      ${chalk.green(cmds.test)}`);
    if (cmds.lint) lines.push(`│   • ${chalk.bold('Lint:')}      ${chalk.green(cmds.lint)}`);
    if (cmds.typecheck) lines.push(`│   • ${chalk.bold('Typecheck:')} ${chalk.green(cmds.typecheck)}`);
    if (cmds.verify) lines.push(`│   • ${chalk.bold('Verify:')}    ${chalk.green(cmds.verify)}`);
    if (cmds.clean) lines.push(`│   • ${chalk.bold('Clean:')}     ${chalk.green(cmds.clean)}`);
    if (cmds.start) lines.push(`│   • ${chalk.bold('Start:')}     ${chalk.green(cmds.start)}`);
  }

  // CI Workflows & Mined Verify Commands
  if (profile.ci.workflows.length > 0 || profile.ci.minedVerifyCommands.length > 0) {
    lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));
    lines.push(`│ ${chalk.yellow.bold('🔄 CI Workflows & Mined Verification:')}`);
    if (profile.ci.providers.length > 0) {
      lines.push(`│   • Providers: ${profile.ci.providers.join(', ')}`);
    }
    for (const wf of profile.ci.workflows) {
      const vCmds = wf.verifyCommands.length > 0 ? ` (${wf.verifyCommands.length} verify commands)` : '';
      lines.push(`│   • Workflow: ${chalk.bold(wf.file)}${vCmds}`);
    }
    if (profile.ci.minedVerifyCommands.length > 0) {
      lines.push(`│   ${chalk.bold('Mined Ground-Truth Verify Commands:')}`);
      for (const mcmd of profile.ci.minedVerifyCommands) {
        lines.push(`│     ${chalk.green('▶')} ${chalk.cyan(mcmd)}`);
      }
    }
  }

  // Devcontainer
  if (profile.devcontainer) {
    lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));
    lines.push(`│ ${chalk.yellow.bold('🐳 Devcontainer:')}`);
    if (profile.devcontainer.image) lines.push(`│   • Image: ${profile.devcontainer.image}`);
    if (profile.devcontainer.postCreateCommand) {
      lines.push(`│   • postCreate: ${profile.devcontainer.postCreateCommand}`);
    }
  }

  // Unknown Ecosystem / Raw findings
  if (profile.rawFindings && profile.ecosystems.includes('unknown')) {
    lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));
    lines.push(`│ ${chalk.magenta.bold('🔍 Raw Findings (Unknown/Custom Structure):')}`);
    if (profile.rawFindings.scriptFiles.length > 0) {
      lines.push(`│   • Scripts: ${profile.rawFindings.scriptFiles.join(', ')}`);
    }
    if (profile.rawFindings.configFiles.length > 0) {
      lines.push(`│   • Configs: ${profile.rawFindings.configFiles.join(', ')}`);
    }
    if (profile.rawFindings.readmeSnippets && profile.rawFindings.readmeSnippets.length > 0) {
      lines.push(`│   • README Hints: ${profile.rawFindings.readmeSnippets.length} snippets found`);
    }
  }

  // Notes
  if (profile.notes && profile.notes.length > 0) {
    lines.push(chalk.cyan.bold(`├${'─'.repeat(width)}┤`));
    lines.push(`│ ${chalk.dim.bold('📝 Notes:')}`);
    for (const n of profile.notes) {
      lines.push(`│   • ${chalk.dim(n)}`);
    }
  }

  lines.push(chalk.cyan.bold(`└${'─'.repeat(width)}┘`));
  return lines.join('\n');
}

/**
 * Format repository profile as Markdown for LLM system prompt injection.
 */
export function formatRepoProfileForPrompt(profile: RepoProfile): string {
  const parts: string[] = [];

  parts.push('## Repository Profile & Toolchain (Auto-detected)');

  // Ecosystems & Confidence
  const ecoStr = profile.ecosystems.length > 0 ? profile.ecosystems.join(', ') : 'unknown';
  parts.push(`- **Ecosystems**: ${ecoStr} (confidence: ${profile.confidence})`);

  // Toolchains
  if (profile.toolchains.length > 0) {
    const tcStrs = profile.toolchains.map((tc) => {
      const ver = tc.version ? ` (${tc.version})` : tc.rawSpec ? ` (${tc.rawSpec})` : '';
      return `${tc.name}${ver}`;
    });
    parts.push(`- **Toolchains**: ${tcStrs.join(', ')}`);
  }

  // Package Managers
  if (profile.packageManagers.length > 0) {
    const pmStrs = profile.packageManagers.map((pm) => {
      const lock = pm.lockfile ? ` [lockfile: ${pm.lockfile}]` : '';
      const ver = pm.version ? `@${pm.version}` : '';
      return `${pm.name}${ver}${lock}`;
    });
    parts.push(`- **Package Managers**: ${pmStrs.join(', ')}`);
  }

  // Frameworks
  if (profile.frameworks.length > 0) {
    const fwStrs = profile.frameworks.map((fw) => {
      const ver = fw.version ? ` (${fw.version})` : '';
      return `${fw.name}${ver} [${fw.category}]`;
    });
    parts.push(`- **Frameworks & Tools**: ${fwStrs.join(', ')}`);
  }

  // Commands
  const cmds = profile.commands;
  const cmdEntries: string[] = [];
  if (cmds.install) cmdEntries.push(`• Install: \`${cmds.install}\``);
  if (cmds.build) cmdEntries.push(`• Build: \`${cmds.build}\``);
  if (cmds.test) cmdEntries.push(`• Test: \`${cmds.test}\``);
  if (cmds.lint) cmdEntries.push(`• Lint: \`${cmds.lint}\``);
  if (cmds.typecheck) cmdEntries.push(`• Typecheck: \`${cmds.typecheck}\``);
  if (cmds.verify) cmdEntries.push(`• Verify: \`${cmds.verify}\``);
  if (cmds.clean) cmdEntries.push(`• Clean: \`${cmds.clean}\``);
  if (cmds.start) cmdEntries.push(`• Start: \`${cmds.start}\``);

  if (cmdEntries.length > 0) {
    parts.push('- **Discovered Commands**:');
    for (const c of cmdEntries) {
      parts.push(`  ${c}`);
    }
  }

  // CI Mined Verification Commands (Ground Truth)
  if (profile.ci.minedVerifyCommands.length > 0) {
    parts.push('- **CI Mined Verification Commands (Ground Truth)**:');
    for (const mc of profile.ci.minedVerifyCommands) {
      parts.push(`  • \`${mc}\``);
    }
  }

  // Unknown raw findings fallback hints
  if (profile.rawFindings && profile.ecosystems.includes('unknown')) {
    if (profile.rawFindings.scriptFiles.length > 0) {
      parts.push(`- **Discovered Scripts**: ${profile.rawFindings.scriptFiles.join(', ')}`);
    }
    if (profile.rawFindings.configFiles.length > 0) {
      parts.push(`- **Discovered Configs**: ${profile.rawFindings.configFiles.join(', ')}`);
    }
  }

  return parts.join('\n');
}
