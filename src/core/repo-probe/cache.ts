import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { RepoProfile } from './types.js';

interface CacheEntry {
  profile: RepoProfile;
  fingerprint: string;
  timestamp: number;
}

const MEMORY_CACHE = new Map<string, CacheEntry>();

function getGlobalCacheDir(customDir?: string): string {
  return customDir || join(homedir(), '.sc-agent', 'repo-profiles');
}

function getCacheFileName(workspaceRoot: string): string {
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  return `profile-${hash}.json`;
}

/**
 * Compute fingerprint for cache validation from manifest files and their modification times.
 */
export function computeManifestFingerprint(workspaceRoot: string, manifests?: string[]): string {
  const checkFiles = manifests && manifests.length > 0
    ? manifests
    : [
        'package.json',
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lockb',
        'bun.lock',
        'tsconfig.json',
        'Cargo.toml',
        'Cargo.lock',
        'pyproject.toml',
        'requirements.txt',
        'setup.py',
        'go.mod',
        'go.sum',
        'pom.xml',
        'build.gradle',
        'build.gradle.kts',
        'Makefile',
        'makefile',
        '.github/workflows/ci.yml',
        '.github/workflows/ci.yaml',
        '.devcontainer/devcontainer.json',
        '.devcontainer.json',
      ];

  const parts: string[] = [];
  for (const rel of checkFiles) {
    const full = join(workspaceRoot, rel);
    if (existsSync(full)) {
      try {
        const stat = statSync(full);
        parts.push(`${rel}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        // ignore
      }
    }
  }

  return parts.sort().join(';');
}

/**
 * Retrieve cached repo profile if fresh.
 */
export function getCachedProfile(
  workspaceRoot: string,
  manifests?: string[],
  cacheDir?: string
): RepoProfile | null {
  const currentFingerprint = computeManifestFingerprint(workspaceRoot, manifests);

  // 1. Check in-memory cache
  const memEntry = MEMORY_CACHE.get(workspaceRoot);
  if (memEntry && memEntry.fingerprint === currentFingerprint) {
    return memEntry.profile;
  }

  // 2. Check disk cache
  const dir = getGlobalCacheDir(cacheDir);
  const cacheFile = join(dir, getCacheFileName(workspaceRoot));
  if (existsSync(cacheFile)) {
    try {
      const content = readFileSync(cacheFile, 'utf-8');
      const entry: CacheEntry = JSON.parse(content);
      if (entry && entry.fingerprint === currentFingerprint && entry.profile) {
        // Hydrate memory cache
        MEMORY_CACHE.set(workspaceRoot, entry);
        return entry.profile;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Save repo profile to memory and disk cache.
 */
export function saveCachedProfile(
  profile: RepoProfile,
  cacheDir?: string
): void {
  const currentFingerprint = computeManifestFingerprint(profile.root, profile.manifests);
  const entry: CacheEntry = {
    profile,
    fingerprint: currentFingerprint,
    timestamp: Date.now(),
  };

  // Memory cache
  MEMORY_CACHE.set(profile.root, entry);

  // Disk cache
  try {
    const dir = getGlobalCacheDir(cacheDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const cacheFile = join(dir, getCacheFileName(profile.root));
    writeFileSync(cacheFile, JSON.stringify(entry, null, 2), 'utf-8');
  } catch {
    // Non-fatal if disk write fails
  }
}

/**
 * Clear the repo profile cache (both memory and disk).
 */
export function clearRepoProfileCache(): void {
  MEMORY_CACHE.clear();
}
