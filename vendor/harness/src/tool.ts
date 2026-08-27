/**
 * Tool system — two-layer architecture.
 *
 * Layer A: declarative ToolDescriptor + availability AST + planner.
 *          Borrowed from openclaw src/tools/types.ts, planner.ts.
 *
 * Layer B: ToolExecutor (the runtime) + wrappers.
 *          Borrowed from openclaw src/agents/pi-tools.ts wrappers,
 *          plus opencode's uniform Effect.withSpan + Truncate wrapper.
 *
 * The model gets a tool list materialized from descriptors after the
 * planner evaluates availability for the current turn.
 */

import type {
  AsyncDisposable, JsonObject, MessageId, SessionId, ToolCallId,
  ToolOwnerRef, WorkspaceContext,
} from "./types.ts";
import type { Bus, StandardEvents } from "./bus.ts";
import type { ImageAttachment } from "./llm/protocol.ts";

// ──────────────────────────────────────────────────────────────────────────
// Availability AST (openclaw pattern)
// ──────────────────────────────────────────────────────────────────────────

export type AvailabilitySignal =
  | { kind: "always" }
  | { kind: "auth"; providerId: string }
  | { kind: "config"; path: string; expect?: "non-empty" | "available" }
  | { kind: "env"; var: string }
  | { kind: "plugin-enabled"; pluginId: string }
  | { kind: "context"; key: string; equals: unknown };

export type AvailabilityExpr =
  | AvailabilitySignal
  | { kind: "allOf"; of: AvailabilityExpr[] }
  | { kind: "anyOf"; of: AvailabilityExpr[] }
  | { kind: "not"; of: AvailabilityExpr };

export interface AvailabilityContext {
  authedProviders: Set<string>;
  configPath(p: string): unknown;
  env: Record<string, string | undefined>;
  enabledPlugins: Set<string>;
  contextValues: Record<string, unknown>;
}

export type AvailabilityResult =
  | { available: true }
  | { available: false; reason: string };

