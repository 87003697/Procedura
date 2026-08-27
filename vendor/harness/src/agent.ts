/**
 * Agent loop — the heart of the harness.
 *
 * Patterns synthesized:
 *   - opencode runLoop (session/prompt.ts:1240-1483): stop check, subtask
 *     handling, compaction triggers, SessionTools.resolve, stream.
 *   - opencode doom-loop detection (session/processor.ts:33): 3 identical
 *     tool calls in a row → ask the user.
 *   - openclaw session lane + file-based write lock + non-reentrant guard.
 */

import type {
  AsyncDisposable, FinishReason, JsonObject, MessageId, ModelRef, PartId, RunId,
  SessionId, TokenUsage, ToolCallId,
} from "./types.ts";
import type { Bus, StandardEvents } from "./bus.ts";
import type { SessionStore, ToolCallPartData, ToolResultPartData } from "./storage.ts";
import type { ToolRegistry, ToolContext } from "./tool.ts";
import type { PermissionEngine } from "./permission/index.ts";
import type { SandboxBridge } from "./sandbox.ts";
import type { ContextEngine, CompactionTrigger } from "./context.ts";
import type { LLMClient } from "./llm/route.ts";
import type { RouteDef } from "./llm/route.ts";
import type { CanonicalRequest, LLMEvent } from "./llm/protocol.ts";
import { applyAutoCache } from "./llm/cache-policy.ts";
import { defaultTrigger } from "./context.ts";

// ──────────────────────────────────────────────────────────────────────────
// Session manager — lane queue + write lock + lifecycle
// ──────────────────────────────────────────────────────────────────────────

export interface SessionLock extends AsyncDisposable {
  readonly sessionId: SessionId;
  readonly acquiredAt: number;
}

export interface SessionLane {
  /** Serialize per-session ops; FIFO. Returns a fresh write lock. */
  acquire(sessionId: SessionId, opts?: { timeoutMs?: number; allowReentrant?: boolean }): Promise<SessionLock>;
}

