import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureSecureDirSync, writeFileSecureSync } from './secure-fs.js';

const PERMS_DIR = join(homedir(), '.sc-agent');
const PERMS_FILE = join(PERMS_DIR, 'permissions.json');

export interface PersistedPermissions {
  mode: 'ask_once' | 'always_ask' | 'unlimited';
  sessionTools: string[];
  restoreOnStart: boolean;
  updated: number;
}

const DEFAULTS: PersistedPermissions = {
  mode: 'ask_once',
  sessionTools: [],
  restoreOnStart: false,
  updated: Date.now(),
};

export function loadPermissions(): PersistedPermissions {
  try {
    if (existsSync(PERMS_FILE)) {
      const data = readFileSync(PERMS_FILE, 'utf-8');
      return { ...DEFAULTS, ...JSON.parse(data) };
    }
  } catch {
    // Corrupt or missing file — use defaults
  }
  return { ...DEFAULTS };
}

export function savePermissions(perms: Partial<PersistedPermissions>): void {
  try {
    const current = loadPermissions();
    const merged = { ...current, ...perms, updated: Date.now() };
    ensureSecureDirSync(PERMS_DIR);
    writeFileSecureSync(PERMS_FILE, JSON.stringify(merged, null, 2));
  } catch {
    // Silent failure — persistence is optional
  }
}