export function evaluateAvailability(
  expr: AvailabilityExpr | undefined,
  ctx: AvailabilityContext,
): AvailabilityResult {
  if (!expr) return { available: true };
  switch (expr.kind) {
    case "always": return { available: true };
    case "auth":
      return ctx.authedProviders.has(expr.providerId)
        ? { available: true }
        : { available: false, reason: `Missing auth provider: ${expr.providerId}` };
    case "config": {
      const v = ctx.configPath(expr.path);
      if (v === undefined || v === null) return { available: false, reason: `Missing config: ${expr.path}` };
      if (expr.expect === "non-empty" && (typeof v === "string" ? v.length === 0 : false))
        return { available: false, reason: `Empty config: ${expr.path}` };
      return { available: true };
    }
    case "env":
      return ctx.env[expr.var] !== undefined
        ? { available: true }
        : { available: false, reason: `Missing env var: ${expr.var}` };
    case "plugin-enabled":
      return ctx.enabledPlugins.has(expr.pluginId)
        ? { available: true }
        : { available: false, reason: `Plugin not enabled: ${expr.pluginId}` };
    case "context":
      return ctx.contextValues[expr.key] === expr.equals
        ? { available: true }
        : { available: false, reason: `Context mismatch: ${expr.key}` };
    case "allOf":
      for (const sub of expr.of) {
        const r = evaluateAvailability(sub, ctx);
        if (!r.available) return r;
      }
      return { available: true };
    case "anyOf": {
      const reasons: string[] = [];
      for (const sub of expr.of) {
        const r = evaluateAvailability(sub, ctx);
        if (r.available) return { available: true };
        reasons.push(r.reason);
      }
      return { available: false, reason: `None matched: ${reasons.join("; ")}` };
    }
    case "not": {
      const r = evaluateAvailability(expr.of, ctx);
      return r.available ? { available: false, reason: "Negation matched" } : { available: true };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ToolDescriptor — what the model sees and what the host plans
// ──────────────────────────────────────────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonObject;        // JSON Schema (use zod-to-json-schema)
  outputSchema?: JsonObject;
  owner: ToolOwnerRef;
  availability?: AvailabilityExpr;
  annotations?: JsonObject;
  /** Deterministic sort key for prompt-cache stability. Defaults to name. */
  sortKey?: string;
}

export interface ToolPlan {
  visible: ToolDescriptor[];
  hidden: { descriptor: ToolDescriptor; reason: string }[];
}

export function buildToolPlan(
  descriptors: ToolDescriptor[],
  ctx: AvailabilityContext,
): ToolPlan {
  const sorted = [...descriptors].sort((a, b) =>
    (a.sortKey ?? a.name).localeCompare(b.sortKey ?? b.name));
  const seen = new Set<string>();
  for (const d of sorted) {
    if (seen.has(d.name)) throw new Error(`Duplicate tool name: ${d.name}`);
    seen.add(d.name);
  }
  const visible: ToolDescriptor[] = [];
  const hidden: ToolPlan["hidden"] = [];
  for (const d of sorted) {
    const r = evaluateAvailability(d.availability, ctx);
    if (r.available) visible.push(d);
    else hidden.push({ descriptor: d, reason: r.reason });
  }
  return { visible, hidden };
}

// ──────────────────────────────────────────────────────────────────────────
// ToolExecutor — runtime side
// ──────────────────────────────────────────────────────────────────────────

export interface ToolContext {
  sessionId: SessionId;
  messageId: MessageId;
  toolCallId: ToolCallId;
  workspace: WorkspaceContext;
  signal: AbortSignal;
  bus: Bus<StandardEvents & Record<string, unknown>>;
  /** Ask the user via permission engine; returns true if allowed. */
  ask(question: string, kind?: string): Promise<boolean>;
  /** Get/set per-session arbitrary state. */
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
}

export type ToolResult =
  | { ok: true; output: string | JsonObject; attachments?: ImageAttachment[] }
  | { ok: false; error: string };

export interface ToolExecutor {
  descriptor: ToolDescriptor;
  execute(input: JsonObject, ctx: ToolContext): Promise<ToolResult>;
}

// ──────────────────────────────────────────────────────────────────────────
// Wrappers — composable around any ToolExecutor
// ──────────────────────────────────────────────────────────────────────────

export type ToolWrapper = (executor: ToolExecutor) => ToolExecutor;

/** Compose multiple wrappers; left-to-right means leftmost runs outermost. */
export function composeWrappers(...wrappers: ToolWrapper[]): ToolWrapper {
  return (executor) => wrappers.reduceRight((acc, w) => w(acc), executor);
}

/** Enforce that every path argument stays inside the workspace root(s). */
export function wrapWorkspaceRootGuard(opts: { pathFields: string[] }): ToolWrapper {
  return (executor) => ({
    ...executor,
    async execute(input, ctx) {
      const roots = [ctx.workspace.rootDir, ...(ctx.workspace.additionalRoots ?? [])];
      for (const field of opts.pathFields) {
        const v = input[field];
        if (typeof v !== "string") continue;
        const allowed = roots.some((r) => isPathInside(v, r));
        if (!allowed) {
          return { ok: false, error: `Path '${v}' outside workspace roots` };
        }
      }
      return executor.execute(input, ctx);
    },
  });
}

/** Truncate large outputs to a sidecar file, replacing the tool result. */
export function wrapTruncateOutput(opts: { maxBytes: number; writeSidecar(text: string): Promise<string> }): ToolWrapper {
  return (executor) => ({
    ...executor,
    async execute(input, ctx) {
      const r = await executor.execute(input, ctx);
      if (!r.ok) return r;
      const text = typeof r.output === "string" ? r.output : JSON.stringify(r.output);
      if (text.length <= opts.maxBytes) return r;
      const path = await opts.writeSidecar(text);
      return {
        ok: true,
        output: `${text.slice(0, opts.maxBytes)}\n\n…output truncated…\n\nFull output saved to: ${path}`,
      };
    },
  });
}

/** Schema-validate the input before execution. */
export function wrapParamValidation(opts: { validate(input: unknown): { ok: true } | { ok: false; error: string } }): ToolWrapper {
  return (executor) => ({
    ...executor,
    async execute(input, ctx) {
      const r = opts.validate(input);
      if (!r.ok) return { ok: false, error: `Invalid args: ${r.error}` };
      return executor.execute(input, ctx);
    },
  });
}

/** Open-time span tracing (Otel / Honeycomb / whatever). */
export function wrapSpan(opts: { onSpan(span: { tool: string; sessionId: string; messageId: string; toolCallId: string; durationMs: number; ok: boolean }): void }): ToolWrapper {
  return (executor) => ({
    ...executor,
    async execute(input, ctx) {
      const t0 = Date.now();
      const r = await executor.execute(input, ctx);
      opts.onSpan({
        tool: executor.descriptor.name,
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        toolCallId: ctx.toolCallId,
        durationMs: Date.now() - t0,
        ok: r.ok,
      });
      return r;
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────
// ToolRegistry — owns the set of executors and runs them
// ──────────────────────────────────────────────────────────────────────────

export interface ToolRegistry extends AsyncDisposable {
  register(executor: ToolExecutor): void;
  unregister(name: string): void;
  get(name: string): ToolExecutor | undefined;
  list(): ToolExecutor[];
  /** Build the per-turn ToolPlan using current registrations + availability. */
  plan(ctx: AvailabilityContext): ToolPlan;
}

export function createToolRegistry(opts: { wrappers?: ToolWrapper[] } = {}): ToolRegistry {
  const map = new Map<string, ToolExecutor>();
  const wrap = opts.wrappers && opts.wrappers.length
    ? composeWrappers(...opts.wrappers)
    : (e: ToolExecutor) => e;
  return {
    register(e) { map.set(e.descriptor.name, wrap(e)); },
    unregister(n) { map.delete(n); },
    get(n) { return map.get(n); },
    list() { return [...map.values()]; },
    plan(ctx) { return buildToolPlan([...map.values()].map((e) => e.descriptor), ctx); },
    async dispose() { map.clear(); },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────

function isPathInside(path: string, root: string): boolean {
  // Naive — production: use path.resolve + startsWith with path separator.
  if (!path || !root) return false;
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}
