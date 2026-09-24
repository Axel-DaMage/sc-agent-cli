import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { probeProviderEndpoint } from './doctor.js';
import type { ProjectConfig } from '../core/types.js';

function makeConfig(overrides: Partial<ProjectConfig['model']> = {}): ProjectConfig {
  return {
    model: {
      provider: 'openai-compatible',
      baseUrl: 'http://gateway.local/v1',
      apiKey: 'test-key',
      model: 'test-model',
      ...overrides,
    },
  };
}

function stubFetchSequence(handler: (url: string) => Response | Promise<Response> | Error) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const out = handler(url);
    if (out instanceof Error) throw out;
    return out;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('probeProviderEndpoint: /models 2xx → PASS', async () => {
  const calls = stubFetchSequence(() => new Response('{}', { status: 200 }));
  const r = await probeProviderEndpoint(makeConfig());
  assert.equal(r.status, 'PASS');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/models$/);
});

test('probeProviderEndpoint: /models 401 + chat/completions 2xx → PASS (admin-protected gateway)', async () => {
  const calls = stubFetchSequence((url) =>
    url.endsWith('/models')
      ? new Response('unauthorized', { status: 401 })
      : new Response('{"choices":[]}', { status: 200 }),
  );
  const r = await probeProviderEndpoint(makeConfig());
  assert.equal(r.status, 'PASS');
  assert.match(r.detail, /admin-protected/);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/chat\/completions$/);
});

test('probeProviderEndpoint: /models 401 + chat/completions 401 with apiKey → FAIL', async () => {
  stubFetchSequence(() => new Response('unauthorized', { status: 401 }));
  const r = await probeProviderEndpoint(makeConfig());
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /auth rejected/);
  assert.ok(r.fix);
});

test('probeProviderEndpoint: 401s without apiKey → WARN (key missing, not rejected)', async () => {
  stubFetchSequence(() => new Response('unauthorized', { status: 401 }));
  const r = await probeProviderEndpoint(makeConfig({ apiKey: undefined }));
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /no apiKey/);
});

test('probeProviderEndpoint: /models 401 + chat/completions non-auth error → WARN inconclusive', async () => {
  stubFetchSequence((url) =>
    url.endsWith('/models')
      ? new Response('unauthorized', { status: 401 })
      : new Response('bad gateway', { status: 502 }),
  );
  const r = await probeProviderEndpoint(makeConfig());
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /inconclusive/);
});

test('probeProviderEndpoint: /models 401 + probe throws → WARN (could not confirm)', async () => {
  stubFetchSequence((url) =>
    url.endsWith('/models')
      ? new Response('unauthorized', { status: 401 })
      : new Error('socket hangup'),
  );
  const r = await probeProviderEndpoint(makeConfig());
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /probe failed/);
});

test('probeProviderEndpoint: /models unreachable → FAIL', async () => {
  stubFetchSequence(() => new Error('connect ECONNREFUSED'));
  const r = await probeProviderEndpoint(makeConfig());
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /unreachable/);
});

test('probeProviderEndpoint: /models non-auth non-2xx → WARN', async () => {
  stubFetchSequence(() => new Response('oops', { status: 500 }));
  const r = await probeProviderEndpoint(makeConfig());
  assert.equal(r.status, 'WARN');
});
