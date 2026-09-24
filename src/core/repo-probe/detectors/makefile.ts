import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoCommands } from '../types.js';
import { parseMakefileTargets } from '../parser-utils.js';

export interface MakefileDetectionResult {
  detected: boolean;
  targets: Record<string, string[]>;
  commands: RepoCommands;
  manifests: string[];
}

export function detectMakefile(workspaceRoot: string): MakefileDetectionResult {
  const result: MakefileDetectionResult = {
    detected: false,
    targets: {},
    commands: {},
    manifests: [],
  };

  const possibleNames = ['Makefile', 'makefile', 'GNUmakefile'];
  let makefilePath: string | null = null;
  let makefileName: string | null = null;

  for (const name of possibleNames) {
    const p = join(workspaceRoot, name);
    if (existsSync(p)) {
      makefilePath = p;
      makefileName = name;
      break;
    }
  }

  if (!makefilePath || !makefileName) {
    return result;
  }

  result.detected = true;
  result.manifests.push(makefileName);

  let content = '';
  try {
    content = readFileSync(makefilePath, 'utf-8');
  } catch {
    return result;
  }

  const targets = parseMakefileTargets(content);
  result.targets = targets;

  // Map standard targets
  if (targets['install']) {
    result.commands.install = 'make install';
  }
  if (targets['build']) {
    result.commands.build = 'make build';
  } else if (targets['all']) {
    result.commands.build = 'make all';
  }

  if (targets['test']) {
    result.commands.test = 'make test';
  } else if (targets['tests']) {
    result.commands.test = 'make tests';
  } else if (targets['check']) {
    result.commands.test = 'make check';
  }

  if (targets['lint']) {
    result.commands.lint = 'make lint';
  }

  if (targets['verify']) {
    result.commands.verify = 'make verify';
  } else if (targets['ci']) {
    result.commands.verify = 'make ci';
  }

  if (targets['clean']) {
    result.commands.clean = 'make clean';
  }

  return result;
}
