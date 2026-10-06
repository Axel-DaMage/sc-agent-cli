import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isMutatingShellCommand,
  isMutatingToolCall,
  isWorkspaceMutatingToolCall,
  countMutatingToolCalls,
  getWorkspaceGitState,
  hasWorktreeChanges,
  detectSessionMutations,
  expectsWorkspaceMutation,
  declaresNoChangesNeeded,
} from './mutation-detector.js';
import type { Message } from '../core/types.js';

test('isMutatingShellCommand detects output redirection', () => {
  assert.equal(isMutatingShellCommand('echo "hello" > file.txt'), true);
  assert.equal(isMutatingShellCommand('echo "hello" >> file.txt'), true);
  assert.equal(isMutatingShellCommand('cat << "EOF" > test.ts\nconst x = 1;\nEOF'), true);
  assert.equal(isMutatingShellCommand('cat << \'EOF\' > test.ts'), true);
  assert.equal(isMutatingShellCommand('printf "data" > out.log'), true);
  assert.equal(isMutatingShellCommand('cat data.txt | tee output.txt'), true);
  assert.equal(isMutatingShellCommand('cat data.txt | tee -a output.txt'), true);
});

test('isMutatingShellCommand ignores harmless descriptor redirects and dev/null', () => {
  assert.equal(isMutatingShellCommand('ls -la > /dev/null'), false);
  assert.equal(isMutatingShellCommand('grep -rn "pattern" . 2>/dev/null'), false);
  assert.equal(isMutatingShellCommand('find . -name "*.ts" > /dev/null 2>&1'), false);
  assert.equal(isMutatingShellCommand('cmd > /dev/null 2>&1'), false);
  assert.equal(isMutatingShellCommand('cmd 2>&1'), false);
  assert.equal(isMutatingShellCommand('echo "hello > world"'), false);
  assert.equal(isMutatingShellCommand('grep ">" file.txt 2>/dev/null'), false);
  assert.equal(isMutatingShellCommand('cat data.txt | tee /dev/null'), false);
});

test('isMutatingShellCommand detects stream editors and patchers', () => {
  assert.equal(isMutatingShellCommand("sed -i 's/foo/bar/g' file.txt"), true);
  assert.equal(isMutatingShellCommand("sed --in-place 's/foo/bar/g' file.txt"), true);
  assert.equal(isMutatingShellCommand("perl -i -pe 's/foo/bar/g' file.txt"), true);
  assert.equal(isMutatingShellCommand('patch -p1 < diff.patch'), true);
});

test('isMutatingShellCommand detects filesystem mutations', () => {
  assert.equal(isMutatingShellCommand('touch file.txt'), true);
  assert.equal(isMutatingShellCommand('rm file.txt'), true);
  assert.equal(isMutatingShellCommand('rm -rf build/'), true);
  assert.equal(isMutatingShellCommand('mv a.txt b.txt'), true);
  assert.equal(isMutatingShellCommand('cp a.txt b.txt'), true);
  assert.equal(isMutatingShellCommand('mkdir -p src/foo'), true);
  assert.equal(isMutatingShellCommand('rmdir empty_dir'), true);
  assert.equal(isMutatingShellCommand('chmod +x script.sh'), true);
  assert.equal(isMutatingShellCommand('ln -s target linkname'), true);
});

test('isMutatingShellCommand detects archive extractions and downloads', () => {
  assert.equal(isMutatingShellCommand('tar -xzf archive.tar.gz'), true);
  assert.equal(isMutatingShellCommand('tar --extract -f archive.tar'), true);
  assert.equal(isMutatingShellCommand('unzip archive.zip'), true);
  assert.equal(isMutatingShellCommand('curl -o file.txt https://example.com'), true);
  assert.equal(isMutatingShellCommand('curl -O https://example.com/file.txt'), true);
  assert.equal(isMutatingShellCommand('wget https://example.com/file.txt'), true);
});

