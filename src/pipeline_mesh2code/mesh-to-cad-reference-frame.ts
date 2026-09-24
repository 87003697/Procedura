import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { normalizeMeshInPlace } from "../mesh/normalize.ts";
import { ReferenceAuthority, formatOf } from "../reference/authority.ts";
import { normalizeReference } from "../reference/normalization.ts";
import {
  planReferenceRun,
  type PlanReferenceRunOpts,
  type PlanReferenceRunResult,
} from "./mesh-to-cad-plan.ts";

const PROCEDURA_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
// The [-1, 1]^3 cube scaled by 50: the draft facet policy ($fs = 1) and prompt
// tolerances such as 0.5 mm overlaps assume millimetre-sized models.
const REFERENCE_LONGEST_SIDE_MM = 100;

/** Maps canonical Z-up millimetre coordinates into the Mesh-to-CAD frame as (source + centerOffset) * scale. */
export interface ReferenceNormalization {
  schemaVersion: 1;
  centerOffset: [number, number, number];
  scale: number;
  sourceDimensions: [number, number, number];
  dimensions: [number, number, number];
}

/** Center an STL's bounding box at the origin and scale its longest side to 100 mm, in place, without rotation. */
export function normalizeReferenceStl(stlPath: string): ReferenceNormalization {
  const result = normalizeMeshInPlace({ stlPath, targetHalfExtent: REFERENCE_LONGEST_SIDE_MM / 2 });
  return {
    schemaVersion: 1,
    centerOffset: result.center_offset,
    scale: result.scale,
    sourceDimensions: result.bbox_before_size,
    dimensions: result.bbox_after_size,
  };
}

/**
 * Plan a Mesh-to-CAD run from a normalized copy of the reference mesh.
 *
 * The copy is staged inside the private reference root and removed after the
 * reference store imports it; the transform is kept in the run directory as
 * reference-normalization.json.
 */
export async function planNormalizedReferenceRun(opts: PlanReferenceRunOpts): Promise<PlanReferenceRunResult> {
  const runsRoot = resolve(
    opts.runsRoot ?? process.env["PROCEDURA_OUTPUTS_ROOT"] ?? join(PROCEDURA_ROOT, "outputs"),
  );
  const configuredRoot = opts.referenceRoot ?? process.env["PROCEDURA_REFERENCE_ROOT"];
  if (!configuredRoot) throw new Error("Mesh-to-CAD requires --reference-root or PROCEDURA_REFERENCE_ROOT");
  const referenceRoot = resolve(configuredRoot);
  // Rejects a root that overlaps runs or the workspace before the copy is written into it.
  new ReferenceAuthority(referenceRoot, [runsRoot, PROCEDURA_ROOT]);
  const source = resolve(opts.meshPath);
  if (!existsSync(source)) throw new Error("reference mesh not found: " + source);
  const format = formatOf(source);
  mkdirSync(referenceRoot, { recursive: true });
  const stagingDir = mkdtempSync(join(referenceRoot, ".normalize-"));
  try {
    const meshPath = join(stagingDir, "reference.stl");
    await normalizeReference(source, format, meshPath);
    const normalization = normalizeReferenceStl(meshPath);
    const planned = await planReferenceRun({ ...opts, meshPath });
    writeFileSync(
      join(planned.outputDir, "reference-normalization.json"),
      JSON.stringify(normalization, null, 2) + "\n",
      "utf8",
    );
    return planned;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Describe the normalized reference frame for every draft request. */
export function referenceFrameText(dimensions: [number, number, number]): string {
  const [x, y, z] = dimensions;
  return "=== REFERENCE FRAME ===\n" +
    "Z-up millimetres. The reference object's axis-aligned bounding box is centred at the origin " +
    `and measures ${x.toFixed(2)} × ${y.toFixed(2)} × ${z.toFixed(2)} mm ` +
    `(X ±${(x / 2).toFixed(2)}, Y ±${(y / 2).toFixed(2)}, Z ±${(z / 2).toFixed(2)}). ` +
    "Build the assembled model at this scale and position so its overall bounding box matches on " +
    "every axis. The origin is the centre of the whole object, not of the root part: place every " +
    "part, including the first, at its own position inside this box.";
}
