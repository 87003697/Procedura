import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  planReferenceRun,
  type PlanReferenceRunOpts,
  type PlanReferenceRunResult,
} from "./mesh-to-cad-plan.ts";
import { runProcedura } from "./procedura.ts";
import type { ViewName } from "../render/views.ts";

const PROCEDURA_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const STALE_FILES = [
  "final.scad", "final.obj", "final.stl", "final.mtl", "final_summary.txt",
  "final_painted.scad", "final_painted.stl", "final_painted.obj", "final_painted.mtl",
  "final_materials.json", "final_palette.json", "ortho_reviewed.scad",
  "ortho_reviewed.obj", "ortho_reviewed.stl", "ortho_reviewed.mtl", "ortho_review_summary.txt",
];
const STALE_DIRS = [
  "preview_final", "preview_painted", "preview_ao", "preview_ao_ortho",
  "preview_final.tmp", "_final_build", "_refine_steps", "motion",
];
const REFINE_REFERENCE_VIEWS = [
  "isometric", "front", "back", "left", "right", "top", "bottom",
] as const satisfies readonly ViewName[];

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function runMeshToCadGeneration(
  opts: PlanReferenceRunOpts & { refine?: boolean },
): Promise<PlanReferenceRunResult> {
  const { refine = false, ...planOpts } = opts;
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
  const planned = await planReferenceRun({
    ...planOpts,
    ...(refine ? { referenceViews: REFINE_REFERENCE_VIEWS } : {}),
    maxParts: 0,
  });
  const imagePath = resolve(planned.outputDir, "image.png");
  const planPath = resolve(planned.outputDir, "plan.json");
  if (!existsSync(imagePath) || !existsSync(planPath)) {
    throw new Error("Mesh-to-CAD generation requires Plan 2 image.png and plan.json");
  }
  const planText = readFileSync(planPath, "utf8");
  const generated = await runProcedura({
    text: "Generate editable CAD from this host-produced plan:\n\n" + planText,
    outputDir: planned.outputDir,
    incremental: true,
    inputImages: planned.referenceImages.map((image) => ({
      label: image.view,
      path: image.path,
    })),
    inputPlan: planPath,
    redo: true,
    refine,
    refineMode: "direct",
    draftPromotion: "open-loop",
  });
  const finalScad = resolve(outputDir, "final.scad");
  const finalObj = resolve(outputDir, "final.obj");
  if (!generated.refine.ok) {
    throw new Error(`Mesh-to-CAD refine ended with verdict: ${generated.refine.verdict}`);
  }
  if (!existsSync(finalScad) || !existsSync(finalObj) ||
    statSync(finalScad).size === 0 || statSync(finalObj).size === 0) {
    throw new Error("Mesh-to-CAD generation did not produce complete final artifacts");
  }
  return planned;
}
