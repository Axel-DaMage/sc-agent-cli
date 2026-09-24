import { spawn, ChildProcess } from 'node:child_process';

/**
 * Minimal MCP client — stdio transport, newline-delimited JSON-RPC 2.0 (#401).
 *
 * One McpClient per configured server. Crash isolation: if the child dies,
 * all pending requests reject and future calls fail cleanly — a dead server
 * can never take down the agent loop.
 */

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number; // per-request timeout, default 30000
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private dead: Error | null = null;
  private stderrTail: string[] = [];

  constructor(
    public readonly name: string,
    private spec: McpServerSpec,
  ) {}

  private get timeoutMs(): number {
    return this.spec.timeoutMs ?? 30_000;
  }

  /** Spawn + initialize handshake + tools/list. Throws on failure. */
  async connect(): Promise<McpToolDef[]> {
    if (this.child) throw new Error(`MCP server "${this.name}" already connected`);
    this.child = spawn(this.spec.command, this.spec.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(this.spec.env ?? {}) },
    });

    this.child.stdout!.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr!.on('data', (d: Buffer) => {
      this.stderrTail.push(d.toString('utf-8'));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    this.child.on('error', (e) => this.onDeath(new Error(`spawn failed: ${e.message}`)));
    this.child.on('close', (code) =>
      this.onDeath(new Error(`process exited (code ${code})${this.stderrTail.length ? ` — stderr: ${this.stderrTail.join('').slice(-400)}` : ''}`))
    );
    // Ensure children never outlive the CLI
    process.on('exit', () => this.kill());

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sc-agent', version: '0.4.2' },
    });
    // MCP spec: client must send notifications/initialized before other calls
    this.notify('notifications/initialized', {});

    const listed = (await this.request('tools/list', {})) as { tools?: McpToolDef[] };
    return listed.tools ?? [];
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', { name: tool, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (result?.isError) throw new Error(text || 'MCP tool returned isError');
    return text || JSON.stringify(result ?? {});
  }

  isAlive(): boolean {
    return !this.dead && !!this.child && this.child.exitCode === null;
  }

  kill(): void {
    try {
      this.child?.kill();
    } catch {
      /* already dead */
    }
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.isAlive()) return;
    this.child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.isAlive()) {
      return Promise.reject(this.dead ?? new Error(`MCP server "${this.name}" is not connected`));
    }
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`MCP "${this.name}" ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString('utf-8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout — ignore
      }
      if (typeof msg.id !== 'number') continue; // server-initiated notification/request — ignore
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
      else p.resolve(msg.result);
    }
  }

  private onDeath(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
