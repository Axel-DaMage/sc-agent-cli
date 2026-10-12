import { existsSync, statSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';

// Default: 1GB in bytes
const DEFAULT_MAX_STORAGE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GiB

export function getMaxStorageBytes(): number {
  const envValue = process.env.SC_MAX_STORAGE_GB;
  if (!envValue) {
    return DEFAULT_MAX_STORAGE_BYTES;
  }

  const parsedGB = parseFloat(envValue);
  if (isNaN(parsedGB) || parsedGB <= 0) {
    console.warn(chalk.yellow(`⚠️  Invalid SC_MAX_STORAGE_GB: "${envValue}", using default 1GB`));
    return DEFAULT_MAX_STORAGE_BYTES;
  }

  return parsedGB * 1024 * 1024 * 1024;
}

export function getDirectorySize(dirPath: string): number {
  if (!existsSync(dirPath)) {
    return 0;
  }

  let totalSize = 0;

  try {
    const items = readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      const itemPath = join(dirPath, item.name);

      if (item.isDirectory()) {
        totalSize += getDirectorySize(itemPath);
      } else if (item.isFile()) {
        const stats = statSync(itemPath);
        totalSize += stats.size;
      }
    }
  } catch {
    // Ignore permission errors
  }

  return totalSize;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export interface StorageInfo {
  currentSize: number;
  maxSize: number;
  usagePercent: number;
  needsCleanup: boolean;
}

export function checkStorageLimit(dirPath: string): StorageInfo {
  const currentSize = getDirectorySize(dirPath);
  const maxSize = getMaxStorageBytes();
  const usagePercent = (currentSize / maxSize) * 100;
  const needsCleanup = currentSize > maxSize;

  return {
    currentSize,
    maxSize,
    usagePercent,
    needsCleanup,
  };
}

export function cleanupOldestFiles(dirPath: string, targetSizeBytes: number): number {
  if (!existsSync(dirPath)) {
    return 0;
  }

  // Get all files with timestamps
  const files: Array<{ path: string; mtime: Date; size: number }> = [];
  const MAX_COLLECT_DEPTH = 20;

  function collectFiles(currentPath: string, depth = 0) {
    if (depth > MAX_COLLECT_DEPTH) {
      console.warn(chalk.yellow(`⚠️  Directory depth limit (${MAX_COLLECT_DEPTH}) exceeded at: ${currentPath}`));
      return;
    }
    try {
      const items = readdirSync(currentPath, { withFileTypes: true });

      for (const item of items) {
        const itemPath = join(currentPath, item.name);

        if (item.isDirectory()) {
          collectFiles(itemPath, depth + 1);
        } else if (item.isFile()) {
          const stats = statSync(itemPath);
          files.push({
            path: itemPath,
            mtime: stats.mtime,
            size: stats.size,
          });
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  collectFiles(dirPath);

  // Sort by oldest first
  files.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

  let deletedSize = 0;
  const currentSize = getDirectorySize(dirPath);
  const targetToDelete = currentSize - targetSizeBytes;

  for (const file of files) {
    if (deletedSize >= targetToDelete) {
      break;
    }

    try {
      unlinkSync(file.path);
      deletedSize += file.size;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(chalk.yellow(`⚠️  Could not delete ${file.path}: ${msg}`));
    }
  }

  // Clean up empty directories
  cleanupEmptyDirs(dirPath);

  return deletedSize;
}

function cleanupEmptyDirs(dirPath: string) {
  if (!existsSync(dirPath)) {
    return;
  }

  try {
    const items = readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (item.isDirectory()) {
        const itemPath = join(dirPath, item.name);
        cleanupEmptyDirs(itemPath);

        // Try to remove if empty
        try {
          const contents = readdirSync(itemPath);
          if (contents.length === 0) {
            rmdirSync(itemPath);
          }
        } catch {
          // Not empty or permission error
        }
      }
    }
  } catch {
    // Ignore errors
  }
}

export function enforceStorageLimit(dirPath: string, autoCleanup = true, quiet = false): boolean {
  const info = checkStorageLimit(dirPath);

  if (!info.needsCleanup) {
    return true; // Within limits
  }

  // Quiet/headless mode (sc -q, --output-format json): keep stdout reserved
  // for the run output/manifest — report cleanup progress on stderr.
  const print = quiet ? console.error : console.log;

  print(chalk.yellow(`\n⚠️  Storage limit exceeded`));
  print(chalk.gray(`  Current: ${formatBytes(info.currentSize)}`));
  print(chalk.gray(`  Limit:   ${formatBytes(info.maxSize)}`));
  print(chalk.gray(`  Usage:   ${info.usagePercent.toFixed(1)}%\n`));

  if (autoCleanup) {
    print(chalk.cyan('  Cleaning up oldest files...\n'));

    const deletedSize = cleanupOldestFiles(dirPath, info.maxSize * 0.9); // Clean to 90%

    print(chalk.green(`✓ Cleaned up ${formatBytes(deletedSize)}`));

    const newInfo = checkStorageLimit(dirPath);
    print(chalk.gray(`  New size: ${formatBytes(newInfo.currentSize)} (${newInfo.usagePercent.toFixed(1)}%)\n`));

    return !newInfo.needsCleanup;
  }

  return false;
}