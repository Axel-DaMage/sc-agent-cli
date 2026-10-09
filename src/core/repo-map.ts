import { open } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import type { ProjectConfig } from './types.js';
import { resolveSafePath } from '../utils/path-security.js';
import { verbose } from '../utils/verbose-logger.js';

/**
 * Repo-map / skeleton context mode (#461).
 *
 * `context.mode: 'skeleton'` (or SC_CONTEXT_MODE=skeleton) replaces the
 * whole-file project-context injection with a generated structural index
 * of the workspace: per-file symbols/signatures plus import edges.
 * Extraction is pure regex/heuristic keyed by file extension — no
 * tree-sitter/ctags dependency. Emission is bounded per file (~60 lines)
 * and per repo (file count, total lines, per-file read head). The result
 * is injected as the `repo_map` context source so its spend is accounted
 * by the #422 SC_CONTEXT_BUDGET_TOKENS guard; file bodies stay
 * pull-on-demand via the read_file tool — the map names exact paths.
 */

export interface RepoMapOptions {
  /** Max source files indexed (bounded per repo). Default 250. */
  maxFiles?: number;
  /** Max emitted lines per file block (path + imports + symbols). Default 60. */
  maxLinesPerFile?: number;
  /** Max emitted lines for the whole map. Default 2000. */
  maxTotalLines?: number;
  /** Per-file read cap — only the head is scanned. Default 128 KiB. */
  maxFileBytes?: number;
  /** Max entries in the path-only "other files" listing. Default 150. */
  maxOtherFiles?: number;
}

export interface RepoMapExtraction {
  /** Import edges: module specifiers / include targets this file references. */
  imports: string[];
  /** Declaration/signature lines in source order (indentation preserved). */
  symbols: string[];
}

type Extractor = (lines: string[]) => RepoMapExtraction;

// --- bounds ------------------------------------------------------------------

const DEFAULT_MAX_FILES = 250;
const DEFAULT_MAX_LINES_PER_FILE = 60;
const DEFAULT_MAX_TOTAL_LINES = 2000;
const DEFAULT_MAX_FILE_BYTES = 128 * 1024;
const DEFAULT_MAX_OTHER_FILES = 150;
const MAX_SYMBOL_LINE = 160;
const MAX_IMPORTS_PER_FILE = 16;

// Directories that never belong in a repo map (deps, build output, VCS, caches).
const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/target/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/.turbo/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.sc-agent/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/.gradle/**',
  '**/.terraform/**',
  // Defense-in-depth: secret-class files never enter the index even if
  // permissions.denyPaths was weakened.
  '**/.env',
  '**/.env.*',
];

// Binary/generated assets — never indexed, never listed.
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.whl',
  '.pdf', '.wasm', '.map', '.lock', '.sqlite', '.sqlite3', '.db',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.flac',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.class', '.pyc', '.pyo',
  '.snap', '.ico', '.icns', '.parquet', '.avro', '.npy', '.onnx', '.pt', '.bin',
]);

const SKIP_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock',
  'gemfile.lock', 'poetry.lock', 'composer.lock', 'pipfile.lock',
  'go.sum', 'bun.lock', 'bun.lockb', '.ds_store', 'thumbs.db',
]);

const SKIP_SUFFIXES = ['.min.js', '.min.css', '.bundle.js'];

// Doc/config files listed path-only — useful for orientation, not indexed.
const PATH_ONLY_EXTS = new Set([
  '.md', '.markdown', '.mdx', '.rst', '.txt', '.adoc',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.json', '.jsonc', '.json5', '.xml', '.proto', '.tf', '.hcl', '.gradle',
]);

const PATH_ONLY_NAME_RE =
  /^(?:dockerfile(?:\..+)?|.*\.dockerfile|makefile|containerfile|cmakelists\.txt|rakefile|gemfile|podfile|justfile|procfile|license(?:\..*)?|notice|codeowners|changelog(?:\..*)?|\.gitignore|\.dockerignore|\.editorconfig|\.gitattributes|\.gitmodules)$/i;

