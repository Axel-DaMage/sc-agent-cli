import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ToolchainInfo,
  PackageManagerInfo,
  FrameworkInfo,
  RepoCommands,
} from '../types.js';
import { parseJsonSafe } from '../parser-utils.js';

export interface OtherDetectionResult {
  detected: boolean;
  ecosystems: string[];
  toolchains: ToolchainInfo[];
  packageManagers: PackageManagerInfo[];
  frameworks: FrameworkInfo[];
  commands: RepoCommands;
  manifests: string[];
}

export function detectOtherEcosystems(workspaceRoot: string): OtherDetectionResult {
  const result: OtherDetectionResult = {
    detected: false,
    ecosystems: [],
    toolchains: [],
    packageManagers: [],
    frameworks: [],
    commands: {},
    manifests: [],
  };

  // 1. Ruby
  const gemfilePath = join(workspaceRoot, 'Gemfile');
  if (existsSync(gemfilePath)) {
    result.detected = true;
    result.ecosystems.push('ruby');
    result.manifests.push('Gemfile');

    let rubyVersion: string | undefined;
    const rubyVerPath = join(workspaceRoot, '.ruby-version');
    if (existsSync(rubyVerPath)) {
      result.manifests.push('.ruby-version');
      try {
        rubyVersion = readFileSync(rubyVerPath, 'utf-8').trim();
      } catch {
        // ignore
      }
    }

    result.toolchains.push({
      name: 'ruby',
      version: rubyVersion,
      sourceFile: rubyVersion ? '.ruby-version' : 'Gemfile',
    });

    result.packageManagers.push({
      name: 'bundler',
      lockfile: existsSync(join(workspaceRoot, 'Gemfile.lock')) ? 'Gemfile.lock' : undefined,
      sourceFile: 'Gemfile',
    });
    if (existsSync(join(workspaceRoot, 'Gemfile.lock'))) {
      result.manifests.push('Gemfile.lock');
    }

    let gemfileContent = '';
    try {
      gemfileContent = readFileSync(gemfilePath, 'utf-8');
    } catch {
      // ignore
    }

    if (gemfileContent.includes('rspec')) {
      result.frameworks.push({ name: 'rspec', category: 'test', sourceFile: 'Gemfile' });
      result.commands.test = 'bundle exec rspec';
    } else {
      result.commands.test = 'bundle exec rake test';
    }

    if (gemfileContent.includes('rubocop')) {
      result.frameworks.push({ name: 'rubocop', category: 'lint', sourceFile: 'Gemfile' });
      result.commands.lint = 'bundle exec rubocop';
    }

    result.commands.install = 'bundle install';
  }

  // 2. PHP (Composer)
  const composerPath = join(workspaceRoot, 'composer.json');
  if (existsSync(composerPath)) {
    result.detected = true;
    result.ecosystems.push('php');
    result.manifests.push('composer.json');

    let composerJson: any = {};
    try {
      composerJson = parseJsonSafe(readFileSync(composerPath, 'utf-8')) || {};
    } catch {
      // ignore
    }

    const phpReq = composerJson.require?.php;
    result.toolchains.push({
      name: 'php',
      version: typeof phpReq === 'string' ? phpReq.replace(/[\^~>=<]/g, '').trim() : undefined,
      rawSpec: typeof phpReq === 'string' ? phpReq : undefined,
      sourceFile: 'composer.json',
    });

    const hasComposerLock = existsSync(join(workspaceRoot, 'composer.lock'));
    if (hasComposerLock) result.manifests.push('composer.lock');

    result.packageManagers.push({
      name: 'composer',
      lockfile: hasComposerLock ? 'composer.lock' : undefined,
      sourceFile: 'composer.json',
    });

    result.commands.install = hasComposerLock ? 'composer install' : 'composer update';
    if (composerJson.scripts?.test) {
      result.commands.test = 'composer test';
    } else {
      result.commands.test = 'vendor/bin/phpunit';
    }

    if (composerJson.scripts?.lint) {
      result.commands.lint = 'composer lint';
    }
  }

  // 3. Deno
  const denoJsonPath = join(workspaceRoot, 'deno.json');
  const denoJsoncPath = join(workspaceRoot, 'deno.jsonc');
  if (existsSync(denoJsonPath) || existsSync(denoJsoncPath)) {
    result.detected = true;
    result.ecosystems.push('deno');
    const denoFile = existsSync(denoJsonPath) ? 'deno.json' : 'deno.jsonc';
    result.manifests.push(denoFile);

    result.toolchains.push({
      name: 'deno',
      sourceFile: denoFile,
    });

    result.packageManagers.push({
      name: 'deno',
      sourceFile: denoFile,
    });

    result.commands.test = 'deno test';
    result.commands.lint = 'deno lint';
    result.commands.typecheck = 'deno check';
  }

  // 4. Elixir
  const mixPath = join(workspaceRoot, 'mix.exs');
  if (existsSync(mixPath)) {
    result.detected = true;
    result.ecosystems.push('elixir');
    result.manifests.push('mix.exs');

    result.toolchains.push({
      name: 'elixir',
      sourceFile: 'mix.exs',
    });

    result.packageManagers.push({
      name: 'mix',
      lockfile: existsSync(join(workspaceRoot, 'mix.lock')) ? 'mix.lock' : undefined,
      sourceFile: 'mix.exs',
    });
    if (existsSync(join(workspaceRoot, 'mix.lock'))) result.manifests.push('mix.lock');

    result.commands.install = 'mix deps.get';
    result.commands.build = 'mix compile';
    result.commands.test = 'mix test';
  }

  // 5. .NET / C#
  try {
    const entries = readdirSync(workspaceRoot);
    const slnOrCsproj = entries.filter((f) => f.endsWith('.sln') || f.endsWith('.csproj'));
    if (slnOrCsproj.length > 0) {
      result.detected = true;
      result.ecosystems.push('dotnet');
      for (const f of slnOrCsproj) {
        result.manifests.push(f);
      }

      result.toolchains.push({
        name: 'dotnet',
        sourceFile: slnOrCsproj[0],
      });

      result.packageManagers.push({
        name: 'nuget',
        sourceFile: slnOrCsproj[0],
      });

      result.commands.install = 'dotnet restore';
      result.commands.build = 'dotnet build';
      result.commands.test = 'dotnet test';
    }
  } catch {
    // ignore
  }

  // 6. CMake / C/C++
  const cmakePath = join(workspaceRoot, 'CMakeLists.txt');
  if (existsSync(cmakePath)) {
    result.detected = true;
    result.ecosystems.push('cmake', 'c/cpp');
    result.manifests.push('CMakeLists.txt');

    result.toolchains.push({
      name: 'cmake',
      sourceFile: 'CMakeLists.txt',
    });

    result.commands.build = 'cmake -B build && cmake --build build';
    result.commands.test = 'ctest --test-dir build';
  }

  return result;
}
