/**
 * A trajectory emitter for stages that have no agent.
 *
 * The draft stage used to get its trajectory by building a whole `createHarness`
 * — sessions, a message store, an event bus, a sandbox, a permission ruleset —
 * and then attaching a recorder to that bus. It never registered a tool and the
 * agent loop never ran; the harness existed so `harness.bus.emit(...)` had
 * somewhere to go, and so a `recordTurn` helper could fabricate user/assistant
 * messages and parts for the trajectory viewer to replay.
 *
 * The viewer renders `{seq, ts, type, payload}` rows. That is all this needs to
 * produce.
 */

import type { TrajectoryEvent } from "@harness/template/trajectory";

export type TrajectorySink = (event: TrajectoryEvent) => void | Promise<void>;

export interface StageEmitter {
  /** Record one event. Returns immediately; the sink owns any buffering. */
  emit(type: string, payload?: Record<string, unknown>): void;
  /** Events emitted so far — handy in tests and for a final summary line. */
  readonly count: number;
}

export function createStageEmitter(args: {
  sink: TrajectorySink;
  sessionId: string;
  workspaceDir: string;
  runId?: string;
  source?: string;
  provider?: string;
  modelId?: string;
}): StageEmitter {
  let seq = 0;
  const traceId = `trace_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    emit(type, payload = {}) {
      seq += 1;
      const ev = {
        traceId,
        source: args.source ?? "pipeline",
        type,
        seq,
        ts: Date.now(),
        sessionId: args.sessionId,
        ...(args.runId !== undefined ? { runId: args.runId } : {}),
        workspaceDir: args.workspaceDir,
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
        entryId: `e${seq}`,
        payload,
      } as unknown as TrajectoryEvent;
      void args.sink(ev);
    },
    get count() { return seq; },
  };
}
