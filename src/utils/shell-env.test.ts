import { test, vi, afterEach, type Mock } from 'vitest';
import assert from 'node:assert/strict';

// shell-env shells out for tool detection (`execSync('<tool> --version')`) and
// for the WSL marker (`cat /proc/version`), and reads process.platform — all
// mocked here. detectTools() caches results in module scope, so each scenario
// reloads the module and re-fetches the fresh mock instance (resetModules
// re-runs the mock factory; a statically imported reference would go stale).
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

type ExecSyncMock = Mock<(command: string, options?: unknown) => string>;

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: NodeJS.Platform): void {
  assert.ok(platformDescriptor, 'process.platform must be redefinable');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value });
}

const SHELL_ENV_KEYS = ['SHELL', 'COMSPEC', 'PSModulePath', '__PWSH_PID'] as const;

function stubShellEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const key of SHELL_ENV_KEYS) {
    if (!(key in overrides)) vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

interface ExecScenario {
  /** Value returned by `cat /proc/version ...` (or an Error to throw). */
  procVersion?: string | Error;
  /** Bare tool names that should resolve (e.g. 'git', 'winget', 'choco'). */
  tools?: string[];
}

function applyExecScenario(execMock: ExecSyncMock, scenario: ExecScenario): void {
  const tools = new Set(scenario.tools ?? []);
  execMock.mockImplementation((command: string) => {
    if (command.startsWith('cat /proc/version')) {
      const pv = scenario.procVersion;
      if (pv instanceof Error) throw pv;
      if (typeof pv === 'string') return pv;
      return 'Linux version 6.6.0-generic';
    }
    const tool = command.split(' ')[0];
    if (tools.has(tool)) return '';
    throw new Error(`command failed: ${command}`);
  });
}

async function loadShellEnv(scenario: ExecScenario = {}) {
  vi.resetModules();
  const mod = await import('./shell-env.js');
  const cp = await import('node:child_process');
  const execMock = cp.execSync as unknown as ExecSyncMock;
  applyExecScenario(execMock, scenario);
  return mod;
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ── Windows matrix ────────────────────────────────────────────────────────

test('win32 + bash SHELL → git-bash with POSIX tips', async () => {
  setPlatform('win32');
  stubShellEnv({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' });
  const { detectShell } = await loadShellEnv({ tools: ['git', 'node', 'jq', 'wget', 'winget', 'choco'] });

  const info = detectShell();

  assert.equal(info.type, 'git-bash');
  assert.equal(info.isWindows, true);
  assert.equal(info.isWSL, false);
  assert.equal(info.shellPath, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.ok(info.tools.git && info.tools.node && info.tools.jq);
  assert.equal(info.tools.winget, true, 'winget probed on win32');
  assert.equal(info.tools.choco, true, 'choco probed on win32');
  assert.ok(info.tips.some((t) => t.includes('POSIX commands work')));
  assert.ok(info.tips.some((t) => t.includes('jq available')));
  assert.ok(info.tips.some((t) => t.includes('wget available')));
  assert.ok(info.tips.some((t) => t.includes('winget available')));
});

test('win32 + PSModulePath → powershell', async () => {
  setPlatform('win32');
  stubShellEnv({ COMSPEC: 'C:\\Windows\\system32\\cmd.exe', PSModulePath: 'C:\\Users\\x\\Documents\\PowerShell\\Modules' });
  const { detectShell } = await loadShellEnv({ tools: [] });

  const info = detectShell();

  assert.equal(info.type, 'powershell');
  assert.equal(info.isWindows, true);
  assert.equal(info.shellPath, 'C:\\Windows\\system32\\cmd.exe', 'shellPath falls back to COMSPEC when SHELL is unset');
  assert.ok(info.tips.some((t) => t.includes('PowerShell cmdlets')));
  assert.ok(info.tips.some((t) => t.includes('winget install jqlang.jq')), 'missing jq on win32 suggests winget install');
});

test('win32 + __PWSH_PID → powershell (alternate signal)', async () => {
  setPlatform('win32');
  stubShellEnv({ __PWSH_PID: '4242' });
  const { detectShell } = await loadShellEnv({ tools: [] });

  assert.equal(detectShell().type, 'powershell');
});

test('win32 bare → cmd with CMD tips', async () => {
  setPlatform('win32');
  stubShellEnv({ COMSPEC: 'C:\\Windows\\system32\\cmd.exe' });
  const { detectShell } = await loadShellEnv({ tools: ['podman'] });

  const info = detectShell();

  assert.equal(info.type, 'cmd');
  assert.equal(info.shellPath, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(info.hasPodman, true);
  assert.ok(info.tips.some((t) => t.includes('CMD shell')));
  assert.ok(info.tips.some((t) => t.includes('%VAR%')));
  assert.ok(info.tips.some((t) => t.includes('Podman available')));
  assert.ok(info.tips.some((t) => t.includes('wget not installed')));
});

test('win32 SHELL without "bash" falls through to cmd/powershell detection', async () => {
  setPlatform('win32');
  stubShellEnv({ SHELL: 'C:\\tools\\weird-shell.exe', COMSPEC: 'cmd.exe' });
  const { detectShell } = await loadShellEnv({ tools: [] });

  assert.equal(detectShell().type, 'cmd');
});

// ── POSIX matrix ──────────────────────────────────────────────────────────

test('linux (no WSL marker) → bash with native tip', async () => {
  setPlatform('linux');
  stubShellEnv({ SHELL: '/bin/bash' });
  const { detectShell } = await loadShellEnv({
    procVersion: 'Linux version 6.6.0-generic',
    tools: ['git', 'node', 'npm', 'curl', 'jq', 'wget'],
  });

  const info = detectShell();

  assert.equal(info.type, 'bash');
  assert.equal(info.isWindows, false);
  assert.equal(info.isWSL, false);
  assert.equal(info.shellPath, '/bin/bash');
  assert.ok(info.tips.some((t) => t.includes('Native Linux shell')));
  assert.ok(info.tips.some((t) => t.includes('jq available')));
  assert.ok(info.tips.some((t) => t.includes('Install Podman')), 'podman absent on POSIX suggests install');
});

test('linux + /proc/version microsoft marker → wsl with /mnt tips', async () => {
  setPlatform('linux');
  stubShellEnv({ SHELL: '/bin/bash' });
  const { detectShell } = await loadShellEnv({
    procVersion: 'Linux version 5.15.90.1-microsoft-standard-WSL2',
    tools: [],
  });

  const info = detectShell();

  assert.equal(info.type, 'wsl');
  assert.equal(info.isWSL, true);
  assert.ok(info.tips.some((t) => t.includes('Running in WSL')));
  assert.ok(info.tips.some((t) => t.includes('/mnt/c/')), 'WSL exposes Windows mounts');
});

test('linux + WSL kernel-release marker → wsl', async () => {
  setPlatform('linux');
  stubShellEnv({});
  const { detectShell } = await loadShellEnv({ procVersion: '6.6.36-WSL2-lts', tools: [] });

  assert.equal(detectShell().type, 'wsl');
});

test('darwin → bash type with POSIX semantics, shellPath from $SHELL', async () => {
  setPlatform('darwin');
  stubShellEnv({ SHELL: '/bin/zsh' });
  // On macOS `cat /proc/version` fails and the `|| uname -r` fallback runs —
  // a single execSync returning the kernel release.
  const { detectShell } = await loadShellEnv({ procVersion: '23.5.0', tools: ['git', 'jq'] });

  const info = detectShell();

  assert.equal(info.type, 'bash');
  assert.equal(info.isWindows, false);
  assert.equal(info.shellPath, '/bin/zsh');
  assert.ok(info.tips.some((t) => t.includes('Native Linux shell')));
});

test('version probe failure degrades to bash + POSIX tip', async () => {
  setPlatform('linux');
  stubShellEnv({});
  const { detectShell } = await loadShellEnv({ procVersion: new Error('no /proc'), tools: [] });

  const info = detectShell();

  assert.equal(info.type, 'bash');
  assert.ok(info.tips.some((t) => t.includes('POSIX environment')));
  assert.ok(info.tips.some((t) => t.includes('wget not installed')));
  assert.equal(info.hasPodman, false);
});

test('empty environment → shellPath empty string', async () => {
  setPlatform('linux');
  stubShellEnv({});
  const { detectShell } = await loadShellEnv({ procVersion: 'Linux version 6.6.0-generic', tools: [] });

  assert.equal(detectShell().shellPath, '');
});

// ── getShellPromptSections ────────────────────────────────────────────────

function shellInfo(type: string, overrides: Record<string, unknown> = {}) {
  return {
    type,
    isWindows: type === 'cmd' || type === 'powershell' || type === 'git-bash',
    isWSL: type === 'wsl',
    shellPath: '/bin/sh',
    tips: [],
    hasPodman: false,
    tools: {
      git: true, gh: false, node: true, npm: true, python: false,
      curl: true, wget: true, jq: false, podman: false, winget: false, choco: false,
    },
    ...overrides,
  } as import('./shell-env.js').ShellInfo;
}

test('prompt sections: cmd gets the Windows compatibility block (jq absent)', async () => {
  const { getShellPromptSections } = await loadShellEnv();
  const out = getShellPromptSections(shellInfo('cmd'));

  assert.match(out, /# Windows CMD\/PowerShell Compatibility/);
  assert.match(out, /running in CMD, NOT a POSIX shell/);
  assert.match(out, /ConvertFrom-Json/, 'no jq → PowerShell JSON fallback documented');
  assert.match(out, /# Shell-Aware Command Execution/);
});

test('prompt sections: powershell names the shell; jq present short-circuits fallbacks', async () => {
  const { getShellPromptSections } = await loadShellEnv();
  const tools = { ...shellInfo('powershell').tools, jq: true };
  const out = getShellPromptSections(shellInfo('powershell', { tools }));

  assert.match(out, /running in PowerShell/);
  assert.match(out, /jq available: cat file\.json/);
});

test('prompt sections: git-bash and wsl get their own blocks', async () => {
  const { getShellPromptSections } = await loadShellEnv();

  const gitBash = getShellPromptSections(shellInfo('git-bash'));
  assert.match(gitBash, /# Git Bash Compatibility/);
  assert.match(gitBash, /POSIX commands work/);
  assert.doesNotMatch(gitBash, /CMD\/PowerShell Compatibility/);

  const wsl = getShellPromptSections(shellInfo('wsl', { isWindows: false }));
  assert.match(wsl, /# WSL Compatibility/);
  assert.match(wsl, /\/mnt\/c\//);
});

test('prompt sections: podman adds the container block', async () => {
  const { getShellPromptSections } = await loadShellEnv();
  const tools = { ...shellInfo('bash').tools, podman: true };
  const out = getShellPromptSections(
    shellInfo('bash', { isWindows: false, hasPodman: true, tools })
  );

  assert.match(out, /# Podman Containers \(available\)/);
  assert.match(out, /podman run -it/);
});

test('prompt sections: plain bash emits only the generic footer', async () => {
  const { getShellPromptSections } = await loadShellEnv();
  const out = getShellPromptSections(shellInfo('bash', { isWindows: false }));

  assert.match(out, /# Shell-Aware Command Execution/);
  assert.doesNotMatch(out, /Compatibility/);
});
