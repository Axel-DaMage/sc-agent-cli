import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseJsonSafe,
  parseTomlSafe,
  parseCiWorkflowYaml,
  parseXmlProperties,
  parseMakefileTargets,
} from './parser-utils.js';

// Prototype-pollution guards (#478): manifest files come from scanned repos and
// are untrusted — '__proto__'/'constructor'/'prototype' names must never reach
// `target[key] = ...` writes (which go through [[Set]]).

test('parseTomlSafe: [__proto__] table cannot reach Object.prototype', () => {
  const result = parseTomlSafe('[__proto__]\npolluted = "yes"\n');

  assert.equal((result as Record<string, unknown>).polluted, undefined);
  assert.ok(!('polluted' in {}), 'Object.prototype must stay clean');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('parseTomlSafe: dotted unsafe segments drop the whole table', () => {
  const result = parseTomlSafe('[deps.__proto__.evil]\npolluted = "yes"\n[ok]\nx = 1\n');

  assert.ok(!('polluted' in {}), 'Object.prototype must stay clean');
  assert.equal((result.ok as Record<string, unknown>)?.x, 1);
});

test('parseTomlSafe: unsafe keys and array-table headers are skipped', () => {
  const result = parseTomlSafe(
    'name = "safe"\nver = 1\n' +
      '__proto__ = { polluted = 1 }\nconstructor = "x"\nprototype = "y"\n' +
      '[[__proto__]]\npolluted = "arr"\n[ok]\nx = 2\n'
  );

  assert.equal(result.name, 'safe');
  assert.equal(result.ver, 1);
  assert.equal((result.ok as Record<string, unknown>).x, 2);
  assert.equal(Object.hasOwn(result, '__proto__'), false);
  assert.equal(Object.hasOwn(result, 'constructor'), false);
  assert.equal(Object.hasOwn(result, 'prototype'), false);
  assert.ok(!('polluted' in {}), 'Object.prototype must stay clean');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('parseCiWorkflowYaml: unsafe job names do not pollute or crash', () => {
  const proto = parseCiWorkflowYaml(
    ['jobs:', '  __proto__:', '    steps:', '      - run: evil'].join('\n')
  );
  assert.equal(Object.getPrototypeOf(proto.jobs), Object.prototype);
  assert.equal(Object.hasOwn(proto.jobs, '__proto__'), false);

  const ctor = parseCiWorkflowYaml(
    ['jobs:', '  constructor:', '    steps:', '      - run: x'].join('\n')
  );
  assert.equal(Object.hasOwn(ctor.jobs, 'constructor'), false);

  const ok = parseCiWorkflowYaml(
    ['jobs:', '  build:', '    steps:', '      - run: make'].join('\n')
  );
  assert.deepEqual(ok.jobs.build?.steps[0]?.run, 'make');
});

test('parseMakefileTargets: unsafe target names do not crash or pollute', () => {
  const targets = parseMakefileTargets(
    '__proto__: deps\n\tinjected\nhasOwnProperty: d\n\techo hi\nbuild: src\n\tmake build\n'
  );

  assert.equal(Object.getPrototypeOf(targets), Object.prototype);
  assert.equal(Object.hasOwn(targets, '__proto__'), false);
  assert.deepEqual(targets.build, ['make build']);
  // hasOwnProperty is a legitimate target — own array, not the inherited fn
  assert.deepEqual(targets.hasOwnProperty, ['echo hi']);
});

test('parseXmlProperties: unsafe tag names are skipped', () => {
  const properties = parseXmlProperties(
    '<java.version>17</java.version><__proto__>x</__proto__><constructor>y</constructor>'
  );

  assert.equal(properties['java.version'], '17');
  assert.equal(Object.hasOwn(properties, '__proto__'), false);
  assert.equal(Object.hasOwn(properties, 'constructor'), false);
});

// ---------------------------------------------------------------------------
// Malformed-input contract (#482): the parsers are total — they never throw,
// and degrade to null/empty results so a broken manifest degrades the
// detector to "not detected" instead of crashing the probe.
// ---------------------------------------------------------------------------

test('parseJsonSafe: invalid JSON returns null, never throws', () => {
  assert.equal(parseJsonSafe('{ "a": '), null);
  assert.equal(parseJsonSafe('{truncated'), null);
  assert.equal(parseJsonSafe('not json at all'), null);
  assert.equal(parseJsonSafe(''), null);
  // @ts-expect-error — non-string input must also degrade to null
  assert.equal(parseJsonSafe(undefined), null);
});

test('parseJsonSafe: valid JSON, JSONC comments, and trailing commas parse', () => {
  assert.deepEqual(parseJsonSafe('{"a":1}'), { a: 1 });
  assert.deepEqual(
    parseJsonSafe('// comment\n{"a": 1, /* block */ "b": [2,],}\n'),
    { a: 1, b: [2] }
  );
});

test('parseTomlSafe: malformed input returns a (possibly empty) object', () => {
  assert.deepEqual(parseTomlSafe(''), {});
  // @ts-expect-error — non-string input
  assert.deepEqual(parseTomlSafe(null), {});
  // Unparseable lines are skipped; valid ones still land.
  const res = parseTomlSafe('[[[\nthis is = = not toml\nname = "ok"\n= orphan\n');
  assert.equal(res.name, 'ok');
  assert.equal(Object.keys(res).length, 1);
});

test('parseTomlSafe: nested tables, arrays, numbers, booleans, comments', () => {
  const res = parseTomlSafe(
    [
      '# full-line comment',
      '[project]',
      'name = "demo"',
      'requires-python = ">=3.11"',
      'version = 2 # inline comment on unquoted value',
      'private = true',
      'deps = ["a", "b"]',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.12"',
      '',
    ].join('\n')
  );
  assert.equal(res.project.name, 'demo');
  assert.equal(res.project['requires-python'], '>=3.11');
  assert.equal(res.project.version, 2);
  assert.equal(res.project.private, true);
  assert.deepEqual(res.project.deps, ['a', 'b']);
  assert.equal(res.tool.poetry.dependencies.python, '^3.12');
});

test('parseTomlSafe: array-of-tables and multi-line arrays', () => {
  const res = parseTomlSafe(
    [
      'deps = [',
      '  "a",',
      '  "b",',
      ']',
      '[[bin]]',
      'name = "one"',
      '[[bin]]',
      'name = "two"',
      '',
    ].join('\n')
  );
  assert.deepEqual(res.deps, ['a', 'b']);
  assert.deepEqual(res.bin.map((b: { name: string }) => b.name), ['one', 'two']);
});

test('parseTomlSafe: inline tables parse key-value pairs', () => {
  const res = parseTomlSafe('pkg = { name = "x", version = "1" }\n');
  assert.deepEqual(res.pkg, { name: 'x', version: '1' });
});

test('parseCiWorkflowYaml: empty/malformed input returns the empty shape', () => {
  assert.deepEqual(parseCiWorkflowYaml(''), { jobs: {}, steps: [], allRuns: [] });
  // @ts-expect-error — non-string input
  assert.deepEqual(parseCiWorkflowYaml(null), { jobs: {}, steps: [], allRuns: [] });
  // Garbage lines are ignored rather than throwing.
  const res = parseCiWorkflowYaml(String.fromCharCode(0, 1) + '{{{ nonsense\n');
  assert.deepEqual(res.jobs, {});
  assert.deepEqual(res.steps, []);
});

test('parseXmlProperties: empty/malformed input returns {}', () => {
  assert.deepEqual(parseXmlProperties(''), {});
  assert.deepEqual(parseXmlProperties('not xml <<< at all'), {});
  assert.deepEqual(parseXmlProperties('<unclosed>oops'), {});
  // @ts-expect-error — non-string input
  assert.deepEqual(parseXmlProperties(undefined), {});
});

test('parseMakefileTargets: empty/malformed input returns {}', () => {
  assert.deepEqual(parseMakefileTargets(''), {});
  assert.deepEqual(parseMakefileTargets('###\n\nVAR := x\n'), {});
  // Variable assignments (:=) are not targets; recipes need a target first.
  const res = parseMakefileTargets('FOO := bar\n\techo stray\nbuild:\n\tmake it\n');
  assert.deepEqual(res, { build: ['make it'] });
});
