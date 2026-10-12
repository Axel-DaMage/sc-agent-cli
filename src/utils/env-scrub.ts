// #471 — keep provider credentials and agent internals out of spawned shell
// commands.
//
// run_shell (and the other tool-spawned children) previously inherited the
// full parent environment, so `env`, `printenv`, or a one-liner reading
// `/proc/$PPID/environ` dumped SC_API_KEY / OPENAI_API_KEY / GH_TOKEN into the
// tool output — which is then shipped to the model provider and persisted in
// session history and checkpoints.
//
// The fix has two layers:
//   1. Children receive an allowlisted environment: a small hardcoded base
//      (PATH, HOME, shell basics) plus optional `run_shell.allowedEnvVars`
//      entries. Credential-shaped names (`*_API_KEY`, `*_TOKEN`, `*_SECRET`,
//      `SC_*`, …) are stripped unconditionally — the allowlist can never
//      re-add them.
//   2. Tool output is redacted for *known* secret values (credential env vars
//      from the parent environment + configured API keys) so a file read that
//      slips past the deny-command guards still cannot leak the key.

import type { ProjectConfig } from '../core/types.js';

/**
 * Environment variables a spawned command needs to function. Everything else
 * is dropped from the child environment. Matching is case-insensitive so the
 * Windows spellings (`Path`, `SystemRoot`, …) work the same as POSIX ones.
 */
export const BASE_CHILD_ENV_VARS: readonly string[] = [
  // POSIX core
  'PATH', 'HOME', 'SHELL', 'TERM', 'USER', 'LOGNAME', 'PWD', 'OLDPWD',
  'HOSTNAME', 'TZ', 'SHLVL',
  // Locale / terminal presentation
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'COLORTERM',
  'TERM_PROGRAM', 'TERMINFO',
  // Temp dirs
  'TMPDIR', 'TMP', 'TEMP',
  // XDG dirs (npm, gh, and other tools resolve config/cache through them)
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  // Pagers/editors used by interactive commands
  'PAGER', 'EDITOR', 'VISUAL', 'GIT_EDITOR',
  // Outbound proxy config — ambient infra settings children need in proxied
  // networks. A creds-bearing proxy URL (`http://user:pass@host`) is masked
  // from tool output by collectSecretValues below. The sandbox's egress proxy
  // vars are injected after scrubbing, so they always win anyway.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ftp_proxy',
  // Windows essentials (cmd.exe resolution, .cmd/.bat shims, roaming profiles)
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PSMODULEPATH', 'OS', 'PUBLIC',
  'ALLUSERSPROFILE', 'NUMBER_OF_PROCESSORS',
  // Agent sockets — grant signing/auth *capability* without disclosing key
  // material (keys never leave the agent). ssh-based git flows rely on these.
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  // Harmless behavior flags commonly read by scripts
  'CI', 'DEBIAN_FRONTEND',
];

/**
 * Names the sensitive-name patterns may match but that are not secrets —
 * `SSH_AUTH_SOCK` trips the `_AUTH_` rule yet only holds an agent socket path.
 */
const ENV_NAME_EXEMPTIONS = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID']);

/**
 * Name patterns that mark an environment variable as credential material —
 * the value is a secret worth masking wherever it appears. `SC_API_KEY` is
 * covered by the `_KEY` suffix rule like every other `*_API_KEY`.
 */
const CREDENTIAL_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)KEY($|_)/i, // *_KEY, *_KEY_ID/FILE/… — API keys, SSH keys, signing keys
  /TOKEN/i, // *_TOKEN, GH_TOKEN, NPM_TOKEN, _authToken, SESSION_TOKEN…
  /SECRET/i, // *_SECRET, *_SECRET_KEY, CLIENT_SECRET, AWS_SECRET_ACCESS_KEY…
  /PASSWORD|PASSWD|PASSPHRASE/i,
  /CREDENTIAL|CREDS/i,
  /(^|_)AUTH($|_)/i, // *_AUTH, *_AUTH_* — registry auth blobs (GIT_AUTHOR_* unaffected)
  /BEARER/i,
];

/**
 * Names that must never reach a spawned child's environment — every
 * credential-shaped name above plus the whole `SC_*` agent-internal namespace
 * (SC_MODEL, SC_BASE_URL, SC_CONFIG_PATH, … are config, not child input).
 * Case-insensitive: env names are case-insensitive on Windows, and lowercase
 * variants (`openai_api_key`) must not slip through on POSIX.
 */
const SENSITIVE_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /^SC_/i,
  ...CREDENTIAL_ENV_NAME_PATTERNS,
];

/** true when `name` is credential/agent-internal and must never reach a child env. */
export function isSensitiveEnvName(name: string): boolean {
  if (ENV_NAME_EXEMPTIONS.has(name)) return false;
  return SENSITIVE_ENV_NAME_PATTERNS.some((re) => re.test(name));
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build the environment handed to a spawned command: the safe base set plus
 * operator-approved extras — minus anything credential-shaped.
 *
 * `allowedEnvVars` comes from `run_shell.allowedEnvVars` config. Names are
 * matched case-insensitively; sensitive names are skipped so the allowlist can
 * never re-add a credential.
 */
export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  allowedEnvVars?: readonly string[],
): NodeJS.ProcessEnv {
  const allowed = new Set(BASE_CHILD_ENV_VARS);
  for (const raw of allowedEnvVars ?? []) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!ENV_NAME_RE.test(name)) continue; // validated at config load; stay defensive
    allowed.add(name.toUpperCase());
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(name)) continue;
    if (allowed.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

/** Values shorter than this are not worth masking — too much common-word overlap. */
const SECRET_VALUE_MIN_LENGTH = 8;

export const REDACTED = '***';

/**
 * Known secret values to mask in tool output: the values of credential-shaped
 * parent env vars plus the configured API keys (model + named profiles).
 * Output redaction is best-effort — it catches secrets we already know about;
 * it cannot identify secret-looking strings we never saw.
 */
export function collectSecretValues(
  env: NodeJS.ProcessEnv,
  config?: ProjectConfig,
): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < SECRET_VALUE_MIN_LENGTH) continue;
    if (ENV_NAME_EXEMPTIONS.has(name)) continue; // e.g. SSH_AUTH_SOCK is a path, not a secret
    if (CREDENTIAL_ENV_NAME_PATTERNS.some((re) => re.test(name))) {
      values.add(value);
      continue;
    }
    // Proxy URLs carrying userinfo (`http://user:pass@host`) are credentials —
    // the var name itself is not credential-shaped, so check the value.
    if (/(^|_)PROXY$/i.test(name) && /\/\/[^/\s@]+:[^/\s@]+@/.test(value)) {
      values.add(value);
    }
  }
  const keys = [config?.model?.apiKey];
  for (const profile of Object.values(config?.profiles ?? {})) {
    keys.push(profile?.apiKey);
  }
  for (const key of keys) {
    // Placeholders like '<YOUR_OPENAI_KEY>' are not secrets — skip them.
    if (key && !key.startsWith('<YOUR_') && key.length >= SECRET_VALUE_MIN_LENGTH) {
      values.add(key);
    }
  }
  return [...values].sort((a, b) => b.length - a.length); // longest first
}

/** Replace every occurrence of a known secret value with `***`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  if (!text) return text;
  let out = text;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}