// --- line-level extraction -----------------------------------------------------

interface LanguageScanner {
  /** Line prefixes treated as comments (never produce imports/symbols). */
  comments: string[];
  /** Capture group 1 = module specifier. Tested against the trimmed line. */
  imports: RegExp[];
  /** Declaration lines — tested against the trimmed line at any indent. */
  symbols: RegExp[];
  /** Only tested when the raw line is NOT indented (module-scope decls). */
  topLevelSymbols?: RegExp[];
  /** Only tested when the raw line IS indented (members: methods, fields). */
  memberSymbols?: RegExp[];
  /** Indented lines starting with these words are never symbols — kills
   *  control-flow/call false positives (`if (x) {`, `return foo();`). */
  rejectIndented?: RegExp;
}

const C_LIKE_COMMENTS = ['//', '/*', '*/', '*', '<!--'];
const HASH_COMMENTS = ['#'];
const SQL_COMMENTS = ['--', '/*'];

const JS_TS: LanguageScanner = {
  comments: C_LIKE_COMMENTS,
  imports: [
    /\bfrom\s+['"]([^'"]+)['"]/,              // import/export ... from 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/,  // import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/, // require('x')
    /\bimport\s+['"]([^'"]+)['"]/,            // import 'x'
  ],
  symbols: [
    /^(?:export\s+)?(?:default\s+)?(?:(?:async|abstract|declare)\s+)*function\s*\*?\s*\w+\s*\(/,
    /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w+/,
    /^(?:export\s+)?(?:declare\s+)?(?:interface|enum|namespace|module)\s+\w+/,
    /^(?:export\s+)?type\s+\w+\s*(?:<[^>]*>)?\s*=/,
  ],
  topLevelSymbols: [
    /^(?:export\s+)?(?:const|let|var)\s+[\w$]+/,
  ],
  memberSymbols: [
    // Method definitions: `name<T>(params): ret {` — requires a `{` body so
    // bare calls (`foo(x);`) don't count.
    /^(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|accessor)\s+)*(?:get\s+|set\s+)?[#\w$]+\??\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^={]+)?\s*\{[^;]*$/,
    // Interface sigs without bodies: `name(p): ret;`
    /^(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|accessor)\s+)*(?:get\s+|set\s+)?[#\w$]+\??\s*(?:<[^>]*>)?\s*\([^;]*\)\s*:\s*[^={]+;\s*$/,
    // Arrow-function fields: `handler = async (x) => {`
    /^[#\w$]+\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,
  ],
  rejectIndented:
    /^(?:if|for|while|switch|catch|else|do|return|throw|new|case|break|continue|import|from|const|let|var|await|yield|typeof|delete|try|finally|synchronized|in|of)\b/,
};

const PYTHON: LanguageScanner = {
  comments: HASH_COMMENTS,
  imports: [
    /^\s*from\s+([.\w]+)\s+import\b/,
    /^\s*import\s+([.\w][.\w\s,]*?)\s*(?:\s+as\s+\w+)?$/,
  ],
  symbols: [
    /^\s*(?:async\s+)?def\s+\w+\s*\(/,
    /^\s*class\s+\w+/,
    /^\s*@\w+/,                       // decorators carry API surface (routes, dataclass…)
    /^[A-Z_][A-Z0-9_]*\s*(?::[^=]+)?=/, // module-level constants
  ],
};

const RUST: LanguageScanner = {
  comments: C_LIKE_COMMENTS,
  imports: [
    /^\s*(?:pub\s+)?use\s+([^;]+?)\s*;/,
    /^\s*(?:pub\s+)?(mod\s+\w+)\s*;/, // `mod foo;` → sibling file edge
  ],
  symbols: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]+"\s+)?fn\s+\w+/,
    /^\s*(?:pub\s+)?(?:struct|enum|trait|union)\s+\w+/,
    /^\s*(?:unsafe\s+)?impl\b/,
    /^\s*(?:pub\s+)?(?:const|static|type)\s+\w+/,
    /^\s*(?:pub\s+)?mod\s+\w+/,
    /^\s*macro_rules!\s*\w+/,
  ],
};

const SQL: LanguageScanner = {
  comments: SQL_COMMENTS,
  imports: [],
  symbols: [
    /^\s*(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+|clustered\s+|nonclustered\s+)?(?:table|view|materialized\s+view|index|function|procedure|trigger|schema|sequence|type|extension|database)\b/i,
  ],
};

const JVM: LanguageScanner = {
  comments: C_LIKE_COMMENTS,
  imports: [
    /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;?/,
  ],
  symbols: [
    /^\s*package\s+[\w.]+/,
    /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|internal|open|final|abstract|sealed|data|static|enum|annotation|suspend|inline|external|expect|actual|companion)\s+)*(?:class|interface|enum|record|object|trait|@?interface)\s+\w+/,
    // Kotlin: fun name(...) / fun Type.name(...)
    /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|internal|open|override|suspend|inline|infix|operator|tailrec|external|abstract|final)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\s*\.\s*)?\w+\s*\(/,
    // Java-style methods: `public static void main(String[] a) {`
    /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|protected|private)\s+(?:(?:static|final|abstract|synchronized|native|default|strictfp)\s+)*[\w<>[],.?]+\s+\w+\s*\([^;]*\)\s*(?:throws\s+[\w.,\s]+)?[{;]?\s*$/,
    // Scala/Groovy: `def name(`, `val name`, `var name`
    /^\s*(?:override\s+)?(?:def|val|var)\s+\w+/,
  ],
  memberSymbols: [
    // Package-private members + constructors (no explicit access modifier).
    /^\s*(?:(?:static|final|abstract|synchronized|native|strictfp|default|virtual|override)\s+)*[\w<>\[\],.?]+\s+\w+\s*\([^;]*\)\s*(?:throws\s+[\w.,\s]+)?[{;]?\s*$/,
    /^\s*(?:public|protected|private)\s+\w+\s*\([^;]*\)\s*[{;]?\s*$/,
  ],
  rejectIndented:
    /^(?:if|for|while|switch|catch|else|do|return|throw|new|case|break|continue|synchronized|assert|yield|import|package)\b/,
};

const C_FAMILY: LanguageScanner = {
  comments: C_LIKE_COMMENTS,
  imports: [
    /^\s*#\s*include\s*[<"]([^>"]+)[>"]/,
    /^\s*using\s+(?:namespace\s+)?([\w:]+)\s*;/, // C++/C#
  ],
  symbols: [
    /^\s*#\s*define\s+\w+/,
    /^\s*package\s+[\w.]+/, // C#
    /^\s*namespace\s+\w+/,
    /^\s*typedef\b[^;]+;/,
    /^\s*(?:(?:template)\s*<[^>]*>\s*)?(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|partial|extern|inline|constexpr|friend|readonly|unsafe)\s+)*(?:class|struct|enum|union|interface|record|delegate)\s+\w+/,
    // Function decl/def lines: `ret name(args) {` / `ret name(args);`
    /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|extern|inline|constexpr|async|unsafe|new|partial)\s+)*(?:[\w:~*&<>\[\],?]+\s+)+[\w:~]+\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:\s*where\b[^{]*)?[{;]\s*$/,
  ],
  rejectIndented:
    /^(?:return|throw|co_return|co_await|co_yield|if|for|while|switch|catch|else|do|case|break|continue|sizeof|decltype|static_assert|new|delete|goto|emit|signals|slots)\b/,
};

