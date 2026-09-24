import { resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Tool } from './tool.js';
import { verboseError, verbose } from '../utils/verbose-logger.js';

/**
 * External tool plugins (#400).
 *
 * Config: `plugins: ["./tools/my-tool.mjs", "@org/scc-tools"]` in
 * ~/.sc-agent/config.json or .sc-agent.json. Each module must export a
 * `Tool[]` — via `export default`, a named `tools` export, or the module
 * namespace itself being an array. Explicit specifiers only (no directory
 * scans): predictable and auditable.
 */

function isTool(value: unknown): value is Tool {
  const t = value as Tool;
  return (
    !!t &&
    typeof t === 'object' &&
    !!t.definition?.function?.name &&
    typeof t.definition.function.name === 'string' &&
    typeof t.execute === 'function'
  );
}

function extractTools(mod: Record<string, unknown>): Tool[] {
  const candidates = [mod.default, mod.tools, mod];
  for (const c of candidates) {
    if (Array.isArray(c) && c.every(isTool)) return c;
    if (isTool(c)) return [c];
  }
  return [];
}

function resolveSpecifier(spec: string, workspaceRoot: string): string {
  if (spec.startsWith('~/')) return pathToFileURL(resolve(homedir(), spec.slice(2))).href;
  if (spec.startsWith('.') || isAbsolute(spec))
    return pathToFileURL(resolve(workspaceRoot, spec)).href;
  return spec; // bare package specifier — resolved from node_modules
}

/**
 * Load plugin tool modules. Never throws: a broken plugin logs a warning
 * and is skipped so it cannot take down the CLI.
 */
export async function loadPluginTools(specs: string[], workspaceRoot: string): Promise<Tool[]> {
  const loaded: Tool[] = [];
  for (const spec of specs) {
    try {
      const url = resolveSpecifier(spec, workspaceRoot);
      const mod = (await import(url)) as Record<string, unknown>;
      const tools = extractTools(mod);
      if (tools.length === 0) {
        verboseError(`Plugin "${spec}" exports no valid tools — expected Tool[] (default or named "tools" export). Skipped.`);
        continue;
      }
      for (const t of tools) {
        verbose(`Plugin "${spec}" loaded tool: ${t.definition.function.name}`);
        loaded.push(t);
      }
    } catch (e) {
      verboseError(`Plugin "${spec}" failed to load: ${e instanceof Error ? e.message : String(e)} — skipped.`);
    }
  }
  return loaded;
}
