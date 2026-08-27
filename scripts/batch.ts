#!/usr/bin/env bun
/**
 * End-to-end batch: sample N prompts (or an explicit --ids set) from the dataset
 * and run the unified Procedura pipeline on each, up to --parallel at a time.
 *
 *   bun run scripts/batch.ts \
 *     --n 3 \
 *     --max-steps 3 \
 *     --parallel 4 \
 *     [--incremental] [--motion] [--no-refine] [--urdf] [--images] \
 *     [--prompts /path/to/prompts.jsonl] \
 *     [--out-root outputs/procedura_batch] \
 *     [--seed 42] [--ids id1,id2]
 *
 * Each row produces its own subdir under --out-root, named by the dataset id.
 * The batch manifest is written to <out-root>/batch_manifest.json.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";

import { runProcedura } from "../src/pipeline/procedura.ts";
import { DEFAULT_REFINE_STEPS } from "../src/pipeline/refine.ts";
import { DEFAULT_MODEL } from "../src/config/models.ts";
import { imageGenAvailable, imageGenDisabledReason } from "../src/imagegen/images.ts";

interface Args {
  n: number;
  /** Refine-loop iterations (runProcedura `maxSteps`). Default 3. */
  maxSteps: number;
  parallel: number;
  prompts: string;
  outRoot: string;
  seed: number;
  /** Model for the refine agent loop AND motion planner (the harness LLM path).
   *  Also the draft model unless --draft-model overrides it. */
  model: string;
  /** Separate model for the incremental draft (scad-gen) only. Lets the draft
   *  run on a codex/fast model while refine+motion use an API model — a codex
   *  model (draft-only) can't drive refine/motion. Defaults to `model`. */
  draftModel?: string;
  /** Fallback model: if a case throws a provider-outage error (529 / tunnel
   *  down / stream interrupted) on `model`, the whole case is re-run once on
   *  this model with redo=true (clean regen — never mixes providers within one
   *  asset). Undefined = no failover — e.g. a second gateway for the same model. */
  fallbackModel?: string;
  // ── pipeline pass-through (default off → historical one-shot draft + refine) ──
  /** Part-by-part incremental draft instead of the one-shot draft. */
  incremental: boolean;
  /** Assembly-aware incremental gen (mating-feature lib + prompt). Implies incremental. */
  assembly: boolean;
  /** Phase-3 paint: per-part PBR material pass (vision LLM). Uses the agent model. */
  paint: boolean;
  /** Phase-4 motion export (OpenUSD/Isaac) after the final SCAD. */
  motion: boolean;
  /** Run the whole-model Phase-2 refine. Default true; --no-refine disables. */
  refine: boolean;
  /** Headless Isaac validation of the motion export. Undefined → pipeline default
   *  (on when Isaac is found). --no-validate forces off. */
  validate?: boolean;
  /** Also export URDF (needed for the richest Isaac validation + sim-ready set). */
  urdf: boolean;
  /** Feed each row's `image` field as the reference (skips image-gen → faithful
   *  reconstruction). Resolved relative to the prompts file's directory. */
  useImages: boolean;
  /** Restrict the run to these dataset ids (comma-separated); overrides sampling. */
  ids: string[] | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    n: 3, maxSteps: DEFAULT_REFINE_STEPS, parallel: 3,
    prompts: "prompts.jsonl",
    outRoot: "outputs/procedura_batch",
    seed: 42,
    model: DEFAULT_MODEL,
    incremental: false, assembly: false, paint: false, motion: false, refine: true,
    urdf: false, useImages: false, ids: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--n")           a.n = Number(argv[++i]!);
    else if (flag === "--max-steps") a.maxSteps = Number(argv[++i]!);
    else if (flag === "--parallel")  a.parallel = Number(argv[++i]!);
    else if (flag === "--prompts")   a.prompts  = argv[++i]!;
    else if (flag === "--out-root")  a.outRoot  = argv[++i]!;
    else if (flag === "--seed")      a.seed     = Number(argv[++i]!);
    else if (flag === "--model")     a.model    = argv[++i]!;
    else if (flag === "--draft-model") a.draftModel = argv[++i]!;
    else if (flag === "--fallback-model") a.fallbackModel = argv[++i]!;
    else if (flag === "--incremental") a.incremental = true;
    else if (flag === "--assembly")  { a.assembly = true; a.incremental = true; }
    else if (flag === "--paint")     a.paint = true;
    else if (flag === "--motion")    a.motion = true;
    else if (flag === "--no-refine") a.refine = false;
    else if (flag === "--validate")  a.validate = true;
    else if (flag === "--no-validate") a.validate = false;
    else if (flag === "--urdf")      a.urdf = true;
    else if (flag === "--images")    a.useImages = true;
    else if (flag === "--ids")       a.ids = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "-h" || flag === "--help") printHelpAndExit();
    else { console.error(`unknown flag: ${flag}`); process.exit(2); }
  }
  return a;
}

