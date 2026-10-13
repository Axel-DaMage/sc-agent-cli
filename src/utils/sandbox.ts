// #423 — sandboxed execution for agent-spawned shell commands.
//
// Two enforcement layers, resolved once per agent run:
//
//   bwrap (Linux + bubblewrap) — hard boundary. The command runs in fresh
//   mount/pid/ipc namespaces: `/` read-only, workspace + `writablePaths`
//   writable, `readOnlyPaths` re-mounted read-only, literal
//   `permissions.denyPaths` entries masked (tmpfs over dirs, /dev/null over
//   files — deny wins). Egress: empty `egressAllowlist` → `--unshare-net`
//   (block-all except loopback, brought up via CAP_NET_ADMIN when bwrap ≥0.9);
//   non-empty → shared net + `HTTP_PROXY`/`HTTPS_PROXY` envs pointed at the
//   local EgressFilterProxy. `seccomp: true` installs a generated cBPF
//   denylist via `--seccomp` (x86_64 only).
//
//   proxy (degraded; macOS/Windows or no working bwrap) — the command runs
//   unsandboxed but still behind the egress proxy env filter, and the
//   degradation is recorded (`sandbox.exec_mode: "proxy"` in the run manifest,
//   audit event, one-time stderr notice) so it can never silently weaken.
//
// Violations surface as structured tool errors (`[SANDBOX_VIOLATION]
// {"rule":…,"target":…}`) plus `sandbox_violations` entries in the manifest.

import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';
import { findOnPath } from '../core/devcontainer.js';
import { EgressFilterProxy } from './sandbox-proxy.js';
import {
  buildDefaultSeccompProgram,
  loadSeccompProfile,
  seccompSupportedOnThisHost,
} from './sandbox-seccomp.js';
import { buildChildEnv } from './env-scrub.js';
import { verbose } from './verbose-logger.js';

export interface SandboxViolation {
  rule: 'egress' | 'fs' | 'seccomp' | 'spawn';
  target: string;
}

export type SandboxExecMode = 'bwrap' | 'proxy';

export interface EgressRule {
  /** exact host, `*.` suffix match (apex + subdomains), or `*` allow-all */
  match: 'exact' | 'suffix' | 'any';
  host: string; // lowercase; for 'suffix' this is the apex (no `*.` prefix)
  port: number | null; // null = any port
}

export interface SandboxProfile {
  enabled: boolean;
  egressRules: EgressRule[];
  /** true when the allowlist is empty → block all egress except loopback. */
  egressBlockAll: boolean;
  writablePaths: string[]; // absolute, resolved
  readOnlyPaths: string[]; // absolute, resolved
  seccomp: boolean;
  seccompProfile?: string;
  /** literal denyPaths entries masked inside the sandbox. */
  denyMaskPaths: string[];
}

export interface SandboxBackend {
  mode: SandboxExecMode;
  bwrapPath?: string;
  /** bwrap accepted `--cap-add CAP_NET_ADMIN` (>= 0.9) — enables lo bring-up under --unshare-net. */
  capNetAdmin: boolean;
  degradedReason?: string;
}

/** Manifest-facing summary of the resolved sandbox posture for the run. */
export interface SandboxRunInfo {
  exec_mode: SandboxExecMode;
  egress: 'allowlist' | 'block_all';
  seccomp: 'on' | 'off' | 'unsupported';
  degraded_reason?: string;
  violations: number;
}

const GLOB_CHARS = /[*?[\]{}!()]/;
const MAX_VIOLATIONS = 500;

// ---------------------------------------------------------------------------
// Egress allowlist parsing / matching
// ---------------------------------------------------------------------------

/**
 * Parse `host` | `host:port` | `[v6]` | `[v6]:port` | `*.domain[:port]` | `*`.
 * Bare entries allow any port on the host. Throws on malformed input — config
 * errors must fail fast at session start, not mid-command.
 */
