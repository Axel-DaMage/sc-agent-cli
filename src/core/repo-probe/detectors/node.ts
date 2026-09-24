import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ToolchainInfo,
  PackageManagerInfo,
  FrameworkInfo,
  RepoCommands,
} from '../types.js';
import { parseJsonSafe } from '../parser-utils.js';

export interface NodeDetectionResult {
  detected: boolean;
  ecosystems: string[];
  toolchains: ToolchainInfo[];
  packageManagers: PackageManagerInfo[];
  frameworks: FrameworkInfo[];
  commands: RepoCommands;
  manifests: string[];
}

export function detectNode(workspaceRoot: string): NodeDetectionResult {
  const result: NodeDetectionResult = {
    detected: false,
    ecosystems: [],
    toolchains: [],
    packageManagers: [],
    frameworks: [],
    commands: {},
    manifests: [],
  };

  const pkgJsonPath = join(workspaceRoot, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return result;
  }

  result.detected = true;
  result.ecosystems.push('node');
  result.manifests.push('package.json');

  let pkg: any = {};
  try {
    const raw = readFileSync(pkgJsonPath, 'utf-8');
    pkg = parseJsonSafe(raw) || {};
  } catch {
    pkg = {};
  }

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };

  // 1. Detect Package Manager
  let pmName = 'npm';
  let pmVersion: string | undefined;
  let lockfile: string | undefined;

  const pkgManagerField = pkg.packageManager;
  if (typeof pkgManagerField === 'string') {
    const [name, version] = pkgManagerField.split('@');
    if (name) {
      pmName = name;
      pmVersion = version;
    }
  }

  if (existsSync(join(workspaceRoot, 'pnpm-lock.yaml'))) {
    pmName = 'pnpm';
    lockfile = 'pnpm-lock.yaml';
    result.manifests.push('pnpm-lock.yaml');
  } else if (existsSync(join(workspaceRoot, 'yarn.lock'))) {
    pmName = 'yarn';
    lockfile = 'yarn.lock';
    result.manifests.push('yarn.lock');
  } else if (
    existsSync(join(workspaceRoot, 'bun.lockb')) ||
    existsSync(join(workspaceRoot, 'bun.lock'))
  ) {
    pmName = 'bun';
    lockfile = existsSync(join(workspaceRoot, 'bun.lockb')) ? 'bun.lockb' : 'bun.lock';
    result.manifests.push(lockfile);
  } else if (existsSync(join(workspaceRoot, 'package-lock.json'))) {
    pmName = 'npm';
    lockfile = 'package-lock.json';
    result.manifests.push('package-lock.json');
  }

  result.packageManagers.push({
    name: pmName,
    version: pmVersion,
    lockfile,
    sourceFile: pkgManagerField ? 'package.json' : lockfile,
  });

  // 2. Detect Node Toolchain Version
  let nodeVersion: string | undefined;
  let nodeSource: string | undefined;

  if (existsSync(join(workspaceRoot, '.nvmrc'))) {
    try {
      nodeVersion = readFileSync(join(workspaceRoot, '.nvmrc'), 'utf-8').trim();
      nodeSource = '.nvmrc';
      result.manifests.push('.nvmrc');
    } catch {
      // ignore
    }
  } else if (existsSync(join(workspaceRoot, '.node-version'))) {
    try {
      nodeVersion = readFileSync(join(workspaceRoot, '.node-version'), 'utf-8').trim();
      nodeSource = '.node-version';
      result.manifests.push('.node-version');
    } catch {
      // ignore
    }
  } else if (pkg.engines?.node) {
    nodeVersion = String(pkg.engines.node).trim();
    nodeSource = 'package.json#engines.node';
  }

  result.toolchains.push({
    name: 'node',
    version: nodeVersion,
    rawSpec: pkg.engines?.node ? String(pkg.engines.node) : undefined,
    sourceFile: nodeSource,
  });

  // 3. Detect TypeScript
  const tsconfigPath = join(workspaceRoot, 'tsconfig.json');
  const hasTsConfig = existsSync(tsconfigPath);
  const tsDep = allDeps['typescript'];

  if (hasTsConfig || tsDep) {
    result.ecosystems.push('typescript');
    if (hasTsConfig) result.manifests.push('tsconfig.json');

    let tsVersion = tsDep ? tsDep.replace(/[\^~>=<]/g, '') : undefined;
    result.toolchains.push({
      name: 'typescript',
      version: tsVersion,
      rawSpec: tsDep,
      sourceFile: hasTsConfig ? 'tsconfig.json' : 'package.json',
    });
  }

  // 4. Detect Test Frameworks
  const testFrameworks: Array<{ name: string; key: string }> = [
    { name: 'vitest', key: 'vitest' },
    { name: 'jest', key: 'jest' },
    { name: 'mocha', key: 'mocha' },
    { name: 'ava', key: 'ava' },
    { name: 'playwright', key: '@playwright/test' },
    { name: 'cypress', key: 'cypress' },
    { name: 'jasmine', key: 'jasmine' },
    { name: 'tape', key: 'tape' },
    { name: 'uvu', key: 'uvu' },
    { name: 'node:test', key: '' },
  ];

  for (const tf of testFrameworks) {
    if (tf.key && allDeps[tf.key]) {
      result.frameworks.push({
        name: tf.name,
        category: 'test',
        version: allDeps[tf.key]?.replace(/[\^~>=<]/g, ''),
        sourceFile: 'package.json',
      });
    }
  }

  // 5. Detect Linters & Formatters
  const lintTools: Array<{ name: string; key: string }> = [
    { name: 'eslint', key: 'eslint' },
    { name: 'prettier', key: 'prettier' },
    { name: 'biome', key: '@biomejs/biome' },
    { name: 'oxlint', key: 'oxlint' },
    { name: 'standard', key: 'standard' },
    { name: 'tslint', key: 'tslint' },
  ];

  for (const lt of lintTools) {
    if (allDeps[lt.key]) {
      result.frameworks.push({
        name: lt.name,
        category: 'lint',
        version: allDeps[lt.key]?.replace(/[\^~>=<]/g, ''),
        sourceFile: 'package.json',
      });
    }
  }

  // 6. Detect Build Tools & Frameworks
  const buildFrameworks: Array<{ name: string; key: string }> = [
    { name: 'vite', key: 'vite' },
    { name: 'webpack', key: 'webpack' },
    { name: 'esbuild', key: 'esbuild' },
    { name: 'rollup', key: 'rollup' },
    { name: 'tsup', key: 'tsup' },
    { name: 'turborepo', key: 'turbo' },
    { name: 'nx', key: 'nx' },
    { name: 'next', key: 'next' },
    { name: 'nuxt', key: 'nuxt' },
    { name: 'astro', key: 'astro' },
    { name: 'remix', key: '@remix-run/dev' },
    { name: 'sveltekit', key: '@sveltejs/kit' },
    { name: 'react', key: 'react' },
    { name: 'vue', key: 'vue' },
    { name: 'angular', key: '@angular/core' },
    { name: 'express', key: 'express' },
    { name: 'fastify', key: 'fastify' },
    { name: 'nest', key: '@nestjs/core' },
  ];

  for (const bf of buildFrameworks) {
    if (allDeps[bf.key]) {
      result.frameworks.push({
        name: bf.name,
        category: ['next', 'nuxt', 'astro', 'remix', 'sveltekit', 'react', 'vue', 'angular', 'express', 'fastify', 'nest'].includes(bf.name)
          ? 'web'
          : 'build',
        version: allDeps[bf.key]?.replace(/[\^~>=<]/g, ''),
        sourceFile: 'package.json',
      });
    }
  }

  // 7. Map Commands
  const scripts: Record<string, string> = pkg.scripts || {};

  // Install command
  if (pmName === 'pnpm') {
    result.commands.install = lockfile ? 'pnpm install --frozen-lockfile' : 'pnpm install';
  } else if (pmName === 'yarn') {
    result.commands.install = lockfile ? 'yarn install --frozen-lockfile' : 'yarn install';
  } else if (pmName === 'bun') {
    result.commands.install = lockfile ? 'bun install --frozen-lockfile' : 'bun install';
  } else {
    result.commands.install = lockfile ? 'npm ci' : 'npm install';
  }

  // Run command prefix helper
  const runPrefix = pmName === 'npm' ? 'npm run' : pmName;

  // Build command
  if (scripts.build) {
    result.commands.build = `${runPrefix} build`;
  } else if (hasTsConfig) {
    result.commands.build = 'npx tsc';
  }

  // Test command
  if (scripts.test && !scripts.test.includes('no test specified')) {
    result.commands.test = pmName === 'npm' ? 'npm test' : `${pmName} test`;
  } else if (allDeps['vitest']) {
    result.commands.test = 'npx vitest run';
  } else if (allDeps['jest']) {
    result.commands.test = 'npx jest';
  } else if (allDeps['mocha']) {
    result.commands.test = 'npx mocha';
  }

  // Lint command
  if (scripts.lint) {
    result.commands.lint = `${runPrefix} lint`;
  } else if (scripts['lint:fix']) {
    result.commands.lint = `${runPrefix} lint:fix`;
  } else if (scripts.check) {
    result.commands.lint = `${runPrefix} check`;
  } else if (allDeps['eslint']) {
    result.commands.lint = 'npx eslint .';
  } else if (allDeps['@biomejs/biome']) {
    result.commands.lint = 'npx @biomejs/biome check .';
  }

  // Typecheck command
  if (scripts.typecheck) {
    result.commands.typecheck = `${runPrefix} typecheck`;
  } else if (scripts['type-check']) {
    result.commands.typecheck = `${runPrefix} type-check`;
  } else if (hasTsConfig) {
    result.commands.typecheck = 'npx tsc --noEmit';
  }

  // Start command
  if (scripts.start) {
    result.commands.start = pmName === 'npm' ? 'npm start' : `${pmName} start`;
  }

  // Clean command
  if (scripts.clean) {
    result.commands.clean = `${runPrefix} clean`;
  }

  // Collect any other custom scripts
  const knownKeys = new Set(['build', 'test', 'lint', 'lint:fix', 'check', 'typecheck', 'type-check', 'start', 'clean']);
  const customScripts: Record<string, string> = {};
  for (const [k, v] of Object.entries(scripts)) {
    if (!knownKeys.has(k) && typeof v === 'string') {
      customScripts[k] = v;
    }
  }
  if (Object.keys(customScripts).length > 0) {
    result.commands.custom = customScripts;
  }

  return result;
}
