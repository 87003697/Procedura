/**
 * Workspace resolution.
 *
 * A Procedura refine run is anchored at one output_dir produced earlier by the
 * draft stage. The dir contains:
 *
 *   image.png             — reference image (the ground truth), ABSENT in a
 *                           text-only run, where the text spec IS the target
 *   effective_text.txt    — text spec (preferred); else prompt.txt
 *   draft.scad            — current best SCAD (the buffer we'll edit)
 *   draft.stl, draft.obj  — compiled mesh of draft.scad
 *
 * Refine writes its outputs into the same dir:
 *
 *   final.scad / .stl / .obj
 *   preview_final/
 *   final_summary.txt
 *   _trajectory/procedura-<id>.jsonl
 *   _agent_renders/step_NN/
 *   _agent_compiles/step_NN_subdir/
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface ProceduraWorkspace {
  rootDir: string;             // absolute, no trailing slash
  imagePath: string;           // <root>/image.png — may not exist, see hasImage
  /** False in a text-only run: there is no reference image and the text spec is
   *  the whole target. Consumers must branch on this rather than reading
   *  `imagePath` unconditionally. */
  hasImage: boolean;
  text: string;                // contents of effective_text.txt or prompt.txt
  initialScadPath: string;     // <root>/draft.scad
  initialStlPath: string;      // <root>/draft.stl
}

export function resolveWorkspace(outputDir: string): ProceduraWorkspace {
  const rootDir = resolve(outputDir).replace(/\/+$/, "");
  const imagePath = join(rootDir, "image.png");
  const initialScadPath = join(rootDir, "draft.scad");
  const initialStlPath = join(rootDir, "draft.stl");

  if (!existsSync(rootDir)) throw new Error(`output dir does not exist: ${rootDir}`);
  if (!existsSync(initialScadPath)) throw new Error(`missing draft SCAD: ${initialScadPath}`);
  // A missing image is no longer fatal: a text-only run never produces one. The
  // text spec is checked below and IS fatal, because with neither there is
  // nothing to reconstruct against.
  const hasImage = existsSync(imagePath);

  let text = "";
  for (const candidate of ["effective_text.txt", "prompt.txt"]) {
    const p = join(rootDir, candidate);
    if (existsSync(p)) {
      text = readFileSync(p, "utf8").trim();
      break;
    }
  }
  if (!text) {
    throw new Error(`no text spec in ${rootDir} — need effective_text.txt or prompt.txt`);
  }

  return {
    rootDir,
    imagePath,
    hasImage,
    text,
    initialScadPath,
    initialStlPath,
  };
}
