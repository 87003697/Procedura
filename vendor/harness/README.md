# LLM Harness — a template agentic-coding system

A reference implementation of the 25 design patterns synthesized from `openclaw` and `opencode`. This is a **template**: most of the code is interface definitions + minimal reference implementations; you replace the pieces you don't want and build on top.

> See `ARCHITECTURE.md` for the layered architecture and `docs/` for per-module rationale tied back to the source patterns.

## What you get

A typed, swappable runtime for an LLM-based agent. Twelve core interfaces:

| Module | Interface | Borrowed from |
|---|---|---|
| `bus` | `Bus<E>` — typed pub/sub, per-instance scoped | opencode |
| `effect` | `InstanceState<T>` — per-key scoped cache with finalizers | opencode |
| `storage` | `SessionStore` — SQLite + JSON `data` column | opencode |
| `llm` | `Route.make({Protocol, Endpoint, Auth, Framing})` | opencode |
| `llm/cache-policy` | `applyAutoCache()` — 3-breakpoint placement | opencode |
| `tool` | `ToolDescriptor` + `availability` AST + wrappers | openclaw + opencode |
| `permission` | last-wins wildcard rules + multi-source merge + arity | opencode + openclaw |
| `sandbox` | `SandboxBridge` — `fs.read/write/edit/list/stat/move` over Docker/SSH/local | openclaw |
| `context` | `ContextEngine` — `bootstrap/ingest/assemble/compact/maintain` | openclaw |
| `agent` | `runLoop` — explicit stop-condition + doom-loop guard + session lane + write lock | opencode + openclaw |
| `plugin` | `Hooks` object — 20 lifecycle hooks | opencode |
| `trajectory` | monotonic DAG events for full-run replay | openclaw |

Plus optional extension modules: `mcp`, `acp`, `skill`, `channel`, `approval`, `server`.

## Quickstart

```bash
bun install
bun run example/minimal-cli.ts -- "list TODOs in the README"
```

The `example/minimal-cli.ts` composes the harness in ~60 lines:

```ts
import { createHarness } from "../src";
import { Anthropic } from "../src/llm/protocols/anthropic";
import { LocalSandbox } from "../src/sandbox";

const harness = await createHarness({
  storage: { kind: "sqlite", path: "./sessions.db" },
  llm: { provider: "anthropic", model: "claude-opus-4-7", auth: { kind: "env", var: "ANTHROPIC_API_KEY" } },
  sandbox: new LocalSandbox(process.cwd()),
  tools: ["read", "write", "edit", "bash", "grep", "glob"],
  permission: { defaults: "ask-on-write" },
});

const session = await harness.sessions.create({ title: "demo" });
await harness.run({ session, prompt: process.argv[2] });
```

## Status

- **Interfaces:** stable, copy them as-is into your own codebase.
- **Reference implementations:** minimal &mdash; in-memory bus, SQLite stub, two-protocol LLM. Replace freely.
- **Optional modules** (`mcp`, `acp`, `channel`, `server`): typed surfaces with placeholder impls.

## Layout

```
src/
  types.ts              # Result, JsonObject, ToolOwnerRef, etc.
  bus.ts                # typed pub/sub
  effect.ts             # InstanceState + lazy + global singleton helpers
  storage.ts            # SessionStore interface + SQLite reference impl
  llm/
    route.ts            # Route.make
    protocol.ts         # Protocol contract
    cache-policy.ts     # auto breakpoints
    protocols/
      anthropic.ts
      openai-chat.ts
  tool.ts               # ToolDescriptor + availability + wrappers + planner
  tool/builtins.ts      # read, write, edit, bash, grep, glob, todo
  permission/
    index.ts            # ask/reply service + last-wins eval
    arity.ts            # bash CLI arity table (~100 entries)
    shell-parse.ts      # tree-sitter integration point
  sandbox.ts            # SandboxBridge + LocalSandbox + DockerSandbox stub
  context.ts            # ContextEngine + LegacyEngine + compaction helpers
  agent.ts              # runLoop + doom-loop + session manager + lane + write-lock
  plugin.ts             # Hooks type + PluginHost
  trajectory.ts         # monotonic recording + bundle manifest
  server.ts             # optional HTTP API
  channel/
    adapter.ts          # channel adapter interface
  index.ts              # createHarness barrel
example/
  minimal-cli.ts
docs/
  *.md                  # per-module rationale
```

## Why a template?

The two source repos make ~25 small, individually-good decisions whose value is in their *composition*. Re-deriving each from scratch is the work of months. This template gives you the contracts so you can decide which to keep and which to swap, without re-learning the trade-offs.

## License

MIT.
