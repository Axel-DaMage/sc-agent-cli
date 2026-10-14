// #423 — loopback egress-filter proxy for sandboxed `run_shell` commands.
//
// When `sandbox.egressAllowlist` is non-empty, sandboxed commands run with
// HTTP_PROXY/HTTPS_PROXY/ALL_PROXY pointed here. The proxy is the policy
// decision point: every CONNECT tunnel and plain-HTTP forward is matched
// against the allowlist; non-allowlisted targets get `403 Forbidden` and are
// recorded as `sandbox_violation` events ({rule: 'egress', target: 'h:p'}).
//
// This is application-layer egress control — it filters traffic from tools
// that honor proxy env vars / are proxy-aware. On Linux the full boundary
// additionally lands the command behind bwrap mounts, and an empty allowlist
// gets a hard `--unshare-net` netns block instead of this proxy.

import net from 'node:net';
import { verbose } from './verbose-logger.js';

export interface EgressViolation {
  rule: 'egress';
  target: string; // "host:port" as requested by the sandboxed command
}

export interface EgressFilterProxyOptions {
  /** Policy decision point: is this destination permitted? */
  isAllowed: (host: string, port: number) => boolean;
  /** Called synchronously for every denied connection attempt. */
  onViolation?: (violation: EgressViolation) => void;
  /** Idle socket lifetime before the proxy tears a connection down. */
  socketTimeoutMs?: number;
  /** Injectable upstream dialer (tests). Defaults to net.connect. */
  dial?: (port: number, host: string) => net.Socket;
}

const MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_SOCKET_TIMEOUT_MS = 120_000;

/** Parse an authority-form target `host:port` or `[v6]:port`; missing port → 443. */
export function parseAuthorityTarget(target: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target);
  if (m) return { host: m[1].toLowerCase(), port: m[2] ? parseInt(m[2], 10) : 443 };
  const idx = target.lastIndexOf(':');
  if (idx === -1) return { host: target.toLowerCase(), port: 443 };
  const port = parseInt(target.slice(idx + 1), 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) return null;
  return { host: target.slice(0, idx).toLowerCase(), port };
}

/**
 * Parse a forward-proxy request head. Returns the method, the request target
 * in origin form, and the resolved destination — or null when the request is
 * malformed.
 */
export function parseProxyRequest(head: string): {
  method: string;
  target: string; // origin-form target for non-CONNECT requests
  host: string;
  port: number;
  connect: boolean;
} | null {
  const requestLine = head.split('\r\n', 1)[0];
  const m = /^([^\s]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/i.exec(requestLine);
  if (!m) return null;
  const method = m[1].toUpperCase();
  const rawTarget = m[2];

  if (method === 'CONNECT') {
    const dest = parseAuthorityTarget(rawTarget);
    if (!dest || !dest.host) return null;
    return { method, target: rawTarget, host: dest.host, port: dest.port, connect: true };
  }

  // Absolute-form: `GET http://host[:port]/path` — the proxy-visible form.
  if (/^https?:\/\//i.test(rawTarget)) {
    let url: URL;
    try {
      url = new URL(rawTarget);
    } catch {
      return null;
    }
    const port = url.port
      ? parseInt(url.port, 10)
      : url.protocol === 'https:'
        ? 443
        : 80;
    if (Number.isNaN(port) || port < 1 || port > 65535 || !url.hostname) return null;
    const originForm = `${url.pathname}${url.search}${url.hash}` || '/';
    return {
      method,
      target: originForm,
      host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ''),
      port,
      connect: false,
    };
  }

  // Origin-form: destination comes from the Host header (port 80 implied).
  const hostHeader = /^host:\s*(.+)$/im.exec(head)?.[1]?.trim();
  if (!hostHeader) return null;
  const dest = parseAuthorityTarget(hostHeader);
  if (!dest || !dest.host) return null;
  const hasExplicitPort = hostHeader.startsWith('[')
    ? /\]:\d+$/.test(hostHeader)
    : /:\d+$/.test(hostHeader);
  return {
    method,
    target: rawTarget,
    host: dest.host,
    port: hasExplicitPort ? dest.port : 80,
    connect: false,
  };
}

