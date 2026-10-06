import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';
import {
  buildBwrapArgv,
  detectSandboxBackend,
  formatSandboxViolations,
  isEgressAllowed,
  parseEgressRule,
  resetSandboxBackendCache,
  resolveSandboxProfile,
  SandboxRuntime,
  type SandboxBackend,
} from './sandbox.js';
import type { SandboxViolation } from './sandbox.js';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  resetSandboxBackendCache();
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc-sandbox-'));
  tmpDirs.push(dir);
  return dir;
}

function config(sandbox?: ProjectConfig['sandbox'], denyPaths?: string[]): ProjectConfig {
  return {
    model: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'm' },
    permissions: { denyPaths },
    sandbox,
  };
}

// ---------------------------------------------------------------------------
// parseEgressRule / isEgressAllowed
// ---------------------------------------------------------------------------

test('parseEgressRule parses host, host:port, wildcard and allow-all', () => {
  assert.deepEqual(parseEgressRule('api.github.com'), { match: 'exact', host: 'api.github.com', port: null });
  assert.deepEqual(parseEgressRule('api.github.com:443'), { match: 'exact', host: 'api.github.com', port: 443 });
  assert.deepEqual(parseEgressRule('*.github.com'), { match: 'suffix', host: 'github.com', port: null });
  assert.deepEqual(parseEgressRule('*.github.com:8443'), { match: 'suffix', host: 'github.com', port: 8443 });
  assert.deepEqual(parseEgressRule('*'), { match: 'any', host: '*', port: null });
  assert.deepEqual(parseEgressRule('  Example.COM.  '), { match: 'exact', host: 'example.com', port: null });
  assert.deepEqual(parseEgressRule('[::1]'), { match: 'exact', host: '::1', port: null });
  assert.deepEqual(parseEgressRule('[::1]:8080'), { match: 'exact', host: '::1', port: 8080 });
});

test('parseEgressRule rejects malformed entries', () => {
  for (const bad of ['', '   ', 'api.github.com:0', 'api.github.com:65536', 'api.github.com:abc', 'api.github.com:', 'has space.com', 'user@host', 'foo/bar', '*.', '*.:443']) {
    assert.throws(() => parseEgressRule(bad), /sandbox\.egressAllowlist/, bad);
  }
});

test('isEgressAllowed matches host and optional port case-insensitively', () => {
  const rules = ['api.github.com:443', '*.corp.internal', 'plain.example'].map(parseEgressRule);
  assert.equal(isEgressAllowed(rules, 'api.github.com', 443), true);
  assert.equal(isEgressAllowed(rules, 'API.GitHub.COM', 443), true);
  assert.equal(isEgressAllowed(rules, 'api.github.com', 80), false);
  assert.equal(isEgressAllowed(rules, 'evil.github.com', 443), false); // exact rule, not suffix
  assert.equal(isEgressAllowed(rules, 'svc.corp.internal', 22), true);
  assert.equal(isEgressAllowed(rules, 'corp.internal', 22), true); // apex itself allowed
  assert.equal(isEgressAllowed(rules, 'plain.example', 9999), true); // no port restriction
  assert.equal(isEgressAllowed(rules, 'other.example', 80), false);
});

test('isEgressAllowed wildcard allows any host:port', () => {
  const rules = [parseEgressRule('*')];
  assert.equal(isEgressAllowed(rules, 'anything', 1), true);
});

// ---------------------------------------------------------------------------
// resolveSandboxProfile
// ---------------------------------------------------------------------------

test('resolveSandboxProfile defaults to disabled', () => {
  const ws = tmpWorkspace();
  const p = resolveSandboxProfile(config(), ws);
  assert.equal(p.enabled, false);
  assert.equal(p.egressBlockAll, true);
});

test('resolveSandboxProfile empty egressAllowlist means block-all', () => {
  const ws = tmpWorkspace();
  const p = resolveSandboxProfile(config({ enabled: true }), ws);
  assert.equal(p.enabled, true);
  assert.equal(p.egressBlockAll, true);
  assert.deepEqual(p.egressRules, []);

  const p2 = resolveSandboxProfile(config({ enabled: true, egressAllowlist: [] }), ws);
  assert.equal(p2.egressBlockAll, true);

  const p3 = resolveSandboxProfile(config({ enabled: true, egressAllowlist: ['api.github.com:443'] }), ws);
  assert.equal(p3.egressBlockAll, false);
  assert.equal(p3.egressRules.length, 1);
});

