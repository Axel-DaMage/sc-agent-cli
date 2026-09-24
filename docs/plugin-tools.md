# External Tool Plugins

`sc` can load custom tools at startup without patching core — for org-specific
integrations (ticket systems, internal APIs, chat notifications, etc.).

## Configuration

Add a `plugins` array to `~/.sc-agent/config.json` or `.sc-agent.json`:

```json
{
  "plugins": ["./tools/discord-notify.mjs", "@org/scc-tools"]
}
```

Specifiers may be:

- **Relative paths** — resolved against the workspace root (`./tools/x.mjs`)
- **Absolute paths** and **`~/` home paths**
- **Package specifiers** — resolved from `node_modules` (`@org/scc-tools`)

Only explicit specifiers are loaded — there is no directory scan, so the tool
set stays predictable and auditable.

## Plugin module shape

A plugin is an ES module exporting a `Tool[]` — as the default export, a named
`tools` export, or the module namespace itself. A single `Tool` object is also
accepted.

```js
// tools/hello.mjs
export default [
  {
    definition: {
      type: 'function',
      function: {
        name: 'hello',
        description: 'Say hello to someone',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    },
    async execute(args, ctx) {
      return `Hello, ${args.name}!`;
    },
  },
];
```

The `Tool` interface is the stable contract:

```ts
interface Tool {
  definition: ToolDefinition;   // OpenAI function-calling schema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
```

`ctx` exposes `workspaceRoot`, the effective `ProjectConfig`, and the
`autoApprove` flag.

## Permissions & safety

- Plugin tools flow through the **existing permission system**: they require
  approval unless listed in `permissions.autoApprove` (or `-y` is used).
- `permissions.denyPaths` still applies to any file access the plugin performs
  via `resolveSafePath`.
- A plugin whose name collides with a built-in (or another plugin) is skipped —
  plugins can never shadow core tools.
- Load failures warn and skip — a broken plugin never crashes the CLI.

## Discovery

Loaded plugin tools appear in the tool schema sent to the model, in `/tools`
listings, and in `scc doctor` output like any built-in.
