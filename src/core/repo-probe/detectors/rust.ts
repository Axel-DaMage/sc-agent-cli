import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ToolchainInfo,
  PackageManagerInfo,
  FrameworkInfo,
  RepoCommands,
} from '../types.js';
import { parseTomlSafe } from '../parser-utils.js';

export interface RustDetectionResult {
  detected: boolean;
  ecosystems: string[];
  toolchains: ToolchainInfo[];
  packageManagers: PackageManagerInfo[];
  frameworks: FrameworkInfo[];
  commands: RepoCommands;
  manifests: string[];
}

export function detectRust(workspaceRoot: string): RustDetectionResult {
  const result: RustDetectionResult = {
    detected: false,
    ecosystems: [],
    toolchains: [],
    packageManagers: [],
    frameworks: [],
    commands: {},
    manifests: [],
  };

  const cargoTomlPath = join(workspaceRoot, 'Cargo.toml');
  if (!existsSync(cargoTomlPath)) {
    return result;
  }

  result.detected = true;
  result.ecosystems.push('rust');
  result.manifests.push('Cargo.toml');

  let cargo: Record<string, any> = {};
  try {
    const raw = readFileSync(cargoTomlPath, 'utf-8');
    cargo = parseTomlSafe(raw);
  } catch {
    cargo = {};
  }

  const isWorkspace = Boolean(cargo.workspace);

  // 1. Toolchain Detection
  let rustEdition = cargo.package?.edition ? String(cargo.package.edition) : undefined;
  let rustVersion = cargo.package?.['rust-version'] ? String(cargo.package['rust-version']) : undefined;
  let toolchainSource = 'Cargo.toml';

  const toolchainTomlPath = join(workspaceRoot, 'rust-toolchain.toml');
  const toolchainTxtPath = join(workspaceRoot, 'rust-toolchain');

  if (existsSync(toolchainTomlPath)) {
    result.manifests.push('rust-toolchain.toml');
    try {
      const tc = parseTomlSafe(readFileSync(toolchainTomlPath, 'utf-8'));
      if (tc.toolchain?.channel) {
        rustVersion = tc.toolchain.channel;
        toolchainSource = 'rust-toolchain.toml';
      }
    } catch {
      // ignore
    }
  } else if (existsSync(toolchainTxtPath)) {
    result.manifests.push('rust-toolchain');
    try {
      const line = readFileSync(toolchainTxtPath, 'utf-8').trim();
      if (line) {
        rustVersion = line;
        toolchainSource = 'rust-toolchain';
      }
    } catch {
      // ignore
    }
  }

  result.toolchains.push({
    name: 'rust',
    version: rustVersion,
    rawSpec: rustEdition ? `edition ${rustEdition}` : undefined,
    sourceFile: toolchainSource,
  });

  // 2. Package Manager
  const hasCargoLock = existsSync(join(workspaceRoot, 'Cargo.lock'));
  if (hasCargoLock) {
    result.manifests.push('Cargo.lock');
  }

  result.packageManagers.push({
    name: 'cargo',
    lockfile: hasCargoLock ? 'Cargo.lock' : undefined,
    sourceFile: 'Cargo.toml',
  });

  // 3. Frameworks
  const deps = {
    ...(cargo.dependencies || {}),
    ...(cargo['dev-dependencies'] || {}),
    ...(cargo['build-dependencies'] || {}),
    ...(cargo.workspace?.dependencies || {}),
  };

  result.frameworks.push({
    name: 'cargo-test',
    category: 'test',
    sourceFile: 'Cargo.toml',
  });

  if (deps['nextest'] || deps['cargo-nextest']) {
    result.frameworks.push({
      name: 'cargo-nextest',
      category: 'test',
      sourceFile: 'Cargo.toml',
    });
  }

  if (deps['criterion']) {
    result.frameworks.push({
      name: 'criterion',
      category: 'test',
      sourceFile: 'Cargo.toml',
    });
  }

  if (deps['tokio']) {
    result.frameworks.push({
      name: 'tokio',
      category: 'other',
      sourceFile: 'Cargo.toml',
    });
  }

  if (deps['axum'] || deps['actix-web']) {
    result.frameworks.push({
      name: deps['axum'] ? 'axum' : 'actix-web',
      category: 'web',
      sourceFile: 'Cargo.toml',
    });
  }

  // 4. Commands
  result.commands.install = 'cargo fetch';
  result.commands.build = isWorkspace ? 'cargo build --workspace' : 'cargo build';
  result.commands.test = isWorkspace ? 'cargo test --workspace' : 'cargo test';
  result.commands.lint = isWorkspace ? 'cargo clippy --workspace' : 'cargo clippy';
  result.commands.typecheck = isWorkspace ? 'cargo check --workspace' : 'cargo check';

  return result;
}
