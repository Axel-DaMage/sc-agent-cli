#!/usr/bin/env node
// Ensures dependencies are installed before `npm run build` / `npm test`.
//
// Fresh worktrees and pre-PR quality gates can invoke npm scripts without a
// prior `npm ci`, leaving node_modules — and the tsc/vitest shims — absent
// ("sh: line 1: tsc: command not found", #448). When the required package is
// missing this hook runs `npm ci` (`npm install` when no lockfile exists);
// when present it returns immediately, so the hook is a no-op on warm
// checkouts.
//
// Usage: node scripts/ensure-deps.mjs [package-name]   (default: typescript)

/* global console, process */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = process.argv[2] || 'typescript';
const pkgJson = join(root, 'node_modules', pkg, 'package.json');

function main() {
  if (existsSync(pkgJson)) return;

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [
    existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ];

  console.log(`[ensure-deps] ${pkg} not installed — running \`npm ${args.join(' ')}\`...`);
  const res = spawnSync(npmCmd, args, { cwd: root, stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    console.error(
      `[ensure-deps] npm ${args[0]} failed${res.error ? `: ${res.error.message}` : ` (exit ${res.status})`} — run \`npm install\` manually`
    );
    process.exit(typeof res.status === 'number' && res.status !== 0 ? res.status : 1);
  }
  if (!existsSync(pkgJson)) {
    console.error(`[ensure-deps] ${pkg} still missing after install — check the npm output above`);
    process.exit(1);
  }
}

// Only act when executed directly (`node scripts/ensure-deps.mjs [pkg]`),
// so importing this file from tests or tooling is side-effect free.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
