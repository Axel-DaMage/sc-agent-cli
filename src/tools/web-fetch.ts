import type { Tool, ToolContext } from './tool.js';
import {
  FetchTargetBlockedError,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_MAX_TIMEOUT_MS,
  assertFetchTargetAllowed,
  resolveWebFetchPolicy,
  resolveWebFetchTimeout,
} from '../utils/ssrf-guard.js';

export const webFetchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch content from a public http(s) URL. Use for reading documentation, API responses, GitHub pages, etc. Private, loopback and link-local destinations are blocked (SSRF protection).',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to fetch content from',
          },
          timeout: {
            type: 'number',
            description: `Timeout in milliseconds (default: 15000, max: ${WEB_FETCH_MAX_TIMEOUT_MS})`,
          },
        },
        required: ['url'],
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const url = args.url as string;
    const timeout = resolveWebFetchTimeout(args.timeout);
    const policy = resolveWebFetchPolicy(ctx.config.webFetch);

    if (!url) {
      throw new Error('Missing required argument: url');
    }

    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      let currentUrl = url;

      for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop++) {
        // SSRF gate: scheme/credentials/allowlist/DNS-resolved IP ranges are
        // re-validated for every hop so a redirect cannot bounce into the
        // internal network (#470).
        const target = await assertFetchTargetAllowed(currentUrl, policy);
        const response = await fetch(target.href, {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'User-Agent': 'sc-agent-cli/1.0',
            'Accept': 'text/html,application/json,text/plain,*/*',
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`Redirect ${response.status} with no Location header`);
          }
          currentUrl = new URL(location, target).href;
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const body = await readBodyWithLimit(response, policy.maxBytes);
        const text = body.text;
        let output: string;

        if (contentType.includes('application/json')) {
          try {
            output = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            output = text;
          }
        } else if (contentType.includes('text/html')) {
          output = htmlToText(text);
        } else {
          output = text;
        }

        if (output.length > 30000) {
          output = output.substring(0, 30000) + '\n\n[Truncated at 30000 characters]';
        }
        if (body.truncated) {
          output += `\n\n[Response body exceeded the ${policy.maxBytes}-byte limit; truncated during transfer]`;
        }
        return output;
      }

      throw new Error(`Exceeded maximum redirects (${WEB_FETCH_MAX_REDIRECTS})`);
    } catch (err: unknown) {
      if (err instanceof FetchTargetBlockedError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeout}ms`, { cause: err });
      }
      if (err instanceof Error) {
        throw new Error(`Failed to fetch ${url}: ${err.message}`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  },
};

/**
 * Stream the response body and stop as soon as `maxBytes` have been read —
 * the cap is enforced during transfer so a multi-GB response cannot exhaust
 * process memory (#470). Returns the decoded text plus a truncation flag.
 */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) {
    return { text: '', truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        const keep = value.byteLength - (received - maxBytes);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        received = maxBytes;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // stream may already be torn down — the cap is what matters
        }
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(bytes), truncated };
}

function htmlToText(html: string): string {
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(h[1-6]|p|div|li|blockquote|tr|th|td)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return text;
}
