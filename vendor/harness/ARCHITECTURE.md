# Architecture

Eight layers; each only depends downward. The dependency edges are enforced by the import graph (TypeScript) and could be enforced harder with an `oxlint` boundary rule.

```
┌─────────────────────────────────────────────────────────────┐
│ 7  Surface     server / channel / approval / skill          │  consumers
├─────────────────────────────────────────────────────────────┤
│ 6  Extension   plugin / mcp / acp                           │  optional add-ons
├─────────────────────────────────────────────────────────────┤
│ 5  Loop        agent (runLoop) / session manager            │  the heart
├─────────────────────────────────────────────────────────────┤
│ 4  Context     context engine / compaction                  │  what does the model see
├─────────────────────────────────────────────────────────────┤
│ 3  Execution   tool / permission / sandbox                  │  what does the agent do
├─────────────────────────────────────────────────────────────┤
│ 2  LLM         route / protocol / cache-policy              │  how do we talk to models
├─────────────────────────────────────────────────────────────┤
│ 1  Persistence storage / message schema / trajectory        │  what do we remember
├─────────────────────────────────────────────────────────────┤
│ 0  Foundation  types / bus / effect (InstanceState)         │  primitives
└─────────────────────────────────────────────────────────────┘
```

## Lifecycle of a single turn

```
user prompt
    │
    ▼
session lane queue ◄──── per-session FIFO, plus a process-aware write lock
    │
    ▼
runLoop iteration N
    │
    ├─► stop check: lastAssistant.finish ∧ ≠ "tool-calls" ∧ no pending tool calls ∧ lastUser < lastAssistant ─► BREAK
    │
    ├─► doom-loop check: last 3 tool-call parts identical? ─► ask user, may CONTINUE / BREAK
    │
    ├─► getModel → CachePolicy.apply(request)
    │
    ├─► ContextEngine.assemble({ messages, tokenBudget, availableTools, prompt }) ─► AssembleResult
    │       │
    │       └─► may compact if currentTokenCount > budget
    │
    ├─► hook: before_prompt_build
    ├─► hook: before_model_resolve
    ├─► LLMClient.stream(route, prepared) ───► Processor consumes events ───► MessageV2.Part rows
    │       │
    │       └─► TrajectoryRecorder.emit on every event
    │
    ├─► for each tool_call in stream:
    │       PermissionEngine.evaluate(toolName, args)
    │         │
    │         ├─► allow ─► ToolWrapper(toolName).execute(args, ctx) inside SandboxBridge ─► result truncated
    │         ├─► ask   ─► Approval.deliver(question) → await ApprovalReply
    │         └─► deny  ─► synthetic error result
    │       hook: before_tool_call / after_tool_call
    │
    ├─► hook: before_agent_reply
    └─► outcome ∈ { CONTINUE, COMPACT, BREAK }
            │
            └─► COMPACT: fork ContextEngine.compact(...) and resume

session.finalize → fire after_turn, prune old tool outputs, release write lock
```

## Interface dependency graph

```
                       ┌──────────────┐
                       │ types, bus,  │
                       │ effect       │
                       └──────┬───────┘
                              │
              ┌───────────────┼───────────────────┐
              │               │                   │
       ┌──────▼─────┐   ┌─────▼──────┐    ┌──────▼──────┐
       │  storage   │   │    llm     │    │  trajectory │
       └──────┬─────┘   └─────┬──────┘    └─────────────┘
              │               │
              │         ┌─────┴────────┐
              │         │ cache-policy │
              │         └──────────────┘
              │
        ┌─────▼──────────────────────────────────────┐
        │ message schema (MessageV2.Info / .Part)    │
        └─────┬──────────────────────────────────────┘
              │
        ┌─────▼──────┐    ┌────────────┐    ┌──────────────┐
        │   tool     │◄──►│ permission │◄──►│   sandbox    │
        └─────┬──────┘    └─────┬──────┘    └──────┬───────┘
              │                 │                  │
              └─────────┬───────┘                  │
                        │                          │
                  ┌─────▼─────────────────────────▼┐
                  │     context engine + compaction │
                  └─────┬───────────────────────────┘
                        │
                  ┌─────▼─────────┐
                  │  agent loop   │
                  │  + session    │
                  └─────┬─────────┘
                        │
            ┌───────────┼───────────┬───────────┐
            │           │           │           │
       ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌───▼────┐
       │ plugin  │ │  mcp    │ │  acp    │ │ skill  │
       └────┬────┘ └─────────┘ └─────────┘ └────────┘
            │
       ┌────▼────┐    ┌──────────┐    ┌──────────┐
       │ server  │    │ channel  │    │ approval │
       └─────────┘    └──────────┘    └──────────┘
```

## What's in vs out of the box

### In the box (reference impls included)

- In-memory `Bus` with per-instance scoping (use as-is or replace with PubSub libs)
- SQLite `SessionStore` (Bun-native or node-sqlite, behind a one-line import switch)
- `Route.make` + two protocols (Anthropic Messages, OpenAI Chat) — add more via `~5 lines per provider`
- `auto` cache policy (3-breakpoint placement) with provider-aware short-circuit
- Tool descriptor + availability AST + 4 standard wrappers (workspace-guard, param-validation, truncate-output, policy-filter)
- Last-wins wildcard `PermissionEngine` + 8-source merge helper
- Bash arity table (~100 CLIs) + tree-sitter integration point
- `LocalSandbox` (pass-through); `DockerSandbox` stub showing the interface
- `LegacyContextEngine` (no-op assemble + summarize-fallback compact)
- `runLoop` with stop check + doom-loop guard + session-lane queue + file-based write lock
- `PluginHost` loading the `Hooks` object from `npm:my-plugin`-style specs
- `TrajectoryRecorder` to JSON lines

### Out of the box (you'll write)

- A real model provider per provider you care about (start from `openai-chat` or `anthropic` template)
- A real `SandboxBridge` backend (Docker, Firecracker, e2b, etc.)
- A real surface (TUI/web/CLI) on top of the `Bus` event stream
- Channel adapters (Slack/Discord/iMessage/Telegram)
- Multi-tenant auth/session sharing if you go SaaS

## Design rules

1. **No circular deps.** The 8 layers go one way only. Tool execution depending on a UI symbol is a bug.
2. **Effect-free where possible.** Interfaces are plain TypeScript types. Reference impls use simple async/await. You can lift to Effect/fp-ts/whatever in your fork.
3. **Schemas are application-level, not DB-level.** Persistence is dumb (id, time, JSON `data`); evolution lives in `message-v2.ts`. See opencode pattern #8.
4. **Hooks compose.** Plugins return an object; no method overriding, no inheritance. See opencode plugin model.
5. **Permissions are observable.** Every ask publishes on the bus; UIs subscribe; replies route back through the same bus. No callbacks from execution into rendering.
6. **Sandbox is a bridge, not a wrapper.** Same code path runs locally (pass-through) or remotely (container exec). Tools never know which backend they're inside. See openclaw `fs-bridge`.
7. **Trajectory is for replay, not logs.** Events have monotonic `seq` + DAG parentage (`entryId`/`parentEntryId`) so a bundle can reconstruct a run deterministically.
8. **Cache breakpoints are derived, not annotated.** Auto-place 3 hints; let users add manual hints; never both. Provider-aware skip avoids waste.

## Where to start reading

1. `src/types.ts` — the vocabulary.
2. `src/agent.ts` — the loop, then chase what it calls.
3. `src/tool.ts` + `src/permission/index.ts` — the safety surface.
4. `src/llm/route.ts` — how a provider becomes runnable.
5. `example/minimal-cli.ts` — composition in one screen.
