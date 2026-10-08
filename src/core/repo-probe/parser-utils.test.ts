import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
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
