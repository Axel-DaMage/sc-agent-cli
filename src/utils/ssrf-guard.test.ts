import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  FetchTargetBlockedError,
  WEB_FETCH_MAX_TIMEOUT_MS,
  assertFetchTargetAllowed,
  isBlockedIpAddress,
  resolveWebFetchPolicy,
  resolveWebFetchTimeout,
  type DnsLookupFn,
} from './ssrf-guard.js';

const defaultPolicy = () => resolveWebFetchPolicy(undefined);

// ---------------------------------------------------------------------------
// isBlockedIpAddress — range classification
// ---------------------------------------------------------------------------

test('isBlockedIpAddress blocks loopback/private/link-local/reserved IPv4', () => {
  const blocked = [
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1', // CGNAT
    '100.127.255.255',
    '127.0.0.1',
    '127.63.0.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1', // TEST-NET-1
    '192.88.99.1',
    '192.168.0.1',
    '192.168.255.255',
    '198.18.0.1', // benchmarking
    '198.51.100.1', // TEST-NET-2
    '203.0.113.1', // TEST-NET-3
    '224.0.0.1', // multicast
    '239.255.255.255',
    '240.0.0.1', // reserved
    '255.255.255.255', // broadcast
  ];
  for (const ip of blocked) {
    assert.ok(isBlockedIpAddress(ip), `${ip} should be blocked`);
  }
});

test('isBlockedIpAddress allows public IPv4', () => {
  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '11.0.0.1',
    '100.63.255.255',
    '169.255.0.1',
    '172.32.0.1', // just outside 172.16/12
    '192.0.3.1', // just outside TEST-NET-1
    '198.17.255.255', // just outside 198.18/15
    '223.255.255.255',
  ];
  for (const ip of allowed) {
    assert.ok(!isBlockedIpAddress(ip), `${ip} should be allowed`);
  }
});

test('isBlockedIpAddress blocks loopback/private/link-local/reserved IPv6', () => {
  const blocked = [
    '::', // unspecified
    '::1', // loopback
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:8.8.8.8', // IPv4-mapped public — blocked regardless
    'fe80::1', // link-local
    'febf::1',
    'fec0::1', // site-local (deprecated)
    'fc00::1', // ULA
    'fd12:3456::1',
    'ff02::1', // multicast
    '64:ff9b::1', // NAT64 well-known
    '64:ff9b:1::1', // NAT64 local-use
    '100::1', // discard-only
    '2001::1', // Teredo
    '2001:db8::1', // documentation
    '2002::1', // 6to4
  ];
  for (const ip of blocked) {
    assert.ok(isBlockedIpAddress(ip), `${ip} should be blocked`);
  }
});

test('isBlockedIpAddress allows public IPv6', () => {
  const allowed = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81e::200e'];
  for (const ip of allowed) {
    assert.ok(!isBlockedIpAddress(ip), `${ip} should be allowed`);
  }
});

test('isBlockedIpAddress fails closed on non-IP input', () => {
  assert.ok(isBlockedIpAddress('example.com'));
  assert.ok(isBlockedIpAddress(''));
  assert.ok(isBlockedIpAddress('999.1.2.3'));
});

// ---------------------------------------------------------------------------
// assertFetchTargetAllowed — scheme / credentials / literal IP gates
// ---------------------------------------------------------------------------

test('assertFetchTargetAllowed allows a public IP literal without DNS', async () => {
  const url = await assertFetchTargetAllowed('http://8.8.8.8/path', defaultPolicy());
  assert.equal(url.hostname, '8.8.8.8');
});

test('assertFetchTargetAllowed blocks cloud metadata IP', async () => {
  await assert.rejects(
    assertFetchTargetAllowed('http://169.254.169.254/latest/meta-data/', defaultPolicy()),
    FetchTargetBlockedError,
  );
});

test('assertFetchTargetAllowed blocks loopback and private literals', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://127.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
  ]) {
    await assert.rejects(
      assertFetchTargetAllowed(url, defaultPolicy()),
      FetchTargetBlockedError,
      `${url} should be blocked`,
    );
  }
});

test('assertFetchTargetAllowed rejects non-http(s) schemes', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://x/']) {
    await assert.rejects(assertFetchTargetAllowed(url, defaultPolicy()), /scheme/);
  }
});

test('assertFetchTargetAllowed rejects URLs with embedded credentials', async () => {
  await assert.rejects(
    assertFetchTargetAllowed('http://user:pw@8.8.8.8/', defaultPolicy()),
    /credentials/,
  );
});

// ---------------------------------------------------------------------------
// assertFetchTargetAllowed — DNS resolution gate
// ---------------------------------------------------------------------------

const lookupTo =
  (addresses: Array<{ address: string; family: number }>): DnsLookupFn =>
  async () =>
    addresses;

test('assertFetchTargetAllowed blocks a hostname resolving to the metadata IP', async () => {
  await assert.rejects(
    assertFetchTargetAllowed(
      'http://metadata.evil.test/',
      defaultPolicy(),
      lookupTo([{ address: '169.254.169.254', family: 4 }]),
    ),
    /resolves to 169\.254\.169\.254/,
  );
});

test('assertFetchTargetAllowed blocks when ANY resolved address is private', async () => {
  await assert.rejects(
    assertFetchTargetAllowed(
      'http://mixed.evil.test/',
      defaultPolicy(),
      lookupTo([
        { address: '93.184.216.34', family: 4 },
        { address: '10.1.2.3', family: 4 },
      ]),
    ),
    /10\.1\.2\.3/,
  );
});

