import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FailoverProvider, resolveCascadeTargets, DEFAULT_CASCADE_CLASSES } from './failover.js';
import { OpenAICompatibleProvider } from './provider.js';
import {
  ProviderCascadeError,
  ProviderError,
  classifyHttpStatus,
  classifyProviderError,
  isRetryableClass,
} from './provider-error.js';
import { classifyError, EXIT_CODES } from '../utils/exit-codes.js';
import type { ModelConfig, ProjectConfig } from './types.js';

function makeModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'fixture',
    ...overrides,
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function failWith(status: number, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: `status ${status}` }));
  };
}

function okJson(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
}

async function startServer(handler: Handler) {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    state.requests++;
    handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => state.requests,
  };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

const FAST_RETRY = { maxRetries: 1, baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 5 };
const NO_RETRY = { maxRetries: 0, baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 5 };

const USER_MSG = { messages: [{ role: 'user' as const, content: 'fixture' }], stream: false };

// --- Failure classification ------------------------------------------------

test('classifyHttpStatus maps the taxonomy', () => {
  assert.equal(classifyHttpStatus(429), 'rate_limit');
  assert.equal(classifyHttpStatus(503), 'server');
  assert.equal(classifyHttpStatus(500), 'server');
  assert.equal(classifyHttpStatus(401), 'auth');
  assert.equal(classifyHttpStatus(403), 'auth');
  assert.equal(classifyHttpStatus(400), 'client');
  assert.equal(classifyHttpStatus(404), 'client');
  assert.equal(classifyHttpStatus(200), 'unknown');
});

test('classifyProviderError handles structured and message-only errors', () => {
  assert.equal(
    classifyProviderError(new ProviderError('API Error 429: slow down', 'rate_limit', 429)),
    'rate_limit'
  );
  assert.equal(classifyProviderError(new Error('fetch failed')), 'network');
  assert.equal(classifyProviderError(new Error('Connection timed out')), 'timeout');
  assert.equal(classifyProviderError(new Error('API Error 503: down')), 'server');
  assert.equal(classifyProviderError(new Error('something else')), 'unknown');
});

test('isRetryableClass: transient and unknown retry; auth/client/aborted do not', () => {
  for (const cls of ['rate_limit', 'server', 'timeout', 'network', 'unknown'] as const) {
    assert.equal(isRetryableClass(cls), true, cls);
  }
  for (const cls of ['auth', 'client', 'aborted'] as const) {
    assert.equal(isRetryableClass(cls), false, cls);
  }
});

// --- Bounded retries -------------------------------------------------------

test('provider honors a configurable bounded retry policy', async () => {
  const a = await startServer(failWith(503));
  const provider = new OpenAICompatibleProvider(makeModel({ baseUrl: a.baseUrl }));
  provider.setRetryPolicy({ maxRetries: 0 });
  try {
    await assert.rejects(provider.chatCompletion(USER_MSG), /API Error 503/);
    assert.equal(a.requests(), 1, 'maxRetries=0 means a single attempt');
  } finally {
    await stopServer(a.server);
  }
});

test('provider honors Retry-After hints while staying bounded', async () => {
  let calls = 0;
  const a = await startServer((_req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end(JSON.stringify({ error: 'rate limited' }));
      return;
    }
    okJson(_req, res);
  });
  const provider = new OpenAICompatibleProvider(makeModel({ baseUrl: a.baseUrl }));
  provider.setRetryPolicy(FAST_RETRY);
  try {
    const res = await provider.chatCompletion(USER_MSG);
    assert.equal(res.content, 'ok');
    assert.equal(calls, 2, 'one retry after the 429');
  } finally {
    await stopServer(a.server);
  }
});

test('provider throws ProviderError with structured classification', async () => {
  const a = await startServer(failWith(429));
  const provider = new OpenAICompatibleProvider(makeModel({ baseUrl: a.baseUrl }));
  provider.setRetryPolicy(NO_RETRY);
  try {
    await provider.chatCompletion(USER_MSG);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.failureClass, 'rate_limit');
    assert.equal(err.status, 429);
    assert.equal(classifyError(err), EXIT_CODES.PROVIDER_ERROR);
  } finally {
    await stopServer(a.server);
  }
});

// --- Cascade ---------------------------------------------------------------

