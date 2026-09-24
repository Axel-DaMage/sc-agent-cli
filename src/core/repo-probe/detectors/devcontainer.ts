import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevcontainerInfo } from '../types.js';
import { parseJsonSafe } from '../parser-utils.js';

export interface DevcontainerDetectionResult {
  detected: boolean;
  devcontainer?: DevcontainerInfo;
  manifests: string[];
}

export function detectDevcontainer(workspaceRoot: string): DevcontainerDetectionResult {
  const result: DevcontainerDetectionResult = {
    detected: false,
    manifests: [],
  };

  const possiblePaths = [
    join(workspaceRoot, '.devcontainer', 'devcontainer.json'),
    join(workspaceRoot, '.devcontainer.json'),
  ];

  let configPath: string | null = null;
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      configPath = p;
      break;
    }
  }

  if (!configPath) {
    return result;
  }

  const relConfigPath = configPath.includes('.devcontainer' + (process.platform === 'win32' ? '\\' : '/') + 'devcontainer.json')
    ? '.devcontainer/devcontainer.json'
    : '.devcontainer.json';

  result.detected = true;
  result.manifests.push(relConfigPath);

  let rawJson: any = null;
  try {
    const content = readFileSync(configPath, 'utf-8');
    rawJson = parseJsonSafe(content);
  } catch {
    // ignore
  }

  if (rawJson) {
    result.devcontainer = {
      configFile: relConfigPath,
      image: rawJson.image,
      dockerfile: rawJson.dockerFile || rawJson.build?.dockerfile,
      features: rawJson.features,
      postCreateCommand: typeof rawJson.postCreateCommand === 'string'
        ? rawJson.postCreateCommand
        : typeof rawJson.postCreateCommand === 'object'
        ? JSON.stringify(rawJson.postCreateCommand)
        : undefined,
      updateContentCommand: typeof rawJson.updateContentCommand === 'string'
        ? rawJson.updateContentCommand
        : undefined,
      postStartCommand: typeof rawJson.postStartCommand === 'string'
        ? rawJson.postStartCommand
        : undefined,
      customizations: rawJson.customizations,
    };
  }

  return result;
}
