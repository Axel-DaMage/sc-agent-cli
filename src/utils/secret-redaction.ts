import type { ProjectConfig } from '../core/types.js';

/**
 * Shared secret-redaction layer (#472).
 *
 * One module sits between tool/model output and (a) the provider context
 * and (b) every persisted-state write — session traces, checkpoints,
 * the audit log, run manifests, and persistent memory. Before this,
 * secrets surfaced by tool output (a leaked `.env`, `env` via run_shell,
 * a signed URL from web_fetch) flowed unmodified into all of them.
 *
 * Two detection mechanisms:
 *   1. Patterns — SENSITIVE_KEYS-style assignments (`KEY=value`,
 *      `"key": "value"`, YAML `key: value`), auth headers
 *      (`Bearer …`, `x-access-token: …`), well-known token shapes
 *      (sk-/nvapi-/ghp_/gho_/PEM/JWT/AWS/Google), and scheme-prefixed
 *      credentials.
 *   2. Exact-match — the configured `model.apiKey` (and profile/env
 *      keys) registered at session start; its literal value is masked
 *      regardless of the key name it appears under.
 */

export const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Exact-match registry — literal secret values from configuration.
// ---------------------------------------------------------------------------

// Minimum length for a configured value to be treated as a secret: shorter
// values risk masking ordinary words (e.g. a placeholder like "test").
const MIN_EXACT_SECRET_LEN = 8;

const exactSecrets = new Set<string>();
// Cached longest-first ordering: a short secret must not mask the inside
// of a longer one ("abc" before "abcdef" would leave "def" behind).
let sortedExactSecrets: string[] = [];

function refreshSortedSecrets(): void {
  sortedExactSecrets = [...exactSecrets].sort((a, b) => b.length - a.length);
}

/**
 * Register literal secret values for exact-match masking. Values shorter
 * than MIN_EXACT_SECRET_LEN or `<YOUR_…>` template placeholders are ignored.
 * Idempotent — registering the same value twice is a no-op.
 */
export function registerRedactionSecrets(secrets: Iterable<string | null | undefined>): void {
  let changed = false;
  for (const raw of secrets) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value.length < MIN_EXACT_SECRET_LEN) continue;
    if (value.startsWith('<YOUR_') || value === REDACTED) continue;
    if (!exactSecrets.has(value)) {
      exactSecrets.add(value);
      changed = true;
    }
  }
  if (changed) refreshSortedSecrets();
}

/**
 * Register every credential the resolved config can put on the wire:
 * the active `model.apiKey`, each named profile's `apiKey` (failover
 * candidates and role mappings draw keys from profiles), and the env
 * keys the provider layer honors (SC_API_KEY + provider-specific vars).
 */
export function registerConfigSecrets(config: ProjectConfig): void {
  registerRedactionSecrets([
    config.model?.apiKey,
    ...Object.values(config.profiles ?? {}).map((p) => p?.apiKey),
    process.env.SC_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.NVIDIA_API_KEY,
  ]);
}

/** Test hook: drop every registered exact-match secret. */
export function clearRedactionSecrets(): void {
  exactSecrets.clear();
  refreshSortedSecrets();
}

// ---------------------------------------------------------------------------
// Pattern rules.
// ---------------------------------------------------------------------------

// Sensitive key names (superset of the SENSITIVE_KEYS mask in
// permissions.ts). `[_-]?` tolerates `api_key`/`api-key`/`apikey` and, via
// the case-insensitive flag, camelCase (`apiKey`, `clientSecret`, …).
const SENSITIVE_KEY_ALT = [
  'api[_-]?key',
  'access[_-]?(?:key|token)',
  'refresh[_-]?token',
  'auth[_-]?token',
  'authorization',
  'proxy[_-]?authorization',
  'auth',
  'bearer[_-]?token',
  'private[_-]?(?:key|token)',
  'public[_-]?key',
  'ssh[_-]?(?:private[_-]?)?key',
  'secret(?:[_-]?key|[_-]?access[_-]?key)?',
  'client[_-]?secret',
  'session[_-]?(?:key|token)',
  'cookie',
  'csrf[_-]?token',
  'xsrf[_-]?token',
  'jwt(?:[_-]?token)?',
  'credentials?',
  'x[_-]?(?:access[_-]?token|api[_-]?key|auth[_-]?token|session[_-]?token|amz[_-]?(?:signature|credential|security[_-]?token))',
  'token',
  'key',
  'password',
  'passwd',
  'pass',
  'pwd',
  'sig(?:nature)?',
].join('|');