const RUBY: LanguageScanner = {
  comments: HASH_COMMENTS,
  imports: [
    /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/,
    /^\s*(?:include|extend|prepend)\s+([\w:]+)/,
  ],
  symbols: [
    /^\s*(?:class|module)\s+\w+/,
    /^\s*def\s+\w+/,
    /^\s*attr_(?:accessor|reader|writer)\b/,
  ],
};

const PHP: LanguageScanner = {
  comments: ['//', '#', '/*', '*/', '*'],
  imports: [
    /^\s*use\s+([\w\\]+)/,
    /^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/,
  ],
  symbols: [
    /^\s*namespace\s+[\w\\]+/,
    /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+\w+/,
    /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+\w+\s*\(/,
  ],
};

const SHELL: LanguageScanner = {
  comments: HASH_COMMENTS,
  imports: [
    /^\s*(?:source|\.)\s+['"]?([^\s'"]+)/,
  ],
  symbols: [
    /^\s*(?:function\s+)?[a-zA-Z_][\w.-]*\s*\(\s*\)\s*\{?/,
    /^\s*function\s+\w+/,
  ],
};

const SWIFT: LanguageScanner = {
  comments: C_LIKE_COMMENTS,
  imports: [/^\s*(?:@\w+\s+)*import\s+([\w.]+)/],
  symbols: [
    /^\s*(?:(?:public|private|internal|fileprivate|open|final|static|class|override|mutating|nonisolated|indirect)\s+)*(?:class|struct|enum|protocol|extension|actor|typealias)\s+\w+/,
    /^\s*(?:(?:public|private|internal|fileprivate|open|static|class|override|mutating|nonisolated)\s+)*func\s+\w+/,
  ],
};

const LUA: LanguageScanner = {
  comments: ['--'],
  imports: [/\brequire\s*\(?\s*['"]([^'"]+)['"]/],
  symbols: [
    /^\s*(?:local\s+)?function\s+[\w.:]+\s*\(/,
    /^\s*[\w.]+\s*=\s*function\b/,
  ],
};

/** Go needs block-aware handling for `import ( ... )` / `type ( ... )` groups. */
function extractGo(lines: string[]): RepoMapExtraction {
  const imports = new Set<string>();
  const symbols: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const s = formatSymbolLine(raw);
    if (s && !seen.has(s)) {
      seen.add(s);
      symbols.push(s);
    }
  };

  let parenBlock: 'import' | 'type' | 'const' | 'var' | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (parenBlock) {
      if (line === ')') {
        parenBlock = null;
        continue;
      }
      if (parenBlock === 'import') {
        const m = /^(?:[\w.]*\s+)?"([^"]+)"/.exec(line);
        if (m) imports.add(m[1]);
      } else if (!line.startsWith('//')) {
        push(raw); // `Name type` / `Name = value` inside a grouped decl
      }
      continue;
    }
    if (line.startsWith('//')) continue;
    const block = /^(import|type|const|var)\s*\($/.exec(line);
    if (block) {
      parenBlock = block[1] as 'import' | 'type' | 'const' | 'var';
      continue;
    }
    const singleImport = /^import\s+(?:[\w.]*\s+)?"([^"]+)"/.exec(line);
    if (singleImport) {
      imports.add(singleImport[1]);
      continue;
    }
    if (
      /^package\s+\w+/.test(line) ||
      /^func\s+(?:\([^)]*\)\s*)?\w+\s*\(/.test(line) ||
      /^(?:type|const|var)\s+\w+/.test(line)
    ) {
      push(raw);
    }
  }
  return { imports: [...imports], symbols };
}

