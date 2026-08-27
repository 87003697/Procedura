/**
 * Public surface — the createHarness factory.
 *
 * Compose all twelve interfaces into one runtime. Replace any with your
 * own implementation by passing it in `opts`.
 */

import type { AsyncDisposable, ModelRef, SessionId } from "./types.ts";
import { createBus, type StandardEvents } from "./bus.ts";
import { createInMemoryStore, type SessionStore } from "./storage.ts";
import { createToolRegistry, type ToolRegistry } from "./tool.ts";
import { BUILTINS } from "./tool/builtins.ts";
import { createPermissionEngine, STANDARD_RULESETS, type PermissionEngine } from "./permission/index.ts";
import { createLocalSandbox, type SandboxBridge } from "./sandbox.ts";
import { createLegacyEngine, type ContextEngine } from "./context.ts";
import { createLLMClient, type LLMClient, type RouteDef } from "./llm/route.ts";
import { createPluginHost, type PluginHost } from "./plugin.ts";
import { createTrajectoryRecorder, type TrajectoryRecorder } from "./trajectory.ts";
import { createSessionLane, runLoop, type RunOutcome, type SessionLane } from "./agent.ts";
import type { TraceId } from "./types.ts";
import type { CanonicalMessage } from "./llm/protocol.ts";
import type { MessageInfo } from "./storage.ts";

export interface HarnessOpts {
  workspace: { rootDir: string; cwd?: string; additionalRoots?: string[] };
  llm: { route: RouteDef<unknown>; client?: LLMClient };
  storage?: SessionStore;
  sandbox?: SandboxBridge;
  context?: ContextEngine;
  /** Built-ins to include from `tool/builtins.ts`. */
  includeBuiltins?: boolean;
  /** Custom tools, registered after built-ins. */
  customTools?: import("./tool.ts").ToolExecutor[];
  /** Initial permission ruleset; defaults to STANDARD_RULESETS.build. */
  defaultRuleset?: import("./permission/index.ts").Ruleset;
  /** Plugin specs (npm:..., file path, or factory functions). */
  plugins?: (string | import("./plugin.ts").PluginFactory)[];
  /** Trajectory sink — defaults to no-op. */
  trajectorySink?: (event: import("./trajectory.ts").TrajectoryEvent) => void | Promise<void>;
}

export interface Harness extends AsyncDisposable {
  bus: import("./bus.ts").Bus<StandardEvents & Record<string, unknown>>;
  store: SessionStore;
  tools: ToolRegistry;
  permission: PermissionEngine;
  sandbox: SandboxBridge;
  context: ContextEngine;
  llm: LLMClient;
  route: RouteDef<unknown>;
  plugins: PluginHost;
  trajectory: TrajectoryRecorder;
  lane: SessionLane;

  sessions: {
    create(opts: { title?: string; agentKind?: string; model: ModelRef }): Promise<SessionId>;
  };

  /** Run a single turn. The caller is responsible for appending the user message first. */
  run(opts: {
    sessionId: SessionId;
    model: ModelRef;
    runtimeToolAllowlist?: Set<string>;
    maxSteps?: number;
    signal?: AbortSignal;
  }): Promise<RunOutcome>;

  /** Convenience: append a user message and run. */
  ask(opts: { sessionId: SessionId; model: ModelRef; prompt: string; signal?: AbortSignal }): Promise<RunOutcome>;
}

