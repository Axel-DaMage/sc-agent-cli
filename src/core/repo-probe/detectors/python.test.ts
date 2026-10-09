import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPython } from './python.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-py-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  dirs.push(root);
  return root;
}

test('no python manifests → not detected', () => {
  const res = detectPython(repo({ 'README.md': 'x' }));
  assert.equal(res.detected, false);
});

test('requirements.txt → pip + pip install + unittest fallback', () => {
  const root = repo({ 'requirements.txt': 'requests==2.31.0\n' });
  const res = detectPython(root);

  assert.equal(res.detected, true);
  assert.ok(res.ecosystems.includes('python'));
  assert.ok(res.manifests.includes('requirements.txt'));

  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'pip');
  assert.equal(pm.sourceFile, 'requirements.txt');

  assert.equal(res.commands.install, 'pip install -r requirements.txt');
  assert.equal(res.commands.test, 'python -m unittest');
  assert.ok(res.frameworks.some((f) => f.name === 'unittest' && f.sourceFile === 'built-in'));
});

test('requirements.txt with pytest → pytest framework + pytest test cmd', () => {
  const root = repo({ 'requirements.txt': 'pytest>=7\nflake8\n' });
  const res = detectPython(root);

  assert.ok(res.frameworks.some((f) => f.name === 'pytest' && f.category === 'test'));
  assert.ok(res.frameworks.some((f) => f.name === 'flake8' && f.category === 'lint'));
  assert.equal(res.commands.test, 'pytest');
  assert.equal(res.commands.lint, 'flake8');
});

test('pyproject.toml + uv.lock → uv manager, uv sync install', () => {
  const root = repo({
    'pyproject.toml': [
      '[project]',
      'name = "demo"',
      'requires-python = ">=3.11"',
      'dependencies = ["pytest>=7", "ruff", "mypy", "fastapi"]',
      '',
    ].join('\n'),
    'uv.lock': 'version = 1\n',
  });
  const res = detectPython(root);

  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'uv');
  assert.equal(pm.lockfile, 'uv.lock');
  assert.equal(pm.sourceFile, 'uv.lock');

  const tc = res.toolchains[0];
  assert.equal(tc.name, 'python');
  assert.equal(tc.version, '3.11');
  assert.equal(tc.rawSpec, '>=3.11');
  assert.equal(tc.sourceFile, 'pyproject.toml#project.requires-python');

  assert.equal(res.commands.install, 'uv sync');
  assert.equal(res.commands.build, 'uv build');
  assert.equal(res.commands.test, 'uv run pytest');
  assert.equal(res.commands.lint, 'uv run ruff check .');
  assert.equal(res.commands.typecheck, 'uv run mypy .');
  assert.ok(res.frameworks.some((f) => f.name === 'fastapi' && f.category === 'web'));
});

test('tool.uv without uv.lock → uv manager, uv pip install with requirements', () => {
  const root = repo({
    'pyproject.toml': '[tool.uv]\n[project]\nname = "demo"\n',
    'requirements.txt': 'requests\n',
  });
  const res = detectPython(root);
  assert.equal(res.packageManagers[0].name, 'uv');
  assert.equal(res.packageManagers[0].lockfile, undefined);
  assert.equal(res.commands.install, 'uv pip install -r requirements.txt');
});

test('pyproject.toml + poetry.lock → poetry manager', () => {
  const root = repo({
    'pyproject.toml': [
      '[tool.poetry]',
      'name = "demo"',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'pytest = "^7.0"',
      'django = "^5.0"',
      '',
    ].join('\n'),
    'poetry.lock': '',
  });
  const res = detectPython(root);

  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'poetry');
  assert.equal(pm.lockfile, 'poetry.lock');

  const tc = res.toolchains[0];
  assert.equal(tc.version, '3.11');
  assert.equal(tc.sourceFile, 'pyproject.toml#tool.poetry.dependencies.python');

  assert.equal(res.commands.install, 'poetry install');
  assert.equal(res.commands.build, 'poetry build');
  assert.equal(res.commands.test, 'poetry run pytest');
  assert.ok(res.frameworks.some((f) => f.name === 'django'));
});

test('pdm.lock → pdm manager', () => {
  const root = repo({
    'pyproject.toml': '[project]\nname = "demo"\n',
    'pdm.lock': '',
  });
  const res = detectPython(root);
  assert.equal(res.packageManagers[0].name, 'pdm');
  assert.equal(res.packageManagers[0].lockfile, 'pdm.lock');
  assert.equal(res.commands.install, 'pdm install');
  assert.equal(res.commands.build, 'pdm build');
});

test('Pipfile → pipenv manager', () => {
  const root = repo({ 'Pipfile': '[[source]]\nname = "pypi"\n', 'Pipfile.lock': '{}' });
  const res = detectPython(root);
  assert.equal(res.packageManagers[0].name, 'pipenv');
  assert.equal(res.packageManagers[0].lockfile, 'Pipfile.lock');
  assert.equal(res.commands.install, 'pipenv install');
  assert.equal(res.commands.test, 'pipenv run python -m unittest');
});

test('setup.py → pip with editable install + python -m build', () => {
  const root = repo({ 'setup.py': 'from setuptools import setup\nsetup()\n' });
  const res = detectPython(root);
  assert.equal(res.packageManagers[0].name, 'pip');
  assert.equal(res.packageManagers[0].sourceFile, 'setup.py');
  assert.equal(res.commands.install, 'pip install -e .');
  assert.equal(res.commands.build, 'python -m build');
});

test('.python-version wins over pyproject requires-python', () => {
  const root = repo({
    'pyproject.toml': '[project]\nname = "x"\nrequires-python = ">=3.10"\n',
    '.python-version': '3.12.4\n',
  });
  const res = detectPython(root);
  const tc = res.toolchains[0];
  assert.equal(tc.version, '3.12.4');
  assert.equal(tc.sourceFile, '.python-version');
  assert.ok(res.manifests.includes('.python-version'));
});

test('malformed pyproject.toml degrades to pip defaults without throwing', () => {
  const root = repo({
    'pyproject.toml': 'this is = = not toml [[[',
    'requirements.txt': 'flask\n',
  });
  const res = detectPython(root);
  assert.equal(res.detected, true);
  assert.equal(res.packageManagers[0].name, 'pip');
  assert.equal(res.commands.install, 'pip install -r requirements.txt');
  assert.ok(res.frameworks.some((f) => f.name === 'flask'));
});

test('requirements-dev.txt participates in framework detection', () => {
  const root = repo({
    'requirements.txt': 'requests\n',
    'requirements-dev.txt': 'pyright\nblack\n',
  });
  const res = detectPython(root);
  assert.ok(res.frameworks.some((f) => f.name === 'pyright' && f.category === 'typecheck'));
  assert.ok(res.frameworks.some((f) => f.name === 'black' && f.category === 'lint'));
  assert.equal(res.commands.typecheck, 'pyright');
  assert.equal(res.commands.lint, 'black --check .');
});
