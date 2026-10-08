import chalk from 'chalk';
import { writeFile, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

interface TaskTemplate {
  name: string;
  description: string;
  steps: string[];
}

const BUILTIN_TEMPLATES: Record<string, TaskTemplate> = {
  'add-endpoint': {
    name: 'Add API Endpoint',
    description: 'Add a new REST API endpoint with validation and tests',
    steps: [
      'Define route and HTTP method',
      'Create request/response types',
      'Add input validation',
      'Implement handler logic',
      'Add unit tests',
      'Add integration tests',
      'Update API documentation',
    ],
  },
  'new-feature': {
    name: 'New Feature',
    description: 'Implement a new feature end-to-end',
    steps: [
      'Research and plan implementation',
      'Create/modify data models',
      'Implement business logic',
      'Add public API surface',
      'Write unit tests',
      'Write integration tests',
      'Update documentation',
      'Run full test suite',
    ],
  },
  'refactor': {
    name: 'Refactor',
    description: 'Refactor existing code to improve structure',
    steps: [
      'Identify code to refactor',
      'Define target interface/API',
      'Extract shared logic',
      'Update callers',
      'Remove old code',
      'Run existing tests to verify no regression',
      'Clean up imports and formatting',
    ],
  },
  'fix-bug': {
    name: 'Fix Bug',
    description: 'Investigate and fix a bug',
    steps: [
      'Reproduce the bug',
      'Identify root cause',
      'Write a failing test',
      'Implement fix',
      'Verify fix resolves the issue',
      'Add regression test',
      'Run full test suite',
    ],
  },
  'add-test': {
    name: 'Add Tests',
    description: 'Add unit and/or integration tests',
    steps: [
      'Identify code paths to cover',
      'Create test file',
      'Add happy-path tests',
      'Add edge case tests',
      'Add error-case tests',
      'Run tests and verify coverage',
    ],
  },
  'audit': {
    name: 'Code Audit',
    description: 'Review codebase for issues and improvements',
    steps: [
      'List files to audit',
      'Check for security issues',
      'Check for performance issues',
      'Check for code style violations',
      'Check for missing error handling',
      'Check for outdated dependencies',
      'Compile findings and recommendations',
    ],
  },
};

function getAvailableTemplates(): string {
  return Object.entries(BUILTIN_TEMPLATES)
    .map(([key, t]) => `  ${key.padEnd(16)} ${t.description}`)
    .join('\n');
}

function generateTaskMd(template: TaskTemplate, taskDescription: string): string {
  const date = new Date().toISOString().split('T')[0];
  const lines: string[] = [
    `# Task: ${taskDescription}`,
    ``,
    `**Template:** ${template.name}`,
    `**Created:** ${date}`,
    ``,
    `## Checklist`,
    ``,
  ];

  for (let i = 0; i < template.steps.length; i++) {
    lines.push(`- [ ] ${template.steps[i]}`);
  }

  lines.push(
    ``,
    `## Notes`,
    ``,
    `- [ ] All tests passing`,
    `- [ ] Code reviewed`,
    `- [ ] Documentation updated`,
    ``,
  );

  return lines.join('\n');
}

export async function createTask(templateName: string, taskDescription: string, cwd: string): Promise<string> {
  const template = BUILTIN_TEMPLATES[templateName];
  if (!template) {
    const available = getAvailableTemplates();
    throw new Error(
      `Unknown template: "${templateName}".\nAvailable templates:\n${available}`
    );
  }

  const tasksDir = path.join(cwd, '.sc-agent', 'tasks');
  try {
    await access(tasksDir, constants.F_OK);
  } catch {
    await mkdir(tasksDir, { recursive: true });
  }

  const safeName = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
  const filePath = path.join(tasksDir, `${safeName}.md`);

  const content = generateTaskMd(template, taskDescription);
  await writeFile(filePath, content, 'utf-8');

  return filePath;
}

export async function listTasks(cwd: string): Promise<string[]> {
  const tasksDir = path.join(cwd, '.sc-agent', 'tasks');
  try {
    await access(tasksDir, constants.F_OK);
  } catch {
    return [];
  }

  const { readdir, readFile } = await import('node:fs/promises');
  const files = await readdir(tasksDir);
  const taskFiles = files.filter(f => f.endsWith('.md'));
  const result: string[] = [];

  for (const file of taskFiles) {
    const content = await readFile(path.join(tasksDir, file), 'utf-8');
    const titleMatch = content.match(/^# Task:\s*(.+)/m);
    const title = titleMatch ? titleMatch[1] : file;
    const checked = (content.match(/- \[x\] /gi) || []).length;
    const total = (content.match(/- \[ \] /g) || []).length + checked;
    result.push(`${file}  - ${title} (${checked}/${total} done)`);
  }

  return result;
}

export const taskCommand = {
  async create(template: string, description: string, cwd: string): Promise<void> {
    const filePath = await createTask(template, description, cwd);
    console.log(chalk.green(`\n✓ Task created: ${filePath}\n`));
    const content = await import('node:fs/promises').then(m => m.readFile(filePath, 'utf-8'));
    console.log(chalk.gray(content));
  },

  async list(cwd: string): Promise<void> {
    const tasks = await listTasks(cwd);
    if (tasks.length === 0) {
      console.log(chalk.yellow('\nNo tasks found. Create one with "sc task create <template> <description>"\n'));
      return;
    }
    console.log(chalk.cyan(`\n📋 Tasks (${tasks.length}):\n`));
    for (const t of tasks) {
      console.log(chalk.gray(`  ${t}`));
    }
    console.log();
  },

  async templates(): Promise<void> {
    console.log(chalk.cyan('\nAvailable templates:\n'));
    for (const [key, t] of Object.entries(BUILTIN_TEMPLATES)) {
      console.log(chalk.white(`  ${key}`));
      console.log(chalk.gray(`    ${t.description}`));
      console.log(chalk.gray(`    Steps: ${t.steps.length}`));
      console.log();
    }
  },
};
