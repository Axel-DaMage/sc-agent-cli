import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectMcpServers, shutdownMcpServers } from './server-tools.js';

let dir: string;
let serverPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'scc-mcp-'));
  // Minimal newline-delimited JSON-RPC MCP server fixture
  serverPath = join(dir, 'fake-mcp.mjs');
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
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',serverInfo:{name:'fake',version:'0.1'},capabilities:{tools:{}}}})+'\\n');
    } else if(m.method==='notifications/initialized'){
      // no response
    } else if(m.method==='tools/list'){
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',description:'Echo back',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}})+'\\n');
    } else if(m.method==='tools/call' && m.params?.name==='echo'){
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'echo:'+m.params.arguments.text}]}})+'\\n');
    }
  }
});`
  );
});

afterAll(() => {
  shutdownMcpServers();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP client (stdio)', () => {
  it('connects, lists tools, and exposes mcp__<server>__<tool>', async () => {
    const tools = await connectMcpServers({
      fake: { command: process.execPath, args: [serverPath], timeoutMs: 5000 },
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].definition.function.name).toBe('mcp__fake__echo');
  });

  it('tools/call returns remote text content', async () => {
    const tools = await connectMcpServers({
      fake: { command: process.execPath, args: [serverPath], timeoutMs: 5000 },
    });
    const out = await tools[0].execute({ text: 'hello' }, {} as never);
    expect(out).toBe('echo:hello');
  });

  it('a server that fails to spawn is skipped, not fatal', async () => {
    const tools = await connectMcpServers({
      missing: { command: 'definitely-not-a-real-binary-xyz', timeoutMs: 3000 },
    });
    expect(tools).toHaveLength(0);
  });
});
