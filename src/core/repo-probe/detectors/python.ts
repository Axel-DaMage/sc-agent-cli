import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ToolchainInfo,
  PackageManagerInfo,
  FrameworkInfo,
  RepoCommands,
} from '../types.js';
import { parseTomlSafe } from '../parser-utils.js';

export interface PythonDetectionResult {
  detected: boolean;
  ecosystems: string[];
  toolchains: ToolchainInfo[];
  packageManagers: PackageManagerInfo[];
  frameworks: FrameworkInfo[];
  commands: RepoCommands;
  manifests: string[];
}

export function detectPython(workspaceRoot: string): PythonDetectionResult {
  const result: PythonDetectionResult = {
    detected: false,
    ecosystems: [],
    toolchains: [],
    packageManagers: [],
    frameworks: [],
    commands: {},
    manifests: [],
  };

  const pyprojectPath = join(workspaceRoot, 'pyproject.toml');
  const reqsPath = join(workspaceRoot, 'requirements.txt');
  const setupPyPath = join(workspaceRoot, 'setup.py');
  const setupCfgPath = join(workspaceRoot, 'setup.cfg');
  const pipfilePath = join(workspaceRoot, 'Pipfile');
  const pyVersionPath = join(workspaceRoot, '.python-version');

  const hasPyproject = existsSync(pyprojectPath);
  const hasReqs = existsSync(reqsPath);
  const hasSetupPy = existsSync(setupPyPath);
  const hasSetupCfg = existsSync(setupCfgPath);
  const hasPipfile = existsSync(pipfilePath);
  const hasPyVersion = existsSync(pyVersionPath);

  if (!hasPyproject && !hasReqs && !hasSetupPy && !hasSetupCfg && !hasPipfile && !hasPyVersion) {
    return result;
  }

  result.detected = true;
  result.ecosystems.push('python');

  let pyproject: Record<string, any> = {};
  if (hasPyproject) {
    result.manifests.push('pyproject.toml');
    try {
      pyproject = parseTomlSafe(readFileSync(pyprojectPath, 'utf-8'));
    } catch {
      pyproject = {};
    }
  }

  if (hasReqs) result.manifests.push('requirements.txt');
  if (hasSetupPy) result.manifests.push('setup.py');
  if (hasSetupCfg) result.manifests.push('setup.cfg');
  if (hasPipfile) result.manifests.push('Pipfile');
  if (hasPyVersion) result.manifests.push('.python-version');

  // Check locks
  const hasUvLock = existsSync(join(workspaceRoot, 'uv.lock'));
  const hasPoetryLock = existsSync(join(workspaceRoot, 'poetry.lock'));
  const hasPdmLock = existsSync(join(workspaceRoot, 'pdm.lock'));
  const hasPipfileLock = existsSync(join(workspaceRoot, 'Pipfile.lock'));

  if (hasUvLock) result.manifests.push('uv.lock');
  if (hasPoetryLock) result.manifests.push('poetry.lock');
  if (hasPdmLock) result.manifests.push('pdm.lock');
  if (hasPipfileLock) result.manifests.push('Pipfile.lock');

  // 1. Toolchain Python Version
  let pythonVersion: string | undefined;
  let pythonSource: string | undefined;

  if (hasPyVersion) {
    try {
      pythonVersion = readFileSync(pyVersionPath, 'utf-8').trim();
      pythonSource = '.python-version';
    } catch {
      // ignore
    }
  } else if (pyproject.project?.['requires-python']) {
    pythonVersion = String(pyproject.project['requires-python']);
    pythonSource = 'pyproject.toml#project.requires-python';
  } else if (pyproject.tool?.poetry?.dependencies?.python) {
    pythonVersion = String(pyproject.tool.poetry.dependencies.python);
    pythonSource = 'pyproject.toml#tool.poetry.dependencies.python';
  }

  result.toolchains.push({
    name: 'python',
    version: pythonVersion?.replace(/[\^~>=<]/g, '').trim(),
    rawSpec: pythonVersion,
    sourceFile: pythonSource,
  });

  // 2. Package Manager
  let pmName = 'pip';
  let lockfile: string | undefined;
  let pmSource: string | undefined;

  if (hasUvLock || pyproject.tool?.uv) {
    pmName = 'uv';
    lockfile = hasUvLock ? 'uv.lock' : undefined;
    pmSource = hasUvLock ? 'uv.lock' : 'pyproject.toml';
  } else if (hasPoetryLock || pyproject.tool?.poetry) {
    pmName = 'poetry';
    lockfile = hasPoetryLock ? 'poetry.lock' : undefined;
    pmSource = hasPoetryLock ? 'poetry.lock' : 'pyproject.toml';
  } else if (hasPdmLock || pyproject.tool?.pdm) {
    pmName = 'pdm';
    lockfile = hasPdmLock ? 'pdm.lock' : undefined;
    pmSource = hasPdmLock ? 'pdm.lock' : 'pyproject.toml';
  } else if (hasPipfileLock || hasPipfile) {
    pmName = 'pipenv';
    lockfile = hasPipfileLock ? 'Pipfile.lock' : undefined;
    pmSource = hasPipfileLock ? 'Pipfile.lock' : 'Pipfile';
  } else if (hasReqs) {
    pmName = 'pip';
    pmSource = 'requirements.txt';
  } else if (hasSetupPy || hasSetupCfg) {
    pmName = 'pip';
    pmSource = hasSetupPy ? 'setup.py' : 'setup.cfg';
  }

  result.packageManagers.push({
    name: pmName,
    lockfile,
    sourceFile: pmSource,
  });

  // 3. Frameworks & Tools
  const allDepsString = [
    JSON.stringify(pyproject),
    hasReqs ? readFileSync(reqsPath, 'utf-8') : '',
    existsSync(join(workspaceRoot, 'requirements-dev.txt'))
      ? readFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'utf-8')
      : '',
  ].join(' ').toLowerCase();

  const isPytest = allDepsString.includes('pytest') || Boolean(pyproject.tool?.pytest);
  const isRuff = allDepsString.includes('ruff') || Boolean(pyproject.tool?.ruff);
  const isBlack = allDepsString.includes('black') || Boolean(pyproject.tool?.black);
  const isFlake8 = allDepsString.includes('flake8');
  const isMypy = allDepsString.includes('mypy') || Boolean(pyproject.tool?.mypy);
  const isPyright = allDepsString.includes('pyright') || Boolean(pyproject.tool?.pyright);

  if (isPytest) {
    result.frameworks.push({
      name: 'pytest',
      category: 'test',
      sourceFile: hasPyproject ? 'pyproject.toml' : 'requirements.txt',
    });
  } else {
    result.frameworks.push({
      name: 'unittest',
      category: 'test',
      sourceFile: 'built-in',
    });
  }

  if (isRuff) {
    result.frameworks.push({
      name: 'ruff',
      category: 'lint',
      sourceFile: hasPyproject ? 'pyproject.toml' : 'requirements.txt',
    });
  }
  if (isBlack) {
    result.frameworks.push({
      name: 'black',
      category: 'lint',
      sourceFile: hasPyproject ? 'pyproject.toml' : 'requirements.txt',
    });
  }
  if (isFlake8) {
    result.frameworks.push({
      name: 'flake8',
      category: 'lint',
      sourceFile: 'requirements.txt',
    });
  }
  if (isMypy) {
    result.frameworks.push({
      name: 'mypy',
      category: 'typecheck',
      sourceFile: hasPyproject ? 'pyproject.toml' : 'requirements.txt',
    });
  }
  if (isPyright) {
    result.frameworks.push({
      name: 'pyright',
      category: 'typecheck',
      sourceFile: hasPyproject ? 'pyproject.toml' : 'requirements.txt',
    });
  }

  // Web frameworks
  if (allDepsString.includes('fastapi')) {
    result.frameworks.push({ name: 'fastapi', category: 'web' });
  } else if (allDepsString.includes('django')) {
    result.frameworks.push({ name: 'django', category: 'web' });
  } else if (allDepsString.includes('flask')) {
    result.frameworks.push({ name: 'flask', category: 'web' });
  }

  // 4. Commands
  const runPrefix =
    pmName === 'uv'
      ? 'uv run'
      : pmName === 'poetry'
      ? 'poetry run'
      : pmName === 'pdm'
      ? 'pdm run'
      : pmName === 'pipenv'
      ? 'pipenv run'
      : '';

  // Install
  if (pmName === 'uv') {
    result.commands.install = hasUvLock ? 'uv sync' : (hasReqs ? 'uv pip install -r requirements.txt' : 'uv sync');
  } else if (pmName === 'poetry') {
    result.commands.install = 'poetry install';
  } else if (pmName === 'pdm') {
    result.commands.install = 'pdm install';
  } else if (pmName === 'pipenv') {
    result.commands.install = 'pipenv install';
  } else if (hasReqs) {
    result.commands.install = 'pip install -r requirements.txt';
  } else if (hasSetupPy) {
    result.commands.install = 'pip install -e .';
  }

  // Test
  const testRunner = isPytest ? 'pytest' : 'python -m unittest';
  result.commands.test = runPrefix ? `${runPrefix} ${testRunner}` : testRunner;

  // Build
  if (pmName === 'uv') {
    result.commands.build = 'uv build';
  } else if (pmName === 'poetry') {
    result.commands.build = 'poetry build';
  } else if (pmName === 'pdm') {
    result.commands.build = 'pdm build';
  } else if (hasSetupPy) {
    result.commands.build = 'python -m build';
  }

  // Lint
  if (isRuff) {
    result.commands.lint = runPrefix ? `${runPrefix} ruff check .` : 'ruff check .';
  } else if (isFlake8) {
    result.commands.lint = runPrefix ? `${runPrefix} flake8` : 'flake8';
  } else if (isBlack) {
    result.commands.lint = runPrefix ? `${runPrefix} black --check .` : 'black --check .';
  }

  // Typecheck
  if (isMypy) {
    result.commands.typecheck = runPrefix ? `${runPrefix} mypy .` : 'mypy .';
  } else if (isPyright) {
    result.commands.typecheck = runPrefix ? `${runPrefix} pyright` : 'pyright';
  }

  return result;
}
