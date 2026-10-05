import { test, vi, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from './provider.js';
import type { ModelConfig } from './types.js';

// Real failover classes, fake backoff — tests assert the retry bound,
// not wall-clock pacing.
vi.mock('./failover.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./failover.js')>();
  return { ...mod, computeRetryDelay: () => 1 };
});

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://test.api/v1',
    model: 'test-model',
    ...overrides,
  };
}

function sseEvent(data: string): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseDelta(delta: Record<string, unknown>, finish?: string): string {
  const choice: Record<string, unknown> = { index: 0, delta };
  if (finish) choice.finish_reason = finish;
  const obj = { id: 'test-id', object: 'chat.completion.chunk', choices: [choice] };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseToolCallDelta(toolCall: Record<string, unknown>): string {
  const obj = {
    id: 'test-id',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [toolCall] } }],
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

test('chatCompletion returns text content from non-streaming response', async () => {
  const mockResponse = {
    ok: true,
    json: () => Promise.resolve({
      choices: [{ message: { content: 'Hello, world!' } }],
    }),
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse as any);

  const provider = new OpenAICompatibleProvider(makeConfig());
  const result = await provider.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });

  assert.equal(result.content, 'Hello, world!');
  assert.equal(result.tool_calls, undefined);
});

test('chatCompletion handles streaming response with content', async () => {
  const chunks = [
    sseDelta({ role: 'assistant', content: 'Hello' }),
    sseDelta({ content: ' world' }),
    sseDelta({ content: '' }, 'stop'),
    'data: [DONE]\n\n',
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    body: stream,
  } as any);

  const provider = new OpenAICompatibleProvider(makeConfig());
  const result = await provider.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });

  assert.equal(result.content, 'Hello world');
});

test('chatCompletion streams accumulate tool calls', async () => {
  const chunks = [
    sseDelta({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
    sseDelta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
    sseDelta({ tool_calls: [{ index: 0, function: { arguments: '"test.txt"}' } }] }),
    sseDelta({ content: '' }, 'stop'),
    'data: [DONE]\n\n',
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    body: stream,
  } as any);

  const provider = new OpenAICompatibleProvider(makeConfig());
  const result = await provider.chatCompletion({
    messages: [{ role: 'user', content: 'read file' }],
    stream: true,
  });

  assert.ok(result.tool_calls);
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].function.name, 'read_file');
  assert.equal(result.tool_calls[0].function.arguments, '{"path":"test.txt"}');
});

test('chatCompletion emits deltas via onChunk callback', async () => {
  const chunks = [
    sseDelta({ role: 'assistant', content: 'Hello' }),
    sseDelta({ content: ' world' }),
    'data: [DONE]\n\n',
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    body: stream,
  } as any);

  const deltas: string[] = [];
  const provider = new OpenAICompatibleProvider(makeConfig());
  await provider.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  }, (delta) => {
    if (delta.content) deltas.push(delta.content);
  });

  assert.deepEqual(deltas, ['Hello', ' world']);
});

test('chatCompletion handles SSE data split across TCP chunks', async () => {
  // Split a proper API response format across TCP chunks
  const first = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hel';
  const second = 'lo"}}]}\n\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      controller.enqueue(encoder.encode(second));
      controller.close();
    },
  });

  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    body: stream,
  } as any);

  const provider = new OpenAICompatibleProvider(makeConfig());
  const result = await provider.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });

  assert.equal(result.content, 'hello');
});

test('chatCompletion throws on non-OK response', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: false,
    status: 401,
    text: () => Promise.resolve('Unauthorized'),
  } as any);

  const provider = new OpenAICompatibleProvider(makeConfig());
  await assert.rejects(
    () => provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    /API Error 401/
  );
});

test('chatCompletion handles streaming=false without body gracefully', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    body: null,
    json: () => Promise.resolve({ choices: [{ message: { content: '' } }] }),
  } as any);

  const provider = new OpenAICompatibleProvider(makeConfig({ stream: false }));
  const result = await provider.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });
  assert.equal(result.content, '');
});

test('chatCompletion retries on 429 with backoff', async () => {
  let callCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    callCount++;
    if (callCount < 3) {
      return { ok: false, status: 429, text: () => Promise.resolve('Rate limited') } as any;
    }
    return { ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) } as any;
  });

  const provider = new OpenAICompatibleProvider(makeConfig());
  const result = await provider.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });

  assert.equal(callCount, 3);
  assert.equal(result.content, 'ok');
});
