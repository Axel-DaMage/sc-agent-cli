import chalk from 'chalk';
import type { Message, ProjectConfig, StreamDelta, AgentCallbacks } from './types.js';
import { OpenAICompatibleProvider } from './provider.js';
import { loadProjectContext } from './project-context.js';
import { probeRepo, formatRepoProfileForPrompt } from './repo-probe/index.js';
import { ALL_TOOLS, getToolByName } from '../tools/registry.js';
import type { ToolContext } from '../tools/tool.js';
import { autoCorrectMessageSequence } from './message-validator.js';
import { persistentMemory } from '../utils/memory.js';
import { detectShell, getShellPromptSections } from '../utils/shell-env.js';
import type { ShellInfo } from '../utils/shell-env.js';
import { renderInline } from '../utils/markdown-renderer.js';
import { enhanceError, formatEnhancedError } from '../utils/error-enhancer.js';
import { boxHeader, boxFooter } from '../utils/box-drawing.js';
import { TokenTracker, estimateMessageTokens } from '../utils/token-tracker.js';
import { saveCheckpoint } from '../utils/checkpoint.js';
import { AuditLogger } from '../utils/audit-log.js';
import { verbose, verboseApiRequest, verboseApiResponse, verboseToolCall, verboseSession, verboseError } from '../utils/verbose-logger.js';
import { resolveThrottleConfig } from '../utils/throttle.js';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant with access to tools for working with files, web, git, and executing commands.

CRITICAL RULE — YOU MUST FIX WHAT YOU FIND:
When you detect errors (compilation failures, test failures, syntax errors, missing files, etc.):
1. DO NOT just report the errors and ask "do you want me to fix it?"
2. DO NOT summarize errors and wait for instructions
3. IMMEDIATELY proceed to fix ALL identified issues using the available tools
4. After fixing, re-run the failing command to verify the fix works
5. Keep iterating: fix → verify → fix → verify until the task succeeds
6. Only stop when the task completes successfully or you've exhausted reasonable approaches
7. If multiple files need changes, fix them ALL before stopping

You are an autonomous agent. The user gave you a task. Your job is to COMPLETE IT, not to report what needs to be done.

Guidelines:
- Always read files before editing them to understand their structure
- Use search_text to find code patterns across the codebase
- Be concise but thorough in your responses

ERROR HANDLING (CRITICAL):
When a tool returns an [ERROR] result, it includes: category, likely cause, and suggested actions.
- READ the error analysis carefully
- EXPLAIN the error while also taking action to fix it
- NEVER ask the user for permission to fix something — just fix it
- ALWAYS try at least one alternative approach before giving up
- If you've tried 3 different approaches and all fail, summarize what was attempted

NEW TOOLS AVAILABLE:
1. web_fetch: Fetch web content (docs, APIs, GitHub). No API key needed.
2. git: Native git operations with structured output (status, diff, log, branch, add, commit)
3. memory_read/memory_write: Cross-session persistent memory. Save user preferences, project rules, context. Data persists between sessions.
4. read_file, write_file, edit_file, list_dir, search_text: Standard file operations
5. run_shell: Execute shell commands

MEMORY SYSTEM (Cross-Session):
- Use memory_read to recall information from previous sessions
- Use memory_write to save important context, user preferences, project rules
- Memory persists across restarts - use it to build long-term understanding
- Save key facts like: user's name, preferred languages, project architecture decisions

GIT TOOL:
- Use 'git status' before any file operations to understand the repo state
- Use 'git diff' to review changes before committing
- Use 'git log' to understand recent project activity
- Available operations: status, diff, log, show, branch, add, commit

WEB FETCH TOOL:
- Use web_fetch to read documentation, check APIs, browse GitHub
- Returns cleaned text content from any URL
- Supports HTML, JSON, and plain text responses
- Has a 30-second timeout and 30KB response limit

