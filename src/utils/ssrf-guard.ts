// #470 — SSRF protection + download bounds for the `web_fetch` tool.
//
// Enforcement runs once per request AND once per redirect hop:
//   * scheme restricted to http/https; URLs with embedded credentials rejected
//   * optional operator allowlist (`webFetch.allowlist`) — `host` /
//     `host:port` / `*.domain` / `*` entries, same syntax as
//     `sandbox.egressAllowlist` — applied to the destination host:port
//   * loopback / private / link-local / reserved destination block — applied
//     to the URL hostname and to *every* address returned by DNS, so a
//     public hostname cannot bounce into an internal target via DNS records
//     or via a redirect. `webFetch.allowPrivateHosts` is the explicit escape
//     hatch for local development.
//
// Residual TOCTOU: undici resolves DNS again inside fetch() after this
// check, so a fast-rebinding resolver could theoretically race the two
// resolutions. Rejecting when *any* resolved address is non-public narrows
// the window; pinning the resolved address onto the connection would require
// a custom undici dispatcher (not a runtime dependency today).

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { WebFetchConfig } from '../core/types.js';
import { isEgressAllowed, parseEgressRule, type EgressRule } from './sandbox.js';

export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_TIMEOUT_MS = 60_000;
export const WEB_FETCH_DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const WEB_FETCH_MIN_BODY_CAP = 1024; // 1 KiB
export const WEB_FETCH_MAX_BODY_CAP = 64 * 1024 * 1024; // 64 MiB
export const WEB_FETCH_MAX_REDIRECTS = 10;

const DNS_LOOKUP_TIMEOUT_MS = 10_000;

/** Destination rejected by the SSRF/allowlist policy — surfaced unwrapped so the model sees the policy reason. */
export class FetchTargetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchTargetBlockedError';
  }
}

export interface WebFetchPolicy {
  /** Parsed allowlist rules; empty = no allowlist gate. */
  allowlistRules: readonly EgressRule[];
  /** Skip the private/reserved IP block entirely (operator opt-out). */
  allowPrivateHosts: boolean;
  /** Response body cap in bytes, enforced while streaming. */
  maxBytes: number;
}

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/**
 * Clamp the `timeout` tool argument to [default sane floor, 60s]. Non-positive
 * or non-numeric input falls back to the default — an agent must not be able
 * to pin a request open indefinitely.
 */
export function resolveWebFetchTimeout(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return WEB_FETCH_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.trunc(raw), WEB_FETCH_MAX_TIMEOUT_MS);
}

