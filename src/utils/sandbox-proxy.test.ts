import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import {
  EgressFilterProxy,
  parseAuthorityTarget,
  parseProxyRequest,
  type EgressViolation,
} from './sandbox-proxy.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

// ---------------------------------------------------------------------------
// parseAuthorityTarget
// ---------------------------------------------------------------------------

test('parseAuthorityTarget parses host:port and defaults to 443', () => {
  assert.deepEqual(parseAuthorityTarget('api.github.com:443'), { host: 'api.github.com', port: 443 });
  assert.deepEqual(parseAuthorityTarget('api.github.com'), { host: 'api.github.com', port: 443 });
  assert.deepEqual(parseAuthorityTarget('Example.COM:8443'), { host: 'example.com', port: 8443 });
  assert.deepEqual(parseAuthorityTarget('[::1]:8080'), { host: '::1', port: 8080 });
  assert.deepEqual(parseAuthorityTarget('[::1]'), { host: '::1', port: 443 });
  assert.equal(parseAuthorityTarget('host:notaport'), null);
  assert.equal(parseAuthorityTarget('host:70000'), null);
});

// ---------------------------------------------------------------------------
// parseProxyRequest
// ---------------------------------------------------------------------------

test('parseProxyRequest parses CONNECT authority form', () => {
  const req = parseProxyRequest('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n');
  assert.ok(req);
  assert.equal(req.connect, true);
  assert.equal(req.host, 'api.github.com');
  assert.equal(req.port, 443);
});

test('parseProxyRequest parses absolute-form GET and defaults http→80 / https→443', () => {
  const req = parseProxyRequest('GET http://example.com:8080/path?q=1 HTTP/1.1\r\nHost: example.com\r\n');
  assert.ok(req);
  assert.equal(req.connect, false);
  assert.equal(req.host, 'example.com');
  assert.equal(req.port, 8080);
  assert.equal(req.target, '/path?q=1');

  const https = parseProxyRequest('GET https://example.com/x HTTP/1.1\r\nHost: example.com\r\n');
  assert.equal(https?.port, 443);

  const plain = parseProxyRequest('GET http://example.com/x HTTP/1.1\r\nHost: example.com\r\n');
  assert.equal(plain?.port, 80);
});

test('parseProxyRequest resolves origin-form destinations from the Host header', () => {
  const req = parseProxyRequest('GET /index.html HTTP/1.1\r\nHost: www.example.com\r\n\r\n');
  assert.ok(req);
  assert.equal(req.host, 'www.example.com');
  assert.equal(req.port, 80);
  assert.equal(req.target, '/index.html');

  const withPort = parseProxyRequest('GET /x HTTP/1.1\r\nHost: www.example.com:8080\r\n\r\n');
  assert.equal(withPort?.port, 8080);

  // IPv6 literal hosts: bare colons must not be mistaken for a port separator
  const v6 = parseProxyRequest('GET /x HTTP/1.1\r\nHost: [::1]\r\n\r\n');
  assert.equal(v6?.host, '::1');
  assert.equal(v6?.port, 80);
  const v6p = parseProxyRequest('GET /x HTTP/1.1\r\nHost: [::1]:8080\r\n\r\n');
  assert.equal(v6p?.port, 8080);
});

test('parseProxyRequest rejects malformed requests', () => {
  assert.equal(parseProxyRequest(''), null);
  assert.equal(parseProxyRequest('NOT HTTP AT ALL'), null);
  assert.equal(parseProxyRequest('GET /x HTTP/1.1\r\n\r\n'), null); // no Host
  assert.equal(parseProxyRequest('CONNECT bad:xx HTTP/1.1\r\n\r\n'), null);
});

// ---------------------------------------------------------------------------
// EgressFilterProxy integration (loopback sockets + injected dialer)
// ---------------------------------------------------------------------------

async function startUpstream(handler: (sock: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => server.close());
  return { server, port: (server.address() as net.AddressInfo).port };
}

test('EgressFilterProxy denies non-allowlisted CONNECT with 403 + violation', async () => {
  const violations: EgressViolation[] = [];
  const proxy = new EgressFilterProxy({
    isAllowed: () => false,
    onViolation: (v) => violations.push(v),
  });
  const port = await proxy.start();
  cleanup.push(() => proxy.close());

  const client = net.connect(port, '127.0.0.1');
  await once(client, 'connect');
  client.write('CONNECT evil.com:443 HTTP/1.1\r\n\r\n');
  const chunks: Buffer[] = [];
  client.on('data', (d) => chunks.push(d));
  await once(client, 'close');
  assert.match(Buffer.concat(chunks).toString('latin1'), /^HTTP\/1\.1 403/);
  assert.deepEqual(violations, [{ rule: 'egress', target: 'evil.com:443' }]);
});

test('EgressFilterProxy tunnels allowed CONNECT to the upstream', async () => {
  const upstream = await startUpstream((sock) => sock.end('tunneled-response'));
  const proxy = new EgressFilterProxy({
    isAllowed: (host, p) => host === 'api.example.test' && p === 443,
    dial: () => net.connect(upstream.port, '127.0.0.1'),
  });
  const port = await proxy.start();
  cleanup.push(() => proxy.close());

  const client = net.connect(port, '127.0.0.1');
  await once(client, 'connect');
  client.write('CONNECT api.example.test:443 HTTP/1.1\r\n\r\n');
  const chunks: Buffer[] = [];
  client.on('data', (d) => chunks.push(d));
  await once(client, 'close');
  const text = Buffer.concat(chunks).toString('latin1');
  assert.match(text, /200 Connection Established/);
  assert.match(text, /tunneled-response/);
});

test('EgressFilterProxy rewrites absolute-form GET to origin form upstream', async () => {
  let received = '';
  const upstream = await startUpstream((sock) => {
    sock.on('data', (d) => {
      received += d.toString('latin1');
      sock.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');
    });
  });
  const proxy = new EgressFilterProxy({
    isAllowed: () => true,
    dial: () => net.connect(upstream.port, '127.0.0.1'),
  });
  const port = await proxy.start();
  cleanup.push(() => proxy.close());

  const client = net.connect(port, '127.0.0.1');
  await once(client, 'connect');
  client.write('GET http://allowed.test/some/path HTTP/1.1\r\nHost: allowed.test\r\nX-Keep: yes\r\n\r\n');
  const chunks: Buffer[] = [];
  client.on('data', (d) => chunks.push(d));
  await once(client, 'close');
  assert.match(Buffer.concat(chunks).toString('latin1'), /^HTTP\/1\.1 204/);
  assert.match(received, /^GET \/some\/path HTTP\/1\.1\r\n/);
  assert.match(received, /X-Keep: yes/);
});

test('EgressFilterProxy answers oversized request heads with 431', async () => {
  const proxy = new EgressFilterProxy({ isAllowed: () => true });
  const port = await proxy.start();
  cleanup.push(() => proxy.close());
  const client = net.connect(port, '127.0.0.1');
  await once(client, 'connect');
  client.write(`GET / HTTP/1.1\r\nX-Big: ${'a'.repeat(20 * 1024)}\r\n`);
  const chunks: Buffer[] = [];
  client.on('data', (d) => chunks.push(d));
  await once(client, 'close');
  assert.match(Buffer.concat(chunks).toString('latin1'), /^HTTP\/1\.1 431/);
});
