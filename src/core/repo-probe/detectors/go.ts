import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ToolchainInfo,
  PackageManagerInfo,
  FrameworkInfo,
  RepoCommands,
} from '../types.js';

export interface GoDetectionResult {
  detected: boolean;
  ecosystems: string[];
  toolchains: ToolchainInfo[];
  packageManagers: PackageManagerInfo[];
  frameworks: FrameworkInfo[];
  commands: RepoCommands;
  manifests: string[];
}

export function detectGo(workspaceRoot: string): GoDetectionResult {
  const result: GoDetectionResult = {
    detected: false,
    ecosystems: [],
    toolchains: [],
    packageManagers: [],
    frameworks: [],
    commands: {},
    manifests: [],
  };

  const goModPath = join(workspaceRoot, 'go.mod');
  if (!existsSync(goModPath)) {
    return result;
  }

  result.detected = true;
  result.ecosystems.push('go');
  result.manifests.push('go.mod');

  let goModContent = '';
  try {
    goModContent = readFileSync(goModPath, 'utf-8');
  } catch {
    // ignore
  }

  // 1. Toolchain
  let goVersion: string | undefined;
  const goVerMatch = goModContent.match(/^go\s+([0-9.]+)/m);
  if (goVerMatch) {
    goVersion = goVerMatch[1];
  }
  const toolchainMatch = goModContent.match(/^toolchain\s+go([0-9.]+)/m);
  if (toolchainMatch) {
    goVersion = toolchainMatch[1];
  }

  result.toolchains.push({
    name: 'go',
    version: goVersion,
    rawSpec: goVerMatch ? `go ${goVerMatch[1]}` : undefined,
    sourceFile: 'go.mod',
  });

  // 2. Package Manager
  const hasGoSum = existsSync(join(workspaceRoot, 'go.sum'));
  const hasGoWork = existsSync(join(workspaceRoot, 'go.work'));
  if (hasGoSum) result.manifests.push('go.sum');
  if (hasGoWork) result.manifests.push('go.work');

  result.packageManagers.push({
    name: 'go',
    lockfile: hasGoSum ? 'go.sum' : undefined,
    sourceFile: 'go.mod',
  });

  // 3. Frameworks
  result.frameworks.push({
    name: 'go-test',
    category: 'test',
    sourceFile: 'go.mod',
  });

  if (goModContent.includes('github.com/stretchr/testify')) {
    result.frameworks.push({
      name: 'testify',
      category: 'test',
      sourceFile: 'go.mod',
    });
  }
  if (goModContent.includes('github.com/onsi/ginkgo')) {
    result.frameworks.push({
      name: 'ginkgo',
      category: 'test',
      sourceFile: 'go.mod',
    });
  }
  if (goModContent.includes('github.com/gin-gonic/gin')) {
    result.frameworks.push({
      name: 'gin',
      category: 'web',
      sourceFile: 'go.mod',
    });
  } else if (goModContent.includes('github.com/labstack/echo')) {
    result.frameworks.push({
      name: 'echo',
      category: 'web',
      sourceFile: 'go.mod',
    });
  }

  // 4. Commands
  result.commands.install = 'go mod download';
  result.commands.test = 'go test ./...';
  result.commands.build = 'go build ./...';
  result.commands.lint = existsSync(join(workspaceRoot, '.golangci.yml')) || existsSync(join(workspaceRoot, '.golangci.yaml'))
    ? 'golangci-lint run'
    : 'go vet ./...';
  result.commands.typecheck = 'go vet ./...';

  return result;
}
