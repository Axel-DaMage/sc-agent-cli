// Mock OpenAI-compatible provider for the e2e suite (#483).
//
// Listens on 127.0.0.1 with an ephemeral port and serves the two endpoints
// the CLI actually calls:
//
//   GET  {baseUrl}/models            — probed by `sc doctor`
//   POST {baseUrl}/chat/completions  — probed by `sc chat` and `sc doctor`
//
// Replies honor the transport mode the client requested: plain JSON when
// `stream:false`, SSE frames (`data:` lines terminated by [DONE]) when
// `stream:true`. Every request is recorded so tests can assert on headers,
// the model id, the stream flag, and how many calls a run consumed.
//
// Deterministic by construction: no network, no secrets, canned replies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockToolCall {
  name: string;
  /** Object form is JSON.stringify'd before being sent on the wire. */
  arguments: Record<string, unknown> | string;
  id?: string;
}

export type MockCompletion =
  | { kind: 'message'; content?: string | null; toolCalls?: MockToolCall[] }
  | { kind: 'http'; status: number; body?: unknown };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON request body, or null when absent/unparseable. */
  json: unknown;
}

/** `callIndex` counts POST /chat/completions calls only (0-based). */
export type MockHandler = (req: RecordedRequest, callIndex: number) => MockCompletion;

export interface MockProvider {
  /** e.g. http://127.0.0.1:PORT/v1 — plug into SC_BASE_URL (a project-scope
   *  `.sc-agent.json` `model.baseUrl` is ignored post-#469). */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

function toWireToolCall(tc: MockToolCall, index: number): WireToolCall {
  return {
    id: tc.id ?? `call_${index + 1}`,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
    },
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  res.end(JSON.stringify(payload));
}

function sendCompletion(
  res: ServerResponse,
  model: string,
  reply: Extract<MockCompletion, { kind: 'message' }>,
  streamed: boolean,
): void {
  const toolCalls = reply.toolCalls?.map(toWireToolCall);
  const hasToolCalls = Boolean(toolCalls && toolCalls.length > 0);

  if (!streamed) {
    sendJson(res, 200, {
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: reply.content ?? null,
            ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  });
  const frames: unknown[] = [];
  if (hasToolCalls) {
    // SSE tool_call deltas carry their own `index` field — the provider
    // accumulates name/arguments per index across chunks.
    frames.push({
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: toolCalls!.map((tc, i) => ({ index: i, ...tc })),
          },
        },
      ],
    });
    frames.push({
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
  } else {
    frames.push({
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: reply.content ?? '' } }],
    });
    frames.push({
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
  }
  // Usage frame honors stream_options.include_usage when the client asks
  // for it; providers that ignore the field simply omit it. Always send it —
  // the parser tolerates an extra frame either way.
  frames.push({
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function startMockProvider(handler: MockHandler): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];
  let chatCalls = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let json: unknown = null;
      if (raw) {
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
      }
      const record: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: { ...req.headers },
        json,
      };
      requests.push(record);

      const url = req.url ?? '';
      if (req.method === 'GET' && url.endsWith('/models')) {
        sendJson(res, 200, {
          object: 'list',
          data: [{ id: 'e2e-mock', object: 'model', created: 0, owned_by: 'e2e' }],
        });
        return;
      }

      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        const reply = handler(record, chatCalls++);
        if (reply.kind === 'http') {
          sendJson(res, reply.status, reply.body ?? { error: { message: `mock http ${reply.status}` } });
          return;
        }
        const body = (json ?? {}) as { model?: unknown; stream?: unknown };
        const model = typeof body.model === 'string' && body.model ? body.model : 'e2e-mock';
        sendCompletion(res, model, reply, body.stream === true);
        return;
      }

      sendJson(res, 404, { error: { message: `mock provider: unhandled ${req.method} ${url}` } });
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            // Responses already set Connection: close; closeAllConnections is
            // a belt-and-suspenders kill for any lingering keep-alive socket.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Script a fixed sequence of completion replies; once the list is exhausted
 * the last reply repeats (re-prompts/self-heal keep arriving deterministically).
 */
export function scriptedCompletions(steps: MockCompletion[]): MockHandler {
  return (_req, i) => steps[Math.min(i, steps.length - 1)];
}
