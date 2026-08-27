/**
 * Trajectory JSONL parsing.
 *
 * Each line is one TrajectoryEvent envelope: { type, seq, ts, payload, ... }.
 * The discriminator is the top-level `type`; event data lives under `payload`.
 * A single run interleaves a draft block then a refine block, each delimited by
 * its own run.started / run.finished pair (so there can be 2 of each).
 *
 * Parsing is defensive: a malformed line never aborts the whole file.
 */

import { readFileSync } from "node:fs";
import type {
  TrajectoryData,
  TrajectoryEvent,
  TrajectoryPhase,
} from "../shared/types.ts";

const MAX_EVENTS = 20_000;

export function parseTrajectory(absPath: string, relPath: string): TrajectoryData {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return { file: relPath, events: [], phases: [], truncated: false };
  }

  const lines = raw.split("\n");
  const events: TrajectoryEvent[] = [];
  let truncated = false;
  let fallbackSeq = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (events.length >= MAX_EVENTS) {
      truncated = true;
      break;
    }
    fallbackSeq += 1;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      events.push({
        type: typeof obj["type"] === "string" ? (obj["type"] as string) : "unknown",
        seq: typeof obj["seq"] === "number" ? (obj["seq"] as number) : fallbackSeq,
        ts: typeof obj["ts"] === "number" ? (obj["ts"] as number) : 0,
        sessionId: typeof obj["sessionId"] === "string" ? (obj["sessionId"] as string) : undefined,
        entryId: typeof obj["entryId"] === "string" ? (obj["entryId"] as string) : undefined,
        parentEntryId:
          typeof obj["parentEntryId"] === "string" ? (obj["parentEntryId"] as string) : undefined,
        payload:
          obj["payload"] && typeof obj["payload"] === "object"
            ? (obj["payload"] as Record<string, unknown>)
            : {},
      });
    } catch {
      events.push({
        type: "malformed",
        seq: fallbackSeq,
        ts: 0,
        payload: { _raw: trimmed.slice(0, 2000) },
        malformed: true,
      });
    }
  }

  // Preserve FILE ORDER — `seq` is per-phase (restarts at 1 in each phase),
  // so sorting by seq would interleave the draft and refine blocks. The order
  // lines appear in the JSONL is the true emission order.
  return { file: relPath, events, phases: segmentPhases(events), truncated };
}

/**
 * Split the event stream into phases. Phase 1 (draft) is recognised by the
 * presence of draft.* events or by being the first run.started block; phase 2
 * (refine) is the block containing tool.* events. Falls back to one "unknown"
 * phase if no run.started markers are present.
 */
function segmentPhases(events: TrajectoryEvent[]): TrajectoryPhase[] {
  const phases: TrajectoryPhase[] = [];
  let current: TrajectoryEvent[] = [];
  const flush = (index: number) => {
    if (!current.length) return;
    const hasDraft = current.some((e) => e.type.startsWith("draft."));
    const hasTool = current.some((e) => e.type.startsWith("tool."));
    const kind: TrajectoryPhase["kind"] = hasDraft ? "draft" : hasTool ? "refine" : "unknown";
    const finished = current.find((e) => e.type === "run.finished");
    const reason =
      finished && typeof finished.payload["reason"] === "string"
        ? (finished.payload["reason"] as string)
        : null;
    const tsValues = current.map((e) => e.ts).filter((t) => t > 0);
    for (const e of current) e.phase = kind;
    phases.push({
      kind,
      index,
      startSeq: current[0]!.seq,
      endSeq: current[current.length - 1]!.seq,
      startTs: tsValues.length ? Math.min(...tsValues) : 0,
      endTs: tsValues.length ? Math.max(...tsValues) : 0,
      reason,
    });
    current = [];
  };

  let phaseIndex = 0;
  for (const e of events) {
    if (e.type === "run.started" && current.length) {
      flush(phaseIndex++);
    }
    current.push(e);
  }
  flush(phaseIndex);

  if (!phases.length && events.length) {
    const tsValues = events.map((e) => e.ts).filter((t) => t > 0);
    phases.push({
      kind: "unknown",
      index: 0,
      startSeq: events[0]!.seq,
      endSeq: events[events.length - 1]!.seq,
      startTs: tsValues.length ? Math.min(...tsValues) : 0,
      endTs: tsValues.length ? Math.max(...tsValues) : 0,
      reason: null,
    });
  }
  return phases;
}