export async function createHarness(opts: HarnessOpts): Promise<Harness> {
  const bus = createBus<StandardEvents & Record<string, unknown>>();
  const store = opts.storage ?? createInMemoryStore();
  const sandbox = opts.sandbox ?? createLocalSandbox(opts.workspace);
  const lane = createSessionLane();
  const llm = opts.llm.client ?? createLLMClient();

  const permission = createPermissionEngine({
    bus,
    initialLayers: [{ source: "agent", rules: opts.defaultRuleset ?? STANDARD_RULESETS.build }],
  });

  const tools = createToolRegistry();
  if (opts.includeBuiltins !== false) {
    for (const t of BUILTINS) tools.register(t);
  }
  for (const t of opts.customTools ?? []) tools.register(t);

  const context = opts.context ?? createLegacyEngine({
    materialize: (messages: MessageInfo[]): CanonicalMessage[] =>
      messages.map((m) => ({
        role: m.role,
        content: [{ kind: "text", text: JSON.stringify(m.data) }],
      })),
  });

  const plugins = createPluginHost({
    bus,
    workspaceDir: opts.workspace.rootDir,
    config: {},
  });
  for (const spec of opts.plugins ?? []) await plugins.load(spec);

  const trajectory = createTrajectoryRecorder({
    traceId: `trace_${Date.now().toString(36)}` as TraceId,
    sink: opts.trajectorySink ?? (() => undefined),
  });

  const runOnce: Harness["run"] = async (runOpts) => {
    const lock = await lane.acquire(runOpts.sessionId);
    try {
      return await runLoop(
        { bus, store, tools, permission, sandbox, context, llm, route: opts.llm.route },
        {
          sessionId: runOpts.sessionId,
          runId: `run_${Date.now().toString(36)}` as import("./types.ts").RunId,
          model: runOpts.model,
          ...(runOpts.runtimeToolAllowlist !== undefined ? { runtimeToolAllowlist: runOpts.runtimeToolAllowlist } : {}),
          ...(runOpts.maxSteps !== undefined ? { maxSteps: runOpts.maxSteps } : {}),
          ...(runOpts.signal !== undefined ? { signal: runOpts.signal } : {}),
        },
      );
    } finally {
      await lock.dispose();
    }
  };

  return {
    bus, store, tools, permission, sandbox, context, llm,
    route: opts.llm.route, plugins, trajectory, lane,

    sessions: {
      async create(o) {
        const sessionId = `sess_${Date.now().toString(36)}` as SessionId;
        await store.createSession({
          id: sessionId,
          workspaceDir: opts.workspace.rootDir,
          ...(o.title !== undefined ? { title: o.title } : {}),
          agentKind: o.agentKind ?? "build",
          model: o.model,
        });
        bus.emit("session.created", { sessionId });
        return sessionId;
      },
    },

    run: runOnce,

    async ask(askOpts) {
      const msg: import("./storage.ts").MessageInfo = await store.appendMessage({
        id: `msg_${Date.now().toString(36)}` as import("./types.ts").MessageId,
        sessionId: askOpts.sessionId,
        role: "user",
        data: { text: askOpts.prompt },
      });
      bus.emit("message.append", { sessionId: askOpts.sessionId, messageId: msg.id, role: "user" });
      return runOnce({
        sessionId: askOpts.sessionId,
        model: askOpts.model,
        ...(askOpts.signal !== undefined ? { signal: askOpts.signal } : {}),
      });
    },

    async dispose() {
      await trajectory.dispose();
      await plugins.dispose();
      await context.dispose();
      await sandbox.dispose();
      await permission.dispose();
      await tools.dispose();
      await store.dispose();
      await bus.dispose();
    },
  };
}

// Re-exports for convenience
export type { Bus, StandardEvents } from "./bus.ts";
export type { SessionStore, SessionInfo, MessageInfo, PartInfo, PartKind } from "./storage.ts";
export type { ToolDescriptor, ToolExecutor, ToolRegistry, ToolContext, ToolResult, ToolWrapper } from "./tool.ts";
export type { PermissionEngine, Rule, Ruleset, Action } from "./permission/index.ts";
export type { SandboxBridge, FileInfo, ExecResult } from "./sandbox.ts";
export type { ContextEngine, AssembleInput, AssembleResult, CompactInput, CompactResult } from "./context.ts";
export type { LLMClient, RouteDef } from "./llm/route.ts";
export { Route, Endpoint, Auth, Framing, createLLMClient } from "./llm/route.ts";
export type { Protocol, CanonicalRequest, CanonicalMessage, CanonicalPart, ImageAttachment, LLMEvent } from "./llm/protocol.ts";
export type { Hooks, PluginHost, PluginInput, PluginFactory } from "./plugin.ts";
export type { TrajectoryEvent, TrajectoryRecorder } from "./trajectory.ts";
export { runLoop, detectDoomLoop, DOOM_LOOP_THRESHOLD } from "./agent.ts";
export { evaluate, mergeLayers, STANDARD_RULESETS } from "./permission/index.ts";
export { ARITY, arityPattern } from "./permission/arity.ts";
export { planCommand } from "./permission/shell-parse.ts";
export { AnthropicMessages } from "./llm/protocols/anthropic.ts";
export { OpenAIChat } from "./llm/protocols/openai-chat.ts";
export { applyAutoCache } from "./llm/cache-policy.ts";