function printHelpAndExit(): never {
  console.log(`
Procedura batch — sample N prompts (or --ids), run the unified pipeline in parallel.

Usage:
  bun run scripts/batch.ts [--n 3] [--max-steps 3] [--parallel 3]
                          [--prompts <path>] [--out-root <dir>] [--seed 42]
                          [--model <key>]
                          [--incremental] [--assembly] [--motion]
                          [--no-refine] [--validate|--no-validate] [--urdf]
                          [--images] [--ids id1,id2,...]

--model sets both the draft scad-gen and the refine agent model
(default: $PROCEDURA_MODEL; any key the catalog knows, or provider:model).
--max-steps is the refine-loop iteration cap (default 3).

Pipeline flags (default off → the historical one-shot draft + refine):
  --incremental   part-by-part incremental draft
  --assembly      assembly-aware incremental gen (mating-feature lib + prompt;
                  implies --incremental). Env kill: PROCEDURA_INCREMENTAL_ASSEMBLY=0
  --paint         Phase-3 per-part PBR material pass (vision LLM = the agent model)
  --motion        Phase-4 OpenUSD/Isaac motion export after the final SCAD
                  (motion-aware incremental auto-enables with --incremental)
  --no-refine     skip the whole-model Phase-2 refine
  --validate / --no-validate   force Isaac validation on/off (default: on when
                  Isaac is found and --motion is set)
  --urdf          also export URDF (+ meshes) for the richest validation
  --images        feed each row's "image" as the reference (faithful recon;
                  resolved relative to the prompts file dir)
  --ids a,b,c     run exactly these dataset ids (overrides --n sampling)

Up to --parallel runs in flight at once. With --motion --validate, keep
--parallel low (≈2) so concurrent headless Isaac instances don't exhaust GPU
VRAM. Each run gets its own subdir under --out-root named by the dataset id.
`);
  process.exit(0);
}

interface PromptRow {
  id: string;
  seed?: string;
  prompt: string;
  /** Optional reference image path (relative to the prompts file dir). */
  image?: string;
}

function loadPrompts(path: string): PromptRow[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const out: PromptRow[] = [];
  for (const ln of lines) {
    if (!ln.trim()) continue;
    try {
      const row = JSON.parse(ln) as PromptRow & { condition_prompt_short?: string };
      const prompt = row.prompt ?? row.condition_prompt_short;
      if (row.id && prompt) out.push({ ...row, prompt });
    } catch { /* skip */ }
  }
  return out;
}

// Deterministic seeded RNG — Mulberry32.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleN<T>(arr: T[], n: number, rng: () => number): T[] {
  // Reservoir sampling.
  const k = Math.min(n, arr.length);
  const out = arr.slice(0, k);
  for (let i = k; i < arr.length; i++) {
    const j = Math.floor(rng() * (i + 1));
    if (j < k) out[j] = arr[i]!;
  }
  return out;
}