test('resolveSandboxProfile resolves workspace-relative paths', () => {
  const ws = tmpWorkspace();
  const real = (p: string) => path.resolve(realpathSync(ws), p);
  const p = resolveSandboxProfile(
    config({ enabled: true, writablePaths: ['/var/tmp/data', 'cache-dir'], readOnlyPaths: ['/usr/share/fixtures'] }),
    ws,
  );
  assert.ok(p.writablePaths.includes('/var/tmp/data'));
  assert.ok(p.writablePaths.includes(real('cache-dir')));
  assert.deepEqual(p.readOnlyPaths, ['/usr/share/fixtures']);
});

test('resolveSandboxProfile masks literal denyPaths that exist, skips globs', () => {
  const ws = tmpWorkspace();
  mkdirSync(path.join(ws, 'secrets'), { recursive: true });
  writeFileSync(path.join(ws, 'private.key'), 'x');
  const p = resolveSandboxProfile(
    config({ enabled: true, egressAllowlist: ['*'] }, ['secrets', 'private.key', '*.pem', 'missing-dir']),
    ws,
  );
  const real = (r: string) => path.resolve(realpathSync(ws), r);
  assert.ok(p.denyMaskPaths.includes(real('secrets')));
  assert.ok(p.denyMaskPaths.includes(real('private.key')));
  assert.equal(p.denyMaskPaths.some((m) => m.includes('*.pem')), false);
  assert.equal(p.denyMaskPaths.some((m) => m.includes('missing-dir')), false);
});

// ---------------------------------------------------------------------------
// detectSandboxBackend
// ---------------------------------------------------------------------------

test('detectSandboxBackend returns proxy mode off-Linux', () => {
  const b = detectSandboxBackend({}, 'darwin', () => {
    throw new Error('probe must not run off-Linux');
  });
  assert.equal(b.mode, 'proxy');
  assert.match(b.degradedReason ?? '', /unsupported platform/);
});

test('detectSandboxBackend returns proxy mode when bwrap missing from PATH', () => {
  const b = detectSandboxBackend({ PATH: tmpWorkspace() }, 'linux', () => true);
  assert.equal(b.mode, 'proxy');
  assert.match(b.degradedReason ?? '', /bwrap/);
});

test('detectSandboxBackend returns proxy mode when userns probe fails', () => {
  const bwrapDir = tmpWorkspace();
  const bwrapPath = path.join(bwrapDir, 'bwrap');
  writeFileSync(bwrapPath, '#!/bin/sh\n', { mode: 0o755 });
  const b = detectSandboxBackend({ PATH: bwrapDir }, 'linux', () => false);
  assert.equal(b.mode, 'proxy');
  assert.match(b.degradedReason ?? '', /probe failed/);
});

