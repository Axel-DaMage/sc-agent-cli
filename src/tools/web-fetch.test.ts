import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { webFetchTool } from './web-fetch.js';
import type { ToolContext } from './tool.js';
import type { WebFetchConfig } from '../core/types.js';

function makeCtx(webFetch?: WebFetchConfig): ToolContext {
  return {
    workspaceRoot: '/workspace',
    config: {
      model: {
        provider: 'openai-compatible',
        baseUrl: 'http://provider.test/v1',
        model: 'test-model',
      },
      webFetch,
    },
  };
}

function stubFetch(handler: (url: string) => unknown) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  });
  return calls;
}

const exec = (args: Record<string, unknown>, ctx: ToolContext) =>
  webFetchTool.execute(args, ctx);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

test('web_fetch blocks the cloud metadata IP before connect', async () => {
  const calls = stubFetch(() => new Response('internal'));
  await assert.rejects(
    exec({ url: 'http://169.254.169.254/latest/meta-data/' }, makeCtx()),
    /private\/reserved/,
  );
  assert.equal(calls.length, 0);
});

test('web_fetch blocks loopback and private literal targets', async () => {
  const calls = stubFetch(() => new Response('internal'));
  for (const url of [
    'http://127.0.0.1:8080/',
    'http://10.0.0.1/',
    'http://192.168.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
  ]) {
    await assert.rejects(exec({ url }, makeCtx()), /private\/reserved|Blocked/, `${url}`);
  }
  assert.equal(calls.length, 0);
});

test('web_fetch re-validates every redirect hop — redirect to internal is blocked', async () => {
  const calls = stubFetch((url) =>
    url === 'http://93.184.216.34/start'
      ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
      : new Response('internal'),
  );
  await assert.rejects(
    exec({ url: 'http://93.184.216.34/start' }, makeCtx()),
    /private\/reserved/,
  );
  assert.equal(calls.length, 1); // the internal hop was never fetched
});

test('web_fetch blocks redirect to a private IP', async () => {
  stubFetch(() =>
    new Response(null, { status: 301, headers: { location: 'http://192.168.1.10/admin' } }),
  );
  await assert.rejects(
    exec({ url: 'http://93.184.216.34/' }, makeCtx()),
    /private\/reserved/,
  );
});

test('web_fetch rejects non-http(s) schemes without fetching', async () => {
  const calls = stubFetch(() => new Response('x'));
  await assert.rejects(exec({ url: 'file:///etc/passwd' }, makeCtx()), /scheme/);
  await assert.rejects(exec({ url: 'gopher://internal/' }, makeCtx()), /scheme/);
  assert.equal(calls.length, 0);
});

test('web_fetch rejects URLs with embedded credentials', async () => {
  const calls = stubFetch(() => new Response('x'));
  await assert.rejects(
    exec({ url: 'http://user:pw@93.184.216.34/' }, makeCtx()),
    /credentials/,
  );
  assert.equal(calls.length, 0);
});

test('web_fetch enforces webFetch.allowlist', async () => {
  const calls = stubFetch(() => new Response('x'));
  await assert.rejects(
    exec({ url: 'http://8.8.8.8/' }, makeCtx({ allowlist: ['docs.example.com'] })),
    /webFetch\.allowlist/,
  );
  assert.equal(calls.length, 0);
});

test('web_fetch allows allowlisted private hosts when allowPrivateHosts is set', async () => {
  stubFetch(() => new Response('local docs', { headers: { 'content-type': 'text/plain' } }));
  const out = await exec(
    { url: 'http://localhost:8080/api' },
    makeCtx({ allowlist: ['localhost:8080'], allowPrivateHosts: true }),
  );
  assert.equal(out, 'local docs');
});

// ---------------------------------------------------------------------------
// Download bounds
// ---------------------------------------------------------------------------

test('web_fetch streams the body and truncates at the byte cap', async () => {
  const chunk = new Uint8Array(512).fill(0x61); // 'a'
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (pulls > 20) {
        c.close();
        return;
      }
      c.enqueue(chunk);
    },
  });
  const fakeResponse = {
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/plain' }),
    body: stream,
  };
  stubFetch(() => fakeResponse);

  const out = await exec({ url: 'http://8.8.8.8/big' }, makeCtx({ maxBytes: 2048 }));
  assert.match(out, /truncated during transfer/);
  assert.ok(out.length < 4096, `output should be capped, got ${out.length}`);
  assert.ok(pulls < 20, `stream should have been cancelled early, got ${pulls} pulls`);
});

test('web_fetch caps a buffered oversized body without a stream', async () => {
  const big = 'x'.repeat(64 * 1024);
  stubFetch(() => new Response(big, { headers: { 'content-type': 'text/plain' } }));
  const out = await exec({ url: 'http://8.8.8.8/big' }, makeCtx({ maxBytes: 4096 }));
  assert.match(out, /truncated during transfer/);
  assert.ok(out.length < 8192);
});

// ---------------------------------------------------------------------------
// Regression coverage — normal fetch behavior
// ---------------------------------------------------------------------------

test('web_fetch returns text content for a public URL', async () => {
  stubFetch(() => new Response('hello world', { headers: { 'content-type': 'text/plain' } }));
  assert.equal(await exec({ url: 'http://8.8.8.8/' }, makeCtx()), 'hello world');
});

test('web_fetch follows redirects to public targets', async () => {
  const calls = stubFetch((url) =>
    url === 'http://8.8.8.8/a'
      ? new Response(null, { status: 301, headers: { location: '/b' } })
      : new Response('final', { headers: { 'content-type': 'text/plain' } }),
  );
  assert.equal(await exec({ url: 'http://8.8.8.8/a' }, makeCtx()), 'final');
  assert.equal(calls.length, 2);
});

test('web_fetch pretty-prints JSON responses', async () => {
  stubFetch(
    () =>
      new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }),
  );
  const out = await exec({ url: 'http://8.8.8.8/api' }, makeCtx());
  assert.equal(out, JSON.stringify({ a: 1 }, null, 2));
});

test('web_fetch strips HTML to text', async () => {
  stubFetch(
    () =>
      new Response('<p>Hello <b>world</b></p><script>evil()</script>', {
        headers: { 'content-type': 'text/html' },
      }),
  );
  const out = await exec({ url: 'http://8.8.8.8/' }, makeCtx());
  assert.match(out, /Hello world/);
  assert.ok(!out.includes('script'));
});

test('web_fetch surfaces HTTP errors', async () => {
  stubFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }));
  await assert.rejects(exec({ url: 'http://8.8.8.8/' }, makeCtx()), /HTTP 404/);
});

test('web_fetch fails after exceeding the redirect budget', async () => {
  stubFetch(
    () => new Response(null, { status: 302, headers: { location: 'http://8.8.8.8/next' } }),
  );
  await assert.rejects(exec({ url: 'http://8.8.8.8/a' }, makeCtx()), /maximum redirects/);
});

test('web_fetch validates arguments', async () => {
  await assert.rejects(exec({}, makeCtx()), /Missing required argument/);
  await assert.rejects(exec({ url: 'not a url' }, makeCtx()), /Invalid URL/);
});
