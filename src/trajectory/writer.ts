/**
 * File-based trajectory sink — one JSONL per run, dropped into
 * <output_dir>/_trajectory/run-<id>.jsonl.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { TrajectoryEvent } from "@harness/template/trajectory";

export interface TrajectoryWriter {
  sink(event: TrajectoryEvent): void;
  close(): Promise<void>;
  path: string;
}

export function createFileTrajectoryWriter(
  trajectoryDir: string, runId: string,
): TrajectoryWriter {
  const path = join(trajectoryDir, `run-${runId}.jsonl`);
  const stream: WriteStream = createWriteStream(path, { encoding: "utf8" });

  return {
    path,
    sink(event) {
      // Skip massive image payloads in the trajectory log — they bloat it
      // and aren't needed for replay; the raw renders are on disk separately.
      const safe = redactImagesDeep(event);
      stream.write(JSON.stringify(safe) + "\n");
    },
    async close() {
      await new Promise<void>((r) => stream.end(() => r()));
    },
  };
}

/** Replace any { kind: "image", data: "<base64>", ... } with a marker. */
function redactImagesDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(redactImagesDeep);
  const o = v as Record<string, unknown>;
  if (o["kind"] === "image" && typeof o["data"] === "string") {
    return { ...o, data: `<base64 ${(o["data"] as string).length} chars omitted>` };
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) out[k] = redactImagesDeep(val);
  return out;
}