test('detectSandboxBackend returns bwrap mode with cap-net-admin detection', () => {
  const bwrapDir = tmpWorkspace();
  writeFileSync(path.join(bwrapDir, 'bwrap'), '#!/bin/sh\n', { mode: 0o755 });
  const calls: string[][] = [];
  const b = detectSandboxBackend({ PATH: bwrapDir }, 'linux', (argv) => {
    calls.push(argv.slice(1));
    return !argv.includes('--cap-add'); // base probe ok, cap probe fails
  });
  assert.equal(b.mode, 'bwrap');
  assert.equal(b.capNetAdmin, false);
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// buildBwrapArgv
// ---------------------------------------------------------------------------

function argvFor(profile: Parameters<typeof buildBwrapArgv>[0]['profile'], extra: Partial<Parameters<typeof buildBwrapArgv>[0]> = {}) {
  return buildBwrapArgv({
    bwrapPath: '/usr/bin/bwrap',
    workspaceRoot: '/work',
    command: 'echo hi',
    profile,
    capNetAdmin: false,
    ...extra,
  });
}

const baseProfile = (over: Partial<ReturnType<typeof resolveSandboxProfile>> = {}) => ({
  enabled: true,
  egressRules: [],
  egressBlockAll: true,
  writablePaths: [],
  readOnlyPaths: [],
  seccomp: false,
  denyMaskPaths: [],
  ...over,
});

test('buildBwrapArgv block-all egress unshares net and ro-binds /', () => {
  const argv = argvFor(baseProfile());
  assert.equal(argv[0], '/usr/bin/bwrap');
  assert.ok(argv.includes('--unshare-net'));
  assert.ok(argv.includes('--unshare-user-try'));
  assert.ok(argv.includes('--die-with-parent'));
  const rb = argv.indexOf('--ro-bind');
  assert.equal(argv[rb + 1], '/');
  assert.equal(argv[rb + 2], '/');
  const wb = argv.indexOf('--bind');
  assert.equal(argv[wb + 1], '/work');
  assert.equal(argv[wb + 2], '/work');
  // no loopback script when capNetAdmin is unavailable
  assert.deepEqual(argv.slice(-3), ['sh', '-c', 'echo hi']);
});

test('buildBwrapArgv with capNetAdmin brings loopback up before exec', () => {
  const argv = argvFor(baseProfile(), { capNetAdmin: true });
  assert.ok(argv.includes('--cap-add'));
  assert.ok(argv.includes('CAP_NET_ADMIN'));
  const tail = argv.slice(-4);
  assert.equal(tail[0], 'sh');
  assert.equal(tail[1], '-c');
  assert.match(tail[2], /ip link set lo up/);
  assert.equal(tail[3], 'echo hi');
});

test('buildBwrapArgv allowlist egress shares the network (no --unshare-net)', () => {
  const argv = argvFor(baseProfile({ egressBlockAll: false }));
  assert.equal(argv.includes('--unshare-net'), false);
});

test('buildBwrapArgv layers writable/readOnly paths and seccomp fd', () => {
  const argv = argvFor(
    baseProfile({
      egressBlockAll: false,
      writablePaths: ['/opt/cache'],
      readOnlyPaths: ['/usr/share/fixtures'],
    }),
    { seccompFd: 3 },
  );
  const btry = argv.indexOf('--bind-try');
  assert.equal(argv[btry + 1], '/opt/cache');
  const rbt = argv.indexOf('--ro-bind-try');
  assert.equal(argv[rbt + 1], '/usr/share/fixtures');
  const sc = argv.indexOf('--seccomp');
  assert.equal(argv[sc + 1], '3');
});

// ---------------------------------------------------------------------------
// SandboxRuntime
// ---------------------------------------------------------------------------

const bwrapBackend: SandboxBackend = { mode: 'bwrap', bwrapPath: '/usr/bin/bwrap', capNetAdmin: true };
const proxyBackend: SandboxBackend = { mode: 'proxy', capNetAdmin: false, degradedReason: 'test-degraded' };

test('SandboxRuntime disabled → prepareSpawn is a shell passthrough', async () => {
  const ws = tmpWorkspace();
  const rt = new SandboxRuntime({ config: config(), workspaceRoot: ws, detectBackend: () => bwrapBackend });
  assert.equal(rt.enabled, false);
  const plan = await rt.prepareSpawn('echo hi');
  assert.equal(plan.shell, true);
  assert.equal(plan.file, 'echo hi');
  assert.equal(plan.execMode, 'proxy');
  assert.equal(plan.seccompFd, undefined);
  rt.dispose();
});

test('SandboxRuntime bwrap backend produces a bwrap spawn plan', async () => {
  const ws = tmpWorkspace();
  const rt = new SandboxRuntime({
    config: config({ enabled: true }),
    workspaceRoot: ws,
    detectBackend: () => bwrapBackend,
  });
  const plan = await rt.prepareSpawn('echo hi');
  assert.equal(plan.execMode, 'bwrap');
  assert.equal(plan.shell, false);
  assert.equal(plan.file, '/usr/bin/bwrap');
  assert.ok(plan.argv.includes('--unshare-net'));
  // block-all egress → no proxy env vars needed
  assert.equal(plan.env.HTTP_PROXY, undefined);
  rt.dispose();
});

test('SandboxRuntime allowlist egress injects proxy env vars', async () => {
  const ws = tmpWorkspace();
  const rt = new SandboxRuntime({
    config: config({ enabled: true, egressAllowlist: ['api.github.com:443'] }),
    workspaceRoot: ws,
    detectBackend: () => bwrapBackend,
  });
  const plan = await rt.prepareSpawn('curl https://api.github.com');
  assert.equal(plan.execMode, 'bwrap');
  assert.match(plan.env.HTTP_PROXY ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(plan.env.NO_PROXY, '');
  rt.dispose();
});

test('SandboxRuntime degraded mode injects proxy env even for block-all', async () => {
  const ws = tmpWorkspace();
  const notices: string[] = [];
  const rt = new SandboxRuntime({
    config: config({ enabled: true }),
    workspaceRoot: ws,
    detectBackend: () => proxyBackend,
    onNotice: (m) => notices.push(m),
  });
  assert.ok(notices.some((m) => m.includes('degraded')));
  const plan = await rt.prepareSpawn('curl https://example.com');
  assert.equal(plan.execMode, 'proxy');
  assert.equal(plan.shell, true);
  assert.match(plan.env.HTTPS_PROXY ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  const info = rt.getRunInfo();
  assert.equal(info.exec_mode, 'proxy');
  assert.equal(info.degraded_reason, 'test-degraded');
  rt.dispose();
});

test('SandboxRuntime seccomp is gated to linux/x64 + bwrap', async () => {
  const ws = tmpWorkspace();
  const supported = process.platform === 'linux' && process.arch === 'x64';
  const rt = new SandboxRuntime({
    config: config({ enabled: true, seccomp: true }),
    workspaceRoot: ws,
    detectBackend: () => bwrapBackend,
  });
  const plan = await rt.prepareSpawn('true');
  assert.equal(rt.getRunInfo().seccomp, supported ? 'on' : 'unsupported');
  if (supported) {
    assert.equal(plan.seccompFd, 3);
    assert.ok(plan.seccompBlob && plan.seccompBlob.length % 8 === 0);
  } else {
    assert.equal(plan.seccompFd, undefined);
  }
  rt.dispose();

  // seccomp requested but no bwrap → unsupported, not silently applied
  const rt2 = new SandboxRuntime({
    config: config({ enabled: true, seccomp: true }),
    workspaceRoot: ws,
    detectBackend: () => proxyBackend,
  });
  assert.equal(rt2.getRunInfo().seccomp, 'unsupported');
  rt2.dispose();
});

test('collectStderrViolations maps stderr signatures to structured violations', () => {
  const ws = tmpWorkspace();
  const seen: SandboxViolation[] = [];
  const rt = new SandboxRuntime({
    config: config({ enabled: true }),
    workspaceRoot: ws,
    detectBackend: () => bwrapBackend,
    onViolation: (v) => seen.push(v),
  });
  const found = rt.collectStderrViolations(
    "touch: cannot touch '/etc/x': Read-only file system\n" +
      'curl: (6) Could not resolve host: evil.com\n' +
      'bash: /usr/bin/x: Operation not permitted\n',
  );
  assert.equal(found.length, 3);
  assert.deepEqual(found[0], { rule: 'fs', target: '/etc/x' });
  assert.equal(found[1].rule, 'egress');
  assert.equal(found[2].rule, 'fs'); // seccomp off → EPERM attributed to fs layer
  assert.equal(rt.violations.length, 3);
  assert.equal(seen.length, 3);
  rt.dispose();
});

test('collectStderrViolations is a no-op when disabled', () => {
  const rt = new SandboxRuntime({ config: config(), workspaceRoot: tmpWorkspace() });
  assert.deepEqual(rt.collectStderrViolations('Read-only file system'), []);
  assert.equal(rt.violations.length, 0);
});

test('formatSandboxViolations emits one JSON marker per violation', () => {
  const out = formatSandboxViolations([
    { rule: 'egress', target: 'evil.com:443' },
    { rule: 'fs', target: '/etc/passwd' },
  ]);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0].replace('[SANDBOX_VIOLATION] ', '')), { rule: 'egress', target: 'evil.com:443' });
  assert.equal(formatSandboxViolations([]), '');
});
