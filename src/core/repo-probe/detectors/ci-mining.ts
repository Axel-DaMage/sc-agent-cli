import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CIInfo, CIWorkflow, CIStep, ToolchainInfo } from '../types.js';
import { parseCiWorkflowYaml } from '../parser-utils.js';

export interface CIMiningResult {
  detected: boolean;
  ci: CIInfo;
  discoveredToolchains: ToolchainInfo[];
  manifests: string[];
}

export function mineCiWorkflows(workspaceRoot: string): CIMiningResult {
  const result: CIMiningResult = {
    detected: false,
    ci: {
      providers: [],
      workflows: [],
      minedVerifyCommands: [],
    },
    discoveredToolchains: [],
    manifests: [],
  };

  const verifyCommandSet = new Set<string>();

  // 1. GitHub Actions Workflows (.github/workflows/*.yml, *.yaml)
  const ghWorkflowsDir = join(workspaceRoot, '.github', 'workflows');
  if (existsSync(ghWorkflowsDir)) {
    try {
      const files = readdirSync(ghWorkflowsDir);
      const ymlFiles = files.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

      if (ymlFiles.length > 0 && !result.ci.providers.includes('github-actions')) {
        result.ci.providers.push('github-actions');
        result.detected = true;
      }

      for (const fileName of ymlFiles) {
        const filePath = join(ghWorkflowsDir, fileName);
        const relPath = `.github/workflows/${fileName}`;
        result.manifests.push(relPath);

        try {
          const rawContent = readFileSync(filePath, 'utf-8');
          const parsed = parseCiWorkflowYaml(rawContent);

          const workflowSteps: CIStep[] = [];
          const workflowVerifyCommands: string[] = [];

          for (const s of parsed.steps) {
            const stepItem: CIStep = {
              name: s.name,
              uses: s.uses,
              run: s.run,
              with: s.with,
            };
            workflowSteps.push(stepItem);

            // Mine Toolchain versions from setup actions
            if (s.uses) {
              if (s.uses.includes('actions/setup-node') && s.with?.['node-version']) {
                result.discoveredToolchains.push({
                  name: 'node',
                  version: String(s.with['node-version']),
                  sourceFile: relPath,
                });
              } else if (s.uses.includes('actions/setup-python') && s.with?.['python-version']) {
                result.discoveredToolchains.push({
                  name: 'python',
                  version: String(s.with['python-version']),
                  sourceFile: relPath,
                });
              } else if (s.uses.includes('actions/setup-go') && s.with?.['go-version']) {
                result.discoveredToolchains.push({
                  name: 'go',
                  version: String(s.with['go-version']),
                  sourceFile: relPath,
                });
              } else if (s.uses.includes('actions/setup-java') && s.with?.['java-version']) {
                result.discoveredToolchains.push({
                  name: 'java',
                  version: String(s.with['java-version']),
                  sourceFile: relPath,
                });
              } else if (s.uses.includes('dtolnay/rust-toolchain') && s.with?.['toolchain']) {
                result.discoveredToolchains.push({
                  name: 'rust',
                  version: String(s.with['toolchain']),
                  sourceFile: relPath,
                });
              }
            }

            // Mine Verify Commands from run statements
            if (s.run) {
              const runCmds = splitCompoundCommands(s.run);
              for (const cmd of runCmds) {
                if (isVerifyCommand(cmd, s.name)) {
                  workflowVerifyCommands.push(cmd);
                  verifyCommandSet.add(cmd);
                }
              }
            }
          }

          const workflow: CIWorkflow = {
            file: relPath,
            provider: 'github-actions',
            name: parsed.name || fileName,
            jobs: Object.keys(parsed.jobs),
            steps: workflowSteps,
            verifyCommands: Array.from(new Set(workflowVerifyCommands)),
          };

          result.ci.workflows.push(workflow);
        } catch {
          // ignore single workflow parse errors
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. GitLab CI (.gitlab-ci.yml)
  const gitlabPath = join(workspaceRoot, '.gitlab-ci.yml');
  if (existsSync(gitlabPath)) {
    result.detected = true;
    result.manifests.push('.gitlab-ci.yml');
    if (!result.ci.providers.includes('gitlab-ci')) {
      result.ci.providers.push('gitlab-ci');
    }

    try {
      const rawContent = readFileSync(gitlabPath, 'utf-8');
      const lines = rawContent.split(/\r?\n/);
      const gitlabVerifyCmds: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        const scriptMatch = trimmed.match(/^-\s+(.+)$/);
        if (scriptMatch) {
          const cmd = scriptMatch[1];
          if (isVerifyCommand(cmd)) {
            gitlabVerifyCmds.push(cmd);
            verifyCommandSet.add(cmd);
          }
        }
      }

      result.ci.workflows.push({
        file: '.gitlab-ci.yml',
        provider: 'gitlab-ci',
        name: 'GitLab CI',
        steps: gitlabVerifyCmds.map((c) => ({ run: c })),
        verifyCommands: Array.from(new Set(gitlabVerifyCmds)),
      });
    } catch {
      // ignore
    }
  }

  // 3. CircleCI (.circleci/config.yml)
  const circleciPath = join(workspaceRoot, '.circleci', 'config.yml');
  if (existsSync(circleciPath)) {
    result.detected = true;
    result.manifests.push('.circleci/config.yml');
    if (!result.ci.providers.includes('circleci')) {
      result.ci.providers.push('circleci');
    }

    try {
      const rawContent = readFileSync(circleciPath, 'utf-8');
      const parsed = parseCiWorkflowYaml(rawContent);
      const circleVerifyCmds: string[] = [];

      for (const s of parsed.steps) {
        if (s.run) {
          const runCmds = splitCompoundCommands(s.run);
          for (const cmd of runCmds) {
            if (isVerifyCommand(cmd, s.name)) {
              circleVerifyCmds.push(cmd);
              verifyCommandSet.add(cmd);
            }
          }
        }
      }

      result.ci.workflows.push({
        file: '.circleci/config.yml',
        provider: 'circleci',
        name: parsed.name || 'CircleCI',
        steps: parsed.steps,
        verifyCommands: Array.from(new Set(circleVerifyCmds)),
      });
    } catch {
      // ignore
    }
  }

  // 4. Azure Pipelines (azure-pipelines.yml or .azure-pipelines.yml)
  const azurePaths = ['azure-pipelines.yml', '.azure-pipelines.yml'];
  for (const azName of azurePaths) {
    const azPath = join(workspaceRoot, azName);
    if (existsSync(azPath)) {
      result.detected = true;
      result.manifests.push(azName);
      if (!result.ci.providers.includes('azure-pipelines')) {
        result.ci.providers.push('azure-pipelines');
      }

      try {
        const rawContent = readFileSync(azPath, 'utf-8');
        const parsed = parseCiWorkflowYaml(rawContent);
        const azVerifyCmds: string[] = [];

        for (const s of parsed.steps) {
          if (s.run) {
            const runCmds = splitCompoundCommands(s.run);
            for (const cmd of runCmds) {
              if (isVerifyCommand(cmd, s.name)) {
                azVerifyCmds.push(cmd);
                verifyCommandSet.add(cmd);
              }
            }
          }
        }

        result.ci.workflows.push({
          file: azName,
          provider: 'azure-pipelines',
          name: parsed.name || 'Azure Pipelines',
          steps: parsed.steps,
          verifyCommands: Array.from(new Set(azVerifyCmds)),
        });
      } catch {
        // ignore
      }
    }
  }

  result.ci.minedVerifyCommands = Array.from(verifyCommandSet);
  return result;
}

/**
 * Split compound commands (e.g. "npm ci && npm test" or multi-lines) into individual commands.
 */
function splitCompoundCommands(runString: string): string[] {
  if (!runString) return [];
  return runString
    .split(/\s*&&\s*|\s*;\s*|\r?\n/)
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith('#') && !c.startsWith('echo '));
}

/**
 * Identify if a command is a verification, build, test, lint, or typecheck command.
 */
function isVerifyCommand(cmd: string, stepName?: string): boolean {
  if (!cmd) return false;
  const lower = cmd.toLowerCase();
  const lowerName = (stepName || '').toLowerCase();

  // Exclude purely setup/checkout commands
  if (
    lower.startsWith('git ') ||
    lower.startsWith('export ') ||
    lower.startsWith('set ') ||
    lower.startsWith('mkdir ') ||
    lower.startsWith('cd ') ||
    lower.startsWith('curl ') ||
    lower.startsWith('wget ') ||
    lower === 'true' ||
    lower === 'false'
  ) {
    return false;
  }

  const verifyPatterns = [
    /\b(npm|pnpm|yarn|bun)\s+(test|run\s+test|run\s+build|run\s+lint|run\s+check|run\s+typecheck|run\s+type-check|ci|install)\b/,
    /\b(cargo)\s+(test|check|clippy|build|nextest)\b/,
    /\b(pytest|python\s+-m\s+unittest|python\s+setup\.py\s+test|poetry\s+run\s+pytest|uv\s+run\s+pytest)\b/,
    /\b(ruff\s+check|flake8|black\s+--check|mypy|pyright)\b/,
    /\b(go\s+test|go\s+build|go\s+vet|golangci-lint)\b/,
    /\b(mvn|\.\/mvnw)\s+(test|verify|compile|package|clean\s+verify)\b/,
    /\b(gradle|\.\/gradlew)\s+(test|check|build)\b/,
    /\b(bundle\s+exec\s+rspec|bundle\s+exec\s+rubocop|bundle\s+exec\s+rake\s+test)\b/,
    /\b(vendor\/bin\/phpunit|composer\s+test|composer\s+lint)\b/,
    /\b(dotnet\s+test|dotnet\s+build)\b/,
    /\b(make\s+(test|tests|check|lint|verify|ci|build|all))\b/,
    /\b(npx\s+(vitest|jest|eslint|tsc|biome))\b/,
    /\b(ctest)\b/,
    /\b(deno\s+(test|lint|check))\b/,
    /\b(mix\s+(test|compile))\b/,
  ];

  for (const pattern of verifyPatterns) {
    if (pattern.test(lower)) return true;
  }

  // Check if step name indicated testing/verification and command is an executable script
  if (
    (lowerName.includes('test') || lowerName.includes('lint') || lowerName.includes('verify') || lowerName.includes('build')) &&
    (lower.startsWith('./') || lower.startsWith('bash ') || lower.startsWith('sh '))
  ) {
    return true;
  }

  return false;
}
