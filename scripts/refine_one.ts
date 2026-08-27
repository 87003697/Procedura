/**
 * Refine ONE case directory. Spawned as a child process by refine_batch.ts so
 * each case gets its own clean log, its own memory, and can be killed on a
 * timeout without touching its siblings.
 *
 * Exit codes: 0 = refine finished (any verdict), 1 = threw, 2 = bad usage.
 * The final line of stdout is a JSON result row the parent parses.
 */

import { runRefine } from "../src/pipeline/refine.ts";
import { DEFAULT_MODEL } from "../src/config/models.ts";

const argv = process.argv.slice(2);
let dir = "";
let model = DEFAULT_MODEL;
let maxSteps = 3;
for (let i = 0; i < argv.length; i++) {
  const k = argv[i], v = argv[i + 1];
  if (k === "--dir") { dir = v ?? ""; i++; }
  else if (k === "--model") { model = v ?? model; i++; }
  else if (k === "--max-steps") { maxSteps = Number(v ?? 3); i++; }
}
if (!dir) {
  console.error("usage: refine_one.ts --dir <case> [--model M] [--max-steps N]");
  process.exit(2);
}

const t0 = Date.now();
try {
  const r = await runRefine({ outputDir: dir, model, maxSteps });
  const row = {
    ok: r.ok, verdict: r.verdict, steps: r.steps, toolCalls: r.toolCalls,
    seconds: Math.round((Date.now() - t0) / 1000),
    objPath: r.outputs.objPath ?? null,
    previewDir: r.outputs.previewDir ?? null,
    summary: r.summary.slice(0, 300),
  };
  console.log(`__RESULT__ ${JSON.stringify(row)}`);
  process.exit(0);
} catch (e) {
  const row = {
    ok: false, verdict: "throw", steps: 0, toolCalls: 0,
    seconds: Math.round((Date.now() - t0) / 1000),
    error: (e as Error).message.slice(0, 500),
  };
  console.log(`__RESULT__ ${JSON.stringify(row)}`);
  console.error((e as Error).stack ?? (e as Error).message);
  process.exit(1);
}
