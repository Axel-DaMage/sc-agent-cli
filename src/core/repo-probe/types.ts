export interface ToolchainInfo {
  name: string;
  version?: string;
  rawSpec?: string;
  sourceFile?: string;
}

export interface PackageManagerInfo {
  name: string;
  version?: string;
  lockfile?: string;
  sourceFile?: string;
}

export interface FrameworkInfo {
  name: string;
  category: 'test' | 'build' | 'lint' | 'web' | 'typecheck' | 'other';
  version?: string;
  sourceFile?: string;
}

export interface RepoCommands {
  install?: string;
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
  verify?: string;
  clean?: string;
  start?: string;
  custom?: Record<string, string>;
}

export interface CIStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}

export interface CIWorkflow {
  file: string;
  provider: 'github-actions' | 'gitlab-ci' | 'circleci' | 'azure-pipelines' | 'other';
  name?: string;
  jobs?: string[];
  steps: CIStep[];
  verifyCommands: string[];
}

export interface CIInfo {
  providers: string[];
  workflows: CIWorkflow[];
  minedVerifyCommands: string[];
}

export interface DevcontainerInfo {
  configFile: string;
  image?: string;
  dockerfile?: string;
  features?: Record<string, unknown>;
  postCreateCommand?: string;
  updateContentCommand?: string;
  postStartCommand?: string;
  customizations?: Record<string, unknown>;
}

export interface UnknownEcosystemFindings {
  detectedFiles: string[];
  scriptFiles: string[];
  configFiles: string[];
  readmeSnippets?: string[];
  notes: string[];
}

export interface RepoProfile {
  version: string;
  timestamp: number;
  root: string;
  ecosystems: string[];
  confidence: 'high' | 'medium' | 'low';
  toolchains: ToolchainInfo[];
  packageManagers: PackageManagerInfo[];
  frameworks: FrameworkInfo[];
  commands: RepoCommands;
  ci: CIInfo;
  devcontainer?: DevcontainerInfo;
  manifests: string[];
  rawFindings?: UnknownEcosystemFindings;
  notes?: string[];
}

export interface ProbeOptions {
  workspaceRoot?: string;
  useCache?: boolean;
  forceRefresh?: boolean;
  saveCache?: boolean;
  cacheDir?: string;
}
