// Docs drift guard (#499): docs/environment-variables.md must stay in sync
// with the SC_* environment variables the code actually reads. The check is
// bidirectional and runs inside `npm test` (CI), so drift fails the build
// instead of confusing users:
//
//   * every SC_* env read in src/ must have a `### SC_*` section in the doc
//   * every documented `### SC_*` heading must correspond to a real env read
//     (or be an allowlisted non-env contract, e.g. an emitted stdout marker)
//
// Env reads are collected from three source shapes:
//   process.env.SC_FOO                       — direct dot access
//   process.env['SC_FOO'] / env['SC_FOO']    — string-literal subscripts
//   process.env[SOME_ENV] / env[SOME_ENV]    — constants bound to 'SC_*'
//     literals (FAILOVER_ENV, CONTEXT_BUDGET_ENV_VAR, DEVCONTAINER_ENV_VAR, …)
//
// An ALL_CAPS env subscript that cannot be resolved to an 'SC_*' literal
// binding fails as well — bind it to a literal/`*_ENV` const so the read
// stays greppable.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOC_PATH = path.resolve(SRC_DIR, '..', 'docs', 'environment-variables.md');

// '### SC_*' headings that are part of the documented CLI contract but are
// not environment inputs — the CLI *emits* them for wrappers/orchestrators.
const DOCUMENTED_NON_ENV = new Set([
  'SC_BUDGET_EXCEEDED', // marker emitted on graceful budget stop (exit 22)
  'SC_LIVELOCK',        // [SC_LIVELOCK] error marker on tool-livelock abort (exit 23)
]);

const ENV_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*['"](SC_[A-Z0-9_]+)['"]/g;
const DOT_READ = /\b(?:process\.env|env)\.(SC_[A-Z0-9_]+)/g;
const LITERAL_SUBSCRIPT_READ = /\b(?:process\.env|env)\[\s*['"](SC_[A-Z0-9_]+)['"]\s*\]/g;
const CONST_SUBSCRIPT_READ = /\b(?:process\.env|env)\[\s*([A-Z_][A-Z0-9_]*)\s*\]/g;
const DOC_HEADING = /^###\s+(SC_[A-Z0-9_]+)\b/gm;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

interface EnvScan {
  /** SC_* names read from the environment in src/. */
  implemented: Set<string>;
  /** `file → IDENT` for ALL_CAPS env subscripts with no resolvable 'SC_*' binding. */
  unresolvedReads: string[];
}

function scanEnvReads(): EnvScan {
  const files = collectSourceFiles(SRC_DIR).map((f) => ({
    name: path.relative(SRC_DIR, f),
    text: readFileSync(f, 'utf-8'),
  }));

  // First pass: literal bindings (`const FOO_ENV = 'SC_BAR'`) and direct reads.
  const bindings = new Map<string, string>();
  const implemented = new Set<string>();
  for (const { text } of files) {
    for (const m of text.matchAll(ENV_BINDING)) bindings.set(m[1], m[2]);
    for (const m of text.matchAll(DOT_READ)) implemented.add(m[1]);
    for (const m of text.matchAll(LITERAL_SUBSCRIPT_READ)) implemented.add(m[1]);
  }

  // Second pass: `env[CONST]`/`process.env[CONST]` reads resolved through the
  // binding table. Unresolvable ALL_CAPS subscripts are reported — the check
  // cannot see through them, so drift there would go unnoticed.
  const unresolvedReads: string[] = [];
  for (const { name, text } of files) {
    for (const m of text.matchAll(CONST_SUBSCRIPT_READ)) {
      const bound = bindings.get(m[1]);
      if (bound) implemented.add(bound);
      else unresolvedReads.push(`${name} → env[${m[1]}]`);
    }
  }

  return { implemented, unresolvedReads };
}

function documentedVars(): Set<string> {
  const doc = readFileSync(DOC_PATH, 'utf-8');
  const documented = new Set<string>();
  for (const m of doc.matchAll(DOC_HEADING)) documented.add(m[1]);
  return documented;
}

test('env-var docs: every SC_* env read in src has a ### section in docs/environment-variables.md', () => {
  const { implemented, unresolvedReads } = scanEnvReads();
  assert.deepEqual(
    unresolvedReads,
    [],
    'ALL_CAPS env subscripts with no resolvable SC_* literal binding — use a string literal or a *_ENV const so the drift check stays greppable'
  );

  const documented = documentedVars();
  const undocumented = [...implemented].filter((v) => !documented.has(v)).sort();
  assert.deepEqual(
    undocumented,
    [],
    `SC_* env vars read in src/ but undocumented — add a "### <NAME>" section to docs/environment-variables.md`
  );
});

test('env-var docs: every documented ### SC_* heading is implemented (or an allowlisted marker)', () => {
  const { implemented } = scanEnvReads();
  const documented = documentedVars();
  const stale = [...documented]
    .filter((v) => !implemented.has(v) && !DOCUMENTED_NON_ENV.has(v))
    .sort();
  assert.deepEqual(
    stale,
    [],
    `SC_* vars documented in docs/environment-variables.md but never read in src/ — implement them, remove the section, or add to DOCUMENTED_NON_ENV`
  );
});