test('assertFetchTargetAllowed blocks hostnames resolving to IPv6 ULA', async () => {
  await assert.rejects(
    assertFetchTargetAllowed(
      'http://internal.test/',
      defaultPolicy(),
      lookupTo([{ address: 'fd00::5', family: 6 }]),
    ),
    FetchTargetBlockedError,
  );
});

test('assertFetchTargetAllowed allows a hostname resolving only to public IPs', async () => {
  const url = await assertFetchTargetAllowed(
    'http://docs.example.test/',
    defaultPolicy(),
    lookupTo([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]),
  );
  assert.equal(url.hostname, 'docs.example.test');
});

test('assertFetchTargetAllowed fails on empty DNS answers and lookup errors', async () => {
  await assert.rejects(
    assertFetchTargetAllowed('http://nx.test/', defaultPolicy(), async () => []),
    /no addresses/,
  );
  await assert.rejects(
    assertFetchTargetAllowed('http://nx.test/', defaultPolicy(), async () => {
      throw new Error('ENOTFOUND nx.test');
    }),
    /DNS lookup failed/,
  );
});

// ---------------------------------------------------------------------------
// assertFetchTargetAllowed — allowlist gate
// ---------------------------------------------------------------------------

test('assertFetchTargetAllowed enforces webFetch.allowlist', async () => {
  const policy = resolveWebFetchPolicy({
    allowlist: ['docs.example.com', '*.corp.test', '[2606:4700:4700::1111]'],
  });
  const publicLookup = lookupTo([{ address: '93.184.216.34', family: 4 }]);

  // non-matching host is rejected before DNS
  await assert.rejects(
    assertFetchTargetAllowed('http://evil.test/', policy, async () => {
      throw new Error('should not reach DNS');
    }),
    /webFetch\.allowlist/,
  );

  // exact + wildcard suffix (apex and subdomain) + IPv6 literal all match
  await assertFetchTargetAllowed('http://docs.example.com/', policy, publicLookup);
  await assertFetchTargetAllowed('http://corp.test/', policy, publicLookup);
  await assertFetchTargetAllowed('http://a.b.corp.test/', policy, publicLookup);
  await assertFetchTargetAllowed('http://[2606:4700:4700::1111]/', policy);
});

test('assertFetchTargetAllowed checks allowlist ports', async () => {
  const policy = resolveWebFetchPolicy({ allowlist: ['docs.example.com:8443'] });
  await assert.rejects(
    assertFetchTargetAllowed('http://docs.example.com/', policy), // port 80 ≠ 8443
    /allowlist/,
  );
  await assertFetchTargetAllowed(
    'http://docs.example.com:8443/',
    policy,
    lookupTo([{ address: '93.184.216.34', family: 4 }]),
  );
});

test('allowlist narrows but does not exempt the private-range block', async () => {
  const policy = resolveWebFetchPolicy({ allowlist: ['localhost'] });
  await assert.rejects(
    assertFetchTargetAllowed(
      'http://localhost/',
      policy,
      lookupTo([{ address: '127.0.0.1', family: 4 }]),
    ),
    /private\/reserved/,
  );
});

test('allowPrivateHosts permits loopback destinations', async () => {
  const policy = resolveWebFetchPolicy({ allowPrivateHosts: true });
  const url = await assertFetchTargetAllowed('http://127.0.0.1:8080/x', policy);
  assert.equal(url.hostname, '127.0.0.1');
  const u6 = await assertFetchTargetAllowed('http://[::1]/', policy);
  assert.equal(u6.hostname, '[::1]');
});

test('resolveWebFetchPolicy rejects malformed allowlist entries', () => {
  assert.throws(() => resolveWebFetchPolicy({ allowlist: ['bad entry/x'] }), /Invalid webFetch\.allowlist/);
  assert.throws(() => resolveWebFetchPolicy({ allowlist: ['host:99999'] }), /Invalid webFetch\.allowlist/);
});

// ---------------------------------------------------------------------------
// resolveWebFetchTimeout / resolveWebFetchPolicy — bounds
// ---------------------------------------------------------------------------

test('resolveWebFetchTimeout clamps to the 60s ceiling', () => {
  assert.equal(resolveWebFetchTimeout(999_999_999), WEB_FETCH_MAX_TIMEOUT_MS);
  assert.equal(resolveWebFetchTimeout(60_001), WEB_FETCH_MAX_TIMEOUT_MS);
  assert.equal(resolveWebFetchTimeout(60_000), 60_000);
  assert.equal(resolveWebFetchTimeout(5_000), 5_000);
  assert.equal(resolveWebFetchTimeout(5_000.9), 5_000);
});

test('resolveWebFetchTimeout falls back to the default on invalid input', () => {
  assert.equal(resolveWebFetchTimeout(undefined), 15_000);
  assert.equal(resolveWebFetchTimeout(0), 15_000);
  assert.equal(resolveWebFetchTimeout(-5), 15_000);
  assert.equal(resolveWebFetchTimeout(NaN), 15_000);
  assert.equal(resolveWebFetchTimeout('fast'), 15_000);
});

test('resolveWebFetchPolicy applies defaults and clamps maxBytes', () => {
  const def = resolveWebFetchPolicy(undefined);
  assert.equal(def.maxBytes, 5 * 1024 * 1024);
  assert.equal(def.allowPrivateHosts, false);
  assert.equal(def.allowlistRules.length, 0);

  assert.equal(resolveWebFetchPolicy({ maxBytes: 2048 }).maxBytes, 2048);
  assert.equal(resolveWebFetchPolicy({ maxBytes: 1 }).maxBytes, 1024);
  assert.equal(resolveWebFetchPolicy({ maxBytes: 999_999_999 }).maxBytes, 64 * 1024 * 1024);
});
