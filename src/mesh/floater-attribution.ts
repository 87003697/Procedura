/**
 * Floater → module attribution.
 *
 * `analyzeConnectivity` finds disconnected sub-bodies (floaters) in the merged
 * STL but is blind to which SCAD module produced each one — the agent has to
 * eyeball the bbox and guess. This module closes that gap: it compiles every
 * top-level module AT ITS ASSEMBLY PLACEMENT (via compileModuleInAssembly),
 * takes each module's placed bbox, and matches every floater to the module(s)
 * whose bbox it overlaps. The refine agent then edits the NAMED module instead
 * of guessing — which is the difference between re-placing the real offender
 * and welding on a cosmetic strut to satisfy the connectivity gate.
 *
 * Per-module compiles are cached by SCAD hash so repeated check_connectivity /
 * finish-gate calls on an unchanged buffer don't recompile.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";

import { listTopLevelModules, compileModuleInAssembly } from "../scad/parts.ts";
import { mapPool, COMPILE_CONCURRENCY } from "../util/pool.ts";
import { loadSTL, computeBBox } from "./stl.ts";
import { VISIBLE_SPAN_FRACTION, type ConnectivityBBox, type ConnectivityResult } from "./connectivity.ts";

export interface FloaterAttribution {
  /** Component index in the connectivity result (1 = first floater after main). */
  rank: number;
  /** Longest bbox dimension as a fraction of the whole model (≥ 1% ⇒ VISIBLE). */
  spanFraction: number;
  bbox: ConnectivityBBox;
  /** Best-match module — the one to edit. null when no placed module's bbox
   *  contains the floater (rare: a stray primitive at the assembly root). */
  module: string | null;
  /** Overlap of the floater's bbox captured by the matched module (0..1). */
  confidence: number;
  /** Floater bbox volume as a fraction of the matched module's bbox volume
   *  (0..1). ~1 ⇒ the floater IS the whole module (safe to translate);
   *  small ⇒ a stray piece of a mostly-welded module (translation would rip
   *  the welded part out — the v3 snap failure). */
  moduleFraction: number;
  /** Other modules whose bbox also overlaps the floater ≥ 20% — a detached
   *  SUB-ASSEMBLY floats as several modules together; these are its siblings. */
  alsoOverlaps: string[];
}

interface ModuleBox { name: string; min: number[]; max: number[] }

// Per-module placed bboxes are expensive (one OpenSCAD compile each), so cache
// by SCAD hash. Bounded to a handful of recent buffers.
const boxCache = new Map<string, ModuleBox[]>();

function hashScad(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function overlapVolume(aMin: number[], aMax: number[], bMin: number[], bMax: number[]): number {
  let v = 1;
  for (let i = 0; i < 3; i++) {
    const lo = Math.max(aMin[i]!, bMin[i]!);
    const hi = Math.min(aMax[i]!, bMax[i]!);
    if (hi <= lo) return 0;
    v *= hi - lo;
  }
  return v;
}

function boxVolume(min: number[], max: number[]): number {
  return Math.max(0, max[0]! - min[0]!) * Math.max(0, max[1]! - min[1]!) * Math.max(0, max[2]! - min[2]!);
}

/** Compile each top-level module at its assembly placement and record its bbox. */
export async function computeModuleBoxes(scadCode: string, workDir: string): Promise<ModuleBox[]> {
  const key = hashScad(scadCode);
  const cached = boxCache.get(key);
  if (cached) return cached;

  // Same independent-subprocess shape as render/parts_split.ts: each module
  // compiles from the same immutable source into its own directory, so these
  // run concurrently and are folded back in module order afterwards.
  const names = listTopLevelModules(scadCode);
  const boxes = await mapPool<string, ModuleBox | null>(names, COMPILE_CONCURRENCY, async (name) => {
    try {
      const stl = await compileModuleInAssembly(scadCode, name, join(workDir, name));
      if (!stl) return null;
      const bb = computeBBox(loadSTL(stl));
      return { name, min: bb.min, max: bb.max };
    } catch {
      // A module that fails to compile in isolation is simply unattributable.
      return null;
    }
  });
  const out: ModuleBox[] = boxes.filter((b): b is ModuleBox => b !== null);

  boxCache.set(key, out);
  if (boxCache.size > 8) boxCache.delete(boxCache.keys().next().value!);
  return out;
}

/** Pure matcher — pair each floater component with the module box it overlaps most. */
export function matchFloatersToBoxes(conn: ConnectivityResult, boxes: ModuleBox[]): FloaterAttribution[] {
  const res: FloaterAttribution[] = [];
  for (let i = 1; i < conn.components.length; i++) {
    const c = conn.components[i]!;
    const fMin = c.bbox.min, fMax = c.bbox.max;
    const fVol = boxVolume(fMin, fMax) || 1;
    const scored = boxes
      .map((b) => ({
        name: b.name,
        frac: overlapVolume(fMin, fMax, b.min, b.max) / fVol,
        moduleVol: boxVolume(b.min, b.max),
      }))
      .filter((s) => s.frac > 0.01)
      .sort((a, b) => b.frac - a.frac);
    const best = scored[0];
    res.push({
      rank: i,
      spanFraction: c.spanFraction,
      bbox: c.bbox,
      module: best ? best.name : null,
      confidence: best ? Math.min(1, best.frac) : 0,
      moduleFraction: best && best.moduleVol > 0 ? Math.min(1, fVol / best.moduleVol) : 0,
      alsoOverlaps: scored.slice(1).filter((s) => s.frac >= 0.2).map((s) => s.name),
    });
  }
  return res;
}

/** Compile module boxes then attribute. Returns [] when there are no floaters. */
export async function attributeFloaters(
  scadCode: string,
  conn: ConnectivityResult,
  workDir: string,
): Promise<FloaterAttribution[]> {
  if (conn.floaterCount === 0) return [];
  const boxes = await computeModuleBoxes(scadCode, workDir);
  return matchFloatersToBoxes(conn, boxes);
}

/** One line per VISIBLE floater, naming the module to edit. Empty when none. */
export function formatAttribution(attrs: FloaterAttribution[]): string {
  const visible = attrs.filter((a) => a.spanFraction >= VISIBLE_SPAN_FRACTION);
  if (visible.length === 0) return "";
  const lines = ["", "Floater → module (edit_module these — the named module is the offender):"];
  for (const a of visible) {
    const pct = (a.spanFraction * 100).toFixed(1);
    const also = a.alsoOverlaps.length ? ` — detached with [${a.alsoOverlaps.join(", ")}]` : "";
    lines.push(
      a.module
        ? `  flt${String(a.rank).padStart(2, "0")} (span ${pct}%) → \`${a.module}\` [${(a.confidence * 100).toFixed(0)}% overlap]${also}`
        : `  flt${String(a.rank).padStart(2, "0")} (span ${pct}%) → UNMATCHED (stray primitive at assembly root — check the final union())`,
    );
  }
  return lines.join("\n");
}
