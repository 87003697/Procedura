/**
 * Typed pub/sub event bus, per-instance scoped.
 *
 * Pattern source: opencode `packages/opencode/src/bus/index.ts`.
 * Key insight: subscriptions are *eager*. The subscribe call must register
 * the handler before returning — any publish after subscribe() returns
 * must be delivered, even if the consumer hasn't started reading yet.
 *
 * Each "instance" (per-directory project / per-tenant session group) gets
 * its own Bus via InstanceState (see effect.ts). Cross-instance fan-out is
 * via the optional `globalBus` constructor param.
 */

import type { AsyncDisposable } from "./types.ts";

export interface BusEventMap {
  // Extend this via TypeScript declaration merging:
  //   declare module "@harness/template/bus" {
  //     interface BusEventMap { "my.event": { foo: string } }
  //   }
  [eventName: string]: unknown;
}

export type Subscription = AsyncDisposable;

export interface Bus<M extends BusEventMap = BusEventMap> extends AsyncDisposable {
  /** Synchronously publish; handlers run in registration order. */
  emit<K extends keyof M & string>(event: K, payload: M[K]): void;

  /** Subscribe to one event. Registration is eager — see file header. */
  on<K extends keyof M & string>(
    event: K,
    handler: (payload: M[K]) => void | Promise<void>,
  ): Subscription;

  /** Subscribe to every event. Use sparingly — typically only by trajectory/UI. */
  onAny(handler: (event: string, payload: unknown) => void | Promise<void>): Subscription;
}

/**
 * In-memory reference implementation.
 *
 * Replace with effect/PubSub, ZeroMQ, Redis pub/sub, etc. as needed.
 * The interface is what matters; UIs/trajectory must only depend on Bus<M>.
 */
export function createBus<M extends BusEventMap = BusEventMap>(
  opts: { globalBus?: Bus<M> } = {},
): Bus<M> {
  type Handler = (payload: unknown) => void | Promise<void>;
  type AnyHandler = (event: string, payload: unknown) => void | Promise<void>;

  const typed = new Map<string, Set<Handler>>();
  const wildcard = new Set<AnyHandler>();
  let disposed = false;

  const emit: Bus<M>["emit"] = (event, payload) => {
    if (disposed) return;
    const handlers = typed.get(event);
    if (handlers) {
      for (const h of handlers) void h(payload);
    }
    for (const h of wildcard) void h(event, payload);
    if (opts.globalBus) opts.globalBus.emit(event, payload);
  };

  const on: Bus<M>["on"] = (event, handler) => {
    if (disposed) throw new Error("Bus disposed");
    const set = typed.get(event) ?? new Set<Handler>();
    set.add(handler as Handler);
    typed.set(event, set);
    return {
      async dispose() {
        set.delete(handler as Handler);
        if (set.size === 0) typed.delete(event);
      },
    };
  };

  const onAny: Bus<M>["onAny"] = (handler) => {
    if (disposed) throw new Error("Bus disposed");
    wildcard.add(handler);
    return { async dispose() { wildcard.delete(handler); } };
  };

  return {
    emit,
    on,
    onAny,
    async dispose() {
      if (disposed) return;
      disposed = true;
      typed.clear();
      wildcard.clear();
      // Don't dispose globalBus; we don't own it.
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Standard events the harness emits. Plugins/UIs subscribe to these.
// ──────────────────────────────────────────────────────────────────────────

export interface StandardEvents {
  "session.created": { sessionId: string };
  "session.disposed": { sessionId: string };
  "run.started": { sessionId: string; runId: string };
  "run.finished": { sessionId: string; runId: string; reason: string };
  "message.append": { sessionId: string; messageId: string; role: "user" | "assistant" };
  "part.append": { sessionId: string; messageId: string; partId: string; kind: string };
  "tool.requested": { sessionId: string; toolCallId: string; toolName: string };
  "tool.executed":  { sessionId: string; toolCallId: string; toolName: string; durationMs: number };
  "permission.asked": { sessionId: string; permissionId: string; question: string };
  "permission.replied": { sessionId: string; permissionId: string; reply: "once" | "always" | "reject" };
  "compaction.started":  { sessionId: string; tokenCount: number };
  "compaction.finished": { sessionId: string; newTokenCount: number };
  "instance.disposed": { instanceKey: string };
}
