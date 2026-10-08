// GitHub template drift guard (#500): the issue forms and PR template under
// .github/ must stay wired to the repo's real structure. GitHub only surfaces
// template errors when someone opens the picker — these checks fail CI instead:
//
//   * .github/ISSUE_TEMPLATE/bug_report.yml + feature_request.yml exist and use
//     valid GitHub issue-form schema (known element types, id+label per field)
//   * bug_report.yml collects the acceptance fields (version, provider, OS,
//     repro steps, `sc doctor` output)
//   * config.yml keeps the contact links that route users to docs/FAQ/SECURITY
//   * PULL_REQUEST_TEMPLATE.md keeps the summary / linked-issue / test-plan /
//     checklist skeleton matching CONTRIBUTING.md conventions
//   * every `*.md` path the templates point at exists on disk (no dead links)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SRC_DIR, '..');
const ISSUE_TEMPLATE_DIR = path.join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE');
const PR_TEMPLATE_PATH = path.join(REPO_ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md');

const ISSUE_FORMS = ['bug_report.yml', 'feature_request.yml'] as const;

// Element types valid in GitHub issue forms. `markdown` items are prose-only;
// every other type is a form field and needs an id + label.
const VALID_FORM_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes']);
const FORM_ITEM = /^\s+-\s+type:\s*(\w+)\s*$/gm;

function readIssueTemplate(name: string): string {
  return readFileSync(path.join(ISSUE_TEMPLATE_DIR, name), 'utf-8');
}

/** Split a form's `body:` list into per-item chunks on `- type:` boundaries. */
function formItems(yaml: string): Array<{ type: string; chunk: string }> {
  const matches = [...yaml.matchAll(FORM_ITEM)];
  return matches.map((m, i) => ({
    type: m[1],
    chunk: yaml.slice(m.index!, i + 1 < matches.length ? matches[i + 1].index! : yaml.length),
  }));
}

test('github templates: issue forms, picker config and PR template exist', () => {
  for (const name of [...ISSUE_FORMS, 'config.yml']) {
    assert.ok(
      existsSync(path.join(ISSUE_TEMPLATE_DIR, name)),
      `missing .github/ISSUE_TEMPLATE/${name}`
    );
  }
  assert.ok(existsSync(PR_TEMPLATE_PATH), 'missing .github/PULL_REQUEST_TEMPLATE.md');
});

test('github templates: issue forms declare valid schema and required headers', () => {
  for (const name of ISSUE_FORMS) {
    const yaml = readIssueTemplate(name);
    for (const key of ['name', 'description', 'title', 'labels', 'body']) {
      assert.match(yaml, new RegExp(`^${key}:`, 'm'), `${name} missing top-level "${key}:"`);
    }
    assert.ok(!yaml.includes('\t'), `${name} contains a tab — YAML forbids tab indentation`);

    const items = formItems(yaml);
    assert.ok(items.length > 0, `${name} has no body items`);
    for (const { type, chunk } of items) {
      assert.ok(VALID_FORM_TYPES.has(type), `${name} uses unknown form element type "${type}"`);
      if (type === 'markdown') continue;
      assert.match(chunk, /^\s+id:\s*\w+$/m, `${name}: ${type} field missing "id:"`);
      assert.match(chunk, /^\s+label:\s*\S/m, `${name}: ${type} field missing "label:"`);
    }
  }
});

test('github templates: bug_report.yml collects the acceptance fields', () => {
  const yaml = readIssueTemplate('bug_report.yml');
  for (const id of ['version', 'provider', 'os', 'repro', 'doctor']) {
    assert.match(yaml, new RegExp(`^\\s+id:\\s*${id}\\s*$`, 'm'), `bug_report.yml missing field id "${id}"`);
  }
  // The sc-doctor field must actually point at `sc doctor`, not just exist.
  const doctor = formItems(yaml).find(({ chunk }) => /^\s+id:\s*doctor\s*$/m.test(chunk));
  assert.ok(doctor && /sc doctor/.test(doctor.chunk), 'bug_report.yml "doctor" field must reference `sc doctor`');
});

test('github templates: config.yml keeps picker links to docs, FAQ and security advisories', () => {
  const yaml = readIssueTemplate('config.yml');
  assert.match(yaml, /^blank_issues_enabled:\s*(true|false)$/m, 'config.yml missing blank_issues_enabled');
  assert.match(yaml, /^contact_links:/m, 'config.yml missing contact_links');
  for (const url of [
    'github.com/os-santiago/sc-agent-cli/tree/main/docs',
    'github.com/os-santiago/sc-agent-cli/blob/main/docs/FAQ.md',
    'github.com/os-santiago/sc-agent-cli/security/advisories/new',
  ]) {
    assert.ok(yaml.includes(url), `config.yml contact_links missing ${url}`);
  }
});

test('github templates: PR template keeps summary / linked issue / test plan / checklist', () => {
  const md = readFileSync(PR_TEMPLATE_PATH, 'utf-8');
  for (const heading of ['## Summary', '## Linked issue', '## Test plan', '## Checklist']) {
    assert.ok(md.includes(heading), `PR template missing "${heading}" section`);
  }
  assert.match(md, /Closes #/, 'PR template must prompt for a `Closes #N` link');
  assert.match(md, /Conventional Commits/, 'PR template must remind authors of the conventional-title convention');
  assert.match(md, /- \[ \]/, 'PR template checklist needs checkbox items');
});

test('github templates: every repo doc path referenced by the templates exists', () => {
  const sources = [
    readIssueTemplate('bug_report.yml'),
    readIssueTemplate('feature_request.yml'),
    readIssueTemplate('config.yml'),
    readFileSync(PR_TEMPLATE_PATH, 'utf-8'),
  ];
  const refs = new Set<string>();
  for (const source of sources) {
    for (const m of source.matchAll(/\b(?:docs\/)?[A-Za-z][\w.-]*\.md\b/g)) {
      refs.add(m[0]);
    }
  }
  const missing = [...refs].filter((ref) => !existsSync(path.join(REPO_ROOT, ref))).sort();
  assert.deepEqual(
    missing,
    [],
    `templates reference repo docs that do not exist — fix the link or restore the file`
  );

  // Acceptance criterion: the two onboarding docs must stay linked.
  assert.ok(refs.has('docs/permission-profiles.md'), 'templates must reference docs/permission-profiles.md');
  assert.ok(refs.has('docs/environment-variables.md'), 'templates must reference docs/environment-variables.md');
});
