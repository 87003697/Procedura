/**
 * Trajectory recorder — full-run replay log.
 *
 * Pattern source: openclaw src/trajectory/types.ts.
 *
 * Every event carries:
 *   - monotonic `seq` (across the run)
 *   - DAG parentage (entryId / parentEntryId)
 *   - source (runtime | transcript | export)
 *   - identifying refs (sessionId, runId, provider, modelId)
 *
 * When something goes wrong you don't reason about logs — you replay
 * the bundle.
 */

import type { AsyncDisposable, EntryId, RunId, SessionId, TraceId } from "./types.ts";
import type { Bus } from "./bus.ts";

export type TrajectorySource = "runtime" | "transcript" | "export";

export interface TrajectoryEvent<T = unknown> {
  traceId: TraceId;
  source: TrajectorySource;
  type: string;                 // bus event name or custom
  seq: number;                  // monotonic across run
  ts: number;
  sessionId: SessionId;
  runId?: RunId;
  workspaceDir: string;
  provider?: string;
  modelId?: string;
  modelApi?: string;
  entryId: EntryId;
  parentEntryId?: EntryId;
  payload: T;
}

export interface TrajectoryBundleManifest {
  traceId: TraceId;
  sessionId: SessionId;
  runIds: RunId[];
  workspaceDir: string;
  eventCounts: Record<string, number>;
  leafIds: EntryId[];
  sourceFiles: string[];
  warnings: ("invalid-session-json" | "cyclic-session-branch" | "incomplete-session-branch")[];
}

export interface TrajectoryRecorder extends AsyncDisposable {
  emit<T>(ev: Omit<TrajectoryEvent<T>, "seq" | "ts" | "entryId">): TrajectoryEvent<T>;
  /** Subscribe-from-bus convenience: re-emit every bus event as trajectory. */
  attachToBus(bus: Bus, opts: { sessionId: SessionId; workspaceDir: string }): { dispose(): Promise<void> };
  /** Snapshot manifest for the current trace. */
  manifest(): TrajectoryBundleManifest;
}

export interface TrajectoryRecorderOpts {
  traceId: TraceId;
  sink: (event: TrajectoryEvent) => void | Promise<void>;
}

export function createTrajectoryRecorder(opts: TrajectoryRecorderOpts): TrajectoryRecorder {
  let seq = 0;
  let lastEntryId: EntryId | undefined;
  const eventCounts: Record<string, number> = {};
  const sessions = new Set<SessionId>();
  const runIds = new Set<RunId>();
  const sourceFiles: string[] = [];
  const warnings: TrajectoryBundleManifest["warnings"] = [];

  return {
    emit<T>(ev: Omit<TrajectoryEvent<T>, "seq" | "ts" | "entryId">): TrajectoryEvent<T> {
      const entryId = `entry_${Date.now().toString(36)}_${(++seq).toString(36)}` as EntryId;
      const full: TrajectoryEvent<T> = {
        ...ev,
        seq,
        ts: Date.now(),
        entryId,
        ...(ev.parentEntryId ?? lastEntryId ? { parentEntryId: (ev.parentEntryId ?? lastEntryId) as EntryId } : {}),
      };
      lastEntryId = entryId;
      eventCounts[ev.type] = (eventCounts[ev.type] ?? 0) + 1;
      sessions.add(ev.sessionId);
      if (ev.runId) runIds.add(ev.runId);
      void opts.sink(full as TrajectoryEvent<unknown>);
      return full;
    },
    attachToBus(bus, { sessionId, workspaceDir }) {
      const sub = bus.onAny((event, payload) => {
        this.emit({
          traceId: opts.traceId,
          source: "runtime",
          type: event,
          sessionId,
          workspaceDir,
          payload,
        });
      });
      return { dispose: () => sub.dispose() };
    },
    manifest() {
      return {
        traceId: opts.traceId,
        sessionId: [...sessions][0]!,
        runIds: [...runIds],
        workspaceDir: "",
        eventCounts,
        leafIds: lastEntryId ? [lastEntryId] : [],
        sourceFiles,
        warnings,
      };
    },
    async dispose() { /* sink owns its own lifecycle */ },
  };
}