test('isMutatingShellCommand detects git write commands and ignores read-only git', () => {
  assert.equal(isMutatingShellCommand('git status'), false);
  assert.equal(isMutatingShellCommand('git status --porcelain'), false);
  assert.equal(isMutatingShellCommand('git diff'), false);
  assert.equal(isMutatingShellCommand('git diff HEAD~1'), false);
  assert.equal(isMutatingShellCommand('git log -n 5'), false);
  assert.equal(isMutatingShellCommand('git show HEAD'), false);
  assert.equal(isMutatingShellCommand('git branch'), false);
  assert.equal(isMutatingShellCommand('git branch -a'), false);

  assert.equal(isMutatingShellCommand('git add .'), true);
  assert.equal(isMutatingShellCommand('git commit -m "fix bug"'), true);
  assert.equal(isMutatingShellCommand('git checkout -b feature-branch'), true);
  assert.equal(isMutatingShellCommand('git merge main'), true);
  assert.equal(isMutatingShellCommand('git rebase main'), true);
  assert.equal(isMutatingShellCommand('git stash'), true);
  assert.equal(isMutatingShellCommand('git reset --hard'), true);
  assert.equal(isMutatingShellCommand('git clean -fd'), true);
  assert.equal(isMutatingShellCommand('git restore src/index.ts'), true);
});

test('isMutatingShellCommand distinguishes build/package commands vs test commands', () => {
  assert.equal(isMutatingShellCommand('npm test'), false);
  assert.equal(isMutatingShellCommand('npx vitest run'), false);
  assert.equal(isMutatingShellCommand('npx eslint .'), false);
  assert.equal(isMutatingShellCommand('pytest'), false);
  assert.equal(isMutatingShellCommand('tsc --noEmit'), false);

  assert.equal(isMutatingShellCommand('npm run build'), true);
  assert.equal(isMutatingShellCommand('npm install chalk'), true);
  assert.equal(isMutatingShellCommand('npm i chalk'), true);
  assert.equal(isMutatingShellCommand('pnpm add chalk'), true);
  assert.equal(isMutatingShellCommand('cargo build'), true);
  assert.equal(isMutatingShellCommand('pip install requests'), true);
  assert.equal(isMutatingShellCommand('tsc'), true);
  assert.equal(isMutatingShellCommand('npx eslint --fix .'), true);
  assert.equal(isMutatingShellCommand('npx prettier --write .'), true);
});

test('isMutatingShellCommand handles Windows commands', () => {
  assert.equal(isMutatingShellCommand('del file.txt'), true);
  assert.equal(isMutatingShellCommand('move a.txt b.txt'), true);
  assert.equal(isMutatingShellCommand('copy a.txt b.txt'), true);
  assert.equal(isMutatingShellCommand('Out-File -FilePath file.txt'), true);
  assert.equal(isMutatingShellCommand('Set-Content -Path file.txt -Value "foo"'), true);
});

test('isMutatingToolCall correctly classifies standard tools', () => {
  assert.equal(isMutatingToolCall('write_file', { path: 'a.txt', content: 'x' }), true);
  assert.equal(isMutatingToolCall('edit_file', { path: 'a.txt', patch: 'diff' }), true);
  assert.equal(isMutatingToolCall('memory_write', { key: 'k', content: 'v' }), true);

  assert.equal(isMutatingToolCall('read_file', { path: 'a.txt' }), false);
  assert.equal(isMutatingToolCall('list_dir', { path: '.' }), false);
  assert.equal(isMutatingToolCall('search_text', { pattern: 'foo' }), false);
  assert.equal(isMutatingToolCall('web_fetch', { url: 'https://example.com' }), false);
  assert.equal(isMutatingToolCall('code_query', { path: 'a.ts' }), false);
  assert.equal(isMutatingToolCall('repo_probe', {}), false);
  assert.equal(isMutatingToolCall('mcp_validate', { command: 'node x.js' }), false);
  assert.equal(isMutatingToolCall('memory_read', { key: 'k' }), false);
});

test('isMutatingToolCall distinguishes read-only git operations from mutating ones', () => {
  assert.equal(isMutatingToolCall('git', { operation: 'status' }), false);
  assert.equal(isMutatingToolCall('git', JSON.stringify({ operation: 'status' })), false);
  assert.equal(isMutatingToolCall('git', { operation: 'diff' }), false);
  assert.equal(isMutatingToolCall('git', { operation: 'log' }), false);
  assert.equal(isMutatingToolCall('git', { operation: 'show' }), false);
  assert.equal(isMutatingToolCall('git', { operation: 'branch' }), false);

  assert.equal(isMutatingToolCall('git', { operation: 'add' }), true);
  assert.equal(isMutatingToolCall('git', { operation: 'commit' }), true);
  assert.equal(isMutatingToolCall('git', { operation: 'format' }), true);
});

