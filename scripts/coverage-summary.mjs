#!/usr/bin/env node
/**
 * Renders a markdown coverage summary from coverage/coverage-summary.json
 * (produced by vitest's `json-summary` reporter).
 *
 * Usage:
 *   node scripts/coverage-summary.mjs [--file coverage/coverage-summary.json]
 *
 * Prints markdown to stdout. CI appends it to $GITHUB_STEP_SUMMARY and
 * posts it as an upserted PR comment. Missing/invalid input prints a
 * fallback notice instead of failing, so `if: always()` steps stay green.
 */

import { readFileSync } from 'node:fs';

const idx = process.argv.indexOf('--file');
const file = idx !== -1 ? process.argv[idx + 1] : 'coverage/coverage-summary.json';

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  console.log('Coverage summary unavailable — `coverage/coverage-summary.json` was not produced.');
  process.exit(0);
}

const total = data?.total;
if (!total) {
  console.log('Coverage summary unavailable — `total` totals missing from coverage-summary.json.');
  process.exit(0);
}

const row = (label, m) =>
  m ? `| ${label} | ${m.covered}/${m.total} | ${m.pct}% |` : `| ${label} | n/a | n/a |`;

const lines = [
  '| Metric | Covered | % |',
  '| ------ | ------- | - |',
  row('Statements', total.statements),
  row('Branches', total.branches),
  row('Functions', total.functions),
  row('Lines', total.lines),
];

console.log(lines.join('\n'));