// Slot-pool concurrency limiter — at most `cap` async jobs in flight.
async function mapWithConcurrency<T, R>(
  items: T[], cap: number, fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  }
  const workers = Array.from({ length: Math.min(cap, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** True for transient provider-outage errors worth failing over on (rate
 *  limits, tunnel down, stream cut, gateway 5xx) — NOT genuine pipeline bugs
 *  (bad SCAD, parse errors), which should surface, not silently switch model. */
function isProviderOutage(msg: string): boolean {
  const s = msg.toLowerCase();
  return (
    s.includes("529") || s.includes("resource_exhausted") || s.includes("resource exhausted") ||
    s.includes("rate limit") || s.includes("429") ||
    s.includes("unable to connect") || s.includes("econnrefused") || s.includes("connection refused") ||
    s.includes("socket") || s.includes("stream interrupted") || s.includes("timed out") ||
    s.includes("timeout") || s.includes("503") || s.includes("502") || s.includes("504") ||
    s.includes("no available channel") || s.includes("fetch failed") || s.includes("terminated")
  );
}

// ── main ────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));

const rows = loadPrompts(args.prompts);
const rng = mulberry32(args.seed);
// --ids selects an explicit subset (in dataset order); otherwise seeded sample.
const sampled = args.ids
  ? args.ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is PromptRow => r != null)
  : sampleN(rows, args.n, rng);
if (args.ids) {
  const missing = args.ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) console.warn(`  [warn] --ids not found in dataset: ${missing.join(", ")}`);
}
// Reference images are resolved relative to the prompts file's directory
// (e.g. hard_surface_v2/objects.jsonl -> hard_surface_v2/objects/<id>.png).
const promptsDir = dirname(resolve(args.prompts));

console.log(`\n=== Procedura batch ===`);
console.log(`  dataset:    ${args.prompts} (${rows.length} prompts)`);
console.log(`  model:      ${args.model}${args.draftModel ? `  (draft: ${args.draftModel})` : ""}${args.fallbackModel ? `  (fallback: ${args.fallbackModel})` : ""}`);
console.log(`  n=${args.n}  parallel=${args.parallel}  max-steps=${args.maxSteps}  seed=${args.seed}`);
const pipeline = [
  args.incremental ? "incremental" : "one-shot",
  args.assembly ? "assembly" : null,
  args.refine ? "refine" : "no-refine",
  args.paint ? "paint" : null,
  args.motion ? "motion" : null,
  args.motion ? `validate=${args.validate ?? "auto"}` : null,
  args.urdf ? "urdf" : null,
  args.useImages ? "ref-images" : "generated-refs",
].filter(Boolean).join(" + ");
console.log(`  pipeline:   ${pipeline}`);
console.log(`  out-root:   ${resolve(args.outRoot)}`);
console.log(`  ${args.ids ? "ids" : "sampled"}:    ${sampled.map((r) => r.id).join(", ")}`);

// Any case that cannot supply its own reference would have to GENERATE one.
// Check the whole sample up front: a 100-case batch failing 100 times, one
// case at a time, is a worse way to learn this than not starting.
if (!imageGenAvailable()) {
  const needsGen = sampled.filter((r) => {
    if (!args.useImages || !r.image) return true;
    const p = isAbsolute(r.image) ? r.image : join(promptsDir, r.image);
    return !existsSync(p);
  });
  if (needsGen.length > 0) {
    console.error(
      `${needsGen.length}/${sampled.length} case(s) have no reference image ` +
      `and image generation is off: ${needsGen.slice(0, 5).map((r) => r.id).join(", ")}` +
      `${needsGen.length > 5 ? ", …" : ""}\n` +
      `  Give every row an \`image\` field and pass --images, or set ` +
      `PROCEDURA_IMAGE_MODEL to generate the missing references.`,
    );
    process.exit(2);
  }
}

const outRoot = resolve(args.outRoot);
mkdirSync(outRoot, { recursive: true });

const results = await mapWithConcurrency(sampled, args.parallel, async (row, idx) => {
  const dir = join(outRoot, row.id);
  console.log(`\n[${idx + 1}/${sampled.length}  id=${row.id}] starting → ${dir}`);
  console.log(`    prompt: ${row.prompt.slice(0, 100)}...`);
  // Reference image (faithful reconstruction): use the row's image when --images
  // is set and the file exists; otherwise generate one, which the guard above
  // has already confirmed is possible.
  let inputImage: string | undefined;
  if (args.useImages && row.image) {
    const p = isAbsolute(row.image) ? row.image : join(promptsDir, row.image);
    if (existsSync(p)) inputImage = p;
    else console.warn(`    [warn] image not found, generating one instead: ${p}`);
  }
  // One pipeline run on a given model. `redo` forces a clean regen (used on
  // failover so the fallback provider builds the whole asset, never a mix).
  const runOnce = (agentModel: string, draftModel: string, redo: boolean) => runProcedura({
    text: row.prompt,
    outputDir: dir,
    maxSteps: args.maxSteps,
    agentModel,
    scadModel: draftModel,
    incremental: args.incremental,
    assembly: args.assembly,
    paint: args.paint,
    motion: args.motion,
    refine: args.refine,
    redo,
    ...(args.paint ? { paintModel: agentModel } : {}),
    ...(args.validate !== undefined ? { motionValidate: args.validate } : {}),
    ...(args.urdf ? { motionUrdf: true } : {}),
    ...(inputImage !== undefined ? { inputImage } : {}),
  });

  const tag = `[${idx + 1}/${sampled.length}  id=${row.id}]`;
  let usedModel = args.model;
  let r: Awaited<ReturnType<typeof runProcedura>>;
  try {
    r = await runOnce(args.model, args.draftModel ?? args.model, false);
  } catch (e) {
    const msg = (e as Error).message;
    // Failover: a transient outage on the primary provider → re-run the
    // WHOLE case once on the fallback model, clean (redo). Only for provider
    // outages, not genuine pipeline bugs.
    if (args.fallbackModel && isProviderOutage(msg)) {
      console.log(`${tag} ${args.model} outage (${msg.slice(0, 90)}) → failover to ${args.fallbackModel}`);
      try {
        r = await runOnce(args.fallbackModel, args.fallbackModel, true);
        usedModel = args.fallbackModel;
      } catch (e2) {
        console.log(`${tag} FAILOVER ALSO THREW: ${(e2 as Error).message}`);
        return { id: row.id, dir, ok: false, verdict: "error", steps: 0, draft_ok: false,
          error: `primary: ${msg} | fallback: ${(e2 as Error).message}`, model: args.fallbackModel };
      }
    } else {
      console.log(`${tag} THREW: ${msg}`);
      return { id: row.id, dir, ok: false, verdict: "error", steps: 0, draft_ok: false, error: msg, model: args.model };
    }
  }
  console.log(
    `${tag} done — model=${usedModel === args.model ? "primary" : "FALLBACK"} ` +
    `draft=${(r.draft?.ok ?? true) ? "ok" : "FAIL"} verdict=${r.refine.verdict} steps=${r.refine.steps}` +
    (r.paint ? ` paint=${r.paint.ok ? "ok" : "FAIL"}` : "") +
    (r.paint?.degraded?.length ? ` paint_degraded=${r.paint.degraded.length}` : "") +
    (r.motion ? ` motion=${r.motion.ok ? "ok" : "FAIL"}` : ""),
  );
  return {
    id: row.id, dir,
    ok: r.refine.ok,
    verdict: r.refine.verdict,
    steps: r.refine.steps,
    draft_ok: r.draft?.ok ?? true,
    ...(r.paint ? { paint_ok: r.paint.ok } : {}),
    ...(r.paint?.degraded?.length ? { paint_degraded: r.paint.degraded } : {}),
    ...(r.motion ? { motion_ok: r.motion.ok } : {}),
    model: usedModel,
    ...(usedModel !== args.model ? { failed_over: true } : {}),
    trajectory: r.trajectoryPath,
  };
});

const manifestPath = join(outRoot, "batch_manifest.json");
writeFileSync(
  manifestPath,
  JSON.stringify({
    config: args,
    sampled_ids: sampled.map((r) => r.id),
    results,
  }, null, 2),
  "utf8",
);

const okCnt    = results.filter((r) => r.verdict === "ok").length;
const maxCnt   = results.filter((r) => r.verdict === "max-steps").length;
const otherCnt = results.length - okCnt - maxCnt;

console.log(`\n=== Batch summary ===`);
console.log(`  draft:        ${results.filter((r) => r.draft_ok).length}/${results.length} ok`);
console.log(`  refine:       ok=${okCnt}, max-steps=${maxCnt}, other=${otherCnt}`);
if (args.motion) {
  const motionRows = results.filter((r) => "motion_ok" in r);
  console.log(`  motion:       ${motionRows.filter((r) => (r as { motion_ok?: boolean }).motion_ok).length}/${motionRows.length} ok`);
}
console.log(`  manifest:     ${manifestPath}`);