/**
 * Minimal loopback forward proxy enforcing an egress allowlist.
 * `start()` binds to an ephemeral 127.0.0.1 port; the server is unref'd so it
 * never keeps the CLI process alive on its own.
 */
export class EgressFilterProxy {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  private started = false;
  private port: number | null = null;
  private readonly opts: Required<Omit<EgressFilterProxyOptions, 'dial' | 'onViolation' | 'socketTimeoutMs'>> & {
    onViolation?: (v: EgressViolation) => void;
    socketTimeoutMs: number;
    dial: (port: number, host: string) => net.Socket;
  };

  constructor(options: EgressFilterProxyOptions) {
    this.opts = {
      isAllowed: options.isAllowed,
      onViolation: options.onViolation,
      socketTimeoutMs: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
      dial: options.dial ?? ((port, host) => net.connect(port, host)),
    };
    this.server = net.createServer((socket) => this.handleClient(socket));
    this.server.unref();
  }

  get listenPort(): number | null {
    return this.port;
  }

  get proxyUrl(): string | null {
    return this.port == null ? null : `http://127.0.0.1:${this.port}`;
  }

  start(): Promise<number> {
    if (this.started && this.port != null) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        const addr = this.server.address();
        if (addr == null || typeof addr === 'string') {
          reject(new Error('egress proxy failed to bind a loopback port'));
          return;
        }
        this.started = true;
        this.port = addr.port;
        verbose(`sandbox egress proxy listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  close(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    try {
      this.server.close();
    } catch {
      // already closed
    }
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(this.opts.socketTimeoutMs, () => socket.destroy());
    const drop = () => this.sockets.delete(socket);
    socket.on('close', drop);
    socket.on('error', () => {
      socket.destroy();
      drop();
    });
  }

  private handleClient(client: net.Socket): void {
    this.track(client);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headEnd = buf.indexOf('\r\n\r\n');
      if (headEnd === -1) {
        if (buf.length > MAX_HEADER_BYTES) {
          this.respond(client, '431 Request Header Fields Too Large');
        }
        return;
      }
      client.removeListener('data', onData);
      const head = buf.subarray(0, headEnd).toString('latin1');
      const rest = buf.subarray(headEnd + 4);
      this.dispatch(client, head, rest);
    };
    client.on('data', onData);
  }

  private respond(client: net.Socket, status: string): void {
    // end() flushes the response then half-closes; destroy() here would abort
    // the queued write before it hits the wire.
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  private dispatch(client: net.Socket, head: string, rest: Buffer): void {
    const req = parseProxyRequest(head);
    if (!req) {
      this.respond(client, '400 Bad Request');
      return;
    }

    if (!this.opts.isAllowed(req.host, req.port)) {
      this.opts.onViolation?.({ rule: 'egress', target: `${req.host}:${req.port}` });
      this.respond(client, '403 Forbidden');
      return;
    }

    const upstream = this.opts.dial(req.port, req.host);
    upstream.once('error', () => {
      // Upstream refused/failed before the tunnel was established.
      this.respond(client, '502 Bad Gateway');
    });
    upstream.once('connect', () => {
      upstream.removeAllListeners('error');
      upstream.on('error', () => client.destroy());
      this.track(upstream);
      if (req.connect) {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length > 0) upstream.write(rest);
      } else {
        // Rewrite the request line to origin form; the rest of the head is
        // forwarded verbatim so headers/trailers survive untouched.
        const lines = head.split('\r\n');
        lines[0] = `${req.method} ${req.target} ${lines[0].split(' ')[2] ?? 'HTTP/1.1'}`;
        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        if (rest.length > 0) upstream.write(rest);
      }
      upstream.pipe(client).pipe(upstream);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
  }
}
