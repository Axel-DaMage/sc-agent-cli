import path from 'node:path';
import type {
  RepoProfile,
  ProbeOptions,
  ToolchainInfo,
  PackageManagerInfo,
  FrameworkInfo,
  RepoCommands,
} from './types.js';
import { detectNode } from './detectors/node.js';
import { detectRust } from './detectors/rust.js';
import { detectPython } from './detectors/python.js';
import { detectGo } from './detectors/go.js';
import { detectJvm } from './detectors/jvm.js';
import { detectDevcontainer } from './detectors/devcontainer.js';
import { detectMakefile } from './detectors/makefile.js';
import { detectOtherEcosystems } from './detectors/other.js';
import { mineCiWorkflows } from './detectors/ci-mining.js';
import { detectUnknownEcosystem } from './detectors/fallback.js';
import { getCachedProfile, saveCachedProfile } from './cache.js';

export const REPO_PROBE_VERSION = '1.0.0';

/**
 * Probe a repository workspace to auto-detect its toolchains, package managers,
 * frameworks, build/test/lint commands, CI workflows, and container configurations.
 */
export async function probeRepo(
  workspaceRootInput?: string,
  options: ProbeOptions = {}
): Promise<RepoProfile> {
  const root = path.resolve(workspaceRootInput || process.cwd());

  const useCache = options.useCache !== false && !options.forceRefresh;

  // 1. Check Cache
  if (useCache) {
    const cached = getCachedProfile(root, undefined, options.cacheDir);
    if (cached) {
      return cached;
    }
  }

  const ecosystemsSet = new Set<string>();
  const toolchainsList: ToolchainInfo[] = [];
  const packageManagersList: PackageManagerInfo[] = [];
  const frameworksList: FrameworkInfo[] = [];
  const commands: RepoCommands = {};
  const manifestsSet = new Set<string>();
  const notes: string[] = [];

  // 2. Run All Manifest Detectors
  const nodeRes = detectNode(root);
  if (nodeRes.detected) {
    nodeRes.ecosystems.forEach((e) => ecosystemsSet.add(e));
    toolchainsList.push(...nodeRes.toolchains);
    packageManagersList.push(...nodeRes.packageManagers);
    frameworksList.push(...nodeRes.frameworks);
    Object.assign(commands, nodeRes.commands);
    nodeRes.manifests.forEach((m) => manifestsSet.add(m));
  }

  const rustRes = detectRust(root);
  if (rustRes.detected) {
    rustRes.ecosystems.forEach((e) => ecosystemsSet.add(e));
    toolchainsList.push(...rustRes.toolchains);
    packageManagersList.push(...rustRes.packageManagers);
    frameworksList.push(...rustRes.frameworks);
    // Merge commands (if not already set or augmenting)
    if (!commands.build) commands.build = rustRes.commands.build;
    if (!commands.test) commands.test = rustRes.commands.test;
    if (!commands.install) commands.install = rustRes.commands.install;
    if (!commands.lint) commands.lint = rustRes.commands.lint;
    if (!commands.typecheck) commands.typecheck = rustRes.commands.typecheck;
    rustRes.manifests.forEach((m) => manifestsSet.add(m));
  }

  const pyRes = detectPython(root);
  if (pyRes.detected) {
    pyRes.ecosystems.forEach((e) => ecosystemsSet.add(e));
    toolchainsList.push(...pyRes.toolchains);
    packageManagersList.push(...pyRes.packageManagers);
    frameworksList.push(...pyRes.frameworks);
    if (!commands.build) commands.build = pyRes.commands.build;
    if (!commands.test) commands.test = pyRes.commands.test;
    if (!commands.install) commands.install = pyRes.commands.install;
    if (!commands.lint) commands.lint = pyRes.commands.lint;
    if (!commands.typecheck) commands.typecheck = pyRes.commands.typecheck;
    pyRes.manifests.forEach((m) => manifestsSet.add(m));
  }

  const goRes = detectGo(root);
  if (goRes.detected) {
    goRes.ecosystems.forEach((e) => ecosystemsSet.add(e));
    toolchainsList.push(...goRes.toolchains);
    packageManagersList.push(...goRes.packageManagers);
    frameworksList.push(...goRes.frameworks);
    if (!commands.build) commands.build = goRes.commands.build;
    if (!commands.test) commands.test = goRes.commands.test;
    if (!commands.install) commands.install = goRes.commands.install;
    if (!commands.lint) commands.lint = goRes.commands.lint;
    if (!commands.typecheck) commands.typecheck = goRes.commands.typecheck;
    goRes.manifests.forEach((m) => manifestsSet.add(m));
  }

  const jvmRes = detectJvm(root);
  if (jvmRes.detected) {
    jvmRes.ecosystems.forEach((e) => ecosystemsSet.add(e));
    toolchainsList.push(...jvmRes.toolchains);
    packageManagersList.push(...jvmRes.packageManagers);
    frameworksList.push(...jvmRes.frameworks);
    if (!commands.build) commands.build = jvmRes.commands.build;
    if (!commands.test) commands.test = jvmRes.commands.test;
    if (!commands.install) commands.install = jvmRes.commands.install;
    if (!commands.verify) commands.verify = jvmRes.commands.verify;
    if (!commands.lint) commands.lint = jvmRes.commands.lint;
    jvmRes.manifests.forEach((m) => manifestsSet.add(m));
  }

  const otherRes = detectOtherEcosystems(root);
  if (otherRes.detected) {
    otherRes.ecosystems.forEach((e) => ecosystemsSet.add(e));
    toolchainsList.push(...otherRes.toolchains);
    packageManagersList.push(...otherRes.packageManagers);
    frameworksList.push(...otherRes.frameworks);
    if (!commands.build) commands.build = otherRes.commands.build;
    if (!commands.test) commands.test = otherRes.commands.test;
    if (!commands.install) commands.install = otherRes.commands.install;
    if (!commands.lint) commands.lint = otherRes.commands.lint;
    otherRes.manifests.forEach((m) => manifestsSet.add(m));
  }

  const makeRes = detectMakefile(root);
  if (makeRes.detected) {
    makeRes.manifests.forEach((m) => manifestsSet.add(m));
    if (!commands.build && makeRes.commands.build) commands.build = makeRes.commands.build;
    if (!commands.test && makeRes.commands.test) commands.test = makeRes.commands.test;
    if (!commands.lint && makeRes.commands.lint) commands.lint = makeRes.commands.lint;
    if (!commands.verify && makeRes.commands.verify) commands.verify = makeRes.commands.verify;
    if (!commands.install && makeRes.commands.install) commands.install = makeRes.commands.install;
    if (!commands.clean && makeRes.commands.clean) commands.clean = makeRes.commands.clean;
  }

  const devcontainerRes = detectDevcontainer(root);
  if (devcontainerRes.detected) {
    devcontainerRes.manifests.forEach((m) => manifestsSet.add(m));
    if (!commands.install && devcontainerRes.devcontainer?.postCreateCommand) {
      commands.install = devcontainerRes.devcontainer.postCreateCommand;
    }
  }

  // 3. Mine CI Workflows (Source of truth for verification)
  const ciRes = mineCiWorkflows(root);
  if (ciRes.detected) {
    ciRes.manifests.forEach((m) => manifestsSet.add(m));
    // Enrich toolchains from CI if missing
    for (const ciTc of ciRes.discoveredToolchains) {
      const existing = toolchainsList.find((tc) => tc.name === ciTc.name);
      if (existing) {
        if (!existing.version && ciTc.version) {
          existing.version = ciTc.version;
          existing.sourceFile = ciTc.sourceFile;
        }
      } else {
        toolchainsList.push(ciTc);
      }
    }

    // If verify commands were mined and commands.verify is not set, correlate with CI
    if (ciRes.ci.minedVerifyCommands.length > 0) {
      if (!commands.verify) {
        commands.verify = ciRes.ci.minedVerifyCommands.join(' && ');
      }
    }
  }

  // 4. Check for Unknown Ecosystem / Graceful Degradation
  let confidence: 'high' | 'medium' | 'low' = 'high';
  let rawFindings = undefined;

  if (ecosystemsSet.size === 0) {
    const fallback = detectUnknownEcosystem(root);
    fallback.ecosystems.forEach((e) => ecosystemsSet.add(e));
    confidence = fallback.confidence;
    rawFindings = fallback.findings;
    notes.push(...fallback.notes);

    if (!commands.test && fallback.commands.test) commands.test = fallback.commands.test;
    if (!commands.build && fallback.commands.build) commands.build = fallback.commands.build;
    if (!commands.install && fallback.commands.install) commands.install = fallback.commands.install;
  } else {
    // If we have ecosystems but no build/test command, medium confidence
    if (!commands.test && !commands.build && !commands.install) {
      confidence = 'medium';
    }
  }

  // 5. Build Unified Profile
  const profile: RepoProfile = {
    version: REPO_PROBE_VERSION,
    timestamp: Date.now(),
    root,
    ecosystems: Array.from(ecosystemsSet),
    confidence,
    toolchains: deduplicateToolchains(toolchainsList),
    packageManagers: deduplicatePackageManagers(packageManagersList),
    frameworks: deduplicateFrameworks(frameworksList),
    commands,
    ci: ciRes.ci,
    devcontainer: devcontainerRes.devcontainer,
    manifests: Array.from(manifestsSet),
    rawFindings,
    notes: notes.length > 0 ? notes : undefined,
  };

  // 6. Save to Cache
  if (options.saveCache !== false) {
    saveCachedProfile(profile, options.cacheDir);
  }

  return profile;
}

function deduplicateToolchains(list: ToolchainInfo[]): ToolchainInfo[] {
  const map = new Map<string, ToolchainInfo>();
  for (const item of list) {
    if (!map.has(item.name) || (!map.get(item.name)!.version && item.version)) {
      map.set(item.name, item);
    }
  }
  return Array.from(map.values());
}

function deduplicatePackageManagers(list: PackageManagerInfo[]): PackageManagerInfo[] {
  const map = new Map<string, PackageManagerInfo>();
  for (const item of list) {
    if (!map.has(item.name) || (!map.get(item.name)!.lockfile && item.lockfile)) {
      map.set(item.name, item);
    }
  }
  return Array.from(map.values());
}

function deduplicateFrameworks(list: FrameworkInfo[]): FrameworkInfo[] {
  const map = new Map<string, FrameworkInfo>();
  for (const item of list) {
    const key = `${item.name}:${item.category}`;
    if (!map.has(key) || (!map.get(key)!.version && item.version)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}