test('isMutatingToolCall inspects run_shell command content', () => {
  assert.equal(isMutatingToolCall('run_shell', { command: 'cat src/cli.ts' }), false);
  assert.equal(isMutatingToolCall('run_shell', JSON.stringify({ command: 'cat src/cli.ts' })), false);
  assert.equal(isMutatingToolCall('run_shell', { command: 'cat << "EOF" > test.txt\nhi\nEOF' }), true);
  assert.equal(isMutatingToolCall('run_shell', { command: 'sed -i "s/a/b/g" test.txt' }), true);
  assert.equal(isMutatingToolCall('run_shell', { command: 'npm run build' }), true);
});

test('countMutatingToolCalls counts mutating tool calls across history', () => {
  const history: Message[] = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        },
        {
          id: '2',
          type: 'function',
          function: { name: 'run_shell', arguments: JSON.stringify({ command: 'ls -la' }) },
        },
        {
          id: '3',
          type: 'function',
          function: { name: 'run_shell', arguments: JSON.stringify({ command: 'echo "a" > out.txt' }) },
        },
        {
          id: '4',
          type: 'function',
          function: { name: 'git', arguments: JSON.stringify({ operation: 'status' }) },
        },
        {
          id: '5',
          type: 'function',
          function: { name: 'git', arguments: JSON.stringify({ operation: 'commit' }) },
        },
      ],
    },
  ];

  assert.equal(countMutatingToolCalls(history), 2); // 'echo "a" > out.txt' and git commit
});

test('hasWorktreeChanges detects status and head differences', () => {
  assert.equal(hasWorktreeChanges(null, null), false);
  assert.equal(hasWorktreeChanges({ status: '', head: 'abc' }, null), false);
  assert.equal(
    hasWorktreeChanges({ status: '', head: 'abc' }, { status: '', head: 'abc' }),
    false,
  );
  assert.equal(
    hasWorktreeChanges({ status: '', head: 'abc' }, { status: ' M file.ts', head: 'abc' }),
    true,
  );
  assert.equal(
    hasWorktreeChanges({ status: '', head: 'abc' }, { status: '', head: 'def' }),
    true,
  );
});

test('detectSessionMutations accurately detects mutations from tool history and worktree', () => {
  const readOnlyHistory: Message[] = [
    {
      role: 'assistant',
      content: 'I will inspect files.',
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        },
        {
          id: '2',
          type: 'function',
          function: { name: 'git', arguments: JSON.stringify({ operation: 'status' }) },
        },
      ],
    },
  ];

  const res1 = detectSessionMutations(
    readOnlyHistory,
    { status: '', head: 'abc' },
    { status: '', head: 'abc' },
  );
  assert.equal(res1.hasMutations, false);
  assert.equal(res1.mutatingToolCalls, 0);
  assert.equal(res1.worktreeChanged, false);

  // Even if tool calls were read-only, if worktree changed (e.g. background process or unclassified tool), detected!
  const res2 = detectSessionMutations(
    readOnlyHistory,
    { status: '', head: 'abc' },
    { status: '?? new.txt', head: 'abc' },
  );
  assert.equal(res2.hasMutations, true);
  assert.equal(res2.mutatingToolCalls, 0);
  assert.equal(res2.worktreeChanged, true);

  // If run_shell wrote via redirection (Hermes issue #444 reproduction scenario)
  const shellWriteHistory: Message[] = [
    {
      role: 'assistant',
      content: 'Writing file via shell',
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'run_shell', arguments: JSON.stringify({ command: 'cat << "EOF" > fix.js\nconsole.log(1);\nEOF' }) },
        },
      ],
    },
  ];

  const res3 = detectSessionMutations(
    shellWriteHistory,
    { status: '', head: 'abc' },
    { status: '?? fix.js', head: 'abc' },
  );
  assert.equal(res3.hasMutations, true);
  assert.equal(res3.mutatingToolCalls, 1);
  assert.equal(res3.worktreeChanged, true);
});