export function parseEgressRule(raw: string): EgressRule {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) throw new Error('sandbox.egressAllowlist: empty entry');
  if (trimmed === '*') return { match: 'any', host: '*', port: null };
  const entry = trimmed.replace(/\.$/, '');

  let host = entry;
  let port: number | null = null;

  const v6 = /^\[([0-9a-f:]+)\](?::(\d+))?$/.exec(entry);
  if (v6) {
    host = v6[1];
    port = v6[2] !== undefined ? parseInt(v6[2], 10) : null;
  } else {
    const idx = entry.lastIndexOf(':');
    // A single ':' separates host:port; multiple ':' means a bare IPv6 literal.
    if (idx !== -1 && entry.indexOf(':') === idx) {
      host = entry.slice(0, idx);
      port = parseInt(entry.slice(idx + 1), 10);
    }
  }

  // '*' is only valid as the bare allow-all (handled above) or the '*.'
  // suffix prefix — anything else ('*.', 'foo*', '*:443') is malformed.
  if (!host || /[\s/@]/.test(host) || (host.includes('*') && !host.startsWith('*.'))) {
    throw new Error(`sandbox.egressAllowlist: invalid host in "${raw}"`);
  }
  if (port !== null && (Number.isNaN(port) || port < 1 || port > 65535)) {
    throw new Error(`sandbox.egressAllowlist: invalid port in "${raw}" (expected 1-65535)`);
  }

  if (host.startsWith('*.')) {
    const apex = host.slice(2);
    if (!apex || /[\s/@*]/.test(apex)) {
      throw new Error(`sandbox.egressAllowlist: invalid wildcard in "${raw}"`);
    }
    return { match: 'suffix', host: apex, port };
  }
  return { match: 'exact', host, port };
}

