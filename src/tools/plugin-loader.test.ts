import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginTools } from './plugin-loader.js';
import { registerPluginTools, ALL_TOOLS, getToolByName } from './registry.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'scc-plugin-'));
  writeFileSync(
    join(dir, 'good.mjs'),
    `export default [{
      definition: { type: 'function', function: { name: 'test_hello', description: 't', parameters: { type: 'object', properties: {} } } },
      async execute() { return 'hi'; },
    }];`
  );
  writeFileSync(join(dir, 'named.mjs'), `export const tools = [];`);
  writeFileSync(join(dir, 'bad.mjs'), `export default { not: 'a tool' };`);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadPluginTools', () => {
  it('loads Tool[] from a default export', async () => {
    const tools = await loadPluginTools(['./good.mjs'], dir);
    expect(tools).toHaveLength(1);
    expect(tools[0].definition.function.name).toBe('test_hello');
    await expect(tools[0].execute({}, {} as never)).resolves.toBe('hi');
  });

  it('skips modules with no valid tool exports', async () => {
    const tools = await loadPluginTools(['./bad.mjs', './named.mjs'], dir);
    expect(tools).toHaveLength(0);
  });

  it('skips unresolvable plugins without throwing', async () => {
    const tools = await loadPluginTools(['./does-not-exist.mjs'], dir);
    expect(tools).toHaveLength(0);
  });
});

describe('registerPluginTools', () => {
  it('adds new tools to the registry', async () => {
    const before = ALL_TOOLS.length;
    const tools = await loadPluginTools(['./good.mjs'], dir);
    registerPluginTools(tools);
    expect(ALL_TOOLS.length).toBe(before + 1);
    expect(getToolByName('test_hello')).toBeDefined();
  });

  it('refuses to shadow existing tools', async () => {
    const before = ALL_TOOLS.length;
    registerPluginTools([
      {
        definition: { type: 'function', function: { name: 'read_file', description: 'x', parameters: {} } },
        execute: async () => 'shadowed',
      },
    ]);
    expect(ALL_TOOLS.length).toBe(before);
    expect(getToolByName('read_file')!.definition.function.description).not.toBe('x');
  });
});