test('isWorkspaceMutatingToolCall excludes memory_write from workspace mutations (#448)', () => {
  assert.equal(isWorkspaceMutatingToolCall('write_file', { path: 'a.txt', content: 'x' }), true);
  assert.equal(isWorkspaceMutatingToolCall('edit_file', { path: 'a.txt', patch: 'x' }), true);
  assert.equal(isWorkspaceMutatingToolCall('git', { operation: 'commit' }), true);
  assert.equal(isWorkspaceMutatingToolCall('run_shell', { command: 'echo x > f.txt' }), true);

  // memory_write mutates ~/.sc-agent, not the workspace
  assert.equal(isWorkspaceMutatingToolCall('memory_write', { key: 'k', content: 'v' }), false);

  assert.equal(isWorkspaceMutatingToolCall('read_file', { path: 'a.txt' }), false);
  assert.equal(isWorkspaceMutatingToolCall('git', { operation: 'status' }), false);
});

test('expectsWorkspaceMutation detects mutation-scoped prompts (#448)', () => {
  assert.equal(expectsWorkspaceMutation('fix(engine): zero-mutation turn completion on auto/best-coding'), true);
  assert.equal(expectsWorkspaceMutation('Autonomous implementation for issue #446'), true);
  assert.equal(expectsWorkspaceMutation('Add input validation to the endpoint'), true);
  assert.equal(expectsWorkspaceMutation('Update the README with the new flag'), true);
  assert.equal(expectsWorkspaceMutation('refactor the agent loop'), true);
  assert.equal(expectsWorkspaceMutation('resolve the failing CI checks'), true);

  assert.equal(expectsWorkspaceMutation('summarize the contents of README.md'), false);
  assert.equal(expectsWorkspaceMutation('what is the current date'), false);
  assert.equal(expectsWorkspaceMutation('explain how the agent loop works'), false);
  assert.equal(expectsWorkspaceMutation('list all exported functions in cli.ts'), false);
  assert.equal(expectsWorkspaceMutation(''), false);
});

test('declaresNoChangesNeeded detects explicit no-change verdicts (#448)', () => {
  assert.equal(declaresNoChangesNeeded('No changes are required — the feature is already implemented.'), true);
  assert.equal(declaresNoChangesNeeded('nothing to commit, working tree clean'), true);
  assert.equal(declaresNoChangesNeeded('The requested option is already present in the config.'), true);
  assert.equal(declaresNoChangesNeeded('This was a read-only question; no modifications were necessary.'), true);
  assert.equal(declaresNoChangesNeeded('No files were changed.'), true);
  assert.equal(declaresNoChangesNeeded('The task does not require any edits.'), true);

  assert.equal(declaresNoChangesNeeded('I will now apply the fix to parser.ts.'), false);
  assert.equal(declaresNoChangesNeeded('Updated parser.ts with the guard clause.'), false);
  assert.equal(declaresNoChangesNeeded('Here is the plan for the refactor.'), false);
  assert.equal(declaresNoChangesNeeded(''), false);
});

test('getWorkspaceGitState and hasWorktreeChanges work on actual git repo', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sc-git-test-'));
  try {
    spawnSync('git', ['init', '-b', 'main'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });

    const before = getWorkspaceGitState(tmp);
    assert.ok(before !== null);
    // repo top-level is captured for repo-relative path resolution (#464)
    assert.equal(typeof before.root, 'string');
    assert.ok((before.root ?? '').length > 0);

    writeFileSync(join(tmp, 'file.txt'), 'hello');
    const after = getWorkspaceGitState(tmp);
    assert.ok(after !== null);

    assert.equal(hasWorktreeChanges(before, after), true);

    // Commit changes
    spawnSync('git', ['add', '.'], { cwd: tmp });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmp });

    const afterCommit = getWorkspaceGitState(tmp);
    assert.ok(afterCommit !== null);
    assert.equal(hasWorktreeChanges(after, afterCommit), true);
    assert.equal(hasWorktreeChanges(afterCommit, afterCommit), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
