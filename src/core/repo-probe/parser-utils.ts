/**
 * Lightweight, zero-dependency parsers for TOML, YAML (CI), JSONC, XML, and Makefiles.
 */

/**
 * Strip comments and trailing commas from JSON/JSONC string and parse safely.
 */
export function parseJsonSafe<T = any>(content: string): T | null {
  if (!content || typeof content !== 'string') return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    try {
      // Strip single-line comments // ...
      let cleaned = content.replace(/\/\/.*$/gm, '');
      // Strip multi-line comments /* ... */
      cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
      // Remove trailing commas before } or ]
      cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(cleaned) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Lightweight TOML parser supporting tables, sub-tables, key-values, arrays, and basic strings/numbers/booleans.
 */
export function parseTomlSafe(content: string): Record<string, any> {
  if (!content || typeof content !== 'string') return {};

  const result: Record<string, any> = {};
  let currentTarget = result;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    // Remove full-line comments or trim inline comments (handling quotes simply)
    if (!line || line.startsWith('#')) continue;

    // Check table headers: [[array_table]] or [table]
    const arrayTableMatch = line.match(/^\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]$/);
    if (arrayTableMatch) {
      const pathParts = arrayTableMatch[1].split('.');
      let obj = result;
      for (let p = 0; p < pathParts.length - 1; p++) {
        const part = pathParts[p];
        if (!obj[part] || typeof obj[part] !== 'object') obj[part] = {};
        obj = obj[part];
      }
      const lastPart = pathParts[pathParts.length - 1];
      if (!Array.isArray(obj[lastPart])) {
        obj[lastPart] = [];
      }
      const newEntry: Record<string, any> = {};
      obj[lastPart].push(newEntry);
      currentTarget = newEntry;
      continue;
    }

    const tableMatch = line.match(/^\[\s*([a-zA-Z0-9_.-]+)\s*\]$/);
    if (tableMatch) {
      const pathParts = tableMatch[1].split('.');
      let obj = result;
      for (const part of pathParts) {
        if (!obj[part] || typeof obj[part] !== 'object' || Array.isArray(obj[part])) {
          obj[part] = {};
        }
        obj = obj[part];
      }
      currentTarget = obj;
      continue;
    }

    // Key-value pair: key = value
    const kvMatch = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let rawVal = kvMatch[2].trim();

      // Handle inline comments outside strings
      if (rawVal.includes('#') && !rawVal.startsWith('"') && !rawVal.startsWith("'")) {
        rawVal = rawVal.split('#')[0].trim();
      }

      // Parse value
      currentTarget[key] = parseTomlValue(rawVal, lines, i, (nextIdx) => {
        i = nextIdx;
      });
    }
  }

  return result;
}

function parseTomlValue(
  rawVal: string,
  lines: string[],
  currentIdx: number,
  advanceIdx: (idx: number) => void
): any {
  // String with quotes
  if (
    (rawVal.startsWith('"') && rawVal.endsWith('"') && rawVal.length >= 2) ||
    (rawVal.startsWith("'") && rawVal.endsWith("'") && rawVal.length >= 2)
  ) {
    return rawVal.slice(1, -1);
  }

  // Boolean
  if (rawVal === 'true') return true;
  if (rawVal === 'false') return false;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
    return Number(rawVal);
  }

  // Array: [ ... ]
  if (rawVal.startsWith('[')) {
    let arrayStr = rawVal;
    let idx = currentIdx;
    while (!arrayStr.includes(']') && idx + 1 < lines.length) {
      idx++;
      arrayStr += ' ' + lines[idx].trim();
    }
    advanceIdx(idx);

    const inner = arrayStr.slice(1, arrayStr.lastIndexOf(']')).trim();
    if (!inner) return [];

    // Split by commas, considering quotes
    const items: any[] = [];
    const parts = inner.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
    for (const part of parts) {
      const p = part.trim();
      if (p) items.push(parseTomlValue(p, lines, idx, () => {}));
    }
    return items;
  }

  // Inline table: { a = "b", c = 1 }
  if (rawVal.startsWith('{') && rawVal.endsWith('}')) {
    const inner = rawVal.slice(1, -1).trim();
    const subObj: Record<string, any> = {};
    if (!inner) return subObj;
    const pairs = inner.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
    for (const pair of pairs) {
      const [k, ...vParts] = pair.split('=');
      if (k && vParts.length > 0) {
        subObj[k.trim()] = parseTomlValue(vParts.join('=').trim(), lines, currentIdx, () => {});
      }
    }
    return subObj;
  }

  // Strip trailing quote if malformed
  return rawVal.replace(/^["']|["']$/g, '');
}

/**
 * CI Step structure mined from workflow files.
 */
export interface RawWorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  run?: string;
}

export interface RawWorkflowJob {
  name?: string;
  runsOn?: string;
  steps: RawWorkflowStep[];
}

export interface RawWorkflow {
  name?: string;
  jobs: Record<string, RawWorkflowJob>;
  steps: RawWorkflowStep[];
  allRuns: string[];
}

/**
 * Lightweight YAML parser for CI workflows (GitHub Actions, GitLab, CircleCI, Azure Pipelines).
 */