/** Match a requested destination against parsed allowlist rules. */
export function isEgressAllowed(rules: readonly EgressRule[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  for (const rule of rules) {
    if (rule.port !== null && rule.port !== port) continue;
    if (rule.match === 'any') return true;
    if (rule.match === 'exact' && h === rule.host) return true;
    if (rule.match === 'suffix' && (h === rule.host || h.endsWith('.' + rule.host))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

function resolvePathList(entries: string[] | undefined, workspaceRoot: string): string[] {
  if (!entries) return [];
  const out: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('sandbox path entries must be non-empty strings');
    }
    const p = raw.trim();
    out.push(path.resolve(workspaceRoot, p));
  }
  return out;
}

/** Literal (non-glob) denyPaths become mount-level masks inside the sandbox. */
function resolveDenyMasks(denyPaths: string[] | undefined, workspaceRoot: string): string[] {
  const out: string[] = [];
  for (const raw of denyPaths ?? []) {
    if (typeof raw !== 'string' || GLOB_CHARS.test(raw)) continue;
    const p = path.resolve(workspaceRoot, raw.trim());
    try {
      statSync(p);
      out.push(p);
    } catch {
      continue; // nothing to mask
    }
  }
  return out;
}

export function resolveSandboxProfile(config: ProjectConfig, workspaceRoot: string): SandboxProfile {
  const sandbox = config.sandbox;
  const ws = realpathSync(workspaceRoot);
  const profile: SandboxProfile = {
    enabled: Boolean(sandbox?.enabled),
    egressRules: [],
    egressBlockAll: true,
    writablePaths: [],
    readOnlyPaths: [],
    seccomp: Boolean(sandbox?.seccomp),
    seccompProfile: sandbox?.seccompProfile,
    denyMaskPaths: [],
  };
  if (!profile.enabled) return profile;

  profile.egressRules = (sandbox?.egressAllowlist ?? []).map(parseEgressRule);
  profile.egressBlockAll = profile.egressRules.length === 0;
  profile.writablePaths = resolvePathList(sandbox?.writablePaths, ws);
  profile.readOnlyPaths = resolvePathList(sandbox?.readOnlyPaths, ws);
  profile.denyMaskPaths = resolveDenyMasks(config.permissions?.denyPaths, ws);
  return profile;
}

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

export type SandboxProbe = (argv: string[]) => boolean;

const defaultProbe: SandboxProbe = (argv) => {
  try {
    const res = spawnSync(argv[0], argv.slice(1), {
      stdio: 'ignore',
      timeout: 10_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
};

/**
 * Detect the available sandbox backend. On Linux with a working `bwrap` the
 * full boundary applies; anywhere else the runtime degrades to proxy-only
 * egress filtering. Probe results are memoized per process.
 */
let cachedBackend: SandboxBackend | undefined;

export function detectSandboxBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: SandboxProbe = defaultProbe,
): SandboxBackend {
  if (platform !== 'linux') {
    return { mode: 'proxy', capNetAdmin: false, degradedReason: `unsupported platform: ${platform}` };
  }
  const bwrap = findOnPath('bwrap', env);
  if (!bwrap) {
    return { mode: 'proxy', capNetAdmin: false, degradedReason: 'bubblewrap (bwrap) not found on PATH' };
  }
  // Some kernels lock unprivileged userns creation (Ubuntu 24.04 AppArmor,
  // sysctl user.max_user_namespaces=0, nested containers). Probe cheaply.
  // `--unshare-user-try` matches the runtime argv: a setuid/root-capable
  // bwrap can still build the mount sandbox when userns is unavailable.
  if (!probe([bwrap, '--unshare-user-try', '--ro-bind', '/', '/', '--', 'true'])) {
    return { mode: 'proxy', capNetAdmin: false, degradedReason: 'bwrap probe failed (unprivileged namespaces restricted?)' };
  }
  const capNetAdmin = probe([bwrap, '--unshare-user-try', '--unshare-net', '--cap-add', 'CAP_NET_ADMIN', '--ro-bind', '/', '/', '--', 'true']);
  return { mode: 'bwrap', bwrapPath: bwrap, capNetAdmin };
}

export function detectSandboxBackendCached(env?: NodeJS.ProcessEnv): SandboxBackend {
  if (!cachedBackend) cachedBackend = detectSandboxBackend(env ?? process.env);
  return cachedBackend;
}

/** Test hook: reset the memoized backend probe result. */
export function resetSandboxBackendCache(): void {
  cachedBackend = undefined;
}

// ---------------------------------------------------------------------------
// bwrap argv construction
// ---------------------------------------------------------------------------

export interface BuildBwrapArgvOptions {
  bwrapPath: string;
  workspaceRoot: string; // realpath'd
  command: string;
  profile: SandboxProfile;
  capNetAdmin: boolean;
  /** fd number handed to --seccomp (the spawn stdio slot carrying the blob). */
  seccompFd?: number;
}

// Bring loopback up inside the fresh netns, then exec the user command in a
// plain `sh -c` (same semantics as an unsandboxed spawn shell:true).
const NETNS_LOOPBACK_SCRIPT =
  'ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true; exec sh -c "$0"';

export function buildBwrapArgv(opts: BuildBwrapArgvOptions): string[] {
  const { profile, workspaceRoot: ws } = opts;
  const argv: string[] = [
    opts.bwrapPath,
    '--unshare-user-try',
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
  ];

  if (profile.egressBlockAll) {
    argv.push('--unshare-net');
    if (opts.capNetAdmin) argv.push('--cap-add', 'CAP_NET_ADMIN');
  }
  if (opts.seccompFd !== undefined) {
    argv.push('--seccomp', String(opts.seccompFd));
  }

  // Mount policy — applied in order, later ops win.
  argv.push(
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', ws, ws,
  );
  for (const p of profile.writablePaths) {
    if (p === ws || p.startsWith(ws + path.sep)) continue; // already writable via the workspace bind
    argv.push('--bind-try', p, p);
  }
  // readOnlyPaths re-assert ro after every writable bind (deny-wins layering).
  for (const p of profile.readOnlyPaths) {
    argv.push('--ro-bind-try', p, p);
  }
  // Literal denyPaths are masked outright: tmpfs hides dirs, /dev/null hides files.
  for (const p of profile.denyMaskPaths) {
    try {
      if (statSync(p).isDirectory()) {
        argv.push('--tmpfs', p);
      } else {
        argv.push('--ro-bind', '/dev/null', p);
      }
    } catch {
      // raced deletion — nothing to mask
    }
  }

  argv.push('--chdir', ws);
  if (profile.egressBlockAll && opts.capNetAdmin) {
    argv.push('sh', '-c', NETNS_LOOPBACK_SCRIPT, opts.command);
  } else {
    argv.push('sh', '-c', opts.command);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// stderr violation extraction
// ---------------------------------------------------------------------------

interface StderrRule {
  re: RegExp;
  rule: SandboxViolation['rule'];
}

function extractTarget(line: string): string {
  const quoted = /['"]([^'"]+)['"]/.exec(line);
  const target = (quoted?.[1] ?? line).trim();
  return target.length > 160 ? target.slice(0, 157) + '…' : target;
}

// ---------------------------------------------------------------------------
// SandboxRuntime
// ---------------------------------------------------------------------------

export interface SandboxRuntimeOptions {
  config: ProjectConfig;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  /** Sink for violation events (audit log, manifest collection). */
  onViolation?: (v: SandboxViolation) => void;
  /** One-time operator-facing notices (degraded mode, seccomp unsupported). */
  onNotice?: (message: string) => void;
  /** Injectable backend detection (tests). */
  detectBackend?: (env: NodeJS.ProcessEnv) => SandboxBackend;
}

export interface SandboxSpawnPlan {
  /** Executable or shell command string. */
  file: string;
  argv: string[];
  /** true → spawn(file, [], {shell:true}) — the command string itself. */
  shell: boolean;
  env: NodeJS.ProcessEnv;
  /** extra pipe fd to stream the cBPF blob into bwrap. */
  seccompFd?: number;
  seccompBlob?: Buffer;
  execMode: SandboxExecMode;
}

const MAX_STDERR_SCAN_LINES = 200;

export class SandboxRuntime {
  readonly profile: SandboxProfile;
  readonly backend: SandboxBackend;
  private readonly env: NodeJS.ProcessEnv;
  private readonly allowedEnvVars?: string[];
  private readonly workspaceRoot: string;
  private readonly onViolation?: (v: SandboxViolation) => void;
  private readonly onNotice?: (message: string) => void;
  private readonly violationsList: SandboxViolation[] = [];
  private violationOverflow = 0;
  private proxy?: EgressFilterProxy;
  private proxyStart?: Promise<number>;
  private proxyUrlValue?: string;
  private seccompBlob?: Buffer;
  private seccompState: 'on' | 'off' | 'unsupported' = 'off';
  private readonly stderrRules: StderrRule[] = [];

  constructor(opts: SandboxRuntimeOptions) {
    this.env = opts.env ?? process.env;
    this.allowedEnvVars = opts.config.run_shell?.allowedEnvVars;
    this.onViolation = opts.onViolation;
    this.onNotice = opts.onNotice;
    this.workspaceRoot = realpathSync(opts.workspaceRoot);
    this.profile = resolveSandboxProfile(opts.config, this.workspaceRoot);
    this.backend = this.profile.enabled
      ? (opts.detectBackend ?? detectSandboxBackendCached)(this.env)
      : { mode: 'proxy', capNetAdmin: false };

    if (!this.profile.enabled) return;

    if (this.backend.mode === 'proxy') {
      const reason = this.backend.degradedReason ?? 'sandbox backend unavailable';
      this.onNotice?.(
        `sandbox: degraded mode — filesystem/seccomp boundary unavailable (${reason}). ` +
          'Egress is still filtered through the local allowlist proxy; ' +
          'install bubblewrap on Linux for the hard boundary.',
      );
    }

    if (this.profile.seccomp) {
      if (this.backend.mode !== 'bwrap') {
        this.seccompState = 'unsupported';
        this.onNotice?.('sandbox: seccomp requested but no bwrap backend — skipping syscall filter');
      } else if (this.profile.seccompProfile) {
        this.seccompBlob = loadSeccompProfile(this.profile.seccompProfile);
        this.seccompState = 'on';
      } else if (seccompSupportedOnThisHost(process.platform, process.arch)) {
        this.seccompBlob = buildDefaultSeccompProgram();
        this.seccompState = 'on';
      } else {
        this.seccompState = 'unsupported';
        this.onNotice?.(
          `sandbox: seccomp requested but not supported on ${process.platform}/${process.arch} — skipping syscall filter`,
        );
      }
    }

    const seccompActive = this.seccompState === 'on';
    this.stderrRules = [
      { re: /read-only file system|EROFS/i, rule: 'fs' },
      { re: /operation not permitted|\bEPERM\b/i, rule: seccompActive ? 'seccomp' : 'fs' },
      {
        re: /network is unreachable|ENETUNREACH|no route to host|EHOSTUNREACH|temporary failure in name resolution|could not resolve host|name or service not known|received http code 403 from proxy|proxyconnect|proxy refused/i,
        rule: 'egress',
      },
    ];
  }

  get enabled(): boolean {
    return this.profile.enabled;
  }

  get violations(): readonly SandboxViolation[] {
    return this.violationsList;
  }

  get violationCount(): number {
    return this.violationsList.length + this.violationOverflow;
  }

  /** `sandbox` field serialized into the run manifest (#423). */
  getRunInfo(): SandboxRunInfo {
    return {
      exec_mode: this.backend.mode,
      egress: this.profile.egressBlockAll ? 'block_all' : 'allowlist',
      seccomp: this.seccompState,
      ...(this.backend.degradedReason ? { degraded_reason: this.backend.degradedReason } : {}),
      violations: this.violationCount,
    };
  }

  private recordViolation(v: SandboxViolation): void {
    if (this.violationsList.length < MAX_VIOLATIONS) {
      this.violationsList.push(v);
    } else {
      this.violationOverflow++;
    }
    this.onViolation?.(v);
  }

  /**
   * Lazily start the egress proxy. Needed whenever egress filtering is
   * proxy-based: allowlist mode (any backend) or degraded mode (deny-all).
   */
  private async ensureProxy(): Promise<string> {
    if (this.proxyUrlValue) return this.proxyUrlValue;
    this.proxyStart ??= (async () => {
      this.proxy = new EgressFilterProxy({
        isAllowed: (host, port) => isEgressAllowed(this.profile.egressRules, host, port),
        onViolation: (v) => this.recordViolation({ rule: v.rule, target: v.target }),
      });
      return this.proxy.start();
    })();
    const port = await this.proxyStart;
    this.proxyUrlValue = `http://127.0.0.1:${port}`;
    return this.proxyUrlValue;
  }

  private proxyEnv(url: string): Record<string, string> {
    // Empty NO_PROXY forces even loopback through the proxy, so a
    // non-allowlisted `localhost:9999` is still a policy decision, not a leak.
    return {
      HTTP_PROXY: url,
      http_proxy: url,
      HTTPS_PROXY: url,
      https_proxy: url,
      ALL_PROXY: url,
      all_proxy: url,
      FTP_PROXY: url,
      ftp_proxy: url,
      NO_PROXY: '',
      no_proxy: '',
    };
  }

  /**
   * Build the spawn plan for a sandboxed `run_shell` command.
   * Fails closed: if the sandbox cannot be prepared (proxy bind failure,
   * missing seccomp profile) the caller must surface the error rather than
   * run the command unsandboxed.
   */
  async prepareSpawn(command: string): Promise<SandboxSpawnPlan> {
    // #471 — sandboxed or not, the child env is allowlist-scrubbed: provider
    // credentials must not be readable inside the spawned process either.
    const scrubbedEnv = () => buildChildEnv(this.env, this.allowedEnvVars);
    if (!this.profile.enabled) {
      return { file: command, argv: [], shell: true, env: scrubbedEnv(), execMode: 'proxy' };
    }

    const needsProxy = !this.profile.egressBlockAll || this.backend.mode === 'proxy';
    let proxyUrl: string | null = null;
    if (needsProxy) {
      try {
        proxyUrl = await this.ensureProxy();
      } catch (err) {
        const v: SandboxViolation = { rule: 'spawn', target: 'egress-proxy' };
        this.recordViolation(v);
        throw new Error(`sandbox egress proxy failed to start: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    }
    // Proxy envs are appended *after* scrubbing so the egress allowlist filter
    // always reaches the child even though *_PROXY is not a base env var.
    const env: NodeJS.ProcessEnv = proxyUrl
      ? { ...scrubbedEnv(), ...this.proxyEnv(proxyUrl) }
      : scrubbedEnv();

    if (this.backend.mode !== 'bwrap' || !this.backend.bwrapPath) {
      // Degraded: command runs directly but still behind the egress proxy.
      return { file: command, argv: [], shell: true, env, execMode: 'proxy' };
    }

    const seccompFd = this.seccompBlob ? 3 : undefined;
    const argv = buildBwrapArgv({
      bwrapPath: this.backend.bwrapPath,
      workspaceRoot: this.workspaceRoot,
      command,
      profile: this.profile,
      capNetAdmin: this.backend.capNetAdmin,
      seccompFd,
    });
    verbose(`sandbox: bwrap argv: ${argv.map((a) => (a.length > 120 ? a.slice(0, 117) + '…' : a)).join(' ')}`);
    return {
      file: this.backend.bwrapPath,
      argv: argv.slice(1),
      shell: false,
      env,
      seccompFd,
      seccompBlob: this.seccompBlob,
      execMode: 'bwrap',
    };
  }

  /**
   * Scan captured stderr for sandbox-denial signatures (EROFS mounts, EPERM
   * seccomp, unreachable network, proxy 403) and record new violations.
   * Returns the violations found.
   */
  collectStderrViolations(stderr: string): SandboxViolation[] {
    if (!this.profile.enabled || !stderr) return [];
    const found: SandboxViolation[] = [];
    const seen = new Set<string>();
    const lines = stderr.split('\n').slice(0, MAX_STDERR_SCAN_LINES);
    for (const line of lines) {
      for (const { re, rule } of this.stderrRules) {
        if (!re.test(line)) continue;
        const target = extractTarget(line);
        const key = `${rule}:${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const v: SandboxViolation = { rule, target };
        found.push(v);
        this.recordViolation(v);
        break; // one rule per line
      }
    }
    return found;
  }

  dispose(): void {
    this.proxy?.close();
    this.proxy = undefined;
    this.proxyStart = undefined;
    this.proxyUrlValue = undefined;
  }
}

/** Format violations as structured markers appended to a tool result/error. */
export function formatSandboxViolations(violations: readonly SandboxViolation[]): string {
  if (violations.length === 0) return '';
  return violations
    .map((v) => `[SANDBOX_VIOLATION] ${JSON.stringify({ rule: v.rule, target: v.target })}`)
    .join('\n');
}