// Characters that terminate an unquoted credential value. Excludes quotes,
// whitespace, JSON/YAML structural chars (`{}[]`,`), URL query joins (`&`),
// shell/URL punctuation (`;`, `|`), escape chars (`\`), and `<>` so
// `<YOUR_KEY>` placeholders survive untouched.
const VALUE_CHARS = `[^\\s"'(){}\\[\\],&;\\\\|<>]+`;

// `KEY=value`, `KEY: value`, `"key": "value"` (incl. backslash-escaped
// JSON like `\"api_key\": \"v\"`), with an optional Bearer/Basic/Token
// scheme prefix (`Authorization: Bearer xyz` → `Authorization: Bearer
// [REDACTED]`). The key may carry `SEG_`/dot/dash-prefixed or camelCase
// prefixes so `DB_PASSWORD`, `AWS_SECRET_ACCESS_KEY`, `myApiKey`, and
// `x-access-token` all resolve to a sensitive suffix — while `monkey`
// and `token_type` do not match (`key`/`token` are not at a boundary).
//
// The prefix is deliberately written as `(?:alnum+[._-])*(?:alnum+(?=[A-Z]))?`
// — separator-ended segments plus at most one run ending at a camelCase
// hump — because each segment then has exactly one valid partition. An
// alternation of overlapping reps (`alnum+[._-]` vs `alnum+(?=[A-Z])`)
// inside `*?` lets every internal capital letter act as an optional rep
// boundary, so non-matching CONSTANT_CASE tokens (e.g.
// `SC_PROVIDER_ATTEMPT_TIMEOUT_MS` in injected docs) cost ~2^N backtracking
// paths — catastrophic ReDoS that froze `npm test` (#472 gate failure).
const ASSIGNMENT_RE = new RegExp(
  `(\\b(?:[A-Za-z0-9]+[._-])*(?:[A-Za-z0-9]+(?=[A-Z]))?(?:${SENSITIVE_KEY_ALT})\\b` +
    `\\s*\\\\?["']?\\s*[:=][ \\t]*\\\\?["']?)` +
    `((?:bearer|basic|token)[ \\t]+)?` +
    VALUE_CHARS,
  'gi',
);

// Bare scheme-prefixed credentials with no key name: `Bearer xyz`,
// `Basic dXNlcg==`, `Token abc`. The ASSIGNMENT_RE only masks the scheme
// when it follows a sensitive key, so standalone occurrences need this.
const BARE_SCHEME_RE = /\b(Bearer|Basic|Token)[ \t]+[A-Za-z0-9._~+/=-]{6,}/g;

// PEM / OpenSSH / PGP private-key blocks (headers may suffix "BLOCK").
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/g;

// Well-known token shapes that carry secrets regardless of key name.
const TOKEN_VALUE_RES: RegExp[] = [
  // JWT (header.payload.signature — header base64url always starts "eyJ").
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Dash/underscore-prefixed provider tokens: OpenAI sk-*, NVIDIA nvapi-*,
  // xAI, Groq, PyPI, GitLab PAT, Slack xox*/xapp, DigitalOcean, Shopify.
  /\b(?:sk|nvapi|xai|gsk|pypi|glpat|xox[baprs]|xapp|dop_v1|shpat|shpca|shppa)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}/g,
  // GitHub PATs (ghp_/gho_/ghu_/ghs_/ghr_, github_pat_), npm, HuggingFace,
  // Square, Supabase service keys.
  /\b(?:gh[pousr]|github_pat|npm|hf|sq0atp|sq0csp|sbp)_[A-Za-z0-9_]{14,}/g,
  // AWS access key id, Google API key, Google OAuth access token.
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z_-]{10,}/g,
];

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Mask secrets in free text. Applies registered exact-match secrets first
 * (highest confidence), then PEM blocks, keyed assignments, bare auth
 * schemes, and token-shaped values. Idempotent: already-masked output
 * contains no matchable secret forms.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of sortedExactSecrets) {
    out = out.split(secret).join(REDACTED);
  }
  out = out.replace(PEM_BLOCK_RE, REDACTED);
  out = out.replace(ASSIGNMENT_RE, (_match, pre: string, scheme?: string) =>
    `${pre}${scheme ?? ''}${REDACTED}`,
  );
  out = out.replace(BARE_SCHEME_RE, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  for (const re of TOKEN_VALUE_RES) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Deep-copy a value with every string field redacted. Used on structured
 * objects (messages, audit events, manifests) so JSON structure stays
 * valid — redaction runs inside string values, never across syntax.
 * Object keys are preserved (keys are not a leak vector; renaming them
 * would break consumers).
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}
