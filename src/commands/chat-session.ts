import prompts from 'prompts';
import chalk from 'chalk';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../../package.json') as { version: string };
import { stdin as input, stdout as output } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { Agent } from '../core/agent.js';
import type { AgentOptions } from '../core/agent.js';
import type { Message } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { clearSessionPermissions } from '../utils/permissions.js';
import { checkStorageLimit, enforceStorageLimit, formatBytes } from '../utils/storage-limit.js';
import { estimateCost } from '../utils/token-tracker.js';
import { getModelProfileEmptyStateGuidance } from './chat-session-guidance.js';
import { getStorageGuidance } from '../utils/storage-guidance.js';
import { statusBar, getShortcutsBar } from '../utils/status-bar.js';
import { createCompleter } from '../utils/autocomplete.js';
import { persistentMemory } from '../utils/memory.js';
import { boxHeader, boxFooter } from '../utils/box-drawing.js';
import { showConfig } from '../utils/config-display.js';
import { resolveSettings } from '../utils/settings.js';
import { verbose, verboseSession, verboseError } from '../utils/verbose-logger.js';

// Multi-line input handler: Enter=submit, Shift+Enter=newline, paste inserts verbatim
function readUserInput(history: string[], workspaceRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Check if stdin is a TTY - if not, use simple line reading
    if (!input.isTTY) {
      // Non-TTY mode: read entire input from stdin (batch mode)
      let inputData = '';
      let settled = false;
      input.setEncoding('utf8');
      const onData = (chunk: string) => { inputData += chunk; };
      const onEnd = () => {
        if (!settled) { settled = true; }
        cleanup();
        resolve(inputData.trim());
      };
      const onError = (err: Error) => {
        if (!settled) { settled = true; }
        cleanup();
        reject(err);
      };
      function cleanup() {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('error', onError);
      }
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('error', onError);
      // If stdin is already ended (piped input), resolve immediately
      if (input.readableEnded) {
        cleanup();
        resolve('');
      }
      return;
    }

    // TTY mode: interactive multi-line editor
    const buf: string[] = [''];
    let cursorLine = 0;
    let cursorCol = 0;
    let historyIdx = history.length;
    let historyBuf = '';

    let prevPhysicalRows = 0;

    function renderInput(): void {
      const tw = process.stdout.columns || 80;
      const prefix = chalk.bold.blue('│ ');
      // Move up and clear previous lines
      for (let i = 0; i < prevPhysicalRows; i++) {
        process.stdout.write('\x1b[1A\x1b[2K\r');
      }
      let totalPhysicalRows = 0;
      // Write current content
      for (let i = 0; i < buf.length; i++) {
        const line = buf[i];
        const display = i === cursorLine
          ? line.slice(0, cursorCol) + (line[cursorCol] ? chalk.inverse(line[cursorCol]) + line.slice(cursorCol + 1) : chalk.inverse(' '))
          : line;
        process.stdout.write(prefix + display);
        if (tw > 0) {
          const padding = Math.max(0, tw - prefix.length - display.length - 2);
          if (padding > 0) process.stdout.write(' '.repeat(padding));
        }
        process.stdout.write('\n');

        // Calculate the physical rows this line occupies on the screen
        const visualLength = 2 + (i === cursorLine ? Math.max(line.length, cursorCol + 1) : line.length);
        const rows = Math.max(1, Math.ceil(visualLength / tw));
        totalPhysicalRows += rows;
      }
      prevPhysicalRows = totalPhysicalRows;
    }

    function getFullInput(): string {
      return buf.join('\n');
    }

    function setFullInput(text: string): void {
      buf.length = 0;
      const lines = text.split('\n');
      for (const l of lines) buf.push(l);
      cursorLine = buf.length - 1;
      cursorCol = buf[cursorLine].length;
    }

    function submit(): void {
      if (input.isTTY && input.setRawMode) {
        input.setRawMode(false);
      }
      input.removeAllListeners('keypress');
      // Erase the input area
      for (let i = 0; i < prevPhysicalRows; i++) {
        process.stdout.write('\x1b[1A\x1b[2K\r');
      }
      resolve(getFullInput());
    }

    function insertChar(ch: string): void {
      const line = buf[cursorLine];
      buf[cursorLine] = line.slice(0, cursorCol) + ch + line.slice(cursorCol);
      cursorCol += ch.length;
      renderInput();
    }

    function newline(): void {
      const line = buf[cursorLine];
      const rest = line.slice(cursorCol);
      buf[cursorLine] = line.slice(0, cursorCol);
      cursorLine++;
      cursorCol = 0;
      buf.splice(cursorLine, 0, rest);
      renderInput();
    }

    function cursorLeft(): void {
      if (cursorCol > 0) {
        cursorCol--;
        renderInput();
      } else if (cursorLine > 0) {
        cursorLine--;
        cursorCol = buf[cursorLine].length;
        renderInput();
      }
    }

    function cursorRight(): void {
      const line = buf[cursorLine];
      if (cursorCol < line.length) {
        cursorCol++;
        renderInput();
      } else if (cursorLine < buf.length - 1) {
        cursorLine++;
        cursorCol = 0;
        renderInput();
      }
    }

    function cursorUp(): void {
      if (cursorLine > 0) {
        cursorLine--;
        cursorCol = Math.min(cursorCol, buf[cursorLine].length);
        renderInput();
      } else if (historyIdx > 0) {
        if (historyIdx === history.length) historyBuf = getFullInput();
        historyIdx--;
        setFullInput(history[historyIdx]);
        renderInput();
      }
    }

    function cursorDown(): void {
      if (cursorLine < buf.length - 1) {
        cursorLine++;
        cursorCol = Math.min(cursorCol, buf[cursorLine].length);
        renderInput();
      } else if (historyIdx < history.length) {
        historyIdx++;
        if (historyIdx === history.length) {
          setFullInput(historyBuf);
        } else {
          setFullInput(history[historyIdx]);
        }
        renderInput();
      }
    }

    function backspace(): void {
      if (cursorCol > 0) {
        const line = buf[cursorLine];
        buf[cursorLine] = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
        cursorCol--;
        renderInput();
      } else if (cursorLine > 0) {
        const prevLine = buf[cursorLine - 1];
        const curLine = buf[cursorLine];
        buf[cursorLine - 1] = prevLine + curLine;
        buf.splice(cursorLine, 1);
        cursorLine--;
        cursorCol = prevLine.length;
        renderInput();
      }
    }

    function del(): void {
      const line = buf[cursorLine];
      if (cursorCol < line.length) {
        buf[cursorLine] = line.slice(0, cursorCol) + line.slice(cursorCol + 1);
        renderInput();
      } else if (cursorLine < buf.length - 1) {
        buf[cursorLine] = line + buf[cursorLine + 1];
        buf.splice(cursorLine + 1, 1);
        renderInput();
      }
    }

    function home(): void {
      cursorCol = 0;
      renderInput();
    }

    function end(): void {
      cursorCol = buf[cursorLine].length;
      renderInput();
    }

    function handleTab(): void {
      const completer = createCompleter(workspaceRoot);
      const full = getFullInput();
      const [matches, matchLine] = completer(full);
      if (matches.length === 1 && matches[0] !== matchLine) {
        setFullInput(matches[0]);
        renderInput();
      }
    }

    if (input.isTTY && input.setRawMode) {
      input.setRawMode(true);
    }
    input.resume();
    emitKeypressEvents(input);

    // Safety net: if anything throws while in raw mode, restore it
    function restoreRawMode(): void {
      try {
        if (input.isTTY && input.setRawMode) {
          input.setRawMode(false);
        }
      } catch { /* already restored */ }
      input.removeAllListeners('keypress');
    }

    const PASTE_INTERVALS: number[] = [];
    const PASTE_WINDOW_SIZE = 5;
    const PASTE_THRESHOLD_MS = 80;
    let lastKeyTime = 0;

    function isPasteBurst(): boolean {
      if (PASTE_INTERVALS.length < 2) return false;
      const sorted = [...PASTE_INTERVALS].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return median < PASTE_THRESHOLD_MS;
    }

    input.on('keypress', (_chunk: Buffer, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => {
      try {
        const now = Date.now();
        if (lastKeyTime > 0) {
          const interval = now - lastKeyTime;
          if (interval > PASTE_THRESHOLD_MS) {
            PASTE_INTERVALS.length = 0;
          } else {
            PASTE_INTERVALS.push(interval);
            if (PASTE_INTERVALS.length > PASTE_WINDOW_SIZE) PASTE_INTERVALS.shift();
          }
        }
        lastKeyTime = now;

        const name = key.name || '';
        const ctrl = key.ctrl || false;
        const meta = key.meta || false;
        const shift = key.shift || false;

        // Ctrl+C → clean up and exit
        if (ctrl && name === 'c') {
          restoreRawMode();
          process.emit('SIGINT' as any);
          return;
        }

        // Enter: submit only on deliberate press (median interval > threshold). During paste bursts, insert newline.
        if (name === 'enter' && !shift && !meta) {
          if (isPasteBurst()) {
            newline();
          } else {
            submit();
          }
          return;
        }

        // Shift+Enter → newline
        if (name === 'enter' && (shift || meta)) {
          newline();
          return;
        }

        // Tab → autocomplete
        if (name === 'tab') {
          handleTab();
          return;
        }

        // Space (name is 'space', not ' ')
        if (name === 'space') {
          insertChar(' ');
          return;
        }

        // Navigation
        if (name === 'left') { cursorLeft(); return; }
        if (name === 'right') { cursorRight(); return; }
        if (name === 'up' && !ctrl) { cursorUp(); return; }
        if (name === 'down' && !ctrl) { cursorDown(); return; }
        if (name === 'home' || (ctrl && name === 'a')) { home(); return; }
        if (name === 'end' || (ctrl && name === 'e')) { end(); return; }

        // Delete
        if (name === 'backspace') { backspace(); return; }
        if (name === 'delete' || (ctrl && name === 'd' && getFullInput().length > 0)) { del(); return; }

        // Ctrl+W → delete word backward
        if (ctrl && name === 'w') {
          const line = buf[cursorLine];
          const before = line.slice(0, cursorCol);
          const after = line.slice(cursorCol);
          const trimmed = before.replace(/\s*\S+\s*$/, '');
          buf[cursorLine] = trimmed + after;
          cursorCol = trimmed.length;
          renderInput();
          return;
        }

        // Ctrl+U → clear line
        if (ctrl && name === 'u') {
          const after = buf[cursorLine].slice(cursorCol);
          buf[cursorLine] = after;
          cursorCol = 0;
          renderInput();
          return;
        }

        // Ctrl+K → delete to end of line
        if (ctrl && name === 'k') {
          buf[cursorLine] = buf[cursorLine].slice(0, cursorCol);
          renderInput();
          return;
        }

        // Regular character (name length = 1, e.g. letters, numbers, punctuation)
        if (name.length === 1 && !ctrl) {
          insertChar(name);
          return;
        }

        // Handle printable characters (including symbols like '/' or ':' and emojis/surrogate pairs)
        // that Node's keypress doesn't assign a single-character name to, or when pasting.
        const char = _chunk ? _chunk.toString() : '';
        if (char && !ctrl && !meta && !/[\x00-\x1f\x7f-\x9f]/.test(char)) {
          insertChar(char);
          return;
        }
      } catch (err) {
        restoreRawMode();
        throw err;
      }
    });

    // Initial render
    renderInput();
  });
}

  export async function startChatSession(options: AgentOptions): Promise<void> {
  let agent = new Agent(options);
  let history: Message[] = [];
  let historyCheckpoints: Message[][] = [];
  let currentConfig = options.config;
  let inputHistory: string[] = [];
  let currentPermissionMode: 'ask_once' | 'always_ask' | 'unlimited' = options.permissionMode || (options.autoApprove ? 'unlimited' : 'ask_once');
    const settings = resolveSettings(currentConfig);
  let hudEnabled = settings.hud;
  let hudFields = settings.hudFields;

  // Truncate helper for banner
  function trunc(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // Workspace-specific history files (so each directory has its own context)
  function getHistoryPaths(ws: string): { conv: string; input: string } {
    const safe = ws.replace(/[:/\\]/g, '_');
    const base = join(homedir(), '.sc-agent', 'memory', 'workspaces');
    return { conv: join(base, `conv-${safe}.json`), input: join(base, `input-${safe}.json`) };
  }
  const historyPaths = getHistoryPaths(options.workspaceRoot);

  // Generate session ID: safe workspace path + timestamp (using only alphanumeric and "-")
  const safeWsPath = options.workspaceRoot.toLowerCase()
    .replace(/[:/\\]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const timestamp = new Date().toISOString()
    .replace(/\..+/, '')
    .replace(/[^0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const sessionId = options.sessionId || `${safeWsPath}-${timestamp}`;
  options = { ...options, sessionId };

  verbose(`Session initialized: ${sessionId}`);
  verbose(`Profile: ${currentConfig.activeProfile || 'default'} (${currentConfig.model.model})`);
  verbose(`Mode: ${options.initialPrompt ? 'batch' : 'interactive'}, Permissions: ${currentPermissionMode}`);

  // Helper to persist session trace to the unique instance directory
  function saveSessionTrace(msgs: Message[]) {
    try {
      const sessionDir = join(homedir(), '.sc-agent', 'sessions', sessionId);
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }
      writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(msgs, null, 2));
    } catch {
      // Silent: logging is best-effort
    }
  }

  // Tools that mutate the workspace. A run that never calls one of these
  // produced zero filesystem changes (pure read/plan/refusal).
  const MUTATING_TOOLS = ['write_file', 'edit_file', 'git'];

  // Helper to write machine-readable status for automation
  function saveSessionStatus(status: string, error?: string, historyMsgs?: Message[]) {
    try {
      const sessionDir = join(homedir(), '.sc-agent', 'sessions', sessionId);
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }
      const hasChanges = historyMsgs?.some(m =>
        m.role === 'assistant' &&
        m.tool_calls?.some(tc => MUTATING_TOOLS.includes(tc.function.name))
      ) ?? false;
      const statusData: Record<string, unknown> = {
        status,
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        changes: hasChanges,
        model: currentConfig.model.model,
        provider: currentConfig.model.provider,
      };
      if (error) statusData.error = error;
      writeFileSync(join(sessionDir, 'status.json'), JSON.stringify(statusData, null, 2));
    } catch {
      // Silent: best-effort
    }
  }

  // Load persisted conversation + input history for this workspace
  try {
    if (options.clearHistory) {
      if (existsSync(historyPaths.conv)) {
        writeFileSync(historyPaths.conv, JSON.stringify([], null, 2));
      }
      history = [];
    } else if (existsSync(historyPaths.conv)) {
      const data = readFileSync(historyPaths.conv, 'utf-8');
      history = JSON.parse(data);
    }
    if (existsSync(historyPaths.input)) {
      const data = readFileSync(historyPaths.input, 'utf-8');
      inputHistory = JSON.parse(data);
    }
    // Save initial session trace (skip if empty — prevents session.json = [])
    if (history.length > 0) {
      saveSessionTrace(history);
    }
  } catch {
    // Start fresh
  }

  // --resume: replace history with the checkpoint's and annotate (#402).
  // The note uses role 'user': a system message after restored history
  // trips the message validator (system must lead the conversation).
  if (options.resumeCheckpoint) {
    const cp = options.resumeCheckpoint;
    history = JSON.parse(JSON.stringify(cp.history));
    const { formatResumeContext } = await import('./resume-command.js');
    history.push({ role: 'user', content: `[system note]\n${formatResumeContext(cp)}` });
    if (!options.quiet) {
      console.log(chalk.green(`\n✓ Resumed session ${cp.sessionId} from ${new Date(cp.timestamp).toLocaleString()} (${cp.history.length} messages, ${cp.iterations} iterations)\n`));
    }
  }

  // Load saved permissions (needed for banner display)
  let savedPerms: { mode: string; restoreOnStart: boolean } | undefined;
  if (options.autoApprove === undefined) {
    try {
      const { loadPermissions } = await import('../utils/permissions-store.js');
      savedPerms = loadPermissions();
      if (savedPerms.restoreOnStart) {
        currentPermissionMode = savedPerms.mode as 'ask_once' | 'always_ask' | 'unlimited';
      }
    } catch {
      // No saved permissions
    }
  }

  // Check storage limit on startup
  const configDir = join(homedir(), '.sc-agent');
  const storageInfo = checkStorageLimit(configDir);

  // Non-interactive mode: skip UI decorations if quiet flag is set.
  // --output-format json implies quiet: the manifest is the only stdout output.
  const isQuiet = options.quiet || options.outputFormat === 'json';
  const isNonInteractive = Boolean(options.initialPrompt);

  if (!isQuiet) {
    const tw = process.stdout.columns || 80;
    const outer = tw - 2;
    const colW = Math.floor((outer - 6) / 2);

    function row2(label1: string, val1: string, label2: string, val2: string): void {
      const t1 = `${label1} ${val1}`;
      const t2 = `${label2} ${val2}`;
      const fill1 = colW - t1.length + 2;
      console.log(chalk.cyan(`│ ${t1}${' '.repeat(Math.max(0, fill1))}${t2}${' '.repeat(Math.max(0, outer - 4 - t1.length - Math.max(0, fill1) - t2.length))} │`));
    }

    console.log(chalk.cyan(`┌${'─'.repeat(outer)}┐`));
    const title = `  ⚡ scc  —  SC-Agent CLI (v${packageVersion})`;
    console.log(chalk.cyan(`│ ${chalk.bold(title)}${' '.repeat(outer - title.length - 2)} │`));
    console.log(chalk.cyan(`├${'─'.repeat(outer)}┤`));

    // Row 1: Workspace (full width)
    const ws = `${chalk.gray('📁 Workspace')} ${chalk.white(options.workspaceRoot)}`;
    console.log(chalk.cyan(`│ ${ws}${' '.repeat(outer - ws.length - 2)} │`));

    // Row 2: Model + Storage
    row2(
      chalk.gray('🧠 Model'), chalk.white(trunc(currentConfig.model.model, colW - 10)),
      chalk.gray('💾 Storage'), chalk.white(`${formatBytes(storageInfo.currentSize)} / ${formatBytes(storageInfo.maxSize)}`)
    );

    // Row 3: Provider + History
    const providerShort = currentConfig.model.baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '');
    const historyLabel = history.length > 0 ? `${history.length} msgs (restored)` : `${history.length} msgs`;
    row2(
      chalk.gray('🔗 Provider'), chalk.white(trunc(providerShort, colW - 12)),
      chalk.gray('📋 History'), chalk.white(historyLabel)
    );

    // Row 4: Permissions
    const permLabel = chalk.gray('🔐 Permissions');
    let permVal: string;
    if (savedPerms?.restoreOnStart) {
      const modeLabel = savedPerms.mode === 'unlimited' ? 'Unlimited' : savedPerms.mode === 'always_ask' ? 'Always ask' : 'Ask once';
      permVal = chalk.white(`${modeLabel} (auto)`);
    } else if (options.autoApprove) {
      permVal = chalk.white('Unlimited (-y)');
    } else {
      permVal = chalk.white('Ask once');
    }
    const permRow = `${permLabel} ${permVal}`;
    console.log(chalk.cyan(`│ ${permRow}${' '.repeat(outer - permRow.length - 2)} │`));

    console.log(chalk.cyan(`├${'─'.repeat(outer)}┤`));
    const tips = 'exit/quit  /help  /hud  /permissions  /env  /model';
    console.log(chalk.cyan(`│ ${chalk.gray(tips)}${' '.repeat(outer - tips.length - 2)} │`));
    console.log(chalk.cyan(`└${'─'.repeat(outer)}┘\n`));

    if (storageInfo.usagePercent > 80 && !storageInfo.needsCleanup) {
      console.log(chalk.yellow(`⚠️  Storage usage at ${storageInfo.usagePercent.toFixed(1)}% — set SC_MAX_STORAGE_GB`));
    }
  }

  // Permission restore prompt (after banner, only if not auto-restored and mode was changed)
  if (options.autoApprove === undefined && savedPerms && !savedPerms.restoreOnStart && savedPerms.mode !== 'ask_once' && !isQuiet && !isNonInteractive) {
    const { savePermissions } = await import('../utils/permissions-store.js');
    const saved = savedPerms;
    const modeLabel = saved.mode === 'unlimited' ? 'Unlimited' : 'Always ask';
    const response = await prompts({
      type: 'select',
      name: 'choice',
      message: `Previous session had "${modeLabel}" permissions. Restore?`,
      choices: [
        { title: 'Yes', value: 'yes', description: `Use ${modeLabel} mode` },
        { title: 'No (ask once)', value: 'no', description: 'Start with default Ask once mode' },
        { title: "Don't ask again", value: 'always', description: 'Always restore last mode without asking' },
      ],
    });
    if (response.choice === 'yes' || response.choice === 'always') {
      currentPermissionMode = saved.mode as 'ask_once' | 'always_ask' | 'unlimited';
      console.log(chalk.gray(`\n  ✓ Restored: ${modeLabel}\n`));
    }
    if (response.choice === 'always') {
      savePermissions({ restoreOnStart: true });
      console.log(chalk.gray(`  ✓ Won't ask again. Use /permissions to change.\n`));
    }
    if (response.choice === 'no') {
      currentPermissionMode = 'ask_once';
    }
  }

  // Auto-cleanup if over limit
  if (storageInfo.needsCleanup) {
    enforceStorageLimit(configDir, true);
  }

  // Show status bar at bottom (only in interactive mode)
  if (!isNonInteractive && !isQuiet) {
    statusBar.show(getShortcutsBar());
  }

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    if (!isQuiet) {
      statusBar.hide();
      console.log(chalk.gray('\n\n╔════════════════════════════════════════════════════════════╗'));
      console.log(chalk.cyan('  👋 Goodbye!'));
      console.log(chalk.gray('╚════════════════════════════════════════════════════════════╝\n'));
    }
    process.exit(0);
  });

  // Non-interactive mode: process single prompt and exit
  if (isNonInteractive && options.initialPrompt) {
    const userInput = options.initialPrompt;

    if (!isQuiet) {
      console.log(chalk.blue(`\n${boxHeader('Prompt')}`));
      console.log(chalk.gray(`│ ${userInput}`));
      console.log(chalk.blue(boxFooter()));
    }

    verbose(`Prompt received: ${userInput.length} chars, ~${Math.ceil(userInput.length / 4)} tokens (estimated)`);
    verbose(`Batch mode: autoApprove=${!!options.autoApprove}, quiet=${!!isQuiet}`);

    // Save user message to session BEFORE API call
    const userMsg: Message = { role: 'user', content: userInput, timestamp: new Date().toISOString() };
    const preRunHistory = [...history, userMsg];
    saveSessionTrace(preRunHistory);

    // Process the prompt
    if (!isQuiet) {
      console.log(chalk.gray(`\n${boxHeader('Assistant')}`));
    }

    const batchStart = Date.now();
    let agentError: Error | undefined;
    try {
      history = await agent.run(userInput, history);
    } catch (err: any) {
      agentError = err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Categorize error code based on message content
      let errorCode = 'agent_run_error';
      if (/empty response/i.test(errorMsg)) {
        errorCode = 'empty_response';
      } else if (/fetch|network|timeout|abort|econnrefused|econnreset|api_error|5\d{2}/i.test(errorMsg)) {
        errorCode = 'api_error';
      }
      // Build minimal history with user message + error entry
      history = [
        ...history,
        userMsg,
        {
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
          metadata: {
            error: errorMsg,
            error_code: errorCode,
            model: currentConfig.model.model,
            provider: currentConfig.model.provider,
            prompt_tokens_estimated: Math.ceil(userInput.length / 4),
          },
        },
      ];
    }

    if (!isQuiet) {
      console.log(chalk.gray(`${boxFooter()}\n`));
      console.log(chalk.gray(`  🆔 ${sessionId}\n`));
    }

    // #415/#399: machine-readable run manifest — emitted as the LAST stdout
    // write in batch mode so `sc chat -q ... | tail -1 | jq` stays parseable.
    // With `--output-format json` it is the ONLY stdout write.
    const emitUsageSummary = (exitReason: 'success' | 'error' | 'no_changes' | 'budget_exceeded') => {
      const usage = agent.tokenTracker.getUsage();
      const stats = agent.getStats();
      const lastAssistant = [...history].reverse().find(
        m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0
      );
      const checkpointPath = join(homedir(), '.sc-agent', 'checkpoints', `${sessionId}.json`);
      const summary = {
        v: 1,
        success: exitReason === 'success',
        model: currentConfig.model.model,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        estimated_cost_usd: estimateCost(currentConfig.model.model, usage.inputTokens, usage.outputTokens),
        tool_calls: agent.getToolCallCounts(),
        tool_calls_total: stats.toolRunCount,
        iterations: stats.iterations,
        duration_ms: Date.now() - batchStart,
        exit_reason: exitReason,
        final_message: lastAssistant ? String(lastAssistant.content).slice(0, 4000) : null,
        checkpoint: existsSync(checkpointPath) ? checkpointPath : null,
      };
      for (const outPath of [options.summaryFile, options.outputFile]) {
        if (!outPath) continue;
        try {
          writeFileSync(resolve(outPath), JSON.stringify(summary, null, 2));
        } catch (e) {
          verboseError(`manifest write failed (${outPath}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      console.log(JSON.stringify(summary));
    };

    // Save session trace (always, even on error)
    saveSessionTrace(history);
    verboseSession(sessionId, history.length);

    // If agent errored, rethrow so caller sees non-zero exit
    if (agentError) {
      const errorMsg = agentError instanceof Error ? agentError.message : String(agentError);
      saveSessionStatus('error', errorMsg, history);
      verboseError(`Agent run failed: ${errorMsg}`);
      emitUsageSummary('error');
      throw agentError;
    }

    // Check for meaningful response
    const hasMeaningfulResponse = history.some(
      m => m.role === 'assistant' && m.content && m.content.trim().length > 0
    ) || history.some(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0);

    if (!hasMeaningfulResponse) {
      // Save again with explicit empty-response entry
      const emptyResponseMsg: Message = {
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        metadata: { warning: 'Model returned empty response', tokens_received: 0 },
      };
      history = [...history, emptyResponseMsg];
      saveSessionTrace(history);
      saveSessionStatus('no_changes', undefined, history);
      const noMeaningfulMsg = 'No meaningful response generated. The model may not support this prompt length or format.';
      verboseError(noMeaningfulMsg);
      emitUsageSummary('no_changes');
      throw new Error(noMeaningfulMsg);
    }

    // Budget exhaustion: run stopped early but gracefully — emit a
    // machine-greppable marker + distinct exit code (22 per #409 sketch),
    // preserving the partial-work summary instead of a SIGKILL.
    const budgetExceeded = agent.getStats().budgetExceeded;
    if (budgetExceeded) {
      saveSessionStatus('budget_exceeded', `budget:${budgetExceeded}`, history);
      console.log(`SC_BUDGET_EXCEEDED ${budgetExceeded}`);
      process.exitCode = 22;
      emitUsageSummary('budget_exceeded');
      return;
    }

    // Zero-mutation signal: run completed but never called a mutating tool
    // (model refused, answered read-only, or only ran inspections). Emit a
    // machine-greppable marker as the last stdout line and exit with the
    // documented no-changes code (10) — still a clean exit, caller decides.
    const hasMutations = history.some(m =>
      m.role === 'assistant' &&
      m.tool_calls?.some(tc => MUTATING_TOOLS.includes(tc.function.name))
    );
    if (!hasMutations) {
      saveSessionStatus('no_changes', undefined, history);
      console.log('SCC_NO_CHANGES');
      process.exitCode = 10;
      emitUsageSummary('no_changes');
      return;
    }

    // Success — write status and exit
    saveSessionStatus('success', undefined, history);
    emitUsageSummary('success');
    return;
  }

  // Interactive mode loop
  while (true) {
    // Show status bar as prompt indicator, then hide during raw-mode input
    if (!isQuiet) statusBar.show(getShortcutsBar());
    if (!isQuiet) {
      console.log(chalk.blue(`\n${boxHeader('You')}`));
    }
    if (!isQuiet) statusBar.hide();
    const userInput = await readUserInput(inputHistory, options.workspaceRoot);

    if (!userInput) {
      continue;
    }

    if (!isQuiet) {
      // Re-print the user's input with the proper prefix inside the You box, and close it
      const lines = userInput.split('\n');
      for (const line of lines) {
        console.log(chalk.blue('│ ') + line);
      }
      console.log(chalk.blue(boxFooter()));
    }

    // Add to input history (but not commands)
    if (!userInput.startsWith('/') && userInput.toLowerCase() !== 'exit' && userInput.toLowerCase() !== 'quit') {
      inputHistory.push(userInput);
    }

    if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
      statusBar.hide();
      console.log(chalk.gray('\n╔════════════════════════════════════════════════════════════╗'));
      console.log(chalk.cyan('  👋 Goodbye!'));
      console.log(chalk.gray('╚════════════════════════════════════════════════════════════╝\n'));
      break;
    }

    // Handle /help command
    if (userInput.toLowerCase() === '/help') {
      console.log(chalk.cyan('\n📖 Available Commands:\n'));
      console.log(chalk.white('  /help                          ') + chalk.gray('- Show this help message'));
      console.log(chalk.white('  /model                         ') + chalk.gray('- Switch to a different model'));
      console.log(chalk.white('  /permissions                   ') + chalk.gray('- Configure permission mode'));
      console.log(chalk.white('  /profile                       ') + chalk.gray('- Switch permission profile (traditional/blacklist)'));
      console.log(chalk.white('  /pre-approved-commands         ') + chalk.gray('- Setup pre-approved commands via interview'));
      console.log(chalk.white('  /storage                       ') + chalk.gray('- Show storage usage and cleanup options'));
      console.log(chalk.white('  /reload                        ') + chalk.gray('- Reload configuration from disk'));
      console.log(chalk.white('  /undo                          ') + chalk.gray('- Undo last exchange (stack-based)'));
      console.log(chalk.white('  /rollback <n>                  ') + chalk.gray('- Rollback to message index <n>'));
      console.log(chalk.white('  /session                       ') + chalk.gray('- Export/import session context'));
      console.log(chalk.white('  /checkpoint                    ') + chalk.gray('- Save/list/resume execution checkpoints'));
      console.log(chalk.white('  /clear                         ') + chalk.gray('- Clear conversation history'));
      console.log(chalk.white('  /memory                        ') + chalk.gray('- View/manage persistent memory'));
      console.log(chalk.white('  /config                        ') + chalk.gray('- Show full configuration details'));
      console.log(chalk.white('  /probe                         ') + chalk.gray('- Auto-detect repo toolchain, package manager, and commands'));
      console.log(chalk.white('  /hud                           ') + chalk.gray('- Toggle compact status bar'));
      console.log(chalk.white('  /env                           ') + chalk.gray('- Environment diagnostic (tools, shell, versions)'));
      console.log(chalk.white('  /info                          ') + chalk.gray('- Quick summary'));
      console.log(chalk.white('  exit, quit                     ') + chalk.gray('- End the chat session'));
      console.log(chalk.cyan('\n💡 Tools Available:\n'));
      console.log(chalk.gray('  • read_file     - Read file contents'));
      console.log(chalk.gray('  • write_file    - Create/overwrite files'));
      console.log(chalk.gray('  • edit_file     - Apply diffs to files'));
      console.log(chalk.gray('  • list_dir      - List directory contents'));
      console.log(chalk.gray('  • search_text   - Search text in files'));
      console.log(chalk.gray('  • run_shell     - Execute shell commands'));
      console.log(chalk.gray('  • web_fetch     - Fetch URL content (docs, APIs)'));
      console.log(chalk.gray('  • git           - Native git operations'));
      console.log(chalk.gray('  • repo_probe    - Probe repository toolchains & commands'));
      console.log(chalk.gray('  • memory_*      - Persistent cross-session memory'));
      console.log();
      continue;
    }

    // Handle /clear command
    if (userInput.toLowerCase() === '/clear') {
      history = [];
      saveSessionTrace(history);
      console.log(chalk.green('\n✓ Conversation history cleared\n'));
      continue;
    }

    // Handle /undo command
    if (userInput.toLowerCase() === '/undo') {
      if (historyCheckpoints.length === 0) {
        console.log(chalk.yellow('\n⚠ Nothing to undo\n'));
        continue;
      }
      const checkpoint = historyCheckpoints.pop()!;
      history = checkpoint;
      // Persist restored history + input history
      try {
        const dir = dirname(historyPaths.conv);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(historyPaths.conv, JSON.stringify(history, null, 2));
        writeFileSync(historyPaths.input, JSON.stringify(inputHistory, null, 2));
        saveSessionTrace(history);
      } catch {
        console.log(chalk.yellow('\n  ⚠️  Warning: Could not persist history to disk\n'));
      }
      console.log(chalk.green(`\n✓ Undone (${historyCheckpoints.length} checkpoint(s) remaining)\n`));
      continue;
    }

    // Handle /rollback command
    if (userInput.toLowerCase().startsWith('/rollback')) {
      const args = userInput.trim().split(/\s+/);
      if (args.length < 2 || isNaN(Number(args[1]))) {
        console.log(chalk.yellow('\n⚠ Usage: /rollback <message_index>\n'));
        continue;
      }
      const idx = parseInt(args[1], 10);
      if (idx < 0 || idx >= history.length) {
        console.log(chalk.yellow(`\n⚠ Index must be 0-${history.length - 1}\n`));
        continue;
      }
      historyCheckpoints.push(JSON.parse(JSON.stringify(history)));
      history = history.slice(0, idx);
      // Persist restored history + input history
      try {
        const dir = dirname(historyPaths.conv);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(historyPaths.conv, JSON.stringify(history, null, 2));
        writeFileSync(historyPaths.input, JSON.stringify(inputHistory, null, 2));
        saveSessionTrace(history);
      } catch {
        console.log(chalk.yellow('\n  ⚠️  Warning: Could not persist history to disk\n'));
      }
      console.log(chalk.green(`\n✓ Rolled back to message ${idx} (${history.length} messages remaining)\n`));
      continue;
    }

    // Handle /session export/import
    if (userInput.toLowerCase().startsWith('/session')) {
      const sessionArgs = userInput.trim().split(/\s+/);
      const sessionSub = sessionArgs[1]?.toLowerCase();

      if (sessionSub === 'export') {
        const exportPath = sessionArgs[2] || join(process.cwd(), `session-${Date.now()}.json`);
        try {
          const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
          const exportDir = dirname(exportPath);
          if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });
          const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            workspace: options.workspaceRoot,
            model: currentConfig.model.model,
            provider: currentConfig.model.baseUrl,
            profile: currentConfig.activeProfile || 'default',
            history,
            inputHistory,
          };
          writeFileSync(exportPath, JSON.stringify(payload, null, 2));
          console.log(chalk.green(`\n✓ Session exported to ${exportPath} (${history.length} messages)\n`));
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`\n✗ Export failed: ${errorMsg}\n`));
        }
      } else if (sessionSub === 'import') {
        const importPath = sessionArgs[2];
        if (!importPath) {
          console.log(chalk.yellow('\n⚠ Usage: /session import <path-to-session.json>\n'));
          continue;
        }
        try {
          const { readFileSync, existsSync } = await import('node:fs');
          if (!existsSync(importPath)) {
            console.log(chalk.yellow(`\n⚠ File not found: ${importPath}\n`));
            continue;
          }
          const data = JSON.parse(readFileSync(importPath, 'utf-8'));
          if (!data.version || !Array.isArray(data.history)) {
            console.log(chalk.yellow('\n⚠ Invalid session file format\n'));
            continue;
          }
          historyCheckpoints.push(JSON.parse(JSON.stringify(history))); // Save checkpoint before importing
          history = data.history;
          inputHistory = data.inputHistory || [];
          // Persist imported history
          try {
            const dir = dirname(historyPaths.conv);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(historyPaths.conv, JSON.stringify(history, null, 2));
            writeFileSync(historyPaths.input, JSON.stringify(inputHistory, null, 2));
            saveSessionTrace(history);
          } catch {
            console.log(chalk.yellow('\n  ⚠️  Warning: Could not persist history to disk\n'));
          }
          const importedFrom = data.model ? ` (model: ${data.model})` : '';
          console.log(chalk.green(`\n✓ Session imported${importedFrom} — ${history.length} messages restored\n`));
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`\n✗ Import failed: ${errorMsg}\n`));
        }
      } else if (sessionSub === 'info') {
        const info = {
          messages: history.length,
          inputHistory: inputHistory.length,
          workspace: options.workspaceRoot,
          model: currentConfig.model.model,
          provider: currentConfig.model.baseUrl,
          profile: currentConfig.activeProfile || 'default',
        };
        console.log(chalk.cyan('\n📦 Session Info'));
        console.log(chalk.gray(`  Messages:     ${info.messages}`));
        console.log(chalk.gray(`  Input saved:  ${info.inputHistory}`));
        console.log(chalk.gray(`  Workspace:    ${info.workspace}`));
        console.log(chalk.gray(`  Model:        ${info.model}`));
        console.log(chalk.gray(`  Provider:     ${info.provider}`));
        console.log(chalk.gray(`  Profile:      ${info.profile}`));
        console.log(chalk.gray(`  Usage:        /session export [path]`));
        console.log(chalk.gray(`                /session import <path>\n`));
      } else {
        console.log(chalk.cyan('\n📦 Session Commands'));
        console.log(chalk.gray('  /session export [path]   - Export session to file'));
        console.log(chalk.gray('  /session import <path>   - Import session from file'));
        console.log(chalk.gray('  /session info            - Show session details\n'));
      }
      continue;
    }

    // Handle /checkpoint command (save/resume long-running sessions)
    if (userInput.toLowerCase().startsWith('/checkpoint')) {
      const cpArgs = userInput.trim().split(/\s+/);
      const cpSub = cpArgs[1]?.toLowerCase();

      if (cpSub === 'save') {
        try {
          const { saveCheckpoint } = await import('../utils/checkpoint.js');
          const path = saveCheckpoint({
            sessionId,
            workspaceRoot: options.workspaceRoot,
            history,
            inputHistory,
            iterations: agent.getStats().iterations,
            toolRunCount: agent.getStats().toolRunCount,
          });
          console.log(chalk.green(`\n✓ Checkpoint saved (${history.length} messages, ${agent.getStats().iterations} iterations)\n`));
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`\n✗ Checkpoint failed: ${errorMsg}\n`));
        }
      } else if (cpSub === 'resume') {
        try {
          const { findResumeCheckpoint, formatResumeContext } = await import('./resume-command.js');
          const cp = await findResumeCheckpoint(options.workspaceRoot);
          if (!cp) {
            console.log(chalk.yellow('\n⚠ No checkpoint found for this workspace.\n'));
          } else {
            history = JSON.parse(JSON.stringify(cp.history));
            const resumeMsg = formatResumeContext(cp);
            history.push({ role: 'user', content: `[system note]\n${resumeMsg}` });
            console.log(chalk.green(`\n✓ Resumed session from ${new Date(cp.timestamp).toLocaleString()} (${cp.history.length} messages restored)\n`));
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`\n✗ Resume failed: ${errorMsg}\n`));
        }
      } else if (cpSub === 'list') {
        try {
          const { listCheckpoints, printCheckpointInfo } = await import('../utils/checkpoint.js');
          const all = listCheckpoints().filter(c => c.workspaceRoot === options.workspaceRoot);
          if (all.length === 0) {
            console.log(chalk.gray('\n  No checkpoints for this workspace\n'));
          } else {
            console.log(chalk.cyan(`\n📦 Checkpoints (${all.length}):\n`));
            for (const cp of all) {
              printCheckpointInfo(cp);
              console.log();
            }
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`\n✗ Error: ${errorMsg}\n`));
        }
      } else {
        console.log(chalk.cyan('\n📦 Checkpoint Commands\n'));
        console.log(chalk.gray('  /checkpoint save          - Save execution checkpoint'));
        console.log(chalk.gray('  /checkpoint list          - Show saved checkpoints'));
        console.log(chalk.gray('  /checkpoint resume        - Restore last checkpoint for this workspace'));
        console.log(chalk.gray('\n  Checkpoints auto-save every 5 iterations.\n'));
      }
      continue;
    }

    // Handle /hud command (toggle, fields, or field config)
    if (userInput.toLowerCase().startsWith('/hud')) {
      const hudArgs = userInput.trim().split(/\s+/);
      const hudSub = hudArgs[1]?.toLowerCase();

      if (hudSub === 'fields') {
        // Interactive field picker
        const current = hudFields;
        const { ALL_HUD_FIELDS } = await import('../utils/settings.js');
        const choices = ALL_HUD_FIELDS.map(f => ({
          title: f,
          value: f,
          selected: current.includes(f),
        }));
        const sel = await prompts({
          type: 'multiselect',
          name: 'fields',
          message: 'Select HUD fields to show:',
          choices,
          instructions: false,
        });
        if (sel.fields && sel.fields.length > 0) {
          hudFields = sel.fields;
          const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { homedir } = await import('node:os');
          const configPath = join(homedir(), '.sc-agent', 'config.json');
          const configDir = join(homedir(), '.sc-agent');
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
          let cfg: Record<string, unknown> = {};
          if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (!cfg.settings) cfg.settings = {};
          (cfg.settings as Record<string, unknown>).hudFields = hudFields;
          writeFileSync(configPath, JSON.stringify(cfg, null, 2));
          console.log(chalk.green(`\n✓ HUD fields: ${hudFields.join(', ')}\n`));
        } else {
          console.log(chalk.gray('\n  Fields unchanged\n'));
        }
      } else if (hudSub === 'list') {
        console.log(chalk.cyan('\n📊 HUD Configuration'));
        console.log(chalk.gray(`  Enabled: ${hudEnabled ? 'yes' : 'no'}`));
        console.log(chalk.gray(`  Fields:  ${hudFields.join(', ')}`));
        console.log(chalk.gray(`  Usage:   /hud          - toggle on/off`));
        console.log(chalk.gray(`           /hud fields    - select which fields to show`));
        console.log(chalk.gray(`           /hud list      - show current HUD config\n`));
      } else {
        // Toggle on/off
        hudEnabled = !hudEnabled;
        const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        const configPath = join(homedir(), '.sc-agent', 'config.json');
        const configDir = join(homedir(), '.sc-agent');
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
        let cfg: Record<string, unknown> = {};
        if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (!cfg.settings) cfg.settings = {};
        (cfg.settings as Record<string, unknown>).hud = hudEnabled;
        writeFileSync(configPath, JSON.stringify(cfg, null, 2));

        if (hudEnabled) {
          console.log(chalk.cyan('\n📊 HUD enabled'));
          console.log(chalk.gray(`  Fields: ${hudFields.join(' | ')}`));
          console.log(chalk.gray('  Set SC_HUD=false to disable via env'));
          console.log(chalk.gray('  Use /hud fields to customize, /hud list for details\n'));
        } else {
          console.log(chalk.yellow('\n📊 HUD disabled'));
          console.log(chalk.gray('  Set SC_HUD=true to re-enable via env'));
          console.log(chalk.gray('  Or use /hud again\n'));
        }
      }
      continue;
    }

    // Handle /env command - environment diagnostic
    if (userInput.toLowerCase() === '/env') {
      try {
        const { detectShell } = await import('../utils/shell-env.js');
        const shellInfo = detectShell();
        const { checkStorageLimit, formatBytes } = await import('../utils/storage-limit.js');
        const storageInfo = checkStorageLimit(join(homedir(), '.sc-agent'));

        console.log(chalk.cyan('\n🔍 Environment Diagnostic'));
        console.log(chalk.gray('═'.repeat(50)));

        console.log(chalk.gray('\n📋 Shell'));
        console.log(chalk.gray(`  Type:     ${shellInfo.type}`));
        console.log(chalk.gray(`  Platform: ${process.platform}`));
        console.log(chalk.gray(`  Arch:     ${process.arch}`));
        console.log(chalk.gray(`  Node:     ${process.version}`));

        console.log(chalk.gray('\n🔧 Tools'));
        const tools = shellInfo.tools;
        for (const [name, available] of Object.entries(tools)) {
          const icon = available ? chalk.green('✓') : chalk.red('✗');
          console.log(chalk.gray(`  ${icon} ${name}`));
        }

        console.log(chalk.gray('\n💾 Storage'));
        console.log(chalk.gray(`  ${formatBytes(storageInfo.currentSize)} / ${formatBytes(storageInfo.maxSize)} (${storageInfo.usagePercent.toFixed(1)}%)`));

        console.log(chalk.gray('\n📂 Workspace'));
        console.log(chalk.gray(`  ${options.workspaceRoot}`));

        console.log(chalk.gray('\n🌐 Config'));
        console.log(chalk.gray(`  ~/.sc-agent/config.json`));
        console.log(chalk.gray(`  Active profile: ${currentConfig.activeProfile || 'none'}`));
        console.log(chalk.gray(`  Model: ${currentConfig.model.model}`));
        console.log();
      } catch {
        console.log(chalk.red('\n⚠️  Environment diagnostic failed\n'));
      }
      continue;
    }

    // Handle /probe command - auto-detect repo profile and toolchain
    if (userInput.toLowerCase().startsWith('/probe') || userInput.toLowerCase().startsWith('/repo')) {
      try {
        const { probeRepo, formatRepoProfileForTerminal, formatRepoProfileJSON } = await import('../core/repo-probe/index.js');
        const isJson = userInput.includes('--json') || userInput.includes(' json');
        const isRefresh = userInput.includes('--refresh') || userInput.includes(' refresh') || userInput.includes('--no-cache');
        const profile = await probeRepo(options.workspaceRoot, {
          forceRefresh: isRefresh,
          useCache: !isRefresh,
        });
        if (isJson) {
          console.log(formatRepoProfileJSON(profile));
        } else {
          console.log(formatRepoProfileForTerminal(profile));
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n✗ Probe failed: ${errorMsg}\n`));
      }
      continue;
    }

    // Handle /memory command
    if (userInput.toLowerCase().startsWith('/memory')) {
      try {
        const args = userInput.trim().split(/\s+/);
        const subcommand = args[1]?.toLowerCase();

        if (subcommand === 'clear') {
          await persistentMemory.clear();
          console.log(chalk.green('\n✓ All persistent memories cleared\n'));
        } else if (subcommand === 'forget' && args[2]) {
          const key = args.slice(2).join(' ');
          const removed = await persistentMemory.forget(key);
          if (removed) {
            console.log(chalk.green(`\n✓ Forgotten memory: "${key}"\n`));
          } else {
            console.log(chalk.yellow(`\n⚠ No memory found with key: "${key}"\n`));
          }
        } else if (subcommand === 'show' && args[2]) {
          const key = args.slice(2).join(' ');
          const content = await persistentMemory.recall(key);
          if (content) {
            console.log(chalk.cyan(`\n📝 Memory: ${key}\n`));
            console.log(chalk.gray(content));
            console.log();
          } else {
            console.log(chalk.yellow(`\n⚠ No memory found with key: "${key}"\n`));
          }
        } else {
          // Show summary
          const summary = await persistentMemory.getSummary();
          console.log(chalk.cyan(`\n${summary}\n`));

          if (summary !== 'No stored memories.') {
            console.log(chalk.gray('Commands:'));
            console.log(chalk.gray('  /memory show <key>   - View a specific memory'));
            console.log(chalk.gray('  /memory forget <key> - Remove a memory'));
            console.log(chalk.gray('  /memory clear        - Remove all memories'));
            console.log();
          }
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n✗ Error: ${errorMsg}\n`));
      }
      continue;
    }

    // Handle /permissions command
    if (userInput.toLowerCase() === '/permissions') {
      try {
        const { loadPermissions, savePermissions } = await import('../utils/permissions-store.js');
        const savedPerms = loadPermissions();

        const permChoices = [
          {
            title: 'Ask once per tool (recommended)',
            value: 'ask_once',
            description: 'Prompt once per unique tool, then auto-approve for session'
          },
          {
            title: 'Always ask (safer)',
            value: 'always_ask',
            description: 'Prompt every time a tool is used'
          },
          {
            title: 'Unlimited (dangerous)',
            value: 'unlimited',
            description: 'Auto-approve all tools without asking'
          },
        ];

        // Add toggle for auto-restore on session start
        if (savedPerms.restoreOnStart) {
          permChoices.push({
            title: 'Disable auto-restore on session start',
            value: 'no_restore',
            description: 'Ask me what to do each time I start a new session'
          });
        } else {
          permChoices.push({
            title: 'Auto-restore on session start',
            value: 'auto_restore',
            description: 'Always restore last permission mode without asking'
          });
        }

        const permissionMode = await prompts({
          type: 'select',
          name: 'mode',
          message: `Select (current: ${currentPermissionMode}):`,
          choices: permChoices,
          initial: 0,
        });

        if (!permissionMode.mode) {
          console.log(chalk.gray('\nCancelled\n'));
          continue;
        }

        const selectedMode = permissionMode.mode as string;

        // Handle restore toggle options
        if (selectedMode === 'no_restore') {
          savePermissions({ restoreOnStart: false });
          console.log(chalk.gray('\n✓ Auto-restore disabled. You will be asked on next session start.\n'));
          continue;
        }
        if (selectedMode === 'auto_restore') {
          savePermissions({ restoreOnStart: true });
          console.log(chalk.gray('\n✓ Auto-restore enabled. Last mode will be restored silently.\n'));
          continue;
        }

        // Update agent with new permission mode
        currentPermissionMode = selectedMode as 'ask_once' | 'always_ask' | 'unlimited';
        savePermissions({ mode: currentPermissionMode, sessionTools: [] });

        if (selectedMode === 'unlimited') {
          agent = new Agent({
            ...options,
            config: currentConfig,
            autoApprove: true,
          });
          console.log(chalk.yellow('\n⚠️  Permission mode: Unlimited (dangerous)'));
          console.log(chalk.gray('   All tools will auto-approve without asking'));
          console.log(chalk.gray('   Use with caution!\n'));
        } else if (selectedMode === 'always_ask') {
          // Clear any session permissions when switching to always ask
          clearSessionPermissions();
          agent = new Agent({
            ...options,
            config: currentConfig,
            autoApprove: false,
          });
          console.log(chalk.green('\n✓ Permission mode: Always ask (safer)'));
          console.log(chalk.gray('   You will be prompted for every tool use\n'));
        } else {
          // ask_once - default behavior with session tracking
          agent = new Agent({
            ...options,
            config: currentConfig,
            autoApprove: false,
          });
          console.log(chalk.cyan('\n✓ Permission mode: Ask once per tool (recommended)'));
          console.log(chalk.gray('   First use of each tool prompts, then auto-approves for session\n'));
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n✗ Error: ${errorMsg}\n`));
      }
      continue;
    }

    // Handle /profile command
    if (userInput.toLowerCase() === '/profile') {
      try {
        const currentProfile = currentConfig.permissions?.profile || 'traditional';

        console.log(chalk.cyan('\n🔒 Permission Profile\n'));
        console.log(chalk.gray('Choose how permission requests are handled:\n'));

        const profileChoice = await prompts({
          type: 'select',
          name: 'profile',
          message: 'Select permission profile:',
          choices: [
            {
              title: `Traditional ${currentProfile === 'traditional' ? '(current)' : ''}`,
              value: 'traditional',
              description: 'Ask for every tool use (default behavior)',
            },
            {
              title: `Blacklist ${currentProfile === 'blacklist' ? '(current)' : ''}`,
              value: 'blacklist',
              description: 'Only ask for dangerous commands (rm, sudo, etc.)',
            },
          ],
          initial: currentProfile === 'traditional' ? 0 : 1,
        });

        if (!profileChoice.profile) {
          console.log(chalk.gray('\nCancelled\n'));
          continue;
        }

        // Save to config
        try {
          const fs = await import('node:fs');
          const path = await import('node:path');
          const { homedir } = await import('node:os');

          const configPath = path.join(homedir(), '.sc-agent', 'config.json');
          const configDir = path.dirname(configPath);

          if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
          }

          let config: Record<string, unknown> = {};
          if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, 'utf-8');
            config = JSON.parse(configContent);
          }

          if (!config.permissions) {
            config.permissions = {};
          }
          (config.permissions as {profile?: string}).profile = profileChoice.profile;

          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

          // Update current config
          if (!currentConfig.permissions) {
            currentConfig.permissions = {};
          }
          currentConfig.permissions.profile = profileChoice.profile;

          // Recreate agent with new config
          agent = new Agent({
            ...options,
            config: currentConfig,
            autoApprove: currentPermissionMode === 'unlimited',
          });

          if (profileChoice.profile === 'traditional') {
            console.log(chalk.green('\n✓ Permission profile: Traditional'));
            console.log(chalk.gray('   You will be asked for permission for every tool use'));
            console.log(chalk.gray('   Configure auto-approve with /pre-approved-commands\n'));
          } else {
            console.log(chalk.green('\n✓ Permission profile: Blacklist'));
            console.log(chalk.gray('   Only dangerous commands will require permission:'));
            console.log(chalk.gray('   • File deletion (rm, del)'));
            console.log(chalk.gray('   • Privilege escalation (sudo, su)'));
            console.log(chalk.gray('   • Network operations (curl | bash)'));
            console.log(chalk.gray('   • System config (chmod, crontab)'));
            console.log(chalk.gray('   • And more...'));
            console.log(chalk.gray('\n   Safe commands auto-approve automatically\n'));
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`\n✗ Error saving config: ${errorMsg}\n`));
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n✗ Error: ${errorMsg}\n`));
      }
      continue;
    }

    // Handle /pre-approved-commands command
    if (userInput.toLowerCase() === '/pre-approved-commands' || userInput.toLowerCase() === '/pre-approved-commands-interview') {
      try {
        console.log(chalk.cyan('\n📋 Pre-Approved Commands Interview\n'));
        console.log(chalk.gray('Answer a few questions to configure which tools can auto-approve.'));
        console.log(chalk.gray('This will update your config file for future sessions.\n'));

        const preApprovedTools: string[] = [];

        // Question 1: Read-only operations
        const q1 = await prompts({
          type: 'confirm',
          name: 'value',
          message: 'Allow reading files and listing directories without asking?',
          initial: true,
        });
        if (q1.value) {
          preApprovedTools.push('read_file', 'list_dir', 'search_text');
          console.log(chalk.gray('  ✓ Added: read_file, list_dir, search_text\n'));
        }

        // Question 2: Writing files
        const q2 = await prompts({
          type: 'confirm',
          name: 'value',
          message: `Allow writing/editing files in this directory (${options.workspaceRoot})?`,
          initial: false,
        });
        if (q2.value) {
          preApprovedTools.push('write_file', 'edit_file');
          console.log(chalk.gray('  ✓ Added: write_file, edit_file\n'));
        }

        // Question 3: Shell commands (non-admin)
        const q3 = await prompts({
          type: 'confirm',
          name: 'value',
          message: 'Allow executing shell commands (non-admin, e.g., npm, git)?',
          initial: false,
        });
        if (q3.value) {
          preApprovedTools.push('run_shell');
          console.log(chalk.gray('  ✓ Added: run_shell\n'));
        }

        // Question 4: Git operations
        const q4 = await prompts({
          type: 'confirm',
          name: 'value',
          message: 'Common git operations (status, diff, log) without asking?',
          initial: true,
        });
        if (q4.value) {
          console.log(chalk.gray('  ℹ️  Git operations use run_shell (already configured)\n'));
        }

        // Question 5: Package manager
        const q5 = await prompts({
          type: 'confirm',
          name: 'value',
          message: 'Common package manager operations (npm install, build, test)?',
          initial: false,
        });
        if (q5.value) {
          console.log(chalk.gray('  ℹ️  Package operations use run_shell (already configured)\n'));
        }

        // Question 6: Summary
        console.log(chalk.cyan('\n📊 Summary:\n'));
        if (preApprovedTools.length === 0) {
          console.log(chalk.yellow('  No tools will be auto-approved'));
          console.log(chalk.gray('  You will be asked for permission every time\n'));
        } else {
          console.log(chalk.green(`  ${preApprovedTools.length} tool(s) will be auto-approved:`));
          preApprovedTools.forEach(tool => {
            console.log(chalk.gray(`    • ${tool}`));
          });
          console.log();
        }

        // Question 7: Confirm
        const confirm = await prompts({
          type: 'confirm',
          name: 'value',
          message: 'Save this configuration permanently?',
          initial: true,
        });

        if (confirm.value) {
          // Save to config
          try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const { homedir } = await import('node:os');

            const configPath = path.join(homedir(), '.sc-agent', 'config.json');

            // Ensure directory exists
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
              fs.mkdirSync(configDir, { recursive: true });
            }

            // Read existing config or create new
            let config: Record<string, unknown> = {};
            if (fs.existsSync(configPath)) {
              const configContent = fs.readFileSync(configPath, 'utf-8');
              config = JSON.parse(configContent);
            }

            // Update permissions
            if (!config.permissions) {
              config.permissions = {};
            }
            (config.permissions as {autoApprove?: string[]}).autoApprove = preApprovedTools;

            // Write config
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

            console.log(chalk.green('\n✓ Configuration saved to:'));
            console.log(chalk.gray(`  ${configPath}\n`));

            // Reload config
            const reloadedConfig = await loadConfig(options.workspaceRoot);
            currentConfig = reloadedConfig;

            agent = new Agent({
              ...options,
              config: currentConfig,
              autoApprove: false,
            });

            console.log(chalk.cyan('✓ Configuration reloaded'));
            console.log(chalk.gray('  Pre-approved tools are now active\n'));
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(`\n✗ Error saving config: ${errorMsg}\n`));
          }
        } else {
          console.log(chalk.gray('\n  Configuration not saved\n'));
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n✗ Error: ${errorMsg}\n`));
      }
      continue;
    }

    // Handle /storage command
    if (userInput.toLowerCase() === '/storage') {
      try {
        const configDir = join(homedir(), '.sc-agent');
        const info = checkStorageLimit(configDir);

        console.log(chalk.cyan('\n💾 Storage Usage:\n'));
        console.log(chalk.white('  Current:   ') + chalk.gray(formatBytes(info.currentSize)));
        console.log(chalk.white('  Limit:     ') + chalk.gray(formatBytes(info.maxSize)));
        console.log(chalk.white('  Usage:     ') + (
          info.usagePercent > 90 ? chalk.red(`${info.usagePercent.toFixed(1)}%`) :
          info.usagePercent > 80 ? chalk.yellow(`${info.usagePercent.toFixed(1)}%`) :
          chalk.green(`${info.usagePercent.toFixed(1)}%`)
        ));
        console.log(chalk.white('  Directory: ') + chalk.gray(configDir));
        console.log();

        if (info.needsCleanup) {
          console.log(chalk.red('⚠️  Storage limit exceeded!\n'));

          const cleanup = await prompts({
            type: 'confirm',
            name: 'value',
            message: 'Clean up old files now?',
            initial: true,
          });

          if (cleanup.value) {
            enforceStorageLimit(configDir, true);
          }
        } else if (info.usagePercent > 80) {
          console.log(chalk.yellow('💡 Tips:\n'));
          for (const tip of getStorageGuidance()) {
            console.log(chalk.gray(tip));
          }
          console.log();
        } else {
          console.log(chalk.green('✓ Storage usage is healthy\n'));
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n✗ Error: ${errorMsg}\n`));
      }
      continue;
    }

    // Handle /reload command
    if (userInput.toLowerCase() === '/reload') {
      try {
        console.log(chalk.cyan('\n♻️  Reloading configuration...\n'));

        // Reload config from disk
        const reloadedConfig = await loadConfig(options.workspaceRoot);
        currentConfig = reloadedConfig;

        // Override with env var if available
        const envApiKey = process.env.SC_API_KEY
          || process.env.OPENAI_API_KEY
          || process.env.ANTHROPIC_API_KEY
          || process.env.NVIDIA_API_KEY;
        if (envApiKey) {
          currentConfig.model.apiKey = envApiKey;
        }

        // Create new agent with reloaded config
        agent = new Agent({
          ...options,
          config: currentConfig,
        });

        console.log(chalk.green('✓ Configuration reloaded successfully!'));
        console.log(chalk.gray(`  Active profile: ${currentConfig.activeProfile || 'none'}`));
        console.log(chalk.gray(`  Model: ${currentConfig.model.model}`));
        console.log(chalk.yellow('\n💡 Tip: Conversation history preserved. Use /clear to reset.\n'));
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n✗ Error reloading config: ${errorMsg}\n`));
      }
      continue;
    }

    // Handle /config command (comprehensive config view)
    if (userInput.toLowerCase() === '/config') {
      await showConfig(currentConfig, {
        permissionMode: currentPermissionMode,
        historyLength: history.length,
      });
      continue;
    }

    // Handle /info command (short summary)
    if (userInput.toLowerCase() === '/info') {
      console.log(chalk.cyan('\n📋 Quick Info:\n'));
      console.log(chalk.white('  Profile:     ') + chalk.green(currentConfig.activeProfile || 'none'));
      console.log(chalk.white('  Model:       ') + chalk.gray(currentConfig.model.model));
      console.log(chalk.white('  Provider:    ') + chalk.gray(currentConfig.model.baseUrl));
      console.log(chalk.white('  Permissions: ') + (
        currentPermissionMode === 'unlimited' ? chalk.yellow('Unlimited') :
        currentPermissionMode === 'always_ask' ? chalk.green('Always ask') :
        chalk.cyan('Ask once')
      ));
      console.log(chalk.white('  History:     ') + chalk.gray(`${history.length} messages`));
      console.log(chalk.white('  Tools:       ') + chalk.gray('10 available (see /config for details)'));
      console.log();
      continue;
    }

    // Handle /model command
    if (userInput.toLowerCase() === '/model') {
      try {
        const config = await loadConfig(options.workspaceRoot);
        const profiles = config.profiles || {};
        const profileNames = Object.keys(profiles);

        if (profileNames.length === 0) {
          console.log();
          getModelProfileEmptyStateGuidance().forEach((line, index) => {
            const color = index === 0 ? chalk.yellow : chalk.gray;
            console.log(color(line));
          });
          console.log();
          continue;
        }

        const choices = profileNames.map((name) => ({
          title: `${name}${name === config.activeProfile ? ' (current)' : ''} - ${profiles[name]?.model || 'unknown'}`,
          value: name,
        }));

        const selection = await prompts({
          type: 'select',
          name: 'profile',
          message: 'Select a model profile:',
          choices,
        });

        if (!selection.profile) {
          console.log(chalk.gray('\nCancelled\n'));
          continue;
        }

        // Apply the selected profile
        const selectedProfile = profiles[selection.profile];
        if (!selectedProfile) {
          console.log(chalk.red(`\nProfile "${selection.profile}" not found\n`));
          continue;
        }

        currentConfig.model = { ...currentConfig.model, ...selectedProfile };
        currentConfig.activeProfile = selection.profile;

        // Override with env var if available
        const envApiKey = process.env.SC_API_KEY
          || process.env.OPENAI_API_KEY
          || process.env.ANTHROPIC_API_KEY
          || process.env.NVIDIA_API_KEY;
        if (envApiKey) {
          currentConfig.model.apiKey = envApiKey;
        }

        // Create new agent with updated config
        agent = new Agent({
          ...options,
          config: currentConfig,
        });

        console.log(chalk.green(`\n✓ Switched to: ${selection.profile}`));
        console.log(chalk.gray(`  Model: ${currentConfig.model.model}`));
        console.log(chalk.gray(`  Provider: ${currentConfig.model.baseUrl}`));
        console.log(chalk.gray(`  History: ${history.length} messages preserved for continuity\n`));

        // Ask to save as default for future sessions
        const saveDefault = await prompts({
          type: 'confirm',
          name: 'value',
          message: 'Save as default for future sessions?',
          initial: false,
        });

        if (saveDefault.value) {
          try {
            const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs');
            const { join } = await import('node:path');
            const { homedir } = await import('node:os');
            const configPath = join(homedir(), '.sc-agent', 'config.json');
            const configDir = join(homedir(), '.sc-agent');
            if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
            let cfg: Record<string, unknown> = {};
            if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
            cfg.activeProfile = selection.profile;
            writeFileSync(configPath, JSON.stringify(cfg, null, 2));
            console.log(chalk.gray(`  ✓ Saved "${selection.profile}" as default\n`));
          } catch {
            console.log(chalk.gray(`  ⚠️  Could not save to config\n`));
          }
        } else {
          console.log();
        }

      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n✗ Error: ${errorMsg}\n`));
      }
      continue;
    }

    try {
      // Save checkpoint before agent run
      historyCheckpoints.push(JSON.parse(JSON.stringify(history)));
      if (!isQuiet) {
        console.log(chalk.green(`\n${boxHeader('Assistant')}`));
      }
      history = await agent.run(userInput, history);
      // Persist conversation + input history for cross-session/workspace continuity
      try {
        const dir = dirname(historyPaths.conv);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(historyPaths.conv, JSON.stringify(history, null, 2));
        writeFileSync(historyPaths.input, JSON.stringify(inputHistory, null, 2));
        saveSessionTrace(history);
      } catch {
        console.log(chalk.yellow('\n  ⚠️  Warning: Could not persist conversation history\n'));
      }
      if (!isQuiet) {
        console.log(chalk.green(`\n${boxFooter()}`));
      }

      // HUD: compact status line with configurable fields
      if (hudEnabled && !isQuiet) {
        const mem = await persistentMemory.getAll();
        const storage = checkStorageLimit(join(homedir(), '.sc-agent'));
        const permIcon = currentPermissionMode === 'unlimited' ? '∞' : currentPermissionMode === 'always_ask' ? '🔔' : '✓';
        const profileIcon = currentConfig.permissions?.profile === 'blacklist' ? '🛡️' : '🔒';
        const modelShort = currentConfig.model.model.length > 16
          ? currentConfig.model.model.substring(0, 14) + '..'
          : currentConfig.model.model;
        const msgCount = history.filter(m => m.role === 'assistant').length;
        const stats = agent.getStats();
        const tokenUsage = agent.tokenTracker.formatShort();

        const fieldParts: Record<string, string> = {
          model: chalk.cyan(modelShort),
          profile: chalk.gray(`@${currentConfig.activeProfile || 'default'}`),
          memories: chalk.gray(`🧠${mem.length}`),
          messages: chalk.gray(`💬${msgCount}`),
          storage: chalk.gray(`💾${formatBytes(storage.currentSize)}`),
          permissions: `${profileIcon}${permIcon}`,
          tokens: chalk.magenta(tokenUsage),
          iterations: chalk.cyan(`🔄${stats.iterations}`),
          cost: chalk.yellow(`💰${agent.tokenTracker.getEstimatedCost().toFixed(4)}`),
        };
        const parts = hudFields.filter(f => f in fieldParts).map(f => fieldParts[f]);
        parts.push(chalk.yellow(`🆔 ${sessionId}`));

        if (parts.length > 0) {
          console.log(chalk.gray(`  ${parts.join(chalk.dim(' │ '))}\n`));
        }
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`\n✗ Error: ${errorMsg}\n`));
    }
  }
}