export function parseCiWorkflowYaml(content: string): RawWorkflow {
  const result: RawWorkflow = {
    jobs: {},
    steps: [],
    allRuns: [],
  };

  if (!content || typeof content !== 'string') return result;

  const lines = content.split(/\r?\n/);
  let currentJobName: string | null = null;
  let currentStep: RawWorkflowStep | null = null;
  let inSteps = false;
  let inWith = false;
  let inRunBlock = false;
  let runBlockLines: string[] = [];
  let runBlockIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Check multi-line run block collection
    if (inRunBlock) {
      const indent = rawLine.search(/\S/);
      if (indent > runBlockIndent || (!trimmed && inRunBlock)) {
        runBlockLines.push(trimmed);
        continue;
      } else {
        // End of multi-line run block
        if (currentStep) {
          currentStep.run = runBlockLines.filter(Boolean).join(' && ');
          if (currentStep.run) {
            result.allRuns.push(currentStep.run);
          }
        }
        inRunBlock = false;
        runBlockLines = [];
      }
    }

    if (!trimmed || trimmed.startsWith('#')) continue;

    // Workflow top-level name
    const topNameMatch = rawLine.match(/^name:\s*(['"]?)(.+?)\1\s*$/);
    if (topNameMatch && !currentJobName) {
      result.name = topNameMatch[2].trim();
      continue;
    }

    // Jobs section start
    if (/^jobs:\s*$/.test(trimmed)) {
      continue;
    }

    // Job header: e.g. "  build:" or "  test:"
    const jobHeaderMatch = rawLine.match(/^ {2,4}([a-zA-Z0-9_-]+):\s*$/);
    if (jobHeaderMatch && !inSteps) {
      currentJobName = jobHeaderMatch[1];
      result.jobs[currentJobName] = {
        name: currentJobName,
        steps: [],
      };
      continue;
    }

    // Steps list start
    if (/^\s*steps:\s*$/.test(trimmed)) {
      inSteps = true;
      inWith = false;
      continue;
    }

    // Step item start: "- name:" or "- uses:" or "- run:"
    const stepStartMatch = rawLine.match(/^\s*-\s+(name|uses|run):\s*(.*)$/);
    if (stepStartMatch) {
      inWith = false;
      const key = stepStartMatch[1];
      let val = stepStartMatch[2].trim().replace(/^['"]|['"]$/g, '');

      currentStep = {};
      if (currentJobName && result.jobs[currentJobName]) {
        result.jobs[currentJobName].steps.push(currentStep);
      }
      result.steps.push(currentStep);

      if (key === 'name') {
        currentStep.name = val;
      } else if (key === 'uses') {
        currentStep.uses = val;
      } else if (key === 'run') {
        if (val === '|' || val === '>-' || val === '>') {
          inRunBlock = true;
          runBlockLines = [];
          runBlockIndent = rawLine.search(/\S/);
        } else {
          currentStep.run = val;
          result.allRuns.push(val);
        }
      }
      continue;
    }

    // Sub-properties of a step
    if (currentStep) {
      const stepPropMatch = rawLine.match(/^\s+(name|uses|run|with):\s*(.*)$/);
      if (stepPropMatch) {
        const prop = stepPropMatch[1];
        let val = stepPropMatch[2].trim().replace(/^['"]|['"]$/g, '');

        if (prop === 'name') {
          currentStep.name = val;
          inWith = false;
        } else if (prop === 'uses') {
          currentStep.uses = val;
          inWith = false;
        } else if (prop === 'run') {
          inWith = false;
          if (val === '|' || val === '>-' || val === '>') {
            inRunBlock = true;
            runBlockLines = [];
            runBlockIndent = rawLine.search(/\S/);
          } else {
            currentStep.run = val;
            result.allRuns.push(val);
          }
        } else if (prop === 'with') {
          inWith = true;
          currentStep.with = {};
        }
        continue;
      }

      // Key-value inside `with:` block
      if (inWith && currentStep.with) {
        const withKvMatch = rawLine.match(/^\s+([a-zA-Z0-9_.-]+):\s*(['"]?)(.+?)\2\s*$/);
        if (withKvMatch) {
          currentStep.with[withKvMatch[1]] = withKvMatch[3];
          continue;
        }
      }
    }
  }

  // Flush any open run block at end of file
  if (inRunBlock && currentStep) {
    currentStep.run = runBlockLines.filter(Boolean).join(' && ');
    if (currentStep.run) {
      result.allRuns.push(currentStep.run);
    }
  }

  return result;
}

/**
 * Extract simple XML tags/properties from pom.xml or other XML configs.
 */
export function parseXmlProperties(content: string): Record<string, string> {
  const properties: Record<string, string> = {};
  if (!content) return properties;

  // Match <java.version>17</java.version> or <maven.compiler.source>11</maven.compiler.source>
  const tagRegex = /<([a-zA-Z0-9_.-]+)>([^<]+)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    const tagName = match[1];
    const val = match[2].trim();
    properties[tagName] = val;
  }
  return properties;
}

/**
 * Parse targets and basic commands from a Makefile.
 */
export function parseMakefileTargets(content: string): Record<string, string[]> {
  const targets: Record<string, string[]> = {};
  if (!content) return targets;

  const lines = content.split(/\r?\n/);
  let currentTarget: string | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Makefile target definition: `target: dependencies`
    const targetMatch = line.match(/^([a-zA-Z0-9_.-]+)\s*:(?!=)/);
    if (targetMatch && !line.startsWith('\t') && !line.startsWith('  ')) {
      currentTarget = targetMatch[1];
      if (!targets[currentTarget]) {
        targets[currentTarget] = [];
      }
      continue;
    }

    // Recipe line under target (starts with tab or spaces)
    if (currentTarget && (line.startsWith('\t') || line.startsWith('  '))) {
      const command = line.trim().replace(/^@/, '');
      if (command) {
        targets[currentTarget].push(command);
      }
    } else if (currentTarget && line.search(/\S/) === 0) {
      // Reached another top-level construct
      currentTarget = null;
    }
  }

  return targets;
}
