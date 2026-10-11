import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext } from './tool.js';
import { requestPermission } from '../utils/permissions.js';

interface ParsedMethod {
  name: string;
  params: string;
  returnType: string;
  visibility: string;
  line: number;
}

interface ParsedClass {
  type: 'class' | 'interface' | 'struct' | 'trait';
  name: string;
  methods: ParsedMethod[];
  line: number;
}

const EXT_PATTERNS: Record<string, { class: RegExp; method: RegExp; comment: RegExp }> = {
  '.ts': {
    class: /^\s*(export\s+)?(abstract\s+)?(class|interface)\s+(\w+)/m,
    method: /^\s*(public|private|protected|static|\s)*(async\s+)?(\w+)\s*\(([^)]*)\)\s*:\s*([^{=]+)/gm,
    comment: /\/\/.*|\/\*[\s\S]*?\*\//g,
  },
  '.js': {
    class: /^\s*(export\s+)?(class)\s+(\w+)/m,
    method: /^\s*(async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/gm,
    comment: /\/\/.*|\/\*[\s\S]*?\*\//g,
  },
  '.java': {
    class: /^\s*(public|private|protected)?\s*(abstract\s+)?(class|interface)\s+(\w+)/m,
    method: /^\s*(public|private|protected)?\s*(static\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/gm,
    comment: /\/\/.*|\/\*[\s\S]*?\*\//g,
  },
  '.py': {
    class: /^\s*(class)\s+(\w+)/m,
    method: /^\s*(async\s+)?(def)\s+(\w+)\s*\(([^)]*)\)/gm,
    comment: /#.*/g,
  },
  '.go': {
    class: /^\s*type\s+(\w+)\s+(struct|interface)\s*\{/m,
    method: /^\s*func\s+(\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)\s*(\(?[^{]+)?/gm,
    comment: /\/\/.*|\/\*[\s\S]*?\*\//g,
  },
  '.rs': {
    class: /^\s*(pub\s+)?(trait|struct|impl)\s+(\w+)/m,
    method: /^\s*(pub\s+|fn\s+)?(fn)\s+(\w+)\s*\(([^)]*)\)\s*(->\s*[^{{]+)?/gm,
    comment: /\/\/.*|\/\/!.*|\/\*[\s\S]*?\*\//g,
  },
};

function removeComments(code: string, lang: string): string {
  const ext = EXT_PATTERNS[lang];
  if (!ext) return code;
  return code.replace(ext.comment, '');
}

function parseMethods(code: string, lang: string): ParsedMethod[] {
  const ext = EXT_PATTERNS[lang];
  if (!ext) return [];
  const methods: ParsedMethod[] = [];
  const lines = code.split('\n');
  const clean = removeComments(code, lang);
  const cleanLines = clean.split('\n');
  let match: RegExpExecArray | null;

  const re = new RegExp(ext.method.source, ext.method.flags.includes('g') ? 'gm' : 'm');
  while ((match = re.exec(clean)) !== null) {
    const lineIndex = clean.substring(0, match.index).split('\n').length;
    const originalLine = lines[lineIndex - 1] || '';
    const line = lineIndex;

    if (lang === '.ts' || lang === '.js') {
      const groups = match.slice(1);
      const visibilityMatch = originalLine.match(/^\s*(public|private|protected|export)/);
      const visibility = visibilityMatch?.[1] || 'public';
      const isAsync = groups[0]?.includes('async') ? 'async ' : '';
      const name = groups[groups.length - 2];
      const params = groups[groups.length - 1];
      const returnType = groups[groups.length - 1]?.includes(':') ?
        originalLine.split(':').pop()?.trim().replace(/\{.*/, '') || 'any' : 'any';
      if (name && name !== 'async' && name !== 'constructor') {
        methods.push({ name, params: params || '', returnType: returnType || 'any', visibility, line });
      }
    } else if (lang === '.java') {
      const visibility = match[1] || 'package';
      const returnType = match[3] || 'void';
      const name = match[4];
      const params = match[5] || '';
      if (name && name !== 'constructor') {
        methods.push({ name, params, returnType, visibility, line });
      }
    } else if (lang === '.py') {
      const name = match[3];
      const params = match[4] || '';
      if (name && name !== '__init__') {
        methods.push({ name, params, returnType: 'any', visibility: 'public', line });
      }
    } else if (lang === '.go') {
      const receiver = match[1] || '';
      const name = match[2];
      const params = match[3] || '';
      const returnType = match[4]?.trim() || '';
      if (name) {
        methods.push({ name: receiver ? `${receiver.trim()} ${name}` : name, params, returnType, visibility: 'public', line });
      }
    } else if (lang === '.rs') {
      const name = match[3];
      const params = match[4] || '';
      const returnType = match[5]?.trim().replace(/^->\s*/, '') || '()';
      const visibility = originalLine.trim().startsWith('pub') ? 'pub' : 'private';
      if (name && name !== 'new') {
        methods.push({ name, params, returnType, visibility, line });
      }
    }
  }
  return methods;
}

function parseClasses(code: string, lang: string): ParsedClass[] {
  const ext = EXT_PATTERNS[lang];
  if (!ext) return [];
  const classes: ParsedClass[] = [];
  const clean = removeComments(code, lang);
  const lines = code.split('\n');
  let match: RegExpExecArray | null;
  const classRegex = new RegExp(ext.class.source, 'gm');

  while ((match = classRegex.exec(clean)) !== null) {
    const lineIndex = clean.substring(0, match.index).split('\n').length;
    const line = lineIndex;

    if (lang === '.ts' || lang === '.js') {
      const name = match[match.length - 1];
      const type = match[match.length - 2] as 'class' | 'interface';
      if (name) {
        classes.push({ type: type || 'class', name, methods: [], line });
      }
    } else if (lang === '.java') {
      const name = match[4];
      const type = match[3] as 'class' | 'interface';
      if (name) {
        classes.push({ type: type || 'class', name, methods: [], line });
      }
    } else if (lang === '.py') {
      const name = match[2];
      if (name) {
        classes.push({ type: 'class', name, methods: [], line });
      }
    } else if (lang === '.go') {
      const name = match[1];
      const type = match[2].toLowerCase() as 'struct' | 'interface';
      if (name) {
        classes.push({ type, name, methods: [], line });
      }
    } else if (lang === '.rs') {
      const name = match[3];
      const type = match[2] as 'trait' | 'struct';
      if (name) {
        classes.push({ type: type || 'struct', name, methods: [], line });
      }
    }
  }

  const allMethods = parseMethods(code, lang);
  for (const cls of classes) {
    const nextClassLine = classes
      .filter((c) => c.line > cls.line)
      .reduce((min, c) => Math.min(min, c.line), Infinity);
    cls.methods = allMethods.filter(
      (m) => m.line >= cls.line && m.line < nextClassLine
    );
  }

  return classes;
}

function detectLang(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_PATTERNS[ext] ? ext : null;
}

export async function analyzeCode(filePath: string): Promise<string> {
  const lang = detectLang(filePath);
  if (!lang) {
    return `Unsupported file type. Supported: ${Object.keys(EXT_PATTERNS).join(', ')}`;
  }

  const code = await readFile(filePath, 'utf-8');
  const classes = parseClasses(code, lang);
  const methods = parseMethods(code, lang);

  const lines = code.split('\n');
  const result: string[] = [`📄 ${filePath} (${lines.length} lines, ${lang})`];

  if (classes.length > 0) {
    result.push(`\n📋 ${classes.length} ${classes[0].type}(s):`);
    for (const cls of classes) {
      result.push(`  ${cls.type === 'interface' ? '📐' : cls.type === 'struct' ? '🧱' : cls.type === 'trait' ? '⭐' : '📦'} ${cls.name} (line ${cls.line})`);
      if (cls.methods.length > 0) {
        for (const m of cls.methods) {
          result.push(`    • ${m.visibility} ${m.name}(${m.params})${m.returnType !== 'any' ? `: ${m.returnType}` : ''}`);
        }
      } else {
        result.push(`    (no methods detected)`);
      }
    }
  } else if (methods.length > 0) {
    result.push(`\n🔧 Functions (${methods.length}):`);
    for (const m of methods) {
      result.push(`  • ${m.name}(${m.params})${m.returnType !== 'any' ? `: ${m.returnType}` : ''}`);
    }
  } else {
    result.push(`\nNo classes or functions detected.`);
  }

  return result.join('\n');
}

export const codeQueryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'code_query',
      description: 'Analyze a source file and return its classes, interfaces, methods, and function signatures. Supports .ts, .js, .java, .py, .go, .rs.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the source file to analyze',
          },
        },
        required: ['path'],
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const filePath = args.path as string;
    if (!filePath) throw new Error('path is required');

    const approved = await requestPermission({
      toolName: 'code_query',
      args,
      config: ctx.config,
      autoApprove: ctx.autoApprove,
    });

    if (!approved) {
      throw new Error('Permission denied by user');
    }

    try {
      return await analyzeCode(filePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to analyze code: ${msg}`, { cause: err });
    }
  },
};