// Map every language-family extension to its extractor.
const S = (spec: LanguageScanner): Extractor => (lines) => scanLines(lines, spec);
const EXTRACTOR_BY_EXT: Record<string, Extractor> = {
  '.ts': S(JS_TS), '.tsx': S(JS_TS), '.mts': S(JS_TS), '.cts': S(JS_TS),
  '.js': S(JS_TS), '.jsx': S(JS_TS), '.mjs': S(JS_TS), '.cjs': S(JS_TS),
  '.py': S(PYTHON), '.pyi': S(PYTHON),
  '.go': extractGo,
  '.rs': S(RUST),
  '.sql': S(SQL),
  '.java': S(JVM), '.kt': S(JVM), '.kts': S(JVM), '.scala': S(JVM), '.groovy': S(JVM),
  '.c': S(C_FAMILY), '.h': S(C_FAMILY), '.cpp': S(C_FAMILY), '.cc': S(C_FAMILY),
  '.cxx': S(C_FAMILY), '.hpp': S(C_FAMILY), '.hh': S(C_FAMILY), '.hxx': S(C_FAMILY),
  '.cs': S(C_FAMILY), '.m': S(C_FAMILY), '.mm': S(C_FAMILY),
  '.rb': S(RUBY),
  '.php': S(PHP),
  '.sh': S(SHELL), '.bash': S(SHELL), '.zsh': S(SHELL),
  '.swift': S(SWIFT),
  '.lua': S(LUA),
};

