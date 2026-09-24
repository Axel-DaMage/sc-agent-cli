import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, sep } from 'node:path';

// Available slash commands
const SLASH_COMMANDS = [
  '/help',
  '/undo',
    '/rollback',
    '/session',
  '/checkpoint',
  '/config',
  '/hud',
  '/model',
  '/permissions',
  '/profile',
  '/pre-approved-commands',
  '/storage',
  '/reload',
  '/clear',
  '/memory',
  '/info',
  '/probe',
  '/repo',
  '/env',
];

// Available tools
const TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'search_text',
  'run_shell',
  'web_fetch',
  'git',
  'code_query',
  'repo_probe',
  'memory_read',
  'memory_write',
];

export function autocomplete(line: string, workspaceRoot: string): [string[], string] {
  const trimmedLine = line.trimStart();

  // Autocomplete slash commands
  if (trimmedLine.startsWith('/')) {
    const matches = SLASH_COMMANDS.filter(cmd => cmd.startsWith(trimmedLine));
    return [matches, trimmedLine];
  }

  // Autocomplete file paths (when line contains common path indicators)
  if (containsPathIndicators(trimmedLine)) {
    const pathMatches = autocompleteFilePath(trimmedLine, workspaceRoot);
    if (pathMatches.length > 0) {
      return [pathMatches, trimmedLine];
    }
  }

  // Autocomplete tool names (when user mentions tools)
  if (containsToolIndicators(trimmedLine)) {
    const toolMatches = TOOLS.filter(tool =>
      trimmedLine.toLowerCase().includes(tool.substring(0, 4))
    );
    if (toolMatches.length > 0) {
      return [toolMatches, trimmedLine];
    }
  }

  // No matches
  return [[], trimmedLine];
}

function containsPathIndicators(line: string): boolean {
  const indicators = [
    '/',
    '\\',
    './',
    '../',
    '~/',
    'file:',
    'path:',
    'in ',
    'from ',
    'read ',
    'write ',
    'open ',
    'edit ',
  ];

  const lowerLine = line.toLowerCase();
  return indicators.some(indicator => lowerLine.includes(indicator));
}

function containsToolIndicators(line: string): boolean {
  const indicators = [
    'tool',
    'use ',
    'run ',
    'execute ',
    'call ',
  ];

  const lowerLine = line.toLowerCase();
  return indicators.some(indicator => lowerLine.includes(indicator));
}

function autocompleteFilePath(line: string, workspaceRoot: string): string[] {
  // Extract potential path from the line
  const pathMatch = line.match(/(?:^|\s)(\.{0,2}\/[^\s]*|~\/[^\s]*|[a-zA-Z]:[^\s]*)/);
  if (!pathMatch) return [];

  let partialPath = pathMatch[1];
  let basePath = workspaceRoot;

  // Handle different path types
  if (partialPath.startsWith('~/')) {
    basePath = process.env.HOME || process.env.USERPROFILE || workspaceRoot;
    partialPath = partialPath.substring(2);
  } else if (partialPath.startsWith('./')) {
    partialPath = partialPath.substring(2);
  } else if (partialPath.startsWith('../')) {
    basePath = dirname(workspaceRoot);
    partialPath = partialPath.substring(3);
  }

  // Resolve full path
  const fullPath = partialPath ? join(basePath, partialPath) : basePath;
  const dirPath = partialPath.includes(sep) ? dirname(fullPath) : basePath;
  const prefix = basename(fullPath);

  // Get matching files/directories
  try {
    if (!existsSync(dirPath)) return [];

    const entries = readdirSync(dirPath, { withFileTypes: true });
    const matches = entries
      .filter(entry => {
        if (prefix && !entry.name.startsWith(prefix)) return false;
        return true;
      })
      .map(entry => {
        const isDir = entry.isDirectory();
        return isDir ? `${entry.name}/` : entry.name;
      })
      .slice(0, 20); // Limit to 20 suggestions

    return matches;
  } catch {
    return [];
  }
}

// Custom completer for readline
export function createCompleter(workspaceRoot: string) {
  return function completer(line: string): [string[], string] {
    return autocomplete(line, workspaceRoot);
  };
}