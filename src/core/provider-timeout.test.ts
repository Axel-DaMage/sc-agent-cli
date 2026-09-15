import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleProvider } from './provider.js';

test.each([
  { stream: false, status: 200 },
  { stream: true, status: 200 },
  { stream: false, status: 503 },
])('bounds stalled response bodies: $status stream=$stream', async ({ stream, status }) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(status, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
    response.flushHeaders();
    // Deliberately leave the body open after successful header delivery.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const provider = new OpenAICompatibleProvider({
    provider: 'openai-compatible', model: 'fixture',
    baseUrl: `http://127.0.0.1:${port}/v1`, timeout: 200,
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([
      provider.chatCompletion({ messages: [{ role: 'user', content: 'fixture' }], stream }),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('Test watchdog: body deadline was not enforced')), 8000);
      }),
    ]), /abort|timed out/i);
    assert.equal(requests, 3, 'preserve the existing two-retry limit');
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test.each([false, true])('caller cancellation interrupts a stalled body without retry: stream=%s', async stream => {
  let requests = 0;
  let cancel: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
    response.flushHeaders();
    cancel = setTimeout(() => controller.abort(new Error('Caller cancelled')), 50);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const provider = new OpenAICompatibleProvider({
    provider: 'openai-compatible', model: 'fixture',
    baseUrl: `http://127.0.0.1:${port}/v1`, timeout: 1000,
  });
  try {
    await assert.rejects(provider.chatCompletion({
      messages: [{ role: 'user', content: 'fixture' }], stream, signal: controller.signal,
    }), /abort|cancel/i);
    assert.equal(requests, 1);
  } finally {
    clearTimeout(cancel);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