function isCommentLine(line: string, prefixes: string[]): boolean {
  return prefixes.some((p) => line.startsWith(p));
}

/**
 * Normalize a matched declaration into a skeleton line: capped indentation
 * (tabs → 2 spaces), trailing `{`/`:`/`;` stripped, length-bounded.
 */
function formatSymbolLine(raw: string): string {
  const indent = (raw.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '  ').slice(0, 8);
  let text = raw.trim().replace(/[{;:]\s*$/, '').trimEnd();
  if (text.length > MAX_SYMBOL_LINE) text = `${text.slice(0, MAX_SYMBOL_LINE - 3)}...`;
  return indent + text;
}

function scanLines(lines: string[], spec: LanguageScanner): RepoMapExtraction {
  const imports = new Set<string>();
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || isCommentLine(line, spec.comments)) continue;

    for (const re of spec.imports) {
      const m = re.exec(line);
      if (m) {
        for (const part of m[1].split(',')) {
          const s = part.trim();
          if (s) imports.add(s);
        }
        break;
      }
    }

    const indented = /^\s/.test(raw);
    if (indented && spec.rejectIndented?.test(line)) continue;
    const matched =
      spec.symbols.some((re) => re.test(line)) ||
      (!indented && (spec.topLevelSymbols?.some((re) => re.test(line)) ?? false)) ||
      (indented && (spec.memberSymbols?.some((re) => re.test(line)) ?? false));
    if (matched) {
      const sym = formatSymbolLine(raw);
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        symbols.push(sym);
      }
    }
  }
  return { imports: [...imports], symbols };
}

/** Read at most maxBytes from the head of a file — bounded I/O for big trees. */
async function readHead(filePath: string, maxBytes: number): Promise<string> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

function renderFileBlock(relPath: string, ex: RepoMapExtraction, maxLines: number): string[] {
  const out: string[] = [relPath];
  if (ex.imports.length > 0) {
    const shown = ex.imports.slice(0, MAX_IMPORTS_PER_FILE);
    const more = ex.imports.length - shown.length;
    out.push(`  imports: ${shown.join(', ')}${more > 0 ? `, … +${more} more` : ''}`);
  }
  const headroom = Math.max(0, maxLines - out.length);
  const shown = ex.symbols.slice(0, headroom);
  out.push(...shown.map((s) => `  ${s}`));
  const hidden = ex.symbols.length - shown.length;
  if (hidden > 0) out.push(`  … +${hidden} more symbols`);
  return out;
}

/**
 * Generate the skeleton index for a workspace. Returns null when there is
 * nothing worth indexing (empty or non-source trees) so the caller can skip
 * the injection entirely.
 */
