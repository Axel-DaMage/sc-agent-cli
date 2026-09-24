import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_MEMORY_DIR = path.join(homedir(), '.sc-agent', 'memory');
const DEFAULT_MEMORY_FILE = path.join(DEFAULT_MEMORY_DIR, 'memory.json');
const MAX_MEMORY_ENTRIES = 1000;

export interface MemoryEntry {
  key: string;
  content: string;
  timestamp: number;
  tags: string[];
}

interface MemoryStore {
  entries: MemoryEntry[];
  created: number;
  updated: number;
  version: number;
}

function isValidStore(data: unknown): data is MemoryStore {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) return false;
  return obj.entries.every(e =>
    e && typeof e === 'object' &&
    typeof (e as Record<string, unknown>).key === 'string' &&
    typeof (e as Record<string, unknown>).content === 'string'
  );
}

export class PersistentMemory {
  private store: MemoryStore;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private memoryDir: string;
  private memoryFile: string;

  constructor(storageDir?: string) {
    this.memoryDir = storageDir || DEFAULT_MEMORY_DIR;
    this.memoryFile = path.join(this.memoryDir, 'memory.json');
    this.store = {
      entries: [],
      created: Date.now(),
      updated: Date.now(),
      version: 1,
    };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await mkdir(this.memoryDir, { recursive: true });
      await this.load();
      this.initialized = true;
      this.initPromise = null;
    })();
    return this.initPromise;
  }

  private async load(): Promise<void> {
    try {
      if (existsSync(this.memoryFile)) {
        const data = await readFile(this.memoryFile, 'utf-8');
        const parsed = JSON.parse(data);
        if (!isValidStore(parsed)) {
          // Invalid format — start fresh but keep a backup
          try {
            const backupPath = this.memoryFile + '.bak';
            await writeFile(backupPath, data, 'utf-8');
          } catch { /* backup is optional */ }
          this.store = { entries: [], created: Date.now(), updated: Date.now(), version: 1 };
          return;
        }
        this.store = parsed;
        // Keep new writes strictly ahead of every loaded entry
        for (const e of this.store.entries) {
          if (e.timestamp > this.lastTimestamp) this.lastTimestamp = e.timestamp;
        }
      }
    } catch {
      // Start fresh if corrupt
    }
  }

  // Strictly-increasing timestamp source: Date.now() has ~1ms resolution and
  // ties under burst writes, which scrambles recency ordering (#433).
  private lastTimestamp = 0;
  private now(): number {
    const t = Date.now();
    this.lastTimestamp = t > this.lastTimestamp ? t : this.lastTimestamp + 1;
    return this.lastTimestamp;
  }

  private async save(): Promise<void> {
    this.store.updated = this.now();
    await writeFile(this.memoryFile, JSON.stringify(this.store, null, 2), 'utf-8');
  }

  async remember(key: string, content: string, tags: string[] = []): Promise<void> {
    await this.init();
    const existing = this.store.entries.findIndex(e => e.key === key);
    const entry: MemoryEntry = { key, content, timestamp: this.now(), tags };
    if (existing >= 0) {
      this.store.entries[existing] = entry;
    } else {
      // Enforce max entries limit: evict oldest if at cap
      if (this.store.entries.length >= MAX_MEMORY_ENTRIES) {
        this.store.entries.sort((a, b) => a.timestamp - b.timestamp);
        this.store.entries.shift();
      }
      this.store.entries.push(entry);
    }
    await this.save();
  }

  async recall(key: string): Promise<string | null> {
    await this.init();
    const entry = this.store.entries.find(e => e.key === key);
    return entry ? entry.content : null;
  }

  async search(query: string): Promise<MemoryEntry[]> {
    await this.init();
    const lower = query.toLowerCase();
    return this.store.entries
      .filter(e =>
        e.key.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower) ||
        e.tags.some(t => t.toLowerCase().includes(lower))
      )
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async forget(key: string): Promise<boolean> {
    await this.init();
    const len = this.store.entries.length;
    this.store.entries = this.store.entries.filter(e => e.key !== key);
    if (this.store.entries.length !== len) {
      await this.save();
      return true;
    }
    return false;
  }

  async getAll(): Promise<MemoryEntry[]> {
    await this.init();
    return [...this.store.entries].sort((a, b) => b.timestamp - a.timestamp);
  }

  async clear(): Promise<void> {
    await this.init();
    this.store.entries = [];
    await this.save();
  }

  async getSummary(): Promise<string> {
    await this.init();
    if (this.store.entries.length === 0) return 'No stored memories.';
    const lines = this.store.entries.map(e => {
      const date = new Date(e.timestamp).toISOString().split('T')[0];
      const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
      const preview = e.content.substring(0, 80).replace(/\n/g, ' ');
      return `  • ${e.key}${tags} (${date}): ${preview}${e.content.length > 80 ? '...' : ''}`;
    });
    return `📝 Memories (${this.store.entries.length} total)\n${lines.join('\n')}`;
  }

  async getContextString(): Promise<string> {
    await this.init();
    if (this.store.entries.length === 0) return '';
    const entries = this.store.entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);
    const lines = entries.map(e => {
      const truncated = e.content.length > 200 ? e.content.substring(0, 200) + '...' : e.content;
      return `[${e.key}]: ${truncated}`;
    });
    return `\n# Persistent Memories (from previous sessions)\n${lines.join('\n')}\n`;
  }
}

export const persistentMemory = new PersistentMemory();
