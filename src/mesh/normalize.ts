/**
 * Center + uniform-scale a mesh so its longest bbox axis fits [-e, e].
 *
 * Port of aetherion.mesh.normalize.normalize_mesh_inplace. Writes the STL
 * back in place and, if an obj path is given, re-emits the OBJ from the
 * transformed mesh.
 */

import { existsSync, copyFileSync, rmSync } from "node:fs";

import { loadSTL, writeSTL, computeBBox, transformInPlace } from "./stl.ts";
import { writeOBJ } from "./obj.ts";

export interface NormalizeResult {
  scale: number;
  bbox_before_min: [number, number, number];
  bbox_before_max: [number, number, number];
  bbox_before_size: [number, number, number];
  bbox_after_min: [number, number, number];
  bbox_after_max: [number, number, number];
  bbox_after_size: [number, number, number];
  center_offset: [number, number, number];
  target_half_extent: number;
}

export interface NormalizeOpts {
  stlPath: string;
  objPath?: string;
  targetHalfExtent?: number;
}

export function normalizeMeshInPlace(opts: NormalizeOpts): NormalizeResult {
  const targetHalfExtent = opts.targetHalfExtent ?? 1.0;
  const mesh = loadSTL(opts.stlPath);
  if (mesh.triCount === 0) {
    throw new Error(`mesh is empty: ${opts.stlPath}`);
  }
  const before = computeBBox(mesh);
  const longest = Math.max(...before.size);
  if (longest <= 0) {
    throw new Error(`zero-size bbox: ${before.size.join(", ")}`);
  }
  const cx = (before.min[0] + before.max[0]) * 0.5;
  const cy = (before.min[1] + before.max[1]) * 0.5;
  const cz = (before.min[2] + before.max[2]) * 0.5;
  const scale = (2.0 * targetHalfExtent) / longest;

  transformInPlace(mesh, [cx, cy, cz], scale);

  const after = computeBBox(mesh);
  writeSTL(opts.stlPath, mesh);
  if (opts.objPath) writeOBJ(opts.objPath, mesh);

  return {
    scale,
    bbox_before_min: before.min,
    bbox_before_max: before.max,
    bbox_before_size: before.size,
    bbox_after_min: after.min,
    bbox_after_max: after.max,
    bbox_after_size: after.size,
    center_offset: [-cx, -cy, -cz],
    target_half_extent: targetHalfExtent,
  };
}

export interface PublishMeshResult {
  /** The published OBJ path, if one was written. */
  objPath?: string;
  /** The published STL path, if one was written (only when exportStl). */
  stlPath?: string;
}

/**
 * Publish a top-level mesh deliverable (e.g. `draft.obj`/`draft.stl`) from a
 * fresh build compile, enforcing Procedura's two mesh invariants in ONE place so
 * no caller can drift from them:
 *
 *   A. the OBJ is ALWAYS normalized to a unit bbox. (If normalize throws we
 *      fall back to the raw build OBJ so we still ship *a* mesh, and log it.)
 *   B. the STL is written ONLY when `exportStl` is set. When it is not, any
 *      stale STL already at `stlOut` is removed — STL is never a default output.
 *
 * `buildStlPath`/`buildObjPath` are the raw OpenSCAD outputs (kept internal in a
 * build dir); `objOut`/`stlOut` are the published top-level paths. Note that
 * `normalizeMeshInPlace` rewrites `buildStlPath` in place, so a subsequent
 * exportStl copy ships the SAME normalized geometry as the OBJ.
 */
export function publishMesh(args: {
  buildStlPath: string;
  buildObjPath?: string;
  objOut: string;
  stlOut: string;
  exportStl: boolean;
  log?: (msg: string) => void;
}): PublishMeshResult {
  const { buildStlPath, buildObjPath, objOut, stlOut, exportStl, log } = args;

  // A. normalized OBJ (always).
  let objWritten = false;
  try {
    normalizeMeshInPlace({ stlPath: buildStlPath, objPath: objOut, targetHalfExtent: 1.0 });
    objWritten = existsSync(objOut);
  } catch (e) {
    log?.(`normalize failed: ${(e as Error).message} — shipping raw OBJ`);
    if (buildObjPath && existsSync(buildObjPath)) { copyFileSync(buildObjPath, objOut); objWritten = true; }
    else {
      // compileScad no longer writes output.obj by default (CompileOpts.writeObj),
      // so re-emit the raw un-normalized mesh from the build STL. Without this
      // the degenerate-mesh path would ship no OBJ at all → meshProduced false
      // → the CLI's exit 3 flips to 1 and a batch row becomes "no-result".
      try { writeOBJ(objOut, loadSTL(buildStlPath)); objWritten = existsSync(objOut); }
      catch (e2) { log?.(`raw OBJ fallback failed: ${(e2 as Error).message}`); }
    }
  }

  // B. STL only on request; otherwise ensure no stale STL is left behind.
  let stlWritten = false;
  if (exportStl) { copyFileSync(buildStlPath, stlOut); stlWritten = true; }
  else if (existsSync(stlOut)) rmSync(stlOut, { force: true });

  return {
    ...(objWritten ? { objPath: objOut } : {}),
    ...(stlWritten ? { stlPath: stlOut } : {}),
  };
}
