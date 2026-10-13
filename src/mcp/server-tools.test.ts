import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectMcpServers, shutdownMcpServers } from './server-tools.js';
import type { Tool } from '../tools/tool.js';

// client.test.ts covers the happy-path connect/echo flow; this file locks the
// wrapping contract (#482): name sanitization, default tool metadata, the
// per-call isError degradation shape, and spawn/lifecycle failure isolation.

let dir: string;
let serverPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'scc-mcp-tools-'));
  serverPath = join(dir, 'fake-mcp.mjs');
  // Minimal newline-delimited JSON-RPC server exposing two tools:
  // 'echo.tool' returns text; 'fails' always returns isError:true.
  writeFileSync(
    serverPath,
    `let buf='';
process.stdin.on('data',d=>{
  buf+=d.toString();
  let i;
  while((i=buf.indexOf('\\n'))>=0){
    const line=buf.slice(0,i).trim(); buf=buf.slice(i+1);
    if(!line) continue;
    const m=JSON.parse(line);
    if(m.method==='initialize'){
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{capabilities:{tools:{}}}})+'\\n');
    } else if(m.method==='tools/list'){
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[
        {name:'echo.tool',inputSchema:{type:'object',properties:{text:{type:'string'}}}},
        {name:'fails'}
      ]}})+'\\n');
    } else if(m.method==='tools/call' && m.params?.name==='echo.tool'){
      if(m.params.arguments?.bad){
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'bad args'}})+'\\n');
      } else {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'echo:'+m.params.arguments.text}]}})+'\\n');
      }
    } else if(m.method==='tools/call' && m.params?.name==='fails'){
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:'server-side failure'}]}})+'\\n');
    } else if(m.method==='tools/call'){
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unknown tool'}})+'\\n');
    }
  }
});`
  );
});

afterAll(() => {
  shutdownMcpServers();
  rmSync(dir, { recursive: true, force: true });
});

function findTool(tools: Tool[], suffix: string): Tool {
  const t = tools.find((x) => x.definition.function.name.endsWith(suffix));
  assert.ok(t, `tool ending in ${suffix} must exist (got ${tools.map((x) => x.definition.function.name)})`);
  return t!;
}

it('sanitizes server and tool names into mcp__<server>__<tool>', async () => {
  const tools = await connectMcpServers({
    'my.server': { command: process.execPath, args: [serverPath], timeoutMs: 5000 },
  });
  try {
    const names = tools.map((t) => t.definition.function.name).sort();
    assert.deepEqual(names, ['mcp__my_server__echo_tool', 'mcp__my_server__fails']);
  } finally {
    shutdownMcpServers();
  }
});

it('tool definition carries schema; missing description/inputSchema get defaults', async () => {
  const tools = await connectMcpServers({
    srv: { command: process.execPath, args: [serverPath], timeoutMs: 5000 },
  });
  try {
    const echo = findTool(tools, '__echo_tool');
    assert.equal(echo.definition.type, 'function');
    // No description provided by the server → synthesized fallback.
    assert.equal(echo.definition.function.description, 'MCP tool echo.tool (server: srv)');
    assert.deepEqual(echo.definition.function.parameters, {
      type: 'object',
      properties: { text: { type: 'string' } },
    });

    const fails = findTool(tools, '__fails');
    assert.deepEqual(fails.definition.function.parameters, { type: 'object', properties: {} });
  } finally {
    shutdownMcpServers();
  }
});

it('execute() proxies arguments and returns remote text content', async () => {
  const tools = await connectMcpServers({
    srv: { command: process.execPath, args: [serverPath], timeoutMs: 5000 },
  });
  try {
    const echo = findTool(tools, '__echo_tool');
    const out = await echo.execute({ text: 'hello' }, {} as never);
    assert.equal(out, 'echo:hello');
  } finally {
    shutdownMcpServers();
  }
});

it('isError result degrades to a per-call rejection naming the server-side failure', async () => {
  const tools = await connectMcpServers({
    srv: { command: process.execPath, args: [serverPath], timeoutMs: 5000 },
  });
  try {
    const fails = findTool(tools, '__fails');
    await assert.rejects(() => fails.execute({}, {} as never), /server-side failure/);
  } finally {
    shutdownMcpServers();
  }
});

it('JSON-RPC error frames reject the per-call promise', async () => {
  const tools = await connectMcpServers({
    srv: { command: process.execPath, args: [serverPath], timeoutMs: 5000 },
  });
  try {
    const echo = findTool(tools, '__echo_tool');
    await assert.rejects(() => echo.execute({ bad: true }, {} as never), /bad args/);
  } finally {
    shutdownMcpServers();
  }
});

describe('lifecycle', () => {
  it('a server that cannot spawn is skipped — never crashes the caller', async () => {
    const tools = await connectMcpServers({
      missing: { command: 'definitely-not-a-real-binary-xyz-482', timeoutMs: 2000 },
    });
    assert.deepEqual(tools, []);
  });

  it('a server exiting during handshake is skipped', async () => {
    const tools = await connectMcpServers({
      dying: { command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutMs: 3000 },
    });
    assert.deepEqual(tools, []);
  });

  it('a dead server turns subsequent calls into per-call rejections', async () => {
    const tools = await connectMcpServers({
      srv: { command: process.execPath, args: [serverPath], timeoutMs: 5000 },
    });
    const echo = findTool(tools, '__echo_tool');

    shutdownMcpServers();

    // The child dies asynchronously after kill(); poll until the client
    // observes death, then every call must reject — never hang or throw
    // synchronously.
    const deadline = Date.now() + 5000;
    let rejected = false;
    while (Date.now() < deadline) {
      try {
        await echo.execute({ text: 'x' }, {} as never);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        rejected = true;
        break;
      }
    }
    assert.ok(rejected, 'execute() must reject once the server process is dead');
  });

  it('shutdownMcpServers is idempotent', () => {
    shutdownMcpServers();
    shutdownMcpServers();
  });
});