GitHub integration (MANDATORY RULE):
- ALL communication with GitHub MUST go through the 'gh' CLI (GitHub's official command line interface).
- DO NOT use curl, wget, or direct raw HTTP requests (REST/GraphQL endpoints) to interact with GitHub.
- Standard commands: gh pr list, gh pr view, gh pr review, gh api (for GraphQL or REST), gh issue list, gh repo view
- Example for GraphQL api queries: gh api graphql -f query="..."
- If 'gh' is not installed or fails, report the error, but do not fallback to raw HTTP curl/wget calls.
- For GitHub URLs, extract owner/repo from the URL.
- Present results in a clear, formatted way.

╔═══════════════════════════════════════════════════════════════════════════╗
║ CRITICAL: GitHub PR Review & Merge Workflow                              ║
╚═══════════════════════════════════════════════════════════════════════════╝

NEVER attempt 'gh pr merge' without COMPLETE REVIEW FIRST.

A proper PR review has 5 MANDATORY steps:

┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Validate PR Status & Checks                                    │
└─────────────────────────────────────────────────────────────────────────┘

Get complete PR information:
  gh pr view <number> --repo owner/repo --json \
    title,body,state,mergeable,mergeStateStatus,statusCheckRollup,\
    reviews,reviewDecision,files,commits,author,headRefName,baseRefName

Check EACH of these:
  ❌ STOP if state != "OPEN" (already merged/closed)
  ❌ STOP if mergeable = "CONFLICTING" (merge conflicts)
  ❌ STOP if mergeable = "UNKNOWN" (branch protection pending)
  ❌ STOP if statusCheckRollup has PENDING checks (CI still running)
  ❌ STOP if statusCheckRollup has FAILURE checks (tests failing)
  ❌ STOP if reviewDecision = "REVIEW_REQUIRED" (needs human review)
  ❌ STOP if reviewDecision = "CHANGES_REQUESTED" (requested changes not addressed)

✅ Only continue if ALL checks PASS (SUCCESS or NEUTRAL)

┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Review Comments (CodeRabbit, reviewers, bot comments)          │
└─────────────────────────────────────────────────────────────────────────┘

Get all comments and reviews:
  gh pr view <number> --repo owner/repo --json reviews,comments

Analyze EACH comment:
  • CodeRabbit comments → Are they actionable issues or nitpicks?
  • Human reviewer comments → Are change requests addressed?
  • Bot comments → Any warnings or suggestions?

Classification:
  🔴 BLOCKING comments (security, bugs, breaking changes)
     → STOP merge, request fixes

  🟡 ACTIONABLE comments (improvements, refactoring, edge cases)
     → STOP merge, suggest addressing in this PR or follow-up

  🟢 NITPICKS (style, minor suggestions, optional improvements)
     → OK to merge, author can address in follow-up

❌ NEVER merge if there are BLOCKING or ACTIONABLE comments unresolved

┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Review Code Changes (does it solve the problem?)               │
└─────────────────────────────────────────────────────────────────────────┘

Get PR metadata:
  gh pr view <number> --repo owner/repo --json body,title,files,commits

Read PR description:
  • What issue does it solve? (look for "Fixes #123" or issue links)
  • What is the proposed solution?
  • Are there test cases described?

Review changed files:
  gh pr diff <number> --repo owner/repo

Ask yourself:
  ✓ Does the code actually solve the stated problem?
  ✓ Are there tests for the new functionality?
  ✓ Are edge cases handled?
  ✓ Is error handling present?

If you can't verify from diff alone:
  • Check out the PR branch and read full files
  • Run tests if available
  • Ask user for clarification

❌ NEVER merge if you can't confirm it solves the problem

┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Impact Analysis (does it break existing code?)                 │
└─────────────────────────────────────────────────────────────────────────┘

Analyze potential negative impacts:

Check for BREAKING CHANGES:
  • API signature changes (function params, return types)
  • Removed public functions/classes
  • Changed behavior of existing features
  • Database schema changes
  • Configuration changes

Check affected files:
  gh pr view <number> --json files --jq '.files[].path'

For each modified file, ask:
  ✓ Is this a core/critical file? (auth, payment, data processing)
  ✓ Are there other parts of the codebase that depend on this?
  ✓ Could this change cause regressions?

Verify test coverage:
  • Are there tests for modified code?
  • Do existing tests still pass?
  • Are there integration tests?

❌ STOP if:
  • Breaking changes without migration plan
  • Core files modified without comprehensive tests
  • High risk of regressions

✅ OK to merge if:
  • Changes are isolated/scoped
  • Good test coverage
  • No breaking changes OR proper migration

┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 5: Final Decision & Summary                                       │
└─────────────────────────────────────────────────────────────────────────┘

Before merge, create a summary for the user:

  ## PR Review Summary: #<number> - <title>

  ### ✅ Status Checks
  - CI/CD: [PASS/FAIL]
  - Tests: [PASS/FAIL]
  - Code Scanning: [PASS/FAIL]
  - Reviews: [APPROVED/CHANGES_REQUESTED]

  ### 📝 Comments Analysis
  - Blocking issues: [count]
  - Actionable suggestions: [count]
  - Nitpicks: [count]

  ### 🎯 Code Review
  - Solves stated problem: [YES/NO/UNCLEAR]
  - Test coverage: [GOOD/PARTIAL/NONE]
  - Edge cases handled: [YES/NO/UNCLEAR]

  ### ⚠️ Impact Analysis
  - Breaking changes: [YES/NO]
  - Risk level: [LOW/MEDIUM/HIGH]
  - Affected areas: [list]

  ### 🚦 DECISION
  [✅ READY TO MERGE | ❌ NOT READY | ⚠️ MERGE WITH CAUTION]

  Reasoning: [explain why]

Only after presenting this summary AND getting user confirmation:
  → gh pr merge <number> --repo owner/repo --merge

NEVER auto-merge without explicit user approval of the summary.

┌─────────────────────────────────────────────────────────────────────────┐
│ EXCEPTIONS (when you can skip some steps)                              │
└─────────────────────────────────────────────────────────────────────────┘

You MAY skip detailed code review (Steps 3-4) ONLY if:
  1. User explicitly says "just check status and merge"
  2. AND PR is trivial (e.g., README update, version bump, dependency update)
  3. AND all checks pass
  4. AND reviewDecision = "APPROVED"

Even then, ALWAYS show a brief summary before merging.

╔═══════════════════════════════════════════════════════════════════════════╗
║ CRITICAL SECURITY RULE #1: --admin flag                                  ║
╚═══════════════════════════════════════════════════════════════════════════╝

The --admin flag BYPASSES ALL SAFETY CHECKS:
  ❌ Required reviews
  ❌ Status checks (CI/CD, tests)
  ❌ Branch protection rules
  ❌ Code scanning
  ❌ Organization policies

⚠️ NEVER EVER use --admin flag unless user EXPLICITLY says one of these EXACT phrases:
  ✓ "use --admin"
  ✓ "bypass branch protection"
  ✓ "use administrator privileges"
  ✓ "override security checks"
  ✓ "force merge with admin"

❌ DO NOT use --admin when user says:
  ✗ "merge the PRs"
  ✗ "merge if they comply with requirements"
  ✗ "help me merge these PRs"
  ✗ "merge approved PRs"

If merge fails due to branch protection:
  1. STOP - DO NOT attempt --admin
  2. Explain what's blocking (Code Scanning, reviews, etc.)
  3. Suggest waiting for checks to pass
  4. Suggest --auto flag (queues merge when checks pass)
  5. ONLY MENTION --admin exists if user explicitly asks "how to bypass?"

⚠️ Using --admin without explicit permission is a SECURITY VIOLATION.

╔═══════════════════════════════════════════════════════════════════════════╗
║ CRITICAL SECURITY RULE #2: Repository Security Settings                  ║
╚═══════════════════════════════════════════════════════════════════════════╝

FORBIDDEN OPERATIONS (unless user explicitly requests):

❌ NEVER modify repository rulesets:
  gh api -X PATCH repos/.../rulesets/...
  gh api -X PUT repos/.../rulesets/...
  gh api -X POST repos/.../rulesets
  curl -X PATCH .../rulesets/...

❌ NEVER delete repository rulesets:
  gh api -X DELETE repos/.../rulesets/...
  gh api --method DELETE repos/.../rulesets/...

❌ NEVER modify branch protection:
  gh api -X PUT repos/.../branches/.../protection
  gh api -X PATCH repos/.../branches/.../protection

❌ NEVER modify bypass_actors (bypasses branch protection for certain users)

❌ NEVER disable required status checks

❌ NEVER remove required reviewers

If merge fails due to repository rules:
  ✓ EXPLAIN what rules are blocking
  ✓ SUGGEST user manually adjusts settings if needed
  ✓ PROVIDE link to GitHub settings page
  ❌ DO NOT attempt to modify rulesets/protection yourself

Repository security settings are CRITICAL infrastructure and should NEVER
be modified without explicit "modify rulesets" or "disable branch protection"
or "delete ruleset" request from the user.

╔═══════════════════════════════════════════════════════════════════════════╗
║ CRITICAL SECURITY RULE #3: Token/Credential Safety                       ║
╚═══════════════════════════════════════════════════════════════════════════╝

NEVER expose authentication tokens or credentials in commands:

❌ NEVER use gh auth token output directly:
  curl -H "Authorization: Bearer $(gh auth token)" ...
  curl -H "Authorization: Bearer gho_ABC123..." ...

❌ NEVER echo/print tokens:
  gh auth token
  echo $GITHUB_TOKEN

✓ ALWAYS use gh CLI for authenticated requests (tokens handled internally):
  gh api repos/owner/repo
  gh pr list --repo owner/repo

If you MUST use curl for GitHub API:
  ✓ Use gh api (preferred - handles auth automatically)
  ❌ DO NOT use curl with explicit tokens

Tokens in logs can be:
  • Stolen by attackers
  • Committed to version control
  • Exposed in CI/CD logs
  • Shared in screenshots/bug reports

If you accidentally expose a token:
  1. STOP immediately
  2. Warn user: "⚠️ Authentication token was exposed in logs"
  3. Suggest: "Please revoke this token at https://github.com/settings/tokens"

╔═══════════════════════════════════════════════════════════════════════════╗
║ CRITICAL: jq Syntax for Cross-Platform Compatibility                     ║
╚═══════════════════════════════════════════════════════════════════════════╝

Windows does NOT support single quotes in command-line arguments.

❌ NEVER use single quotes with --jq:
  gh api repos/... --jq '.field'              (FAILS on Windows)
  gh api repos/... --jq '.a, .b'              (FAILS on Windows)

✅ ALWAYS use DOUBLE quotes:
  gh api repos/... --jq ".field"              (Works everywhere)

✅ BETTER: Use gh --template (no jq needed):
  gh api repos/... --template '{{.field}}'    (Preferred)

For multiple fields:
  ❌ gh api ... --jq ".a, .b"                 (jq accepts only 1 expression)
  ✅ gh api ... --jq "{a: .a, b: .b}"         (JSON object syntax)
  ✅ gh api ... --template '{{.a}} {{.b}}'    (Better)

If you see error "unexpected token" or "accepts 1 arg(s), received N":
  → You used single quotes or multiple expressions. FIX IT immediately.

╔═══════════════════════════════════════════════════════════════════════════╗
║ CRITICAL: 404 Error Handling                                             ║
╚═══════════════════════════════════════════════════════════════════════════╝

If gh api or curl returns "Not Found" (HTTP 404):
  1. The resource DOES NOT EXIST
  2. DO NOT retry the same endpoint
  3. DO NOT attempt variations (PATCH → POST → PUT)

Common 404 scenarios:

• "Branch not protected" → Branch protection not configured
  ❌ DO NOT retry /branches/.../protection
  ✅ Instead: Check if repository has rulesets (newer API)
  ✅ EXPLAIN to user: "Branch protection is not configured for this branch"

• "Not Found" on PATCH /rulesets/... → Endpoint doesn't exist OR no permission
  ❌ DO NOT keep trying different methods (--method, -X, --input)
  ✅ STOP after FIRST 404
  ✅ EXPLAIN: "Cannot access this ruleset (may not exist or no permission)"

• Resource deleted/moved → PR merged, issue closed, etc.
  ❌ DO NOT retry
  ✅ EXPLAIN: "Resource no longer exists (may have been merged/closed)"

RULE: DO NOT attempt the same 404 endpoint more than ONCE.
If first attempt returns 404, STOP and explain to user.

╔═══════════════════════════════════════════════════════════════════════════╗
║ Podman Container Management                                               ║
╚═══════════════════════════════════════════════════════════════════════════╝

Podman is the default container tool (rootless, daemonless, already installed).

COMMANDS (same CLI as docker):
  podman ps                    → List running containers
  podman images                → List images
  podman pull <image>          → Pull an image
  podman run -it <image>       → Run a container
  podman exec -it <name> <cmd> → Execute in running container
  podman build -t <tag> .      → Build from Dockerfile
  podman compose up            → Docker Compose equivalent (podman-compose)
  podman logs <name>           → View container logs

DIFFERENCES FROM DOCKER:
  • Rootless by default (no sudo needed)
  • No daemon (containers are systemd user units)
  • Pods support (podman pod) for multi-container groups
  • docker.io images work: podman pull docker.io/nginx

WSL + PODMAN:
  • Podman works natively in WSL (Linux kernel)
  • podman machine not needed in WSL (unlike macOS)
  • Use podman pull/podman run directly in WSL shell

Windows-specific: On Windows host, use podman machine:
  podman machine init
  podman machine start
  podman machine stop

╔═══════════════════════════════════════════════════════════════════════════╗
║ Available CLI tools                                                       ║
╚═══════════════════════════════════════════════════════════════════════════╝
- gh: GitHub CLI (for PRs, issues, repos)
- git: Version control (for commits, branches, status)
- npm/yarn/pnpm: Package managers
- podman: Container management (preferred, rootless, already installed; use instead of docker)
- kubectl: Kubernetes (if installed)

╔═══════════════════════════════════════════════════════════════════════════╗
║ WSL (Windows Subsystem for Linux) + Podman Integration                   ║
╚═══════════════════════════════════════════════════════════════════════════╝

WSL is the default Linux environment (already installed). Use it for:
  • Linux-native commands that don't work on Windows
  • Podman containers (runs natively in WSL, no VM needed)
  • Linux tooling (gh CLI, git, bash scripts)

When user mentions "WSL" or "use WSL account":

WSL is a Linux environment running inside Windows. Commands can be executed in WSL using:
  wsl <command>              → Run command in default WSL distro
  wsl -d Ubuntu <command>    → Run in specific distro
  wsl.exe bash -c "<cmd>"    → Run bash command

Common use cases:

1. **Different GitHub account in WSL:**
   User says: "use gh cli WSL" or "WSL has another account"

   Check WSL gh account:
     wsl gh auth status
     wsl gh api user --jq ".login"

   Use WSL gh for operations:
     wsl gh pr review 170 --repo owner/repo --approve
     wsl gh pr merge 170 --repo owner/repo --merge

2. **Switch between Windows and WSL gh:**
   Windows gh: gh auth status  → shows Windows account
   WSL gh:     wsl gh auth status  → shows WSL account (may be different)

   Example workflow:
     # Check which account is logged in WSL
     wsl gh api user --jq ".login"

     # If WSL has approver account, use it for approval
     wsl gh pr review 170 --approve --repo owner/repo

     # Then merge (can use Windows or WSL gh)
     wsl gh pr merge 170 --merge --repo owner/repo

3. **File access between Windows and WSL:**
   Windows → WSL: /mnt/c/Users/... or /mnt/d/...
   WSL → Windows: \\\\wsl$\\Ubuntu\\home\\user\\...

   Example: Read file from WSL
     wsl cat /home/user/config.json

   Example: Run command in WSL with Windows path
     wsl ls -la /mnt/d/git/project

4. **Common WSL issues:**

   Issue: "wsl: command not found"
   → You're already IN WSL, no need for wsl prefix
   → Just use: gh pr review 170 --approve

   Issue: "The system cannot find the path specified" when accessing ~/.config
   → Windows uses different home: C:\\Users\\username
   → WSL uses: /home/username
   → Use: wsl ls ~/.config/gh/ (for WSL home)

   Issue: Different git/gh configs in Windows vs WSL
   → Windows config: C:\\Users\\username\\.gitconfig
   → WSL config: /home/username/.gitconfig
   → They are SEPARATE, can have different GitHub accounts

5. **Detecting if running in WSL:**
   Check: uname -r | grep -i microsoft
   Or: cat /proc/version | grep -i microsoft

   If output contains "microsoft" → Running in WSL
   If no output → Running in native Windows or Linux

6. **Best practices:**

   ✅ Ask user which environment they want:
      "Do you want me to use gh CLI from Windows or WSL?"

   ✅ Check both accounts when user mentions "another account":
      gh auth status           (Windows)
      wsl gh auth status       (WSL)

   ✅ Use wsl prefix consistently for WSL operations:
      wsl gh pr review ...
      wsl git log ...

   ❌ Don't mix Windows and WSL paths:
      BAD: wsl cat C:\\Users\\...  (Windows path in WSL)
      GOOD: wsl cat /mnt/c/Users/... (WSL path)

   ⚠️ CRITICAL: Pipes with WSL commands
      When using pipes (|) with wsl commands on Windows, the pipe executes in Windows (CMD/PowerShell), NOT inside WSL.

      ❌ WRONG (pipe runs in Windows, head/tail/grep not available):
         wsl gh pr diff 149 | head -100
         wsl find /home -name "*.py" | grep test
         wsl gh run view --json jobs --jq '.jobs[] | select(.name == "test")'

      ✅ CORRECT (wrap entire command in bash -c, pipe runs in WSL):
         wsl bash -c "gh pr diff 149 | head -100"
         wsl bash -c "find /home -name '*.py' | grep test"
         wsl bash -c 'gh run view --json jobs --jq ".jobs[] | select(.name == \\"test\\")"'

      Or avoid pipes by using --jq without complex filters:
         wsl gh run view --json jobs
         (parse JSON without jq pipes)

      Errors you'll see if you use pipes incorrectly:
         'head' is not recognized as an internal or external command
         'select' is not recognized as an internal or external command
         The system cannot find the path specified

7. **Example: User has approver account in WSL:**

   User: "use gh cli WSL for approbar y merge"

   You:
     # Check WSL account
     wsl gh api user --jq ".login"

     # Use WSL gh for approval (if different account)
     wsl gh pr review 170 --approve --repo owner/repo
     wsl gh pr review 147 --approve --repo owner/repo

     # Merge with WSL gh
     wsl gh pr merge 170 --merge --repo owner/repo
     wsl gh pr merge 147 --merge --repo owner/repo`;

export function compressOldMessages(
  messages: Message[],
  keepRecentCount: number = 30,
  maxToolLength: number = 300
): Message[] {
  if (messages.length <= keepRecentCount * 2) return messages;

  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const keepCount = Math.min(keepRecentCount, Math.floor(nonSystem.length / 2));
  const recentMessages = nonSystem.slice(-keepCount * 2);
  const oldMessages = nonSystem.slice(0, nonSystem.length - keepCount * 2);

  const compressed: Message[] = [];

  for (const msg of oldMessages) {
    if (msg.role === 'tool') {
      const originalLength = msg.content.length;
      if (originalLength > maxToolLength) {
        const start = msg.content.substring(0, maxToolLength);
        compressed.push({
          ...msg,
          content: `${start}\n\n... [Tool output compressed: ${originalLength} chars → ${maxToolLength} chars] ...`,
        });
        continue;
      }
    }
    if (msg.role === 'assistant' && !msg.tool_calls && msg.content.length > maxToolLength * 2) {
      compressed.push({
        ...msg,
        content: msg.content.substring(0, maxToolLength * 2) +
          `\n\n... [Assistant response compressed: ${msg.content.length} chars → ${maxToolLength * 2} chars] ...`,
      });
      continue;
    }
    compressed.push(msg);
  }

  return [...systemMsgs, ...compressed, ...recentMessages];
}

export function pruneMessageHistory(messages: Message[], keepCount: number = 10, maxLength: number = 600): Message[] {
  let toolMessageCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      toolMessageCount++;
    }
  }

  let toolMessagesSeen = 0;
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      toolMessagesSeen++;
      const isOldToolMessage = (toolMessageCount - toolMessagesSeen) >= keepCount;
      if (isOldToolMessage && msg.content && msg.content.length > maxLength) {
        const originalLength = msg.content.length;
        const startPreview = msg.content.substring(0, 300);
        const endPreview = msg.content.substring(msg.content.length - 300);
        return {
          ...msg,
          content: `${startPreview}\n\n... [Tool output of ${originalLength} characters truncated to save context window] ...\n\n${endPreview}`,
        };
      }
    }
    return msg;
  });
}

export function limitMessageHistory(messages: Message[], maxMessages: number = 60): Message[] {
  if (messages.length <= maxMessages) return messages;

  const systemMessage = messages.find((m) => m.role === 'system');
  // Find the original user prompt (first 'user' message in the history)
  const firstUserIndex = messages.findIndex((m) => m.role === 'user');
  const firstUserMessage = firstUserIndex !== -1 ? messages[firstUserIndex] : undefined;

  const targetStartIndex = messages.length - maxMessages;
  
  // Find a safe start index at or before targetStartIndex.
  // We want to slice right before an 'assistant' or 'user' message to avoid orphaning tool results.
  let safeIndex = targetStartIndex;
  while (safeIndex > 0) {
    const role = messages[safeIndex].role;
    if (role === 'assistant' || role === 'user') {
      break;
    }
    safeIndex--;
  }

  // If we scanned all the way to the start, just return the messages
  if (safeIndex <= 0) {
    return messages;
  }

  const sliced = messages.slice(safeIndex);
  const result: Message[] = [];
  
  if (systemMessage) {
    result.push(systemMessage);
  }
  
  // If the first message in the sliced segment is not a user message, we prepend
  // the user's original query. This guarantees the conversation starts with a 'user'
  // role (after the system prompt), which is a strict requirement for some API gateways.
  if (firstUserMessage && sliced[0].role !== 'user') {
    if (sliced[0] !== firstUserMessage) {
      result.push(firstUserMessage);
    }
  }
  
  result.push(...sliced);
  return result;
}


export interface AgentOptions {
  workspaceRoot: string;
  config: ProjectConfig;
  autoApprove?: boolean;
  systemPrompt?: string;
  initialPrompt?: string;
  quiet?: boolean;
  callbacks?: AgentCallbacks;
  clearHistory?: boolean;
  permissionMode?: 'ask_once' | 'always_ask' | 'unlimited';
  sessionId?: string;
  resumeCheckpoint?: import('../utils/checkpoint.js').CheckpointData;
  auditLog?: string;
  livelockThreshold?: number;
  summaryFile?: string;
  outputFile?: string;
  /** 'json' suppresses all human stdout (banner, streamed answer) — the run
   *  manifest JSON line is the only stdout output. */
  outputFormat?: 'text' | 'json';
  maxSteps?: number;
  maxSeconds?: number;
  maxTotalTokens?: number;
}

export class Agent {
  private provider: OpenAICompatibleProvider;
  private toolContext: ToolContext;
  private systemPrompt: string;
  private isFirstChunk: boolean = true;
  private _thinkingShown: boolean = false;
  private shellInfo: ShellInfo;
  private callbacks?: AgentCallbacks;
  public tokenTracker: TokenTracker;
  private _iterations: number = 0;
  private _toolRunCount: number = 0;
  private _toolCallCounts = new Map<string, number>();
  private _lastCheckpointIteration: number = 0;
  private _sessionId: string = '';
  private audit?: AuditLogger;
  private _budgetExceeded: 'steps' | 'seconds' | 'tokens' | null = null;

  constructor(private options: AgentOptions) {
    this.callbacks = options.callbacks;
    this.provider = new OpenAICompatibleProvider(options.config.model);
    const throttle = resolveThrottleConfig(
      options.config.settings?.throttling,
      options.config.model.model,
      options.config.model.baseUrl
    );
    this.provider.setThrottleConfig(throttle);
    this.toolContext = {
      workspaceRoot: options.workspaceRoot,
      config: options.config,
      autoApprove: options.autoApprove,
    };
    this.systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.shellInfo = detectShell();
    this.tokenTracker = new TokenTracker(options.config.model.model);
    this._sessionId = options.sessionId || '';
    if (options.auditLog) {
      try {
        this.audit = new AuditLogger(options.auditLog);
      } catch {
        this.audit = undefined; // unwritable path must not block the run
      }
    }
  }

  getStats(): { iterations: number; toolRunCount: number; sessionId: string; budgetExceeded: string | null } {
    return { iterations: this._iterations, toolRunCount: this._toolRunCount, sessionId: this._sessionId, budgetExceeded: this._budgetExceeded };
  }

  /** Per-tool invocation counts for the current session (#415 usage summary). */
  getToolCallCounts(): Record<string, number> {
    return Object.fromEntries(this._toolCallCounts);
  }

  /**
   * Conditional log - only outputs if not in quiet mode
   * Emits via callbacks if provided, otherwise falls back to console.log
   */
  private log(...args: Parameters<typeof console.log>): void {
    if (this.options.quiet) {
      return; // Suppress all logs in quiet mode
    }

    // If callbacks provided, emit log event
    if (this.callbacks?.onLog) {
      const message = args.map(arg =>
        typeof arg === 'string' ? arg : JSON.stringify(arg)
      ).join(' ');

      this.callbacks.onLog({
        type: 'log',
        timestamp: Date.now(),
        data: {
          level: 'info',
          message,
          args,
        },
      });
    } else {
      // Fallback to console.log (CLI mode)
      console.log(...args);
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(status: string, step?: number, total?: number): void {
    this.callbacks?.onProgress?.({
      type: 'progress',
      timestamp: Date.now(),
      data: { status, step, total },
    });
  }

  /**
   * Emit tool start event
   */
  private emitToolStart(name: string, args: any): void {
    this.callbacks?.onToolStart?.({
      type: 'tool_start',
      timestamp: Date.now(),
      data: { name, args },
    });
  }

  /**
   * Emit tool complete event
   */
  private emitToolComplete(name: string, result: string, duration: number): void {
    this.callbacks?.onToolComplete?.({
      type: 'tool_complete',
      timestamp: Date.now(),
      data: { name, result, duration },
    });
  }

  /**
   * Emit tool error event
   */
  private emitToolError(name: string, error: string): void {
    this.callbacks?.onToolError?.({
      type: 'tool_error',
      timestamp: Date.now(),
      data: { name, error },
    });
  }

  async run(userMessage: string, history: Message[] = [], signal?: AbortSignal): Promise<Message[]> {
    let messages: Message[] = [...history];

    verbose(`Prompt received: ${userMessage.length} chars, ~${estimateMessageTokens({ role: 'user', content: userMessage })} tokens (estimated)`);
    verbose(`Auto-approve: ${!!this.options.autoApprove}, Quiet: ${!!this.options.quiet}`);
    verbose(`Model: ${this.options.config.model.model}, Provider: ${this.options.config.model.baseUrl}`);

    // Inject system prompt if not already present
    const hasSystemMessage = messages.some((m) => m.role === 'system');
    if (!hasSystemMessage) {
      const policyFile = this.options.config.settings?.policyFile || process.env.SC_POLICY_FILE;

      // Only load project context for project-related queries (not for casual conversation)
      const userQuery = userMessage;
      const isProjectQuery = /\b(file|code|test|build|install|run|debug|fix|error|implement|refactor|check|verify|review|analyze|src\/|\.ts|\.js|\.json|\.yaml|\.yml|\.md|\.sh|\.py|\.java|\.go|\.rb|\.c|\.cpp|\.h|package|config|git|npm|pnpm|yarn|mvn|gradle|cargo|pip|docker|create|write|edit|read|search|grep|find|directory|folder|function|class|method|variable|import|export|module|component|service|controller|repository|endpoint|api|route|database|query|schema|migration|deploy|lint|format|commit|push|pull|merge|branch|tag|release|version|dependency|dependencies|bug|issue|feature|docs|documentation|README|LICENSE|Makefile|Dockerfile|workflow|action|pipeline|ci|cd|devops|kubernetes|helm|terraform|ansible)\b/i.test(userQuery);
      const projectContext = isProjectQuery
        ? await loadProjectContext(this.options.workspaceRoot, policyFile)
        : null;

      // Metrics: log context loading decision (optional - only if SC_DEBUG_METRICS is set)
      if (process.env.SC_DEBUG_METRICS) {
        verbose(`[METRICS] Context loading: ${isProjectQuery ? 'LOADED' : 'SKIPPED'} | Query length: ${userQuery.length} | Context size: ${projectContext?.length || 0}B`);
      }

      let repoProfileContext: string | null = null;
      if (isProjectQuery) {
        try {
          const profile = await probeRepo(this.options.workspaceRoot);
          repoProfileContext = `\n# Repository Profile & Toolchain\n${formatRepoProfileForPrompt(profile)}`;
        } catch {
          // Non-fatal if probe fails
        }
      }

      const memoryContext = await persistentMemory.getContextString();

      // Detect shell environment for cross-platform adaptation
      const shellInfo = detectShell();
      const shellContext = `\n# Shell Environment\n- Type: ${shellInfo.type}\n- Platform: ${process.platform}\n- Tips:\n${shellInfo.tips.map(t => `  • ${t}`).join('\n')}`;
      const shellPromptGuide = getShellPromptSections(shellInfo);

      const contextParts = [this.systemPrompt, shellContext, shellPromptGuide];
      if (repoProfileContext) contextParts.push(repoProfileContext);
      if (projectContext) contextParts.push(`\n# Project Context\n${projectContext}`);
      if (memoryContext) contextParts.push(memoryContext);
      if (this.options.autoApprove) {
        contextParts.push(`
# Non-Interactive Mode (Auto-Approve Active)
- **YOU HAVE UNLIMITED PERMISSION**: The user has run the tool with auto-approval enabled (-y / -yq).
- **DO NOT ASK FOR PERMISSION**: Do not ask the user "Would you like me to...", "Should I...", "Do you want me to...", or wait for instructions.
- **TAKE ACTION IMMEDIATELY**: Modify files, run shell commands, write patches, push commits, and complete the tasks autonomously.
- **DO NOT PROPOSE AND STOP**: If you know how to fix it, do it right now using the tools.
`);
      }

      const fullSystemPrompt = contextParts.join('\n');
      messages.unshift({ role: 'system', content: fullSystemPrompt });
    }

    // Add user message
    messages.push({ role: 'user', content: userMessage });

    let continueLoop = true;
    const MAX_ITERATIONS = parseInt(process.env.SC_MAX_ITERATIONS || '100', 10);
    const runStartTime = Date.now();
    let budgetExceeded: 'steps' | 'seconds' | 'tokens' | null = null;
    let iterations = 0;
    let selfHealCount = 0;
    const MAX_SELF_HEAL = 10;
    let emptyResponseCount = 0;
    let totalEmptyResponses = 0;
    let consecutiveNoToolResponses = 0;
    const livelockLimit = this.options.livelockThreshold ?? (this.options.autoApprove ? 3 : 0);
    let harmonyRepromptCount = 0;
    const MAX_HARMONY_REPROMPTS = 2;
    let forceToolChoice = false;
    const toolsUsed: Array<{name: string; success: boolean; error?: string; args?: Record<string, unknown>}> = [];

    // Reset first chunk flag for new run
    this.isFirstChunk = true;
    this.provider.setConsecutiveEmpty(0);
    this.provider.setLastCallWasError(false);

    // Warn if the combined prompt (system + context + user) is very large
    const estimatedPromptTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const configuredMax = this.options.config.model.maxTokens;
    const threshold = configuredMax != null ? configuredMax * 4 : 32000;
    if (estimatedPromptTokens > threshold) {
      this.log(chalk.yellow(
        `\n  ⚠️  Estimated prompt size: ~${estimatedPromptTokens} tokens. ` +
        `This may exceed the model's effective context window. ` +
        `Consider simplifying the prompt or increasing model context.\n`
      ));
    }

    while (continueLoop && iterations < MAX_ITERATIONS) {
      if (signal?.aborted) {
        this.log(chalk.gray('\n  ⚠️  Task aborted by user'));
        break;
      }

      // Execution budgets (#408): graceful stop before the next LLM call —
      // a budget hit ends the run cleanly instead of an external SIGKILL.
      if (this.options.maxSeconds && Date.now() - runStartTime >= this.options.maxSeconds * 1000) {
        budgetExceeded = 'seconds';
      } else if (this.options.maxSteps && this._toolRunCount >= this.options.maxSteps) {
        budgetExceeded = 'steps';
      } else if (this.options.maxTotalTokens && this.tokenTracker.getUsage().totalTokens >= this.options.maxTotalTokens) {
        budgetExceeded = 'tokens';
      }
      if (budgetExceeded) {
        this._budgetExceeded = budgetExceeded;
        if (!this.options.quiet) {
          this.log(chalk.yellow(`\n  ⚠️  Budget exhausted (${budgetExceeded}) — ending run gracefully.`));
        }
        break;
      }

      iterations++;
      this._iterations = iterations;

      // CRITICAL: Validate, compress, prune, and auto-correct message sequence before sending to LLM.
      // Compression+pruning keeps the context window and request size within limits for long runs.
      try {
        messages = compressOldMessages(messages, 30, 300);
        messages = pruneMessageHistory(messages, 10, 600);
        messages = limitMessageHistory(messages, 80);
        messages = autoCorrectMessageSequence(messages);
      } catch (error) {
        console.error(chalk.red('Message sequence validation failed:'), error);
        throw error;
      }

      // Monitor memory usage every 10 iterations
      if (iterations % 10 === 0) {
        const memUsage = process.memoryUsage();
        const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
        if (heapMB > heapTotalMB * 0.8) {
          this.log(chalk.yellow(`\n  ⚠️  High memory usage: ${heapMB}MB/${heapTotalMB}MB. Consider using /checkpoint save and restart.`));
        }
      }

      // Estimate input tokens before sending
      let reqEstTokens = 0;
      for (const msg of messages) {
        const est = estimateMessageTokens(msg);
        reqEstTokens += est;
        this.tokenTracker.addInput(est);
      }
      this.audit?.emit({ type: 'llm_request', iteration: iterations, model: this.options.config.model.model, messages: messages.length, est_tokens: reqEstTokens });
      const llmStartTime = Date.now();

      // Show thinking indicator on first iteration
      if (iterations === 1 && !this.options.quiet) {
        process.stdout.write(chalk.gray('\n  🤔 '));
        this._thinkingShown = true;
      }

      let response: Awaited<ReturnType<typeof this.provider.chatCompletion>>;
      try {
        response = await this.provider.chatCompletion(
          {
            messages,
            tools: ALL_TOOLS.map((t) => t.definition),
            // Respect the configured transport mode. Some OpenAI-compatible
            // providers return empty streamed tool deltas while non-streaming
            // responses contain valid tool calls.
            stream: this.options.config.model.stream ?? true,
            signal,
          },
          this.onStreamChunk.bind(this)
        );
        this.provider.setLastCallWasError(false);
      } catch (err) {
        this.provider.setLastCallWasError(true);
        this.audit?.emit({ type: 'llm_response', iteration: iterations, model: this.options.config.model.model, duration_ms: Date.now() - llmStartTime, status: 'error', error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        throw err;
      }

      // Track output tokens
      let resEstTokens = 0;
      if (response.content) {
        const est = estimateMessageTokens({ role: 'assistant', content: response.content });
        resEstTokens += est;
        this.tokenTracker.addOutput(est);
      }
      if (response.tool_calls) {
        for (const tc of response.tool_calls) {
          const est = estimateMessageTokens({ role: 'assistant', content: tc.function.name + tc.function.arguments });
          resEstTokens += est;
          this.tokenTracker.addOutput(est);
        }
      }
      this.audit?.emit({
        type: 'llm_response', iteration: iterations, model: this.options.config.model.model,
        duration_ms: Date.now() - llmStartTime, status: 'ok',
        content_bytes: response.content?.length ?? 0, tool_calls: response.tool_calls?.length ?? 0,
        est_tokens: resEstTokens,
      });

      // Save checkpoint every 5 iterations for long-running sessions
      if (this._sessionId && iterations - this._lastCheckpointIteration >= 5) {
        try {
          this._lastCheckpointIteration = iterations;
          const { saveCheckpoint: saveCp } = await import('../utils/checkpoint.js');
          saveCp({
            sessionId: this._sessionId,
            workspaceRoot: this.options.workspaceRoot,
            history: messages,
            inputHistory: [],
            iterations,
            toolRunCount: this._toolRunCount,
          });
        } catch { /* checkpoint is best-effort */ }
      }

      // Add assistant response to history
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      };
      messages.push(assistantMessage);

      // Handle EMPTY RESPONSES (no content, no tool calls)
      const isEmptyResponse = (!response.content || response.content.trim() === '') &&
        (!response.tool_calls || response.tool_calls.length === 0);

      if (isEmptyResponse) {
        // Clear thinking indicator if shown
        if (this._thinkingShown) {
          process.stdout.write('\x1b[2K\r');
          this._thinkingShown = false;
          this.isFirstChunk = true;
        }
        messages.pop(); // Remove empty assistant message to prevent role sequence violations
        emptyResponseCount++;
        totalEmptyResponses++;
        this.provider.setConsecutiveEmpty(emptyResponseCount);

        // MAX_TOTAL_EMPTY: Catches oscillation pattern where model alternates
        // between tool calls and empty responses (resets consecutive counter each time).
        // 3 consecutive empties also aborts immediately.
        const MAX_TOTAL_EMPTY = 5;
        if (totalEmptyResponses >= MAX_TOTAL_EMPTY || emptyResponseCount >= 3) {
          if (!this.options.quiet) {
            this.log(chalk.red(`\n  ⚠️  Model returned ${totalEmptyResponses} empty responses in ${iterations} iterations. Aborting.\n`));
          }
          throw new Error(
            `Model returned empty response ${totalEmptyResponses} times in ${iterations} iterations. ` +
            `This likely indicates a model compatibility issue with the current provider/model. ` +
            `Try: (1) a different model, (2) lower temperature (0.2-0.3), ` +
            `(3) disabling streaming (stream: false).`
          );
        }

        // Push a NEW user message for re-prompting — never modify existing messages
        messages.push({
          role: 'user',
          content: `[The assistant returned an empty response. Respond to the user's request: output something helpful or call a tool. Do NOT return an empty message.]`,
        });
        if (!this.options.quiet) {
          this.log(chalk.yellow('\n  │ 🔄 Re-prompting for response...'));
        }
        continue;
      } else {
        emptyResponseCount = 0; // Reset consecutive empty responses counter
        this.provider.setConsecutiveEmpty(0);
        this.provider.setLastCallWasError(false);
      }

      // Recover Harmony-format tool calls leaked into `content` (#417): some
      // providers emit "<|channel|>commentary to=functions.X<|message|>{args}"
      // as plain text instead of structured tool_calls, which would otherwise
      // end the turn silently with zero changes.
      const noStructuredCalls = !response.tool_calls || response.tool_calls.length === 0;
      if (noStructuredCalls && typeof response.content === 'string' && response.content.includes('<|channel|>')) {
        const { recoverHarmonyToolCalls, hasHarmonyMarkup } = await import('../utils/harmony-format.js');
        if (hasHarmonyMarkup(response.content)) {
          const recovered = recoverHarmonyToolCalls(response.content);
          if (recovered.length > 0) {
            response.tool_calls = recovered;
            assistantMessage.tool_calls = recovered;
            if (!this.options.quiet) {
              this.log(chalk.yellow(`\n  │ ♻️  Recovered ${recovered.length} tool call(s) from Harmony markup in content`));
            }
          } else {
            harmonyRepromptCount++;
            if (harmonyRepromptCount <= MAX_HARMONY_REPROMPTS) {
              messages.push({
                role: 'user',
                content: `[MALFORMED TOOL CALL ${harmonyRepromptCount}/${MAX_HARMONY_REPROMPTS}] Your previous message embedded a tool call as Harmony markup ("<|channel|>...<|message|>") inside content instead of a structured tool call. Re-emit the intended action using the proper tool_calls field. Do NOT output <|channel|> markup.`,
              });
              if (!this.options.quiet) {
                this.log(chalk.yellow(`\n  │ 🔄 Harmony markup detected in content — re-prompting (${harmonyRepromptCount}/${MAX_HARMONY_REPROMPTS})...`));
              }
              continue;
            }
            throw new Error(
              `Model emitted Harmony markup tool calls inside content ${harmonyRepromptCount} times instead of structured tool_calls. ` +
              'This indicates a provider/model format incompatibility — try a different model, ' +
              'lower temperature (0.2-0.3), or disabling streaming (stream: false).'
            );
          }
        }
      }

      // Handle tool calls if any - PARALLEL EXECUTION
      if (response.tool_calls && response.tool_calls.length > 0) {
        consecutiveNoToolResponses = 0;
        this.log(chalk.gray(`\n${boxHeader('Tools', 2)}`));

        const isMultiple = response.tool_calls.length > 1;
        if (isMultiple) {
          this.log(chalk.gray(`  │ 🚀 Executing ${response.tool_calls.length} tools in parallel...`));
        }

        // Emit progress event
        this.emitProgress(
          `Executing ${response.tool_calls.length} tool${response.tool_calls.length > 1 ? 's' : ''}`,
          undefined,
          response.tool_calls.length
        );

        // Execute tool calls with concurrency limit (max 5) to prevent resource exhaustion
        const CONCURRENCY_LIMIT = 5;
    const toolResults: Array<{role: 'tool'; content: string; tool_call_id: string; name: string}> = [];
    const executeTool = async (toolCall: NonNullable<typeof response.tool_calls>[number]) => {
      this._toolRunCount++;
          const toolName = toolCall.function.name;
          this._toolCallCounts.set(toolName, (this._toolCallCounts.get(toolName) || 0) + 1);
          const tool = getToolByName(toolName);

          if (!tool) {
            if (!isMultiple) this.log(chalk.gray(`  │ ${chalk.red('✗')} Unknown tool: ${toolName}`));
            this.emitToolError(toolName, 'Unknown tool');
            toolsUsed.push({name: toolName, success: false, error: 'Unknown tool'});
            return {
              role: 'tool' as const,
              content: `Error: Unknown tool ${toolName}`,
              tool_call_id: toolCall.id,
              name: toolName,
            };
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            // Malformed tool arguments from the model (truncated stream, bad
            // escaping) — return a tool error result so the model can retry,
            // instead of letting Promise.all reject and crash the run (#406).
            const parseError = `Invalid tool arguments JSON for ${toolName}: ${String(toolCall.function.arguments || '').slice(0, 200)}`;
            this.emitToolError(toolName, parseError);
            this.log(chalk.gray(`  │ ${chalk.red('✗')} ${toolName}: ${parseError}`));
            this.audit?.emit({ type: 'tool_result', name: toolName, success: false, phase: 'args_parse', error: parseError.slice(0, 200) });
            toolsUsed.push({name: toolName, success: false, error: parseError});
            return {
              role: 'tool' as const,
              content: `Error: ${parseError}`,
              tool_call_id: toolCall.id,
              name: toolName,
            };
          }

          const toolStartTime = Date.now();
          try {
            verboseToolCall(toolName, args);

            // Emit tool start event
            this.emitToolStart(toolName, args);
            this.audit?.emit({ type: 'tool_call', iteration: iterations, name: toolName, args_digest: AuditLogger.digest(args) });

            const result = await tool.execute(args, this.toolContext);
            const toolDuration = Date.now() - toolStartTime;

            // Emit tool complete event
            this.emitToolComplete(toolName, result, toolDuration);
            this.audit?.emit({ type: 'tool_result', iteration: iterations, name: toolName, success: true, duration_ms: toolDuration, result_bytes: result?.length ?? 0 });

            if (isMultiple) {
              this.log(chalk.gray(`  │    ${chalk.green('✓')} ${toolName}`));
            } else {
              this.log(chalk.gray(`  │ 🔧 Using tool: ${toolName}`));
              this.log(chalk.gray(`  │    Args: ${JSON.stringify(args)}`));
              this.log(chalk.gray(`  │ ${chalk.green('✓')} Tool completed`));
            }

            toolsUsed.push({name: toolName, success: true, args});
            return {
              role: 'tool' as const,
              content: result,
              tool_call_id: toolCall.id,
              name: toolName,
            };
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const errorIcon = isMultiple ? '' : chalk.red('✗');

            // Emit tool error event
            this.emitToolError(toolName, errorMsg);
            this.audit?.emit({ type: 'tool_result', iteration: iterations, name: toolName, success: false, duration_ms: Date.now() - toolStartTime, error: errorMsg.slice(0, 200) });

            this.log(chalk.gray(`  │ ${errorIcon} ${toolName} failed: ${errorMsg}`));
            toolsUsed.push({name: toolName, success: false, error: errorMsg, args});

            // Enrich error with contextual analysis so the LLM can respond intelligently
            const enhanced = enhanceError(toolName, errorMsg, this.shellInfo.type);
            const enrichedContent = formatEnhancedError(enhanced);

            return {
              role: 'tool' as const,
              content: enrichedContent,
              tool_call_id: toolCall.id,
              name: toolName,
            };
          }
        };

        for (let i = 0; i < response.tool_calls.length; i += CONCURRENCY_LIMIT) {
          const batch = response.tool_calls.slice(i, i + CONCURRENCY_LIMIT);
          const batchResults = await Promise.all(batch.map(tc => executeTool(tc)));
          toolResults.push(...batchResults);
        }

        // CRITICAL: Check if the model only responded with tool calls and no text
        // Some models (NVIDIA Nemotron, older Llama) don't auto-generate synthesis
        // Force a continuation prompt to get a visible response for the user
        const hasToolCallsWithoutContent =
          response.tool_calls &&
          response.tool_calls.length > 0 &&
          (!response.content || response.content.trim() === '');

        // Auto-compress giant tool results before adding to history to prevent memory saturation
        const MAX_TOOL_RESULT_CHARS = 10 * 1024;
        function compressResult(content: string): string {
          if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
          const start = content.substring(0, 5000);
          const end = content.substring(content.length - 3000);
          return `${start}\n\n[... Tool output compressed: ${content.length} chars → 8000 chars to prevent memory saturation ...]\n\n${end}`;
        }

        // Push all results to messages
        for (let i = 0; i < toolResults.length; i++) {
          const result = toolResults[i];
          result.content = compressResult(result.content);
          if (i === toolResults.length - 1 && hasToolCallsWithoutContent) {
            // Append the nudge/instruction directly to the last tool result content.
            // This maintains the strict API role sequence (user -> assistant -> tool -> assistant)
            // for picky API gateways (e.g. Anthropic, NVIDIA NIM) while still prompting the model for synthesis.
            result.content += '\n\n[Instruction: Analyze the tool results above. If the task is not yet complete, proceed with the next steps or tool calls to complete the task. Otherwise, summarize the results for the user in natural language. If there were errors, explain what happened and take action to fix them.]';
          }
          messages.push(result);
        }

        // Summary for multiple tools
        if (isMultiple) {
          const successful = toolsUsed.filter(t => t.success).length;
          const failed = toolsUsed.filter(t => !t.success).length;
          this.log(chalk.gray(`  │`));
          if (failed > 0) {
            this.log(chalk.gray(`  │ ${chalk.yellow('📊')} Tools: ${successful} succeeded, ${failed} failed`));
          } else {
            this.log(chalk.gray(`  │ ${chalk.green('✓')} All ${successful} tools completed successfully`));
          }
        }
        this.log(chalk.gray(boxFooter(2)));
      } else {
        // No tool calls — check if LLM is reporting errors without fixing them
        const content = response.content || '';
        const hasToolRun = toolsUsed.length > 0;

        // Tool livelock detection: N consecutive non-empty responses without
        // tool calls means the model narrates instead of acting. A single
        // text response is fine (legit final answer ends the loop at 1) —
        // only a streak reaching the threshold is a livelock.
        consecutiveNoToolResponses++;
        if (livelockLimit > 0 && consecutiveNoToolResponses >= livelockLimit) {
          const lastOutput = content.trim().slice(0, 300);
          throw new Error(
            `[SC_LIVELOCK] Model produced ${consecutiveNoToolResponses} consecutive responses ` +
            `without tool calls in ${iterations} iterations — aborting run (tool livelock). ` +
            `Last model output: "${lastOutput}"`
          );
        }

        // Skip self-heal for purely conversational responses (greetings, clarifications, etc.)
        // But NOT if they also include concrete future actions
        const hasConversationalGreeting = /\b(hello|hi|hey|how are you|doing well|ready to help|what would you like|how can i help|nice to meet|greetings)\b/i.test(content);
        const hasFutureAction = /\b(i will|i'll|i am going to|let's|let me|i need to|i should|i plan to|first, I|first, let)\b/i.test(content);
        const isConversational = hasConversationalGreeting && !hasFutureAction;
        const isShortResponse = content.length < 200 && !hasToolRun && !hasFutureAction;

        const isDeferring = /\b(would you like|do you want|shall I|¿quieres|recommend|suggest|you (should|could|need to))\b/i.test(content);
        const isFutureIntention = this.options.autoApprove && /\b(i will|i'll|i am going to|let's|let me|i need to|i should|i plan to|first, I|first, let|we will|we'll|voy a|comenzaré|primero|debo|tengo que|procederé)\b/i.test(content);
        const hasErrorIndicators = /[❌✗⚠]/.test(content) || /\b(error|failed|fall[óo]|fail(ure)?)\b/i.test(content);
        const hasFailurePhrase = /\b(does not compile|compilation error|syntax error|cannot find|unable to|not compile|build fail)/i.test(content);

        const shouldSelfHeal = (
          !isConversational &&
          !isShortResponse &&
          (isDeferring || isFutureIntention || hasFailurePhrase || (hasErrorIndicators && hasToolRun))
          && selfHealCount < MAX_SELF_HEAL
        );

        // Metrics: log self-heal decision
        if (process.env.SC_DEBUG_METRICS) {
          verbose(`[METRICS] Self-heal: ${shouldSelfHeal ? 'ACTIVATED' : 'SKIPPED'} | Conversational: ${isConversational} | Short: ${isShortResponse} | Count: ${selfHealCount}/${MAX_SELF_HEAL}`);
        }

        if (shouldSelfHeal) {
          selfHealCount++;
          // Build strategy-aware prompt: track what's been tried
          const triedTools = [...new Set(toolsUsed.filter(t => !t.success).map(t => t.name))].join(', ');
          const errorSummary = toolsUsed.filter(t => !t.success).slice(-5)
            .map(t => `  - ${t.name}: ${(t.error || '').substring(0, 100)}`)
            .join('\n');
          let urgency = selfHealCount > 3
            ? `This is attempt ${selfHealCount}. You MUST resolve these issues now. Do not repeat what you already said.`
            : `You identified issues above but must take action to fix them.`;
          if (triedTools) {
            urgency += `\nTools that have failed: ${triedTools}.\nRecent errors:\n${errorSummary}\nTry a DIFFERENT approach — don't repeat the same failing operations.`;
          }
          if (this.options.autoApprove) {
            if (isFutureIntention) {
              urgency = `You described a plan or future intention, but you did not execute any tools in this iteration. You are in non-interactive auto-approve mode, so you have full permission. You MUST NOT just describe your plan. Execute the tools immediately to proceed with your plan.`;
            } else if (isDeferring) {
              urgency = `You proposed or suggested an action, but you did not execute any tools in this iteration. You are in non-interactive auto-approve mode, so you have full permission. Execute the tools immediately to apply your proposal.`;
            } else {
              urgency += ` You are in non-interactive auto-approve mode, so you have full permission. Execute the tools to apply your proposal immediately.`;
            }
          }
          messages.push({
            role: 'user',
            content: `[SELF-HEAL ${selfHealCount}/${MAX_SELF_HEAL} — iteration ${iterations}] ${urgency} Use the available tools to fix ALL problems. Do not ask for permission. Do not summarize again. Fix it now.`,
          });
          if (!this.options.quiet) {
            this.log(chalk.yellow(`\n  │ 🔧 Auto-continuing (${selfHealCount}/${MAX_SELF_HEAL}) — forcing fix...`));
          }
          continue;
        }

        // No tool calls, finish the loop
        continueLoop = false;
      }
    }

    const hitIterationLimit = iterations >= MAX_ITERATIONS;
    const failedTools = toolsUsed.filter(t => !t.success);
    const hadErrors = failedTools.length > 0;

    // Classify blocking errors (task-crippling vs recoverable)
    const blockingErrors = failedTools.filter(t => {
      const errorMsg = (t.error || '').toLowerCase();
      // Blocking errors: permission denied, syntax errors, unauthorized access in core file tools
      const isBlocking =
        (errorMsg.includes('permission denied') && t.name !== 'run_shell') ||
        errorMsg.includes('syntax error') ||
        (errorMsg.includes('cannot read') && t.name !== 'run_shell') ||
        (errorMsg.includes('access denied') && t.name !== 'run_shell');
      return isBlocking;
    });

    // Detect repeated errors (infinite loop detection)
    const errorCounts = new Map<string, number>();
    failedTools.forEach(t => {
      const errorMsg = (t.error || '').toLowerCase();
      const shouldExclude =
        errorMsg.includes('404') ||
        errorMsg.includes('not found') ||
        errorMsg.includes('not recognized') ||
        errorMsg.includes('cannot find the path');

      if (shouldExclude) return;

      let commandKey = t.name;
      if (t.args && typeof t.args === 'object') {
        const args = t.args as Record<string, unknown>;
        if (t.name === 'run_shell' && typeof args.command === 'string') {
          let cmd = args.command.toLowerCase().trim();
          // Strip leading cd commands to avoid clustering all commands under 'cd'
          cmd = cmd.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s&;]+)\s*(?:&&|;|;)\s*/i, '');
          const baseCmd = cmd.split(/[\s|]/)[0];
          commandKey = `${t.name}:${baseCmd}`;
        } else {
          commandKey = t.name;
        }
      }
      errorCounts.set(commandKey, (errorCounts.get(commandKey) || 0) + 1);
    });

    const repeatedErrors = Array.from(errorCounts.entries()).filter(([_, count]) => count >= 3);
    const hasRepeatedErrors = repeatedErrors.length > 0;

    // Determine if task actually completed despite errors
    const successfulTools = toolsUsed.filter(t => t.success);
    const hasBlockingErrors = blockingErrors.length > 0;
    const taskCompleted = successfulTools.length >= 1 && !hasBlockingErrors && !hitIterationLimit;

    // Compact fallback warning for iteration limit
    if (hitIterationLimit) {
      this.log(chalk.gray(`\n  ⚠️  Maximum iteration limit (${MAX_ITERATIONS}) reached`));
      if (hadErrors) console.log(chalk.gray(`  ${failedTools.length} error(s) encountered. The task may be incomplete.`));
    }

    // Warning for repeated errors (loop detection)
    if (hasRepeatedErrors && !taskCompleted) {
      this.log(chalk.gray('\n  ⚠️  Detected repeated errors (possible infinite loop):'));
      repeatedErrors.forEach(([errorKey, count]) => console.log(chalk.gray(`  ${count}x: ${errorKey.substring(0, 50)}...`)));
      this.log(chalk.gray('  The agent attempted the same failing operation multiple times.'));
    }

    // One-line feedback per outcome
    if (hitIterationLimit && !taskCompleted) {
      this.log(chalk.gray('\n  ❌ Task incomplete - iteration limit reached'));
    } else if (hasBlockingErrors) {
      this.log(chalk.gray('\n  ❌ Task incomplete - blocking errors encountered'));
    } else if (hadErrors && taskCompleted) {
      const errorList = [...new Set(failedTools.map(t => t.name))].join(', ');
      this.log(chalk.gray(`\n  ✓ Done (recovered from ${failedTools.length} error(s) in ${errorList})`));
    } else if (hadErrors && !taskCompleted) {
      this.log(chalk.gray('\n  ⚠️  Task may be incomplete - errors encountered'));
    } else if (toolsUsed.length > 0) {
      const toolNames = [...new Set(toolsUsed.map(t => t.name))].join(', ');
      const plural = toolsUsed.length !== 1 ? 's' : '';
      this.log(chalk.gray(`\n  ✓ Done (${toolsUsed.length} tool operation${plural}: ${toolNames})`));
    }

    verboseSession(this._sessionId || 'none', messages.length);

    // Emit completion event
    this.callbacks?.onComplete?.({
      type: 'complete',
      timestamp: Date.now(),
      data: {
        messages,
        toolsUsed: toolsUsed.map(t => t.name),
        iterations,
      },
    });

    return messages;
  }

  private onStreamChunk(delta: StreamDelta): void {
    if (delta.content) {
      // JSON headless mode: the manifest carries final_message — keep stdout clean
      if (this.options.outputFormat === 'json') return;
      // Clear thinking indicator on first content
      if (this._thinkingShown) {
        // ANSI: erase entire line, carriage return
        process.stdout.write('\x1b[2K\r');
        this._thinkingShown = false;
      }
      if (this.isFirstChunk) {
        process.stdout.write('\n');
        this.isFirstChunk = false;
      }
      process.stdout.write(renderInline(delta.content));
    }
  }
}
