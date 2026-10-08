# Contributing to SC-Agent CLI

Thanks for your interest in contributing! SC-Agent CLI is maintained under the
[`os-santiago`](https://github.com/os-santiago) GitHub organization and licensed
under Apache-2.0. Contributions of all sizes are welcome — for anything beyond a
small fix, open an issue first so the approach can be discussed.

## Prerequisites

- **Node.js >= 20** — the dev version is pinned in `.nvmrc` (Node 22, matching
  the devcontainer image); CI tests on Node 20, 22, 24, and 26
- **npm** (ships with Node)

## Getting Started

```bash
git clone https://github.com/os-santiago/sc-agent-cli.git
cd sc-agent-cli
npm ci
npm run build
node bin/sc.js --help
```

External contributors should fork the repo and clone their fork instead:
`git clone https://github.com/<your-username>/sc-agent-cli.git`.

### Devcontainer (optional)

The repo dogfoods its own `--devcontainer` support (#421):
`.devcontainer/devcontainer.json` provides the pinned Node toolchain and, on
create, runs `npm ci`, `npm run build`, and `npm link` so the `sc`/`scc` bins
resolve inside the container. Use it via `devcontainer up --workspace-folder .`,
VS Code "Reopen in Container", or run the agent itself inside it with
`sc chat --devcontainer`.

## Development Workflow

```bash
git checkout -b feat/my-feature        # or fix/, docs/, refactor/, ...
npm run dev                            # tsc --watch: recompile on save
# ... make your changes ...
npm run build && npm test              # the same gates CI runs
```

`npm run build` and `npm test` self-bootstrap dependencies via
`scripts/ensure-deps.mjs` — on a fresh worktree they run `npm ci` for you if
`node_modules` is missing. `npm ci` up front is still the recommended first step.

## Available Commands

| Command | What it does |
|---------|--------------|
| `npm ci` | Clean, lockfile-pinned install (what CI uses) |
| `npm run build` | Compile TypeScript to `dist/` (`tsc`, strict mode) |
| `npm run dev` | `tsc --watch` — incremental rebuild while you work |
| `npm test` | Run the full vitest suite (`vitest run`) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with v8 coverage (thresholds in `vitest.config.ts`) |
| `npm start` | Run the CLI from source (`node bin/sc.js`) |
| `npx eslint .` | Lint with the flat config in `eslint.config.mjs` |

There is no `npm run lint` script yet. ESLint + typescript-eslint are configured
(`eslint.config.mjs`) and CI's security-scan workflow runs
`npx eslint --ext .ts,.js src/ --max-warnings=0` in advisory mode, so keep new
code lint-clean even though lint is not (yet) a hard gate.

## Testing


Testing is **automated**, not manual. The repo ships a vitest suite (~35 test
files) colocated with sources as `src/**/*.test.ts`. Config lives in
`vitest.config.ts` (`environment: 'node'`, `globals: false` — import
`describe`/`it`/`expect`/`vi` from `'vitest'` in each test file).

Run the automated suite with `npm test` (vitest). CLI-level tests in
`src/cli.test.ts` build `dist/` automatically when missing, but `npm run build`
first is the recommended workflow.

For manual smoke testing:

### Running a subset of tests

```bash
npx vitest run src/core/config.test.ts   # a single file
npx vitest run src/core                  # a directory
npx vitest run -t "resolves failover"    # filter by test name
npx vitest run --changed                 # tests related to your git changes
npm run test:watch                       # re-runs affected tests on save
```

PRs that change behavior are expected to include or update tests, matching the
existing `*.test.ts` conventions.

### E2E smoke suite

`test/e2e/` spawns the built `bin/sc.js` — offline commands (`--version`,
`--help`, `sc doctor`) plus headless `sc chat` runs against a mock
OpenAI-compatible provider, asserting the documented exit codes end-to-end.
Requires a prior build:

```bash
npm run build && npm run test:e2e
```

See [`test/e2e/README.md`](test/e2e/README.md) for how the mock provider and
spawn helpers work.

### End-to-end / manual verification

Unit tests don't cover live provider behavior. For real-agent verification:

```bash
npm run build
node bin/sc.js                          # interactive session
node bin/sc.js -yq "list files here"    # headless batch run
node bin/sc.js doctor                   # config/provider preflight checks
```

- `scripts/test-chat.sh` — builds, then launches an interactive smoke session
- `scripts/test-nvidia.sh` — smoke test for the NVIDIA profile (needs `NVIDIA_API_KEY`)
- `TEST-SETUP.md` — manual environment-verification checklist (PowerShell/WSL)
- `docs/non-interactive-mode.md` — batch-mode flags and run manifest
- `docs/exit-codes.md` — canonical exit-code contract (asserted by `test/e2e/chat-exit-codes.test.ts`)

Test with at least one real provider before opening a PR — Ollama is the easiest
local option (`sc profile use ollama`).

## Code Style

- **TypeScript strict mode** (`tsconfig.json`), ES modules — the package is
  `"type": "module"`. Use `node:*` imports for built-ins and include the `.js`
  extension on relative imports.
- **Formatting**: match the surrounding code — 2-space indent, single quotes,
  semicolons, trailing commas. Indentation, charset, and newline defaults are
  pinned in `.editorconfig` (most editors honor it natively or via plugin).
- **Linting**: `eslint.config.mjs` (flat config, typescript-eslint recommended).
  Notable rules: `@typescript-eslint/no-unused-vars` errors unless prefixed with
  `_`; `no-explicit-any` warns.
- **Pre-commit hook**: husky + lint-staged runs
  `vitest run --reporter=verbose --changed` on staged `*.ts` files — committing
  TypeScript changes automatically runs the tests related to your diff.
- Handle errors with meaningful messages; avoid `any` in new code.
- All file operations must go through `resolveSafePath` validation.

## Pull Requests

- **Title**: follow [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`, `test: ...`,
  `chore: ...`. PRs are **squash-merged**, so the title becomes the commit
  message on `main`.
- **Link the issue**: put `Closes #N` (or `Fixes #N`) in the PR body so merging
  auto-closes it. Changelog entries reference issues the same way
  (`(Closes #N)`).
- Keep PRs focused on a single feature or fix, and explain the *why* in the
  description, not just the *what*.
- Update user-facing docs (`README.md`, `docs/`, `AGENTS.md`) and add a
  `CHANGELOG.md` entry under `Unreleased` when the change is user-visible.

### What CI runs on your PR

- **CI** (`ci.yml`): `npm ci` → `npm run build` → `npm test` on Ubuntu Node
  20/22/24/26 plus Windows and macOS on Node 22, plus a coverage report.
- **Security scan** (`security-scan.yml`): CodeQL, TruffleHog secret scanning,
  `npm audit`, license compliance (GPL-licensed deps fail), and pattern scans
  for `eval(`, WebSocket usage, base64/obfuscation, and hardcoded secrets.
- **PR security checks** (`pr-security-checks.yml`): dependency review (GPL
  denied), plus scans restricted to the lines your PR **adds** — hex/unicode
  escapes (`\xNN`, `\uNNNN`), WebSockets, `FormData` uploads, and clipboard
  access fail the check. Changes to `src/utils/permissions.ts` or
  `src/utils/dangerous-commands.ts` get flagged for extra review.

If your change legitimately needs a flagged pattern, expect to justify it in
review — the scans are intentional.


## Adding Features

### Adding a New Tool

1. Create `src/tools/my-tool.ts` implementing the `Tool` interface:

   ```typescript
   import type { Tool, ToolContext } from './tool.js';

   export const myTool: Tool = {
     definition: {
       type: 'function',
       function: {
         name: 'my_tool',
         description: 'Description of what it does',
         parameters: {
           type: 'object',
           properties: {
             arg1: { type: 'string', description: '...' },
           },
           required: ['arg1'],
         },
       },
     },
     async execute(args, ctx) {
       // Implementation
       return 'result';
     },
   };
   ```

2. Register it in `ALL_TOOLS` in `src/tools/registry.ts`.
3. If it is read-only, add it to the auto-approve list in `src/core/config.ts`;
   mutating tools go through the permission system automatically.
4. Add a `my-tool.test.ts` covering happy path and error cases.

### Adding a New Command

1. Create `src/commands/my-command.ts` with the command logic.
2. Register it in `src/cli.ts` via Commander (`program.command(...)`).
3. Add it to tab completion in `src/utils/autocomplete.ts` and to `/help` in
   `src/commands/chat-session.ts`.
4. Cover parsing/registration in `src/cli.test.ts` or a colocated test file.

### Adding Support for a New Provider Type

The provider layer speaks the OpenAI-compatible API (`src/core/provider.ts`,
with the failover contract in `src/core/failover.ts`). To add a provider with a
different API shape (e.g. native Anthropic Messages API):

1. Create a new provider class in `src/core/` implementing the same interface
   as `OpenAICompatibleProvider`.
2. Extend `src/core/types.ts` with the new provider type.
3. Update `src/core/agent.ts` to instantiate it.

## Questions?

[Open an issue](https://github.com/os-santiago/sc-agent-cli/issues) to discuss
ideas before starting major changes.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).


## Adding Features

### Adding a New Tool

1. Create `src/tools/my-tool.ts` implementing the `Tool` interface:

   ```typescript
   import type { Tool, ToolContext } from './tool.js';

   export const myTool: Tool = {
     definition: {
       type: 'function',
       function: {
         name: 'my_tool',
         description: 'Description of what it does',
         parameters: {
           type: 'object',
           properties: {
             arg1: { type: 'string', description: '...' },
           },
           required: ['arg1'],
         },
       },
     },
     async execute(args, ctx) {
       // Implementation
       return 'result';
     },
   };
   ```

2. Register it in `ALL_TOOLS` in `src/tools/registry.ts`.
3. If it is read-only, add it to the auto-approve list in `src/core/config.ts`;
   mutating tools go through the permission system automatically.
4. Add a `my-tool.test.ts` covering happy path and error cases.

### Adding a New Command

1. Create `src/commands/my-command.ts` with the command logic.
2. Register it in `src/cli.ts` via Commander (`program.command(...)`).
3. Add it to tab completion in `src/utils/autocomplete.ts` and to `/help` in
   `src/commands/chat-session.ts`.
4. Cover parsing/registration in `src/cli.test.ts` or a colocated test file.

### Adding Support for a New Provider Type

The provider layer speaks the OpenAI-compatible API (`src/core/provider.ts`,
with the failover contract in `src/core/failover.ts`). To add a provider with a
different API shape (e.g. native Anthropic Messages API):

1. Create a new provider class in `src/core/` implementing the same interface
   as `OpenAICompatibleProvider`.
2. Extend `src/core/types.ts` with the new provider type.
3. Update `src/core/agent.ts` to instantiate it.

## Questions?

[Open an issue](https://github.com/os-santiago/sc-agent-cli/issues) to discuss
ideas before starting major changes.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
