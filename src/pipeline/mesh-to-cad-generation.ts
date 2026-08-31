import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runIncrementalDraft, parsePlanJson } from "./draft-incremental.ts";
import {
  planReferenceRun,
  type PlanReferenceRunOpts,
  type PlanReferenceRunResult,
} from "./mesh-to-cad-plan.ts";

const PROCEDURA_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const STALE_FILES = [
  "final.scad", "final.obj", "final.stl", "final.mtl", "final_summary.txt",
  "final_painted.scad", "final_painted.stl", "final_painted.obj", "final_painted.mtl",
  "final_materials.json", "final_palette.json", "ortho_reviewed.scad",
  "ortho_reviewed.obj", "ortho_reviewed.stl", "ortho_reviewed.mtl", "ortho_review_summary.txt",
];
const STALE_DIRS = [
  "preview_final", "preview_painted", "preview_ao", "preview_ao_ortho",
  "preview_final.tmp", "_final_build", "motion",
];

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function runMeshToCadGeneration(
  opts: PlanReferenceRunOpts,
): Promise<PlanReferenceRunResult> {
  const outputDir = resolve(opts.outputDir);
  if (existsSync(outputDir) && !statSync(outputDir).isDirectory()) {
    throw new Error("outputDir must be a directory");
  }
  const runsRoot = resolve(
    opts.runsRoot ?? process.env["PROCEDURA_OUTPUTS_ROOT"] ?? join(PROCEDURA_ROOT, "outputs"),
  );
  if (!isInside(outputDir, runsRoot)) throw new Error("outputDir must be inside runsRoot");
  for (const file of STALE_FILES) rmSync(resolve(outputDir, file), { force: true });
  for (const dir of STALE_DIRS) rmSync(resolve(outputDir, dir), { recursive: true, force: true });
  const planned = await planReferenceRun({ ...opts, maxParts: 0 });
  const imagePath = resolve(planned.outputDir, "image.png");
  const planPath = resolve(planned.outputDir, "plan.json");
  if (!existsSync(imagePath) || !existsSync(planPath)) {
    throw new Error("Mesh-to-CAD generation requires Plan 2 image.png and plan.json");
  }
  const planText = readFileSync(planPath, "utf8");
  const plan = parsePlanJson(planText, 0);
  if (!plan.length) throw new Error("Mesh-to-CAD generation requires a non-empty plan");
  const draft = await runIncrementalDraft({
    text: "Generate editable CAD from this host-produced plan:\n\n" + planText,
    outputDir: planned.outputDir,
    inputImage: imagePath,
    inputPlan: planPath,
  });
  const draftObj = draft.objPath;
  if (!draft.ok || !existsSync(draft.scadPath) || !draftObj || !existsSync(draftObj) ||
    statSync(draft.scadPath).size === 0 || statSync(draftObj).size === 0) {
    throw new Error(`Mesh-to-CAD generation did not produce a complete draft: ${draft.compileError ?? "unknown failure"}`);
  }
  const finalScad = resolve(outputDir, "final.scad");
  const finalObj = resolve(outputDir, "final.obj");
  const finalSummary = resolve(outputDir, "final_summary.txt");
  try {
    copyFileSync(draft.scadPath, finalScad);
    copyFileSync(draftObj, finalObj);
    writeFileSync(finalSummary, "verdict: ok\n\nsummary:\nopen-loop incremental draft promoted without refinement.\n", "utf8");
    if (statSync(finalScad).size === 0 || statSync(finalObj).size === 0) {
      throw new Error("Mesh-to-CAD generation produced empty final artifacts");
    }
  } catch (error) {
    for (const path of [finalScad, finalObj, finalSummary]) rmSync(path, { force: true });
    throw error;
  }
  return planned;
}