/** In-memory lane. Production should also use a file-based lock on disk. */
export function createSessionLane(): SessionLane {
  const queues = new Map<string, Promise<void>>();
  const held = new Map<string, true>();

  return {
    async acquire(sessionId, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 60_000;

      if (held.has(sessionId) && !opts.allowReentrant) {
        // Wait for prior lock to release (or time out).
        const prior = queues.get(sessionId);
        if (prior) await Promise.race([prior, new Promise<void>((_, rj) => setTimeout(() => rj(new Error("lock acquire timeout")), timeoutMs))]);
      }

      held.set(sessionId, true);
      let release: () => void;
      const inflight = new Promise<void>((r) => { release = r; });
      queues.set(sessionId, inflight);

      return {
        sessionId,
        acquiredAt: Date.now(),
        async dispose() {
          held.delete(sessionId);
          release!();
        },
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Doom-loop detection
// ──────────────────────────────────────────────────────────────────────────

export const DOOM_LOOP_THRESHOLD = 3;

export function detectDoomLoop(recentToolCalls: { name: string; argHash: string }[]): boolean {
  if (recentToolCalls.length < DOOM_LOOP_THRESHOLD) return false;
  const last = recentToolCalls.slice(-DOOM_LOOP_THRESHOLD);
  return last.every((t) => t.name === last[0]!.name && t.argHash === last[0]!.argHash);
}

// ──────────────────────────────────────────────────────────────────────────
// runLoop — opencode-style with explicit stop conditions
// ──────────────────────────────────────────────────────────────────────────

export interface RunLoopDeps {
  bus: Bus<StandardEvents & Record<string, unknown>>;
  store: SessionStore;
  tools: ToolRegistry;
  permission: PermissionEngine;
  sandbox: SandboxBridge;
  context: ContextEngine;
  llm: LLMClient;
  route: RouteDef<unknown>;
  trigger?: CompactionTrigger;
  /** Stable hash of tool input for doom-loop detection. */
  hashToolArgs?: (args: unknown) => string;
}

export interface RunRequest {
  sessionId: SessionId;
  runId: RunId;
  model: ModelRef;
  /** Per-turn allow-list narrows the visible tools. */
  runtimeToolAllowlist?: Set<string>;
  signal?: AbortSignal;
  /** Max iterations before forcibly breaking. */
  maxSteps?: number;
}

export type RunOutcome =
  | { kind: "break"; reason: FinishReason }
  | { kind: "error"; error: Error }
  | { kind: "max-steps"; steps: number };

export async function runLoop(deps: RunLoopDeps, req: RunRequest): Promise<RunOutcome> {
  const trigger = deps.trigger ?? defaultTrigger;
  const hashArgs = deps.hashToolArgs ?? ((a) => JSON.stringify(a));
  const maxSteps = req.maxSteps ?? 30;
  const recent: { name: string; argHash: string }[] = [];

  deps.bus.emit("run.started", { sessionId: req.sessionId, runId: req.runId });

  let step = 0;
  while (step < maxSteps) {
    step += 1;
    if (req.signal?.aborted) {
      deps.bus.emit("run.finished", { sessionId: req.sessionId, runId: req.runId, reason: "aborted" });
      return { kind: "break", reason: "aborted" };
    }

    // 1. Read current message state
    const msgs = await deps.store.liveMessages(req.sessionId);

    // 2. Stop check (opencode pattern)
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    if (lastAssistant && lastUser) {
      const parts = await deps.store.listParts(lastAssistant.id);
      const lastFinish = parts
        .filter((p) => p.kind === "step-finish")
        .map((p) => (p.data as { finishReason?: FinishReason }).finishReason)
        .pop();
      const pendingTools = parts.some((p) => p.kind === "tool-call"
        && !parts.some((q) => q.kind === "tool-result"
          && (q.data as unknown as ToolResultPartData).toolCallId === (p.data as unknown as ToolCallPartData).toolCallId));
      if (lastFinish && lastFinish !== "tool-calls" && !pendingTools && lastUser.createdAt < lastAssistant.createdAt) {
        deps.bus.emit("run.finished", { sessionId: req.sessionId, runId: req.runId, reason: lastFinish });
        return { kind: "break", reason: lastFinish };
      }
    }

    // 3. Compaction check
    const currentTokens = approxTokenCount(msgs);
    const budget = budgetFor(req.model);
    if (trigger.shouldCompact({ currentTokens, budget })) {
      deps.bus.emit("compaction.started", { sessionId: req.sessionId, tokenCount: currentTokens });
      const r = await deps.context.compact({
        sessionId: req.sessionId,
        tokenBudget: budget,
        currentTokenCount: currentTokens,
        compactionTarget: trigger.target({ currentTokens, budget }),
      });
      if (r.performed && r.newTokenCount !== undefined) {
        deps.bus.emit("compaction.finished", { sessionId: req.sessionId, newTokenCount: r.newTokenCount });
      }
      continue; // re-read messages after compaction
    }

    // 4. Assemble context
    const plan = deps.tools.plan({
      authedProviders: new Set([req.model.providerId]),
      configPath: () => undefined,
      env: (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
      enabledPlugins: new Set(),
      contextValues: {},
    });
    const visible = req.runtimeToolAllowlist
      ? plan.visible.filter((d) => req.runtimeToolAllowlist!.has(d.name))
      : plan.visible;

    const assembled = await deps.context.assemble({
      sessionId: req.sessionId,
      messages: msgs,
      tokenBudget: budget,
      availableTools: visible,
      model: req.model,
    });

    // 5. Build LLM request
    const canonical: CanonicalRequest = {
      model: req.model,
      system: assembled.system,
      messages: assembled.messages,
      tools: assembled.tools.map((t) => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
      })),
      signal: req.signal,
    };
    applyAutoCache(canonical, { protocolId: deps.route.protocol.id });

    // 6. Open assistant message
    const assistantMsg = await deps.store.appendMessage({
      id: makeId<MessageId>("msg"),
      sessionId: req.sessionId,
      role: "assistant",
      data: { model: req.model as unknown as JsonObject, runId: req.runId, step },
    });
    deps.bus.emit("message.append", { sessionId: req.sessionId, messageId: assistantMsg.id, role: "assistant" });

    // 7. Stream and process events
    let finishReason: FinishReason = "stop";
    let usage: TokenUsage = { input: 0, output: 0 };
    const pendingCalls = new Map<string, { name: string; args: string }>();

    let sawToolCallsFinish = false;
    for await (const ev of deps.llm.stream(deps.route, canonical)) {
      await consumeEvent(ev, {
        store: deps.store, bus: deps.bus, assistantMsgId: assistantMsg.id, sessionId: req.sessionId,
        pending: pendingCalls,
      });
      if (ev.kind === "message-finish") {
        // Some providers emit a redundant
        // finish_reason="stop" chunk AFTER the tool-calls chunk. Don't
        // let it downgrade the finish reason — tool-calls always wins.
        if (ev.reason === "tool-calls") sawToolCallsFinish = true;
        if (!sawToolCallsFinish || ev.reason === "tool-calls") {
          finishReason = ev.reason;
        }
        if (ev.usage.input || ev.usage.output) usage = ev.usage;
      }
      if (ev.kind === "error") {
        deps.bus.emit("run.finished", { sessionId: req.sessionId, runId: req.runId, reason: "error" });
        return { kind: "error", error: ev.error };
      }
    }
    if (sawToolCallsFinish) finishReason = "tool-calls";

    // 7b. Finalize any pending tool calls whose protocol didn't emit a
    //     tool-call-finish event (OpenAI Chat doesn't). Persist their
    //     tool-call parts to storage so the next turn sees them.
    for (const [callId, call] of pendingCalls) {
      const parts = await deps.store.listParts(assistantMsg.id);
      const alreadyStored = parts.some((p) =>
        p.kind === "tool-call"
        && (p.data as unknown as ToolCallPartData).toolCallId === callId);
      if (alreadyStored) continue;
      let parsed: JsonObject;
      try { parsed = JSON.parse(call.args || "{}") as JsonObject; }
      catch { parsed = { __invalid: call.args } as unknown as JsonObject; }
      const partData: ToolCallPartData = {
        toolCallId: callId as ToolCallId,
        toolName: call.name,
        input: parsed,
      };
      await deps.store.appendPart({
        id: makeId<PartId>("part"),
        messageId: assistantMsg.id,
        sessionId: req.sessionId,
        kind: "tool-call",
        data: partData as unknown as JsonObject,
      });
    }

    await deps.store.appendPart({
      id: makeId<PartId>("part"),
      messageId: assistantMsg.id,
      sessionId: req.sessionId,
      kind: "step-finish",
      data: { finishReason, usage } as unknown as JsonObject,
    });

    // 8. Execute any pending tool calls
    if (pendingCalls.size === 0) {
      // No tool calls and the model said it's done → loop check at top will break.
      if (finishReason !== "tool-calls") continue;
    }

    for (const [callId, call] of pendingCalls) {
      // A model can emit syntactically invalid JSON arguments. That is the
      // MODEL's mistake, not a harness fault — route it back as an error tool
      // result so the model can re-issue the call, instead of throwing out of
      // the whole run (which discards every token spent so far this session).
      let args: JsonObject;
      try {
        args = JSON.parse(call.args || "{}") as JsonObject;
      } catch (e) {
        const resultData: ToolResultPartData = {
          toolCallId: callId as ToolCallId,
          toolName: call.name,
          output:
            `Tool arguments were not valid JSON (${(e as Error).message}). ` +
            `Re-issue the ${call.name} call with well-formed JSON arguments. ` +
            `Raw prefix: ${(call.args ?? "").slice(0, 200)}`,
          isError: true,
        };
        await deps.store.appendPart({
          id: makeId<PartId>("part"),
          messageId: assistantMsg.id,
          sessionId: req.sessionId,
          kind: "tool-result",
          data: resultData as unknown as JsonObject,
        });
        deps.bus.emit("tool.executed", {
          sessionId: req.sessionId, toolCallId: callId, toolName: call.name, durationMs: 0,
        });
        continue;
      }

      // Doom-loop guard
      recent.push({ name: call.name, argHash: hashArgs(args) });
      if (recent.length > DOOM_LOOP_THRESHOLD) recent.shift();
      if (detectDoomLoop(recent)) {
        const allowed = await deps.permission.ask({
          permission: "doom_loop",
          pattern: call.name,
          question: `Same tool ${call.name} called ${DOOM_LOOP_THRESHOLD} times with same args — continue?`,
        });
        if (!allowed) {
          deps.bus.emit("run.finished", { sessionId: req.sessionId, runId: req.runId, reason: "aborted" });
          return { kind: "break", reason: "aborted" };
        }
        recent.length = 0;
      }

      const executor = deps.tools.get(call.name);
      const toolCtx: ToolContext = {
        sessionId: req.sessionId,
        messageId: assistantMsg.id,
        toolCallId: callId as ToolCallId,
        workspace: deps.sandbox.workspace,
        signal: req.signal ?? new AbortController().signal,
        bus: deps.bus,
        ask: (q, kind) => deps.permission.ask({ permission: kind ?? call.name, pattern: "*", question: q }),
        state: makeSessionState(req.sessionId),
      };

      const result = executor
        ? await executor.execute(args, toolCtx)
        : { ok: false as const, error: `Unknown tool: ${call.name}` };

      const resultData: ToolResultPartData = {
        toolCallId: callId as ToolCallId,
        toolName: call.name,
        output: result.ok ? result.output : result.error,
        ...(result.ok ? {} : { isError: true }),
        ...(result.ok && result.attachments && result.attachments.length > 0
          ? { attachments: result.attachments }
          : {}),
      };
      await deps.store.appendPart({
        id: makeId<PartId>("part"),
        messageId: assistantMsg.id,
        sessionId: req.sessionId,
        kind: "tool-result",
        data: resultData as unknown as JsonObject,
      });
      deps.bus.emit("tool.executed", {
        sessionId: req.sessionId, toolCallId: callId, toolName: call.name, durationMs: 0,
      });
    }
  }

  deps.bus.emit("run.finished", { sessionId: req.sessionId, runId: req.runId, reason: "max-steps" });
  return { kind: "max-steps", steps: step };
}

// ──────────────────────────────────────────────────────────────────────────
// Stream event consumer (opencode processor.ts shape)
// ──────────────────────────────────────────────────────────────────────────

interface ConsumeCtx {
  store: SessionStore;
  bus: Bus<StandardEvents & Record<string, unknown>>;
  assistantMsgId: MessageId;
  sessionId: SessionId;
  pending: Map<string, { name: string; args: string }>;
}

async function consumeEvent(ev: LLMEvent, c: ConsumeCtx): Promise<void> {
  switch (ev.kind) {
    case "text-delta": {
      // Append/extend a text part. Production: keep an open part and update its data.
      const id = makeId<PartId>("part");
      await c.store.appendPart({
        id, messageId: c.assistantMsgId, sessionId: c.sessionId,
        kind: "text", data: { text: ev.text },
      });
      c.bus.emit("part.append", { sessionId: c.sessionId, messageId: c.assistantMsgId, partId: id, kind: "text" });
      return;
    }
    case "thinking-delta": {
      const id = makeId<PartId>("part");
      await c.store.appendPart({
        id, messageId: c.assistantMsgId, sessionId: c.sessionId,
        kind: "reasoning", data: { text: ev.text, ...(ev.signature !== undefined ? { signature: ev.signature } : {}) },
      });
      return;
    }
    case "tool-call-start": {
      c.pending.set(ev.toolCallId, { name: ev.toolName, args: "" });
      c.bus.emit("tool.requested", { sessionId: c.sessionId, toolCallId: ev.toolCallId, toolName: ev.toolName });
      return;
    }
    case "tool-call-delta": {
      const p = c.pending.get(ev.toolCallId);
      if (p) p.args += ev.argDelta;
      return;
    }
    case "tool-call-finish": {
      const p = c.pending.get(ev.toolCallId);
      if (p) {
        p.args = JSON.stringify(ev.input);
        const id = makeId<PartId>("part");
        await c.store.appendPart({
          id, messageId: c.assistantMsgId, sessionId: c.sessionId,
          kind: "tool-call",
          data: { toolCallId: ev.toolCallId as ToolCallId, toolName: p.name, input: ev.input } satisfies ToolCallPartData as unknown as JsonObject,
        });
      }
      return;
    }
    case "message-start":
    case "message-finish":
    case "error":
      return;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function makeId<T extends string>(prefix: string): T {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` as T;
}

function approxTokenCount(msgs: { data: unknown }[]): number {
  // Naive: 1 token ≈ 4 chars; production should use tokenizer.
  return msgs.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.data).length / 4), 0);
}

function budgetFor(model: ModelRef): number {
  // Look up from your model catalog (models.dev or equivalent).
  if (model.modelId.includes("opus-4")) return 200_000;
  if (model.modelId.includes("sonnet-4")) return 200_000;
  if (model.modelId.includes("haiku")) return 200_000;
  if (model.modelId.includes("gpt-5")) return 400_000;
  return 128_000;
}

function makeSessionState(_sessionId: SessionId): ToolContext["state"] {
  // Per-session in-memory state. Replace with persistent backing.
  const map = new Map<string, unknown>();
  return {
    get(k) { return map.get(k); },
    set(k, v) { map.set(k, v); },
  };
}
