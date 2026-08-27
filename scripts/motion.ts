#!/usr/bin/env bun
/**
 * Standalone Phase-4 motion export: convert an existing static Procedura output
 * (any directory with final.scad) into a simulation-ready articulated asset —
 * LLM plan -> author -> refine, USD Physics export, optional URDF, headless
 * Isaac Sim validation, and one sim-feedback refine round.
 *
 *   bun scripts/motion.ts <output_dir> [options]
 *
 * Exit codes: 0 = exported (validation passed or skipped), 3 = exported but
 * Isaac validation failed, 1 = export failed.
 */
import { runMotionExport } from "../src/pipeline/motion.ts";
import { beginRun, report } from "../src/pipeline/stage-timer.ts";
import type { MotionCollisionApproximation } from "../src/motion/types.ts";

interface Args {
  outputDir: string;
  scadPath?: string;
  planPath?: string;
  model?: string;
  useLlm?: boolean;
  refine?: boolean;
  author?: boolean;
  fixedBase?: boolean;
  collision?: MotionCollisionApproximation;
  urdf: boolean;
  validate?: boolean;
  simRefine?: boolean;
  validateSteps?: number;
}

function printHelpAndExit(): never {
  console.log(`usage: bun scripts/motion.ts <output_dir> [options]

Runs the motion pipeline on an existing output directory (needs final.scad,
or --scad PATH). Writes motion/final_motion.usda, motion/manifest.json, and
optionally motion/urdf/robot.urdf, then validates headlessly in Isaac Sim.

options:
  --scad PATH          SCAD source (default <output_dir>/final.scad)
  --plan PATH          sidecar MotionPlan JSON; bypasses the LLM planner
  --model M            vision/reasoning model for the motion planner
  --no-llm             use the fixed-joint default plan instead of the LLM
  --refine / --no-refine
                       the one-step LLM repair pass after authoring (default ON).
                       It is the stage's most expensive pass for the least
                       visible effect, but it changes joint topology in 26% of
                       186 archived runs, so --no-refine is a measurement knob,
                       not a recommended preset.
  --no-author          skip the second whole-plan authoring pass, leaving ONE
                       LLM call. Same caveat, more so: the author changes
                       topology in 38% of 190 archived runs.
  --fixed-base         attach the root link to world with a fixed joint
  --floating-base      do not attach the root link to world
  --collision T        default collision approximation (convexHull, ...)
  --urdf               also export URDF (motion/urdf/robot.urdf + meshes/)
  --no-validate        skip headless Isaac Sim validation
  --no-sim-refine      skip the LLM refine round on validation failure
  --validate-steps N   simulation frames for the Isaac dynamic test (default 120)
`);
  process.exit(0);
}

function parseCollision(value: string): MotionCollisionApproximation {
  const allowed = new Set<MotionCollisionApproximation>([
    "none", "convexHull", "convexDecomposition", "boundingCube",
    "boundingSphere", "meshSimplification", "sdf",
  ]);
  if (allowed.has(value as MotionCollisionApproximation)) return value as MotionCollisionApproximation;
  console.error(`invalid --collision: ${value}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { outputDir: "", urdf: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help")    { printHelpAndExit(); }
    if (a === "--scad")                  { args.scadPath = argv[++i]!; continue; }
    if (a === "--plan")                  { args.planPath = argv[++i]!; continue; }
    if (a === "--model")                 { args.model = argv[++i]!; continue; }
    if (a === "--no-llm")                { args.useLlm = false; continue; }
    if (a === "--refine")                { args.refine = true; continue; }
    if (a === "--no-refine")             { args.refine = false; continue; }
    if (a === "--no-author")             { args.author = false; continue; }
    if (a === "--fixed-base")            { args.fixedBase = true; continue; }
    if (a === "--floating-base")         { args.fixedBase = false; continue; }
    if (a === "--collision")             { args.collision = parseCollision(argv[++i]!); continue; }
    if (a === "--urdf")                  { args.urdf = true; continue; }
    if (a === "--no-validate")           { args.validate = false; continue; }
    if (a === "--no-sim-refine")         { args.simRefine = false; continue; }
    if (a === "--validate-steps")        { args.validateSteps = Number(argv[++i]!); continue; }
    if (!a.startsWith("-") && !args.outputDir) { args.outputDir = a; continue; }
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
  if (!args.outputDir) {
    console.error(`usage: bun scripts/motion.ts <output_dir> [options] (see --help)`);
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

beginRun();

const result = await runMotionExport({
  outputDir: args.outputDir,
  ...(args.scadPath !== undefined ? { scadPath: args.scadPath } : {}),
  ...(args.planPath !== undefined ? { motionPlanPath: args.planPath } : {}),
  ...(args.model !== undefined ? { model: args.model } : {}),
  ...(args.useLlm !== undefined ? { useLlm: args.useLlm } : {}),
  ...(args.refine !== undefined ? { refine: args.refine } : {}),
  ...(args.author !== undefined ? { author: args.author } : {}),
  ...(args.fixedBase !== undefined ? { fixedBase: args.fixedBase } : {}),
  ...(args.collision !== undefined ? { defaultCollision: args.collision } : {}),
  exportUrdf: args.urdf,
  ...(args.validate !== undefined ? { validate: args.validate } : {}),
  ...(args.simRefine !== undefined ? { simRefine: args.simRefine } : {}),
  ...(args.validateSteps !== undefined ? { validateSteps: args.validateSteps } : {}),
  log: (line) => console.log(line),
});

console.log(`\n=== Motion export ${result.ok ? "done" : "FAILED"} ===`);
console.log(`  output_dir: ${result.outputDir}`);
console.log(`  plan_source: ${result.planSource} (${result.linkCount} links, ${result.jointCount} joints)`);
if (result.usdaPath) console.log(`  usd:  ${result.usdaPath}`);
if (result.urdfPath) console.log(`  urdf: ${result.urdfPath}`);
if (result.validation?.ran) {
  console.log(`  isaac_validation: ${result.validation.ok ? "passed" : "FAILED"}` +
              `${result.simRefined ? " (after sim-refine)" : ""}` +
              ` strict=${result.validation.strictOk ? "ok" : "advisory-issues"}` +
              ` report=${result.validation.reportPath}`);
} else if (result.validation?.skippedReason) {
  console.log(`  isaac_validation: skipped (${result.validation.skippedReason})`);
}
for (const err of result.errors) console.log(`  ERROR: ${err}`);
if (result.warnings.length > 0) console.log(`  warnings: ${result.warnings.length} (see motion/manifest.json)`);
console.log(`  duration: ${Math.round(result.durationMs / 1000)}s`);

// Nested: motion.context contains motion.split and blender.parts_color, so the
// column deliberately overlaps and must not be summed.
console.log("\n" + report("motion breakdown", [
  ["planner context", "motion.context", 0],
  ["per-part split (OpenSCAD)", "motion.split", 1],
  ["per-part render (Blender)", "blender.parts_color", 1],
  ["instance compiles", "motion.instances", 1],
  ["LLM plan", "llm.motion-plan", 0],
  ["LLM author (--no-author)", "llm.motion-author", 0],
  ["LLM refine (--no-refine)", "llm.motion-refine", 0],
  ["LLM sim-refine", "llm.motion-sim-refine", 0],
  ["link compiles", "motion.links", 0],
  ["Isaac validation", "motion.isaac", 0],
]));

process.exit(result.ok ? ((result.validation?.ran && result.validation.ok !== true) ? 3 : 0) : 1);