export async function generateRepoMap(
  workspaceRoot: string,
  config?: ProjectConfig,
  options: RepoMapOptions = {},
): Promise<string | null> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxLinesPerFile = options.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE;
  const maxTotalLines = options.maxTotalLines ?? DEFAULT_MAX_TOTAL_LINES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxOtherFiles = options.maxOtherFiles ?? DEFAULT_MAX_OTHER_FILES;

  let relPaths: string[];
  try {
    relPaths = await fg('**/*', {
      cwd: workspaceRoot,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: IGNORE_GLOBS,
    });
  } catch {
    return null; // unreadable/missing workspace — nothing to index
  }
  if (relPaths.length === 0) return null;

  // Deny-listed paths (secrets, user exclusions) never enter the index.
  const deny = ignore().add([
    ...(config?.permissions?.denyPaths ?? []),
    '.env', '.env.*', '**/*.key', '**/*.pem',
  ]);

  const sourceFiles: string[] = [];
  const otherFiles: string[] = [];
  for (const rel of relPaths.sort()) {
    if (deny.ignores(rel)) continue;
    const base = path.basename(rel).toLowerCase();
    const ext = path.extname(rel).toLowerCase();
    if (SKIP_NAMES.has(base) || SKIP_EXTS.has(ext) || SKIP_SUFFIXES.some((s) => base.endsWith(s))) {
      continue;
    }
    if (EXTRACTOR_BY_EXT[ext]) sourceFiles.push(rel);
    else if (PATH_ONLY_EXTS.has(ext) || PATH_ONLY_NAME_RE.test(base)) otherFiles.push(rel);
  }
  if (sourceFiles.length === 0 && otherFiles.length === 0) return null;

  const indexed = sourceFiles.slice(0, maxFiles);
  const lines: string[] = [];
  let indexedCount = 0;
  for (const rel of indexed) {
    if (lines.length >= maxTotalLines) break;
    let safePath: string;
    try {
      // Same path-security contract as read_file: deny patterns + realpath
      // containment (a symlinked file must not leak content from outside
      // the workspace into the index).
      safePath = resolveSafePath(rel, workspaceRoot, config ?? { model: { provider: 'openai-compatible', baseUrl: '', model: '' } });
    } catch {
      continue;
    }
    let content: string;
    try {
      content = await readHead(safePath, maxFileBytes);
    } catch {
      continue; // unreadable file — skip
    }
    const extractor = EXTRACTOR_BY_EXT[path.extname(rel).toLowerCase()];
    const ex = extractor(content.split('\n'));
    const remaining = maxTotalLines - lines.length;
    const block = renderFileBlock(rel, ex, maxLinesPerFile);
    if (block.length > remaining) {
      lines.push(...block.slice(0, remaining), `  … truncated (map line budget)`);
      break;
    }
    lines.push(...block);
    indexedCount++;
  }

  const omitted = indexed.length - indexedCount;
  const out: string[] = [
    '# Repository Skeleton (context.mode = skeleton)',
    `Compressed index of ${indexedCount} workspace source files — symbols, signatures, and import edges.`,
    'File bodies are NOT injected in this mode. To inspect or modify a file, call',
    'read_file with the exact workspace-relative path shown below.',
    '',
    ...lines,
  ];

  if (otherFiles.length > 0) {
    const shown = otherFiles.slice(0, maxOtherFiles);
    out.push('', '# Other files (paths only — read_file works on these too)');
    out.push(...shown.map((p) => `  ${p}`));
    if (otherFiles.length > shown.length) {
      out.push(`  … +${otherFiles.length - shown.length} more paths`);
    }
  }

  if (omitted > 0 || sourceFiles.length > indexed.length) {
    const total = omitted + Math.max(0, sourceFiles.length - indexed.length);
    out.push(`… repo map truncated: ${total} more source file(s) omitted (bounds: ${maxFiles} files / ${maxTotalLines} lines)`);
  }

  verbose(`[REPO_MAP] indexed ${indexedCount}/${sourceFiles.length} source files, ${out.length} lines emitted`);
  return out.join('\n');
}
