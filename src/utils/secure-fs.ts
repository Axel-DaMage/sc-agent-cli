import { appendFileSync, chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import chalk from 'chalk';

// Owner-only modes for sensitive state (#475). Everything under ~/.sc-agent
// (config.json credentials, memory store, session transcripts, checkpoints,
// permissions store) plus user-targeted artifacts (run manifests, audit
// logs, session exports) is written 0600; state directories are 0700.
export const SECURE_FILE_MODE = 0o600;
export const SECURE_DIR_MODE = 0o700;

// POSIX permission bits are synthesized on Windows (stat reports 0666/0777
// and chmod is a no-op), so mode checks and repairs are skipped there.
const POSIX_PERMS = process.platform !== 'win32';

const STATE_ROOT = join(homedir(), '.sc-agent');

function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

// writeFile's `mode` only applies when the file is created — a pre-existing
// loose file keeps its mode. Tighten explicitly so rewrites self-heal.
function tightenFileSync(path: string): void {
  if (!POSIX_PERMS) return;
  const mode = fileMode(path);
  if (mode !== null && (mode & 0o077) !== 0) {
    try {
      chmodSync(path, SECURE_FILE_MODE);
    } catch {
      // Best effort — e.g. EPERM on a file we can write but don't own.
    }
  }
}

async function tightenFile(path: string): Promise<void> {
  if (!POSIX_PERMS) return;
  try {
    const st = await stat(path);
    if ((st.mode & 0o077) !== 0) await chmod(path, SECURE_FILE_MODE);
  } catch {
    // Best effort — same rationale as tightenFileSync.
  }
}

function tightenDir(dir: string): void {
  try {
    const mode = statSync(dir).mode & 0o777;
    if ((mode & 0o077) !== 0) chmodSync(dir, SECURE_DIR_MODE);
  } catch {
    // Best effort — never break a write over a mode fix.
  }
}

async function tightenDirAsync(dir: string): Promise<void> {
  try {
    const st = await stat(dir);
    if ((st.mode & 0o077) !== 0) await chmod(dir, SECURE_DIR_MODE);
  } catch {
    // Best effort — same rationale as tightenDir.
  }
}

// `dir` plus every ancestor up to and including ~/.sc-agent. A loose state
// root would expose member names even when every file inside stays 0600.
function dirChain(dir: string): string[] {
  const chain = [dir];
  let cur = dir;
  while (cur.startsWith(STATE_ROOT + sep)) {
    cur = dirname(cur);
    chain.push(cur);
  }
  return chain;
}

/**
 * mkdir -p with mode 0700, then tighten pre-existing directories in the
 * chain (mkdir's mode only applies to directories it creates).
 */
export function ensureSecureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
  if (!POSIX_PERMS) return;
  for (const d of dirChain(dir)) tightenDir(d);
}

export async function ensureSecureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: SECURE_DIR_MODE });
  if (!POSIX_PERMS) return;
  for (const d of dirChain(dir)) await tightenDirAsync(d);
}

export function writeFileSecureSync(path: string, data: string): void {
  writeFileSync(path, data, { mode: SECURE_FILE_MODE });
  tightenFileSync(path);
}

export async function writeFileSecure(path: string, data: string): Promise<void> {
  await writeFile(path, data, { mode: SECURE_FILE_MODE });
  await tightenFile(path);
}

export function appendFileSecureSync(path: string, data: string): void {
  appendFileSync(path, data, { mode: SECURE_FILE_MODE });
  tightenFileSync(path);
}

/**
 * Warn (stderr) when a sensitive file is group/other-readable and repair it
 * to 0600. No-op on Windows, on missing files, and when already tight.
 */
export function warnOnLoosePermissions(path: string, label?: string): void {
  if (!POSIX_PERMS) return;
  const mode = fileMode(path);
  if (mode === null || (mode & 0o077) === 0) return;
  const name = label ?? 'File';
  const actual = mode.toString(8).padStart(3, '0');
  try {
    chmodSync(path, SECURE_FILE_MODE);
    console.warn(chalk.yellow(`⚠️  ${name} ${path} had loose permissions (${actual}) — repaired to 600`));
  } catch {
    console.warn(chalk.yellow(`⚠️  ${name} ${path} is readable by other users (mode ${actual})`));
    console.warn(chalk.gray(`   Fix with: chmod 600 "${path}"`));
  }
}