/** Resolve the effective fetch policy from config. Throws on malformed allowlist entries (fail fast). */
export function resolveWebFetchPolicy(config: WebFetchConfig | undefined): WebFetchPolicy {
  const allowlist = config?.allowlist ?? [];
  let allowlistRules: EgressRule[] = [];
  if (allowlist.length > 0) {
    try {
      allowlistRules = allowlist.map(parseEgressRule);
    } catch (err) {
      throw new Error(
        `Invalid webFetch.allowlist: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const rawMaxBytes = config?.maxBytes;
  let maxBytes = WEB_FETCH_DEFAULT_MAX_BYTES;
  if (typeof rawMaxBytes === 'number' && Number.isFinite(rawMaxBytes)) {
    maxBytes = Math.min(
      Math.max(Math.trunc(rawMaxBytes), WEB_FETCH_MIN_BODY_CAP),
      WEB_FETCH_MAX_BODY_CAP,
    );
  }
  return {
    allowlistRules,
    allowPrivateHosts: config?.allowPrivateHosts === true,
    maxBytes,
  };
}

/**
 * Assert a fetch target is allowed under the policy. Runs before every
 * connect — callers must re-invoke for each redirect hop. Returns the
 * normalized URL on success; throws FetchTargetBlockedError on policy denial.
 */
export async function assertFetchTargetAllowed(
  target: string | URL,
  policy: WebFetchPolicy,
  lookup: DnsLookupFn = systemDnsLookup,
): Promise<URL> {
  const url = typeof target === 'string' ? new URL(target) : target;

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchTargetBlockedError(
      `Blocked URL scheme "${url.protocol}" — only http and https are fetchable`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new FetchTargetBlockedError('Blocked URL with embedded credentials');
  }

  const hostname = normalizeHostname(url.hostname);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

  if (policy.allowlistRules.length > 0 && !isEgressAllowed(policy.allowlistRules, hostname, port)) {
    throw new FetchTargetBlockedError(
      `Blocked by webFetch.allowlist: ${hostname}:${port} is not an allowed destination`,
    );
  }

  if (policy.allowPrivateHosts) {
    return url;
  }

  // WHATWG URL parsing already normalized exotic IPv4 notations
  // (2130706433, 0x7f000001, 0177.0.0.1, 127.1) into canonical form.
  if (isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new FetchTargetBlockedError(`Blocked private/reserved destination: ${hostname}`);
    }
    return url;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    throw new Error(
      `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  }
  // Block if ANY resolved address is non-public — round-robin answers that
  // mix public and internal records must not leave a lucky path open.
  for (const { address } of addresses) {
    if (isBlockedIpAddress(address)) {
      throw new FetchTargetBlockedError(
        `Blocked private/reserved destination: ${hostname} resolves to ${address}`,
      );
    }
  }
  return url;
}

/**
 * Classify an IP literal. Returns true when the address is loopback,
 * private, link-local, multicast, reserved, or documentation-only — i.e.
 * anything that must not be a fetch destination. Fails closed: input that
 * is not an IP literal at all also returns true.
 */
export function isBlockedIpAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

function normalizeHostname(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

const systemDnsLookup: DnsLookupFn = async (hostname) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms`)),
          DNS_LOOKUP_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// IPv4 range classification
// ---------------------------------------------------------------------------

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

function ipv4ToLong(ip: string): number | null {
  const bytes = ipv4ToBytes(ip);
  if (!bytes) return null;
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

/** [network base, prefix bits] pairs — RFC1918, loopback, link-local, CGNAT, doc/benchmark ranges, multicast, reserved. */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8       "this network"
  [0x0a000000, 8], // 10.0.0.0/8      RFC1918 private
  [0x64400000, 10], // 100.64.0.0/10  CGNAT shared address space
  [0x7f000000, 8], // 127.0.0.0/8     loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata endpoint)
  [0xac100000, 12], // 172.16.0.0/12  RFC1918 private
  [0xc0000000, 24], // 192.0.0.0/24   IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24   TEST-NET-1 (documentation)
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay anycast (deprecated)
  [0xc0a80000, 16], // 192.168.0.0/16 RFC1918 private
  [0xc6120000, 15], // 198.18.0.0/15  benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2 (documentation)
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3 (documentation)
  [0xe0000000, 4], // 224.0.0.0/4    multicast
  [0xf0000000, 4], // 240.0.0.0/4    reserved + limited broadcast
];

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToLong(ip);
  if (n === null) return true; // fail closed on malformed input
  return BLOCKED_IPV4_RANGES.some(
    ([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits),
  );
}

// ---------------------------------------------------------------------------
// IPv6 range classification
// ---------------------------------------------------------------------------

/** Parse an IPv6 literal (incl. `::` compression and dotted-quad tails) into 16 bytes. Null on malformed input. */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let s = ip.toLowerCase();
  const zoneIdx = s.indexOf('%');
  if (zoneIdx !== -1) s = s.slice(0, zoneIdx); // %zone scoped ids — still classified below
  if (!s.includes(':')) return null;

  // Embedded dotted-quad tail (IPv4-mapped / IPv4-compatible forms) occupies
  // the last two 16-bit group slots.
  let v4Tail: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  const tailCandidate = s.slice(lastColon + 1);
  if (tailCandidate.includes('.')) {
    v4Tail = ipv4ToBytes(tailCandidate);
    if (!v4Tail) return null;
    s = s.slice(0, lastColon);
    if (s.endsWith(':') && !s.endsWith('::')) s += ':'; // restore "::" terminator
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const headParts = halves[0] === '' ? [] : halves[0].split(':');
  const tailParts =
    halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];

  const head: number[] = [];
  for (const g of headParts) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    head.push(parseInt(g, 16));
  }
  const tail: number[] = [];
  for (const g of tailParts) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    tail.push(parseInt(g, 16));
  }

  const used = head.length + tail.length + (v4Tail ? 2 : 0);
  if (halves.length === 1 && used !== 8) return null;
  if (halves.length === 2 && used > 8) return null;

  const fill = 8 - used; // zero groups compressed by "::" (0 when absent)
  const out = new Uint8Array(16);
  let i = 0;
  for (const g of head) {
    out[i++] = g >> 8;
    out[i++] = g & 0xff;
  }
  i += fill * 2;
  for (const g of tail) {
    out[i++] = g >> 8;
    out[i++] = g & 0xff;
  }
  if (v4Tail) {
    out[12] = v4Tail[0];
    out[13] = v4Tail[1];
    out[14] = v4Tail[2];
    out[15] = v4Tail[3];
  }
  return out;
}

function isAllZero(b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (b[i] !== 0) return false;
  }
  return true;
}

function isBlockedIpv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // fail closed

  // ::/96 — unspecified (::), loopback (::1), deprecated IPv4-compatible
  if (isAllZero(b, 0, 12)) return true;
  // IPv4-mapped ::ffff:x.x.x.x and IPv4-translated ::ffff:0:x.x.x.x — these
  // literal forms only exist to smuggle IPv4 past address checks; block outright
  if (isAllZero(b, 0, 10) && b[10] === 0xff) return true;
  // ff00::/8 — multicast
  if (b[0] === 0xff) return true;
  // fc00::/7 — unique-local (fc00–fdff)
  if ((b[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local + fec0::/10 site-local (deprecated) → fe80–feff
  if (b[0] === 0xfe && (b[1] & 0x80) !== 0) return true;
  // 64:ff9b::/32 — NAT64 translation prefixes embed a translated IPv4 (RFC6052/8215)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  // 100::/64 — discard-only (RFC6666)
  if (b[0] === 0x01 && isAllZero(b, 1, 8)) return true;
  // 2001::/32 — Teredo (embeds an inverted IPv4)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;
  // 2001:db8::/32 — documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  // 2002::/16 — 6to4 (embeds an IPv4)
  if (b[0] === 0x20 && b[1] === 0x02) return true;

  return false;
}
