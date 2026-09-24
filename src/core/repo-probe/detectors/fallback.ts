import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnknownEcosystemFindings, RepoCommands } from '../types.js';

export interface FallbackResult {
  ecosystems: string[];
  confidence: 'high' | 'medium' | 'low';
  commands: RepoCommands;
  findings: UnknownEcosystemFindings;
  notes: string[];
}

export function detectUnknownEcosystem(workspaceRoot: string): FallbackResult {
  const findings: UnknownEcosystemFindings = {
    detectedFiles: [],
    scriptFiles: [],
    configFiles: [],
    readmeSnippets: [],
    notes: [],
  };

  const commands: RepoCommands = {};
  const notes: string[] = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(workspaceRoot);
  } catch (err: any) {
    notes.push(`Could not read workspace root: ${err.message}`);
    return {
      ecosystems: ['unknown'],
      confidence: 'low',
      commands,
      findings,
      notes,
    };
  }

  // Filter out noise / hidden folders
  const visibleEntries = entries.filter((e) => !e.startsWith('.git') && e !== 'node_modules' && e !== '.cache');
  findings.detectedFiles = visibleEntries.slice(0, 50); // top 50 entries

  // 1. Detect executable scripts and build scripts
  for (const entry of visibleEntries) {
    const fullPath = join(workspaceRoot, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isFile()) {
        const lower = entry.toLowerCase();

        // Scripts
        if (
          lower.endsWith('.sh') ||
          lower.endsWith('.bash') ||
          lower.endsWith('.ps1') ||
          lower.endsWith('.bat') ||
          lower.endsWith('.cmd')
        ) {
          findings.scriptFiles.push(entry);

          if (/^(test|tests|run-tests|check)\./i.test(entry)) {
            commands.test = entry.endsWith('.sh') ? `./${entry}` : entry;
          } else if (/^(build|compile|make)\./i.test(entry)) {
            commands.build = entry.endsWith('.sh') ? `./${entry}` : entry;
          } else if (/^(install|setup|bootstrap|init)\./i.test(entry)) {
            commands.install = entry.endsWith('.sh') ? `./${entry}` : entry;
          }
        }

        // Config & Container files
        if (
          lower === 'dockerfile' ||
          lower === 'containerfile' ||
          lower.startsWith('docker-compose') ||
          lower.startsWith('compose.') ||
          lower === 'vagrantfile' ||
          lower === 'procfile' ||
          lower === 'brewfile' ||
          lower === 'flake.nix' ||
          lower === 'shell.nix' ||
          lower === 'cmakelists.txt' ||
          lower === 'makefile' ||
          lower === 'justfile'
        ) {
          findings.configFiles.push(entry);
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Inspect README.md for instructions
  const readmeCandidates = ['README.md', 'README.txt', 'README', 'INSTALL.md', 'BUILD.md'];
  for (const rName of readmeCandidates) {
    const rPath = join(workspaceRoot, rName);
    if (existsSync(rPath)) {
      try {
        const content = readFileSync(rPath, 'utf-8');
        const snippets = extractReadmeSnippets(content);
        if (snippets.length > 0) {
          findings.readmeSnippets = snippets;
        }
      } catch {
        // ignore
      }
      break;
    }
  }

  if (findings.scriptFiles.length > 0) {
    notes.push(`Discovered script files: ${findings.scriptFiles.join(', ')}`);
  }
  if (findings.configFiles.length > 0) {
    notes.push(`Discovered configuration/container files: ${findings.configFiles.join(', ')}`);
  }
  if (findings.detectedFiles.length === 0) {
    notes.push('Workspace directory is empty.');
  } else {
    notes.push(`Workspace contains ${visibleEntries.length} root items.`);
  }

  return {
    ecosystems: ['unknown'],
    confidence: 'low',
    commands,
    findings,
    notes,
  };
}

/**
 * Extract code blocks or commands from build/test/install sections in README.
 */
function extractReadmeSnippets(content: string): string[] {
  const snippets: string[] = [];
  const lines = content.split(/\r?\n/);
  let inRelevantSection = false;
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Check heading for build, test, install, run
    if (/^#{1,4}\s+(build|test|install|setup|usage|quickstart|getting started|how to run)/i.test(trimmed)) {
      inRelevantSection = true;
      continue;
    } else if (/^#{1,3}\s+/.test(trimmed)) {
      inRelevantSection = false;
    }

    if (inRelevantSection) {
      if (trimmed.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLines = [];
        } else {
          inCodeBlock = false;
          if (codeBlockLines.length > 0) {
            snippets.push(codeBlockLines.join('\n'));
          }
        }
        continue;
      }

      if (inCodeBlock && trimmed && !trimmed.startsWith('#')) {
        codeBlockLines.push(trimmed);
      }
    }
  }

  return snippets.slice(0, 5); // limit to top 5 snippets
}
