# Tool-Call Sandboxing (#423)

Opt-in execution sandbox for `run_shell` tool calls — filesystem scope, network
egress, and optional syscall filtering for agent-spawned commands. Designed for
autonomous runs on CI runners and shared infrastructure.

## Configuration

Add a `sandbox` block to `.sc-agent.json` (project) or
`~/.sc-agent/config.json` (global):

```json
{
  "sandbox": {
    "enabled": true,
    "egressAllowlist": ["api.github.com:443", "*.npmjs.org"],
    "readOnlyPaths": ["/usr/share/fixtures"],
    "writablePaths": ["cache", "/var/tmp/agent-cache"],
    "seccomp": true
  }
}
```

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | bool | `false` | Opt-in switch. `SC_SANDBOX=1|0` overrides per-run. |
| `egressAllowlist` | `host` or `host:port` list | `[]` | Empty = **block all egress except loopback**. `*.dom` matches apex + subdomains; `*` allows everything. |
| `writablePaths` | path list | `[]` | Additional writable mounts (absolute or workspace-relative). Workspace root is always writable. |
| `readOnlyPaths` | path list | `[]` | Explicit read-only mounts layered over writable binds. |
| `seccomp` | bool | `false` | Enable the syscall denylist (Linux + bwrap + x86_64 only). |
| `seccompProfile` | path | – | Raw cBPF blob (e.g. `seccomp_export_bpf` output) replacing the built-in denylist. |

## Backends

| Backend | When | Boundary |
|---------|------|----------|
| `bwrap` | Linux + working `bubblewrap` | Mount/pid/ipc namespaces: `/` read-only, workspace + `writablePaths` writable, literal `denyPaths` masked (tmpfs over dirs, `/dev/null` over files). Egress: empty allowlist → `--unshare-net` (hard block, loopback brought up when bwrap ≥ 0.9); non-empty → shared net + proxy envs. `seccomp` installs a generated cBPF denylist via `--seccomp`. |
| `proxy` | macOS/Windows, or bwrap unavailable | Degraded: commands run unsandboxed behind the loopback egress proxy (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`). Filesystem and syscall layers are **not** enforced — the run manifest records `sandbox.exec_mode: "proxy"` + `degraded_reason`, and a one-time warning is printed. |

Run `sc doctor` to probe which backend a host provides.

## Egress

- `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` are injected into the
  sandboxed command's environment pointing at a loopback `EgressFilterProxy`.
- Every `CONNECT` tunnel and plain-HTTP forward is matched against the
  allowlist; non-allowlisted destinations get `403 Forbidden` and are recorded
  as `sandbox_violation` events (`{rule: "egress", target: "host:port"}`).
- With `bwrap` + empty allowlist there is **no** proxy: the command gets a
  fresh network namespace without any interfaces except loopback.
- The proxy is application-layer control — tools that ignore proxy env vars
  bypass it. Use the `bwrap` backend when raw-socket egress must be denied.

## Violations

Denials surface three ways:

1. **Structured tool error** — the `run_shell` result/error ends with
   `[SANDBOX_VIOLATION] {"rule":"fs|egress|seccomp|spawn","target":"…"}`
   lines; the agent is told not to retry the blocked operation.
2. **Audit log** — `sandbox_violation` events on `--audit-log` JSONL.
3. **Run manifest** — `sandbox.exec_mode`/`egress`/`seccomp`/`violations` plus
   a `sandbox_violations[]` list of `{rule, target}` objects.

stderr is scanned for denial signatures (EROFS mounts, EPERM seccomp,
`ENETUNREACH`, proxy 403) so kernel-level denials become structured events
instead of silent command failures.

## Interplay with permissions

Sandbox rules compose **additively** with `permissions.denyPaths` /
`denyCommands` — deny always wins:

- `denyCommands` still rejects matching commands before the sandbox sees them.
- Literal `denyPaths` entries are masked inside the sandbox mount namespace
  (glob entries stay enforced by the file tools' `resolveSafePath`).
- `writablePaths`/`readOnlyPaths` can widen the fs boundary but cannot un-deny
  a `denyPaths` entry.

## Limits & notes

- `seccomp: true` needs Linux + bwrap; the generated profile covers x86_64.
  Elsewhere it reports `seccomp: "unsupported"` instead of pretending.
- Sandbox setup failures are **fail-closed**: the command is not run, and the
  error is tagged `[SANDBOX_VIOLATION] {"rule":"spawn"}`.
- `SC_SANDBOX=on` forces enablement from CI without editing config files.
