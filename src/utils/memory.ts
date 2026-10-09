import { readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { ensureSecureDir, writeFileSecure } from './secure-fs.js';
import { redactSecrets } from './secret-redaction.js';

const DEFAULT_MEMORY_DIR = path.join(homedir(), '.sc-agent', 'memory');
const MAX_MEMORY_ENTRIES = 1000;
const MEMORY_INJECTION_LIMIT = 10;
const STORE_VERSION = 2;

/**
 * #476 — memory tiers. `workspace` entries are namespaced to a single
 * workspace (sha256(realpath(root)).slice(0,12)); `global` is opt-in shared
 * state; `legacy` holds pre-migration v1 entries — loadable everywhere but
 * never auto-injected into the system prompt.
 */
export type MemoryScope = 'workspace' | 'global' | 'legacy';
/** Writable scopes — `legacy` is migration-only, never a write target. */
export type MemoryWriteScope = 'workspace' | 'global';

export interface MemoryEntry {
  key: string;
  content: string;
  timestamp: number;
  tags: string[];
  scope: MemoryScope;
  /** sha256(realpath(workspaceRoot)).slice(0,12) — set when scope === 'workspace'. */
  workspaceId?: string;
  /** Realpath of the owning workspace — kept for provenance display. */
  workspacePath?: string;
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

interface ResolvedWorkspace {
  id: string;
  path: string;
}

/**
 * Workspace identity for the `workspace` tier (#476):
 * `sha256(realpath(workspaceRoot)).slice(0,12)`. Returns null when the root
 * cannot be resolved — callers then see only the `global` + `legacy` tiers.
 */
async function resolveWorkspacePath(workspaceRoot: string): Promise<ResolvedWorkspace | null> {
  try {
    const real = await realpath(workspaceRoot);
    return { id: createHash('sha256').update(real).digest('hex').slice(0, 12), path: real };
  } catch {
    return null;
  }
}

/** Public variant returning just the workspace id hash. */
export async function workspaceIdFor(workspaceRoot: string): Promise<string | null> {
  const ws = await resolveWorkspacePath(workspaceRoot);
  return ws ? ws.id : null;
}

/** Provenance tag prepended to every injected memory line (#476). */
export function memoryScopeTag(scope: MemoryScope): string {
  return `[memory:${scope}]`;
}

export class PersistentMemory {
  private store: MemoryStore;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private memoryDir: string;
  private memoryFile: string;
  private defaultWorkspaceRoot?: string;
  private workspaceCache = new Map<string, Promise<ResolvedWorkspace | null>>();

  constructor(storageDir?: string, workspaceRoot?: string) {
    this.memoryDir = storageDir || DEFAULT_MEMORY_DIR;
    this.memoryFile = path.join(this.memoryDir, 'memory.json');
    this.defaultWorkspaceRoot = workspaceRoot;
    this.store = {
      entries: [],
      created: Date.now(),
      updated: Date.now(),
      version: STORE_VERSION,
    };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await ensureSecureDir(this.memoryDir);
      await this.load();
      this.initialized = true;
      this.initPromise = null;
    })();
    return this.initPromise;
  }

  /**
   * Resolve the calling session's workspace identity. `workspaceRoot`
   * overrides the constructor default; an unresolvable root yields null and
   * the caller sees only `global` + `legacy` entries.
   */
  private resolveWorkspace(workspaceRoot?: string): Promise<ResolvedWorkspace | null> {
    const root = workspaceRoot ?? this.defaultWorkspaceRoot;
    if (!root) return Promise.resolve(null);
    let cached = this.workspaceCache.get(root);
    if (!cached) {
      cached = resolveWorkspacePath(root);
      this.workspaceCache.set(root, cached);
    }
    return cached;
  }

  /**
   * Tier visibility for this session. Other workspaces' entries are
   * quarantined — invisible to reads, writes, moves, and clears. `legacy`
   * predates scoping, so it loads everywhere (still never auto-injected).
   */
  private isVisible(e: MemoryEntry, wsId: string | null): boolean {
    if (e.scope === 'workspace') return wsId !== null && e.workspaceId === wsId;
    return true;
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
            await writeFileSecure(backupPath, data);
          } catch { /* backup is optional */ }
          this.store = { entries: [], created: Date.now(), updated: Date.now(), version: STORE_VERSION };
          return;
        }
        // #476 migration: v1 entries carry no `scope` — quarantine them into
        // `legacy` (loadable but never auto-injected) and persist the v2
        // schema on first load. A pristine pre-migration copy is kept once.
        const rawEntries = parsed.entries as Array<Partial<MemoryEntry> & Pick<MemoryEntry, 'key' | 'content'>>;
        let migrated = parsed.version !== STORE_VERSION;
        for (const e of rawEntries) {
          if (e.scope !== 'workspace' && e.scope !== 'global' && e.scope !== 'legacy') {
            e.scope = 'legacy';
            migrated = true;
          }
          if (e.scope === 'workspace' && typeof e.workspaceId !== 'string') {
            // Corrupt v2 workspace entry — quarantine rather than leak.
            e.scope = 'legacy';
            delete e.workspaceId;
            delete e.workspacePath;
            migrated = true;
          }
          if (!Array.isArray(e.tags)) { e.tags = []; migrated = true; }
          if (typeof e.timestamp !== 'number') { e.timestamp = Date.now(); migrated = true; }
        }
        this.store = {
          entries: rawEntries as MemoryEntry[],
          created: typeof parsed.created === 'number' ? parsed.created : Date.now(),
          updated: typeof parsed.updated === 'number' ? parsed.updated : Date.now(),
          version: STORE_VERSION,
        };
        // Keep new writes strictly ahead of every loaded entry
        for (const e of this.store.entries) {
          if (e.timestamp > this.lastTimestamp) this.lastTimestamp = e.timestamp;
        }
        if (migrated) {
          try {
            const legacyBackup = this.memoryFile + '.pre-v2.bak';
            if (!existsSync(legacyBackup)) await writeFileSecure(legacyBackup, data);
          } catch { /* backup is optional */ }
          await this.save();
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
    await writeFileSecure(this.memoryFile, JSON.stringify(this.store, null, 2));
  }

  /**
   * Index of the entry a keyed operation acts on. A key may exist in both
   * `legacy` and an active tier (migration can leave a shadow) — the active
   * tier always wins; `legacy` is the fallback.
   */
  private findScopedEntryIndex(key: string, wsId: string | null): number {
    let legacyIdx = -1;
    for (let i = 0; i < this.store.entries.length; i++) {
      const e = this.store.entries[i];
      if (e.key !== key || !this.isVisible(e, wsId)) continue;
      if (e.scope !== 'legacy') return i;
      if (legacyIdx < 0) legacyIdx = i;
    }
    return legacyIdx;
  }

  /** At-cap eviction prefers the oldest entry this session can see. */
  private evictOldest(wsId: string | null): void {
    const sorted = [...this.store.entries].sort((a, b) => a.timestamp - b.timestamp);
    const victim = sorted.find(e => this.isVisible(e, wsId)) ?? sorted[0];
    this.store.entries = this.store.entries.filter(e => e !== victim);
  }

  /**
   * Upsert by key within the caller-visible tiers (#476): writing a key that
   * already exists in another tier re-files it (this is the programmatic
   * `/memory move` path — `memory_write` with `scope` + `id`). Keys owned by
   * a different workspace are invisible and never overwritten.
   */
  async remember(
    key: string,
    content: string,
    tags: string[] = [],
    options: { scope?: MemoryWriteScope; workspaceRoot?: string } = {},
  ): Promise<MemoryEntry> {
    await this.init();
    const scope: MemoryWriteScope = options.scope ?? 'workspace';
    const ws = await this.resolveWorkspace(options.workspaceRoot);
    if (scope === 'workspace' && !ws) {
      throw new Error(
        'Workspace-scoped memory unavailable: could not resolve the workspace root ' +
        '(pass scope "global" to store a cross-workspace memory).',
      );
    }
    const existing = this.findScopedEntryIndex(key, ws?.id ?? null);
    // #472: memory is persisted state — the model can stash a leaked
    // credential here, so it crosses the redaction layer on write.
    const entry: MemoryEntry = {
      key,
      content: redactSecrets(content),
      timestamp: this.now(),
      tags,
      scope,
      ...(scope === 'workspace' ? { workspaceId: ws!.id, workspacePath: ws!.path } : {}),
    };
    if (existing >= 0) {
      this.store.entries[existing] = entry;
    } else {
      // Enforce max entries limit: evict oldest if at cap
      if (this.store.entries.length >= MAX_MEMORY_ENTRIES) {
        this.evictOldest(ws?.id ?? null);
      }
      this.store.entries.push(entry);
    }
    await this.save();
    return entry;
  }

  async recallEntry(key: string, workspaceRoot?: string): Promise<MemoryEntry | null> {
    await this.init();
    const ws = await this.resolveWorkspace(workspaceRoot);
    const idx = this.findScopedEntryIndex(key, ws?.id ?? null);
    return idx >= 0 ? this.store.entries[idx] : null;
  }

  async recall(key: string, workspaceRoot?: string): Promise<string | null> {
    const entry = await this.recallEntry(key, workspaceRoot);
    return entry ? entry.content : null;
  }

  async search(query: string, workspaceRoot?: string, options: { includeLegacy?: boolean } = {}): Promise<MemoryEntry[]> {
    await this.init();
    const ws = await this.resolveWorkspace(workspaceRoot);
    const wsId = ws?.id ?? null;
    const lower = query.toLowerCase();
    return this.store.entries
      .filter(e =>
        this.isVisible(e, wsId) &&
        (options.includeLegacy === true || e.scope !== 'legacy') &&
        (e.key.toLowerCase().includes(lower) ||
          e.content.toLowerCase().includes(lower) ||
          e.tags.some(t => t.toLowerCase().includes(lower)))
      )
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async forget(key: string, workspaceRoot?: string): Promise<boolean> {
    await this.init();
    const ws = await this.resolveWorkspace(workspaceRoot);
    const wsId = ws?.id ?? null;
    const len = this.store.entries.length;
    this.store.entries = this.store.entries.filter(e => !(e.key === key && this.isVisible(e, wsId)));
    if (this.store.entries.length !== len) {
      await this.save();
      return true;
    }
    return false;
  }

  /**
   * Re-file an entry between writable tiers (`/memory move <key> --to
   * workspace|global`). Legacy entries can be claimed this way; other
   * workspaces' entries are unreachable.
   */
  async move(key: string, to: MemoryWriteScope, workspaceRoot?: string): Promise<MemoryEntry> {
    await this.init();
    const ws = await this.resolveWorkspace(workspaceRoot);
    if (to === 'workspace' && !ws) {
      throw new Error('Cannot move memory to workspace scope: could not resolve the workspace root.');
    }
    const idx = this.findScopedEntryIndex(key, ws?.id ?? null);
    if (idx < 0) {
      throw new Error(`No memory found with key "${key}".`);
    }
    const entry = this.store.entries[idx];
    if (entry.scope === to) return entry;
    entry.scope = to;
    if (to === 'workspace') {
      entry.workspaceId = ws!.id;
      entry.workspacePath = ws!.path;
    } else {
      delete entry.workspaceId;
      delete entry.workspacePath;
    }
    await this.save();
    return entry;
  }

  async getAll(options: { workspaceRoot?: string; includeLegacy?: boolean } = {}): Promise<MemoryEntry[]> {
    await this.init();
    const ws = await this.resolveWorkspace(options.workspaceRoot);
    const wsId = ws?.id ?? null;
    return this.store.entries
      .filter(e => this.isVisible(e, wsId) && (options.includeLegacy === true || e.scope !== 'legacy'))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Wipe every tier this session owns — workspace + global + legacy. Other
   * workspaces' entries are never touched (#476).
   */
  async clear(workspaceRoot?: string): Promise<void> {
    await this.init();
    const ws = await this.resolveWorkspace(workspaceRoot);
    const wsId = ws?.id ?? null;
    this.store.entries = this.store.entries.filter(e => !this.isVisible(e, wsId));
    await this.save();
  }

  async getSummary(workspaceRoot?: string, options: { all?: boolean } = {}): Promise<string> {
    await this.init();
    const ws = await this.resolveWorkspace(workspaceRoot);
    const wsId = ws?.id ?? null;
    const visible = this.store.entries.filter(e => this.isVisible(e, wsId));
    const active = visible.filter(e => e.scope !== 'legacy').sort((a, b) => b.timestamp - a.timestamp);
    const legacy = visible.filter(e => e.scope === 'legacy').sort((a, b) => b.timestamp - a.timestamp);
    const shown = options.all === true ? [...active, ...legacy] : active;
    if (shown.length === 0) {
      return legacy.length === 0
        ? 'No stored memories.'
        : `No workspace/global memories — ${legacy.length} legacy ${legacy.length === 1 ? 'entry' : 'entries'} quarantined (never auto-injected). "/memory show --all" to view, "/memory move <key> --to workspace|global" to re-file.`;
    }

    const wsCount = active.filter(e => e.scope === 'workspace').length;
    const counts = options.all === true
      ? `${shown.length} total — workspace: ${wsCount}, global: ${active.length - wsCount}, legacy: ${legacy.length}`
      : `${shown.length} total — workspace: ${wsCount}, global: ${active.length - wsCount}`;
    const lines = shown.map(e => {
      const date = new Date(e.timestamp).toISOString().split('T')[0];
      const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
      const preview = e.content.substring(0, 80).replace(/\n/g, ' ');
      return `  • ${e.key} [${e.scope}]${tags} (${date}): ${preview}${e.content.length > 80 ? '...' : ''}`;
    });
    let out = `📝 Memories (${counts})\n${lines.join('\n')}`;
    if (options.all !== true && legacy.length > 0) {
      out += `\n\n  ${legacy.length} legacy ${legacy.length === 1 ? 'memory' : 'memories'} hidden (pre-scoping, never auto-injected)` +
        ` — "/memory show --all" to view, "/memory move <key> --to workspace|global" to re-file.`;
    }
    return out;
  }

  /**
   * System-prompt injection block. Workspace memories take precedence and
   * fill the shared 10-entry cap first; `global` entries fill the remainder.
   * Every line carries a `[memory:<scope>]` provenance tag (#476). `legacy`
   * entries are never injected.
   */
  async getContextString(workspaceRoot?: string): Promise<string> {
    await this.init();
    const ws = await this.resolveWorkspace(workspaceRoot);
    const wsId = ws?.id ?? null;
    const workspaceEntries = wsId !== null
      ? this.store.entries
          .filter(e => e.scope === 'workspace' && e.workspaceId === wsId)
          .sort((a, b) => b.timestamp - a.timestamp)
      : [];
    const globalEntries = this.store.entries
      .filter(e => e.scope === 'global')
      .sort((a, b) => b.timestamp - a.timestamp);
    const entries = [...workspaceEntries, ...globalEntries].slice(0, MEMORY_INJECTION_LIMIT);
    if (entries.length === 0) return '';
    const lines = entries.map(e => {
      const truncated = e.content.length > 200 ? e.content.substring(0, 200) + '...' : e.content;
      return `${memoryScopeTag(e.scope)} [${e.key}]: ${truncated}`;
    });
    return `\n# Persistent Memories (from previous sessions)\n${lines.join('\n')}\n`;
  }
}

export const persistentMemory = new PersistentMemory();
