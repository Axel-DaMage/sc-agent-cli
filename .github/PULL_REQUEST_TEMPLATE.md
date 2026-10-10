## Summary

<!-- What does this PR change and why? Keep PRs focused on a single feature or fix. -->

## Linked issue

<!-- Required — use a closing keyword so merging auto-closes the issue. -->

Closes #

## Test plan

<!-- How was this verified? Include commands run and any manual smoke testing (provider used, OS). -->

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] `npm run test:e2e` passes (when CLI surface changes)

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`) — PRs are squash-merged, so the title becomes the commit message on `main`
- [ ] Linked issue above uses `Closes #N` / `Fixes #N`
- [ ] Tests added or updated for behavior changes (colocated `src/**/*.test.ts`, vitest)
- [ ] User-facing docs updated (`README.md`, `docs/`, `AGENTS.md`) and a `CHANGELOG.md` entry added under `Unreleased` when the change is user-visible
- [ ] New code is lint-clean (`npx eslint .`)
- [ ] No secrets, API keys, or credentials committed — see [SECURITY.md](SECURITY.md)

<!-- CI also runs CodeQL, dependency review, and PR security scans — see CONTRIBUTING.md if a flagged pattern is intentional. -->