test.each([429, 503])(
  'cascades to the next provider after bounded retries on %i, then stays sticky',
  async status => {
    const a = await startServer(failWith(status));
    const b = await startServer(okJson);
    const failoverEvents: string[] = [];
    const fp = new FailoverProvider(
      [
        { label: 'primary', config: makeModel({ baseUrl: a.baseUrl, model: 'model-a' }) },
        { label: 'fallback', config: makeModel({ baseUrl: b.baseUrl, model: 'model-b' }) },
      ],
      { retry: FAST_RETRY, onFailover: (from, to) => failoverEvents.push(`${from.label}->${to.label}`) }
    );
    try {
      const res = await fp.chatCompletion(USER_MSG);
      assert.equal(res.content, 'ok');
      assert.equal(a.requests(), 2, 'primary bounded at 1 + maxRetries');
      assert.equal(b.requests(), 1);
      assert.equal(fp.activeModel, 'model-b');
      assert.deepEqual(failoverEvents, ['primary->fallback']);
      assert.equal(fp.lastAttempts.length, 1);
      assert.equal(fp.lastAttempts[0].label, 'primary');

      // Sticky: the next call goes straight to the working provider.
      const res2 = await fp.chatCompletion(USER_MSG);
      assert.equal(res2.content, 'ok');
      assert.equal(b.requests(), 2);
      assert.equal(a.requests(), 2, 'primary is not retried once failed over');
    } finally {
      await stopServer(a.server);
      await stopServer(b.server);
    }
  }
);

test('does not cascade on auth errors by default', async () => {
  const a = await startServer(failWith(401));
  const b = await startServer(okJson);
  const fp = new FailoverProvider(
    [
      { label: 'primary', config: makeModel({ baseUrl: a.baseUrl }) },
      { label: 'fallback', config: makeModel({ baseUrl: b.baseUrl }) },
    ],
    { retry: NO_RETRY }
  );
  try {
    await assert.rejects(fp.chatCompletion(USER_MSG), /API Error 401/);
    assert.equal(a.requests(), 1);
    assert.equal(b.requests(), 0, 'auth errors fail fast — never reach the fallback');
  } finally {
    await stopServer(a.server);
    await stopServer(b.server);
  }
});

test('cascadeOn makes otherwise-terminal classes eligible', async () => {
  const a = await startServer(failWith(401));
  const b = await startServer(okJson);
  const fp = new FailoverProvider(
    [
      { label: 'primary', config: makeModel({ baseUrl: a.baseUrl }) },
      { label: 'fallback', config: makeModel({ baseUrl: b.baseUrl }) },
    ],
    { retry: NO_RETRY, cascadeOn: [...DEFAULT_CASCADE_CLASSES, 'auth'] }
  );
  try {
    const res = await fp.chatCompletion(USER_MSG);
    assert.equal(res.content, 'ok');
    assert.equal(b.requests(), 1);
  } finally {
    await stopServer(a.server);
    await stopServer(b.server);
  }
});

test('exhausted cascade throws ProviderCascadeError with the ordered attempt log', async () => {
  const a = await startServer(failWith(503));
  const b = await startServer(failWith(429));
  const fp = new FailoverProvider(
    [
      { label: 'primary', config: makeModel({ baseUrl: a.baseUrl, model: 'model-a' }) },
      { label: 'fallback', config: makeModel({ baseUrl: b.baseUrl, model: 'model-b' }) },
    ],
    { retry: NO_RETRY }
  );
  try {
    await fp.chatCompletion(USER_MSG);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ProviderCascadeError);
    assert.equal(err.attempts.length, 2);
    assert.equal(err.attempts[0].label, 'primary');
    assert.equal(err.attempts[0].failureClass, 'server');
    assert.equal(err.attempts[1].label, 'fallback');
    assert.equal(err.attempts[1].failureClass, 'rate_limit');
    assert.equal(err.failureClass, 'rate_limit', 'terminal failure drives classification');
    assert.equal(classifyError(err), EXIT_CODES.PROVIDER_ERROR);
    assert.match(err.message, /failover chain failed \(2 targets\)/);
  } finally {
    await stopServer(a.server);
    await stopServer(b.server);
  }
});

