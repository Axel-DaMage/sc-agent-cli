# Persistent Memory — Scoped Tiers

sc-agent-cli persists memories across sessions in `~/.sc-agent/memory/memory.json`
(owner-only: dir `0700`, file `0600`). Since v0.4.x (#476) memories are
**scoped per workspace** — a memory saved while working in repo A is never
injected into a session running in repo B.

## Tiers

| Tier | Visibility | How entries land there |
|------|-----------|------------------------|
| `workspace` | Only the owning workspace (default) | `memory_write` default scope, `/remember <text>` |
| `global` | Every workspace (opt-in) | `memory_write` with `scope: "global"`, `/remember --global <text>` |
| `legacy` | Loadable everywhere, **never auto-injected** | Automatic migration of pre-scoping `memory.json` entries |

### Workspace identity

A workspace is identified by `sha256(realpath(workspaceRoot)).slice(0, 12)`.
Symlinked paths resolve to the same workspace. When the workspace root cannot
be resolved (deleted directory, missing mount), only the `global` and `legacy`
tiers are loaded — workspace-scoped writes fail with a clear error telling you
to use `scope: "global"` instead.

### Injection & provenance

The system prompt injects up to **10 memories** per session: workspace entries
first (most recent), then global entries filling the remaining slots. Every
injected line carries a provenance tag so the model knows where the memory
came from:

```text
# Persistent Memories (from previous sessions)
[memory:workspace] [api-conventions]: use zod for request validation
[memory:global] [user-prefs]: prefers terse answers
```

`legacy` entries are never part of this block.

## Commands (interactive chat)

```text
/remember <text>                        Save to the workspace tier
/remember --global <text>               Save to the global tier
/memory                                 List workspace + global memories
/memory show <key>                      Print one memory (any tier, exact key)
/memory show --all                      Include quarantined legacy entries
/memory move <key> --to workspace|global  Re-file a memory between scopes
/memory forget <key>                    Remove a memory
/memory clear                           Wipe workspace + global + legacy
```

`/memory clear` and `/memory forget` can never touch another workspace's
entries — foreign entries are quarantined and invisible to the session.

## Tool arguments

`memory_write` accepts:

| Arg | Notes |
|-----|-------|
| `key` | Unique key (or `id` — same thing) |
| `content` | Required for new memories. Omit with an existing `key`/`id` + `scope` to **move** the entry without rewriting it |
| `tags` | Comma-separated tags |
| `scope` | `"workspace"` (default) or `"global"` |

Re-writing an existing key into a different scope re-files it — this is the
programmatic equivalent of `/memory move`.

`memory_read` searches the workspace + global tiers (`search`/no-arg summary)
and answers exact-key lookups from any tier. Results carry the
`[memory:<scope>]` provenance tag.

## Migration from the v1 store

On first load after the upgrade, entries without a `scope` are moved to the
`legacy` tier, the file is rewritten as `version: 2`, and the original is
preserved at `~/.sc-agent/memory/memory.json.pre-v2.bak`.

Legacy entries still answer exact-key `recall`/`/memory show <key>` lookups
and appear under `/memory show --all`, so nothing is lost — but they are never
injected into the model context. Re-file the ones you still want:

```text
/memory move user-prefs --to global      # share everywhere
/memory move api-notes  --to workspace   # bind to this repo
```

## Why

A single global `memory.json` meant the last 10 memories from **every**
project were injected into **every** session — cross-project leakage of
secrets and project details, plus durable prompt injection from any repo that
managed to get a poisoned `memory_write` stored. Scoping removes both risks
while keeping the opt-in `global` tier for genuinely shared facts.
