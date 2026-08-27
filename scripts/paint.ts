/**
 * Paint-only entry point — re-run Phase 3 on an existing output directory.
 *
 * The full pipeline (`scripts/procedura.ts --paint`) regenerates geometry, so there
 * was no way to re-paint a finished run or to turn up the sub-part passes. This
 * runs `runPaint` alone against a directory that already contains `final.scad`
 * (or `draft.scad`) and `image.png`.
 *
 * `--subpart-steps` feeds the already-sub-coloured module sources back and asks
 * for finer splits. It mattered when every module went out in one request and
 * the reply truncated; with one call per module the first pass already resolves
 * the small hardware, trim, seals and lenses, and the default is 1.
 *
 * Usage:
 *   bun run scripts/paint.ts \
 *     <runDir> [--subpart-steps N] [--refine-steps N] [--model KEY] \
 *     [--views a,b,c] [--no-render] [--no-subparts] [--size N] [--samples N]
 *
 * Every option and env knob is documented in the README.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { runPaint, DEFAULT_PAINT_MODEL } from "../src/pipeline/paint.ts";
import { beginRun, report } from "../src/pipeline/stage-timer.ts";
import { DEFAULT_VIEWS, type ViewName } from "../src/render/views.ts";

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error(`usage: bun run scripts/paint.ts <runDir> [--subpart-steps N] [--refine-steps N]
                       [--size N] [--samples N] [--views a,b,c] [--model KEY]
                       [--no-render] [--no-subparts]

  --subpart-steps N  sub-part decomposition passes (default 1). A second pass
                     rewrites every module again once the calls are
                     one-per-module: same mesh count, ~+31% wall, and the
                     perceptual measure could not separate the two at n=2.
                     Raise it only if a subject proves it needs it.
  --refine-steps N   paint-critic passes over the rendered views (default 1).
                     0 also skips the v0 render, which exists only to feed it.
  --size N           shipping render resolution (default 1280; 2048 for a hero).
  --samples N        Cycles samples for that render (default 350).
  --views a,b,c      which views to render (default ${DEFAULT_VIEWS.join(",")}).
  --no-subparts      per-part colours only — skips the stage that supplies most
                     of the separation, and most of the cost.
  --no-render        no Blender at all; SCAD + OBJ/MTL only.
  --model KEY        vision model (default ${DEFAULT_PAINT_MODEL}).`);
  process.exit(2);
}
const outputDir = resolve(dir);
if (!existsSync(outputDir)) { console.error(`no such directory: ${outputDir}`); process.exit(2); }

function num(flag: string): number | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : undefined;
}
function str(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

const views = str("--views")?.split(",").map((v) => v.trim()).filter(Boolean) as ViewName[] | undefined;
const subpartSteps = num("--subpart-steps");
const refineSteps = num("--refine-steps");
const model = str("--model");
const size = num("--size");
const samples = num("--samples");

console.log(`[paint-only] ${outputDir}`);
// Keep these fallbacks in step with runPaint's own defaults — a stale number here
// silently misreports what the run actually did.
console.log(`[paint-only] subpartSteps=${subpartSteps ?? 1} refineSteps=${refineSteps ?? 1} ` +
            `model=${model ?? DEFAULT_PAINT_MODEL} views=${(views ?? DEFAULT_VIEWS).join(",")}`);

const t0 = Date.now();
beginRun();
const r = await runPaint({
  outputDir,
  ...(model !== undefined ? { model } : {}),
  ...(views !== undefined ? { views } : {}),
  ...(subpartSteps !== undefined ? { subpartSteps } : {}),
  ...(refineSteps !== undefined ? { refineSteps } : {}),
  ...(size !== undefined ? { size } : {}),
  ...(samples !== undefined ? { samples } : {}),
  ...(argv.includes("--no-render") ? { render: false } : {}),
  ...(argv.includes("--no-subparts") ? { subparts: false } : {}),
});

console.log(`\n[paint-only] ${r.ok ? "ok" : "FAILED"} in ${Math.round((Date.now() - t0) / 1000)}s`);
// Phase 3 is now the most expensive stage in the pipeline and the one whose
// cost moves with the deep-texture settings, so a paint-only run prints the
// same breakdown the full pipeline does rather than a single duration.
console.log("\n" + report("paint breakdown", [
  ["LLM — extract", "llm.paint-extract", 0],
  ["LLM — assign", "llm.paint-assign", 0],
  ["LLM — refine", "llm.paint-refine", 0],
  ["LLM — subparts", "llm.paint-subparts", 0],
  ["OpenSCAD — geometry split", "paint.split", 0],
  ["OpenSCAD — colour split", "paint.color_split", 0],
  ["OpenSCAD — subpart validate", "paint.subpart_validate", 0],
  ["Blender — PBR renders", "paint.render", 0],
]));
if (r.error) console.error(`[paint-only] error: ${r.error}`);
for (const d of r.degraded ?? []) console.error(`[paint-only] DEGRADED: ${d}`);
console.log(`[paint-only] ${r.palette.length} library materials, ${r.parts.length} parts painted`);
if (r.previewDir) console.log(`[paint-only] preview: ${r.previewDir}`);
if (r.paintedScadPath) console.log(`[paint-only] painted scad: ${r.paintedScadPath}`);
process.exit(r.ok ? 0 : 1);