test('a terminal non-eligible error mid-cascade preserves the attempt trail', async () => {
  const a = await startServer(failWith(503));
  const b = await startServer(failWith(401));
  const fp = new FailoverProvider(
    [
      { label: 'primary', config: makeModel({ baseUrl: a.baseUrl }) },
      { label: 'fallback', config: makeModel({ baseUrl: b.baseUrl }) },
    ],
    { retry: NO_RETRY }
  );
  try {
    await fp.chatCompletion(USER_MSG);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ProviderCascadeError);
    assert.equal(err.attempts.length, 2);
    assert.equal(err.failureClass, 'auth');
    assert.equal(classifyError(err), EXIT_CODES.AUTH_ERROR);
  } finally {
    await stopServer(a.server);
    await stopServer(b.server);
  }
});

test('caller abort never retries or cascades', async () => {
  const a = await startServer(failWith(503));
  const b = await startServer(okJson);
  const controller = new AbortController();
  controller.abort(new Error('Caller cancelled'));
  const fp = new FailoverProvider(
    [
      { label: 'primary', config: makeModel({ baseUrl: a.baseUrl }) },
      { label: 'fallback', config: makeModel({ baseUrl: b.baseUrl }) },
    ],
    { retry: FAST_RETRY }
  );
  try {
    await assert.rejects(
      fp.chatCompletion({ ...USER_MSG, signal: controller.signal }),
      /cancel/i
    );
    assert.equal(a.requests(), 0, 'aborted before the first request');
    assert.equal(b.requests(), 0);
  } finally {
    await stopServer(a.server);
    await stopServer(b.server);
  }
});

test('single-provider chain rethrows the original error unwrapped', async () => {
  const a = await startServer(failWith(503));
  const fp = new FailoverProvider(
    [{ label: 'primary', config: makeModel({ baseUrl: a.baseUrl }) }],
    { retry: NO_RETRY }
  );
  try {
    await fp.chatCompletion(USER_MSG);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.ok(!(err instanceof ProviderCascadeError));
    assert.match(err.message, /API Error 503/);
  } finally {
    await stopServer(a.server);
  }
});

// --- Config resolution -----------------------------------------------------

test('resolveCascadeTargets resolves profile names and inline overrides', () => {
  vi.stubEnv('NVIDIA_API_KEY', '');
  const config: ProjectConfig = {
    model: makeModel({ baseUrl: 'https://api.openai.com/v1', apiKey: 'primary-key', model: 'gpt-4o' }),
    profiles: {
      ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
      nvidia: {
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: '<YOUR_NVIDIA_KEY>',
        model: 'nvidia/nemotron',
      },
    },
    failover: {
      cascade: ['ollama', 'nvidia', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }],
    },
  };
  try {
    const targets = resolveCascadeTargets(config);
    assert.equal(targets.length, 3);
    assert.equal(targets[0].label, 'ollama');
    assert.equal(targets[0].config.model, 'llama3.2');
    assert.equal(
      targets[0].config.apiKey,
      undefined,
      'a different-host fallback must not inherit the primary credential'
    );
    assert.equal(targets[1].label, 'nvidia');
    assert.equal(targets[1].config.apiKey, undefined, 'placeholder resolves to undefined without env');
    assert.equal(targets[2].label, 'gpt-4o-mini');
    assert.equal(targets[2].config.apiKey, 'primary-key', 'same-host fallback keeps the credential');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('resolveCascadeTargets picks up provider-specific env keys for fallback hosts', () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
  const config: ProjectConfig = {
    model: makeModel({ baseUrl: 'http://localhost:11434/v1' }),
    profiles: {
      anthropic: {
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: '<YOUR_ANTHROPIC_KEY>',
        model: 'claude-sonnet-4-6',
      },
    },
    failover: { cascade: ['anthropic'] },
  };
  try {
    const [target] = resolveCascadeTargets(config);
    assert.equal(target.config.apiKey, 'env-key');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('resolveCascadeTargets throws on unknown profile names', () => {
  const config: ProjectConfig = {
    model: makeModel(),
    failover: { cascade: ['nope'] },
  };
  assert.throws(() => resolveCascadeTargets(config), /unknown profile "nope"/);
});

test('empty cascade resolves to an empty chain', () => {
  assert.deepEqual(resolveCascadeTargets({ model: makeModel() }), []);
});
