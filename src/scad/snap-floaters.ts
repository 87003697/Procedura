/**
 * Deterministic floater re-seating — no LLM in the loop.
 *
 * Floaters are mechanical defects with a mechanical fix. The conversational
 * path (critic describes → fixer guesses a delta → next cycle checks) never
 * actually fixed them: across the v1/v2 guard runs every case still shipped
 * 48–107 visible floaters. This module closes the loop numerically:
 *
 *   analyze → attribute each visible floater to its module → compute the
 *   axis-aligned bbox gap from the floater to the MAIN body → translate the
 *   module by that gap plus a small overlap → recompile → re-analyze →
 *   keep only if the visible-floater count strictly dropped, else revert.
 *
 * Safety rules:
 *   - A module is only moved when the floater essentially IS the module
 *     (floater bbox ≥ half the module bbox volume). A module that is mostly
 *     welded into the main body with one stray piece is skipped — translating
 *     it would rip the welded part out.
 *   - A module attributed to SEVERAL floater pieces is internally disconnected;
 *     translation can't fix that. Skipped, reported.
 *   - Escalation: one retry with a deeper push for floaters that survive the
 *     first pass. After that we stop — the caller gets an honest report.
 *   - The result is verified by a full recompile; on no improvement the
 *     original SCAD is returned untouched.
 */

import { compileScad } from "./compile.ts";
import { nudgeAssemblyPlacements, wrapAssemblyInUnion } from "./parts.ts";
import { loadSTL } from "../mesh/stl.ts";
import {
  analyzeConnectivity,
  floaterGapsMm,
  MICRO_GAP_MM,
  VISIBLE_SPAN_FRACTION,
  type ConnectivityResult,
} from "../mesh/connectivity.ts";
import { attributeFloaters } from "../mesh/floater-attribution.ts";
import { join } from "node:path";

/** Overlap pushed INTO the main body beyond closing the bbox gap (mm). */
const PUSH_MM = 0.7;
/** Deeper push for the escalation round (mm). */
const PUSH_ESCALATED_MM = 2.5;
/** Floater bbox volume must be at least this fraction of its module's bbox
 *  volume for a whole-module translation to be safe. v3 tested the WRONG ratio
 *  (floater-inside-module-bbox, which is ~1 for any attributed floater) and
 *  moved mostly-welded modules — fixing one gap while opening another. */
const WHOLE_MODULE_MIN_FRAC = 0.6;

export interface SnapMove {
  module: string;
  delta: [number, number, number];
  floaterSpanPct: number;
}

export interface SnapReport {
  ok: boolean;
  /** SCAD after snapping — the input when nothing improved. */
  scad: string;
  changed: boolean;
  visibleBefore: number;
  visibleAfter: number;
  /** Of `visibleAfter`, how many have a REAL air gap (>= MICRO_GAP_MM to any
   *  neighbour) versus exact-touch micro-gap shells. The distinction is the
   *  whole point: on these drafts the visible count is dominated by parts that
   *  sit flush against their neighbour, which are tolerable — reporting the
   *  raw count as "real air gaps" overstates the defect ~50x. */
  realAfter: number;
  microAfter: number;
  moves: SnapMove[];
  /** Floaters we declined to fix, with the reason — the LLM's remaining work. */
  skipped: { module: string | null; spanPct: number; reason: string }[];
  /** Compiled artifacts of the accepted result (undefined when unchanged). */
  stlPath?: string;
  objPath?: string;
  note: string;
}

interface Box { min: number[]; max: number[] }

/** Signed per-axis translation that closes the bbox gap from `f` to `m`,
 *  plus `push` mm along the dominant axis (into the body). */
function snapDelta(f: Box, m: Box, push: number): [number, number, number] {
  const d: [number, number, number] = [0, 0, 0];
  let domAxis = -1;
  let domGap = 0;
  for (let a = 0; a < 3; a++) {
    if (f.min[a]! > m.max[a]!) d[a] = m.max[a]! - f.min[a]!;        // move negative
    else if (f.max[a]! < m.min[a]!) d[a] = m.min[a]! - f.max[a]!;   // move positive
    if (Math.abs(d[a]!) > domGap) { domGap = Math.abs(d[a]!); domAxis = a; }
  }
  if (domAxis >= 0) {
    d[domAxis] = d[domAxis]! + Math.sign(d[domAxis]!) * push;
    return d;
  }
  // Bboxes already overlap (exact-touch faces, or nested recess) — the mesh gap
  // is sub-bbox. Push toward the main-body centre along the dominant offset axis.
  const fc = [0, 1, 2].map((a) => (f.min[a]! + f.max[a]!) / 2);
  const mc = [0, 1, 2].map((a) => (m.min[a]! + m.max[a]!) / 2);
  let axis = 0;
  for (let a = 1; a < 3; a++) {
    if (Math.abs(mc[a]! - fc[a]!) > Math.abs(mc[axis]! - fc[axis]!)) axis = a;
  }
  const dir = Math.sign(mc[axis]! - fc[axis]!) || 1;
  d[axis] = dir * push;
  return d;
}

/** Split a result's visible floaters into real-air-gap vs micro-gap counts. */
function splitVisible(conn: ConnectivityResult): { real: number; micro: number } {
  const gaps = floaterGapsMm(conn);
  let real = 0, vis = 0;
  for (let i = 1; i < conn.components.length; i++) {
    if (conn.components[i]!.spanFraction < VISIBLE_SPAN_FRACTION) continue;
    vis += 1;
    if (gaps[i]! >= MICRO_GAP_MM) real += 1;
  }
  return { real, micro: vis - real };
}

async function compileAndAnalyze(
  scad: string, outDir: string,
): Promise<{ conn: ConnectivityResult; stlPath: string; objPath: string } | null> {
  try {
    // UNION-WRAPPED: our normal compiles enable lazy-union, which exports one
    // shell per top-level statement — on such a mesh an overlap-fix can never
    // reduce the component count. Real connectivity needs the real boolean.
    const r = await compileScad(wrapAssemblyInUnion(scad), { outputDir: outDir });
    if (r.empty) return null;
    return { conn: analyzeConnectivity(loadSTL(r.stlPath)), stlPath: r.stlPath, objPath: r.objPath };
  } catch {
    return null;
  }
}

export async function snapFloaters(args: {
  scad: string;
  workDir: string;
  /** Reuse an existing analysis of `scad` (skips the first compile). */
  precomputed?: { conn: ConnectivityResult; stlPath: string; objPath: string };
  log?: (line: string) => void;
}): Promise<SnapReport> {
  const log = args.log ?? (() => undefined);
  const snapDir = join(args.workDir, "_snap");

  const base = args.precomputed ?? await compileAndAnalyze(args.scad, join(snapDir, "base"));
  if (!base || !base.conn.analyzed) {
    return {
      ok: false, scad: args.scad, changed: false,
      visibleBefore: -1, visibleAfter: -1, realAfter: -1, microAfter: -1, moves: [], skipped: [],
      note: "snap_floaters: could not compile/analyze the current buffer.",
    };
  }
  const visibleBefore = base.conn.visibleFloaterCount;
  if (visibleBefore === 0) {
    return {
      ok: true, scad: args.scad, changed: false,
      visibleBefore, visibleAfter: 0, realAfter: 0, microAfter: 0, moves: [], skipped: [],
      note: "No visible floaters — nothing to snap.",
    };
  }

  // Attribute floaters to modules (per-module compiles, cached by SCAD hash —
  // the same cache check_connectivity uses).
  const attrs = await attributeFloaters(args.scad, base.conn, join(snapDir, "attr"));
  const visible = attrs.filter((a) => a.spanFraction >= VISIBLE_SPAN_FRACTION);

  // Group by module; multi-piece modules can't be fixed by translation.
  const byModule = new Map<string, typeof visible>();
  const skipped: SnapReport["skipped"] = [];
  for (const a of visible) {
    if (a.module === null) {
      skipped.push({ module: null, spanPct: a.spanFraction * 100, reason: "no owning module (stray primitive at assembly root)" });
      continue;
    }
    const arr = byModule.get(a.module) ?? [];
    arr.push(a);
    byModule.set(a.module, arr);
  }

  // Snap each floater toward its NEAREST other component, not the main body.
  // v3 lesson: on a real model the main component's bbox spans most of the
  // model, so every floater bbox already "overlaps" it and the old main-bbox
  // heuristic degenerated to a blind 0.7mm push toward the centre — zero of
  // 4-7 planned moves improved the count on any of the three cases. The gap
  // that matters is to the physically nearest neighbour (usually a micro-gap
  // along one axis); the per-component bboxes from the analysis give exactly
  // that.
  const componentBoxes = base.conn.components.map((c) => c.bbox);
  const gapDist2 = (f: Box, t: Box): number => {
    let d2 = 0;
    for (let a = 0; a < 3; a++) {
      const gap = Math.max(0, Math.max(f.min[a]! - t.max[a]!, t.min[a]! - f.max[a]!));
      d2 += gap * gap;
    }
    return d2;
  };
  const nearestTarget = (rank: number): Box => {
    let best = 0;                                  // default: the main body
    let bestD = Infinity;
    for (let i = 0; i < componentBoxes.length; i++) {
      if (i === rank) continue;
      const d = gapDist2(componentBoxes[rank]!, componentBoxes[i]!);
      // Prefer the closer component; ties go to the larger (earlier) one.
      if (d < bestD - 1e-9) { bestD = d; best = i; }
    }
    return componentBoxes[best]!;
  };

  const planMoves = (push: number, only?: Set<string>): { moves: SnapMove[]; scad: string } => {
    let scad = args.scad;
    const moves: SnapMove[] = [];
    for (const [module, pieces] of byModule) {
      if (only && !only.has(module)) continue;
      if (pieces.length > 1) continue;                 // handled in skip report below
      const a = pieces[0]!;
      if (a.moduleFraction < WHOLE_MODULE_MIN_FRAC) continue;   // not the whole module
      const delta = snapDelta(a.bbox, nearestTarget(a.rank), push);
      if (delta.every((x) => x === 0)) continue;
      const r = nudgeAssemblyPlacements(scad, new Set([module]), delta);
      if (r.wrappedStatements === 0) continue;
      scad = r.scad;
      moves.push({ module, delta, floaterSpanPct: a.spanFraction * 100 });
    }
    return { moves, scad };
  };
  for (const [module, pieces] of byModule) {
    if (pieces.length > 1) {
      skipped.push({ module, spanPct: Math.max(...pieces.map((p) => p.spanFraction)) * 100, reason: `module splits into ${pieces.length} disconnected pieces — needs a geometry edit, not a move` });
    } else if (pieces[0]!.moduleFraction < WHOLE_MODULE_MIN_FRAC) {
      skipped.push({ module, spanPct: pieces[0]!.spanFraction * 100, reason: `floater is only ${(pieces[0]!.moduleFraction * 100).toFixed(0)}% of the module — a stray internal piece; needs an edit_module fix inside the module` });
    }
  }

  const round1 = planMoves(PUSH_MM);
  if (round1.moves.length === 0) {
    return {
      ok: true, scad: args.scad, changed: false,
      visibleBefore, visibleAfter: visibleBefore, ...(() => { const sp = splitVisible(base.conn); return { realAfter: sp.real, microAfter: sp.micro }; })(), moves: [], skipped,
      note: `snap_floaters: ${visibleBefore} visible floater(s) but none safely movable ` +
        `(${skipped.length} skipped). They need geometry edits.`,
    };
  }

  log(`  snap_floaters: moving ${round1.moves.length} module(s) [push ${PUSH_MM}mm]`);
  let best = { scad: args.scad, visible: visibleBefore, stlPath: base.stlPath, objPath: base.objPath, moves: [] as SnapMove[], conn: base.conn };
  const check1 = await compileAndAnalyze(round1.scad, join(snapDir, "round1"));
  if (check1 && check1.conn.analyzed && check1.conn.visibleFloaterCount < best.visible) {
    best = { scad: round1.scad, visible: check1.conn.visibleFloaterCount, stlPath: check1.stlPath, objPath: check1.objPath, moves: round1.moves, conn: check1.conn };
  }

  // Escalation: if floaters remain and round1 helped (or did nothing), push the
  // survivors deeper once. Re-attribution is skipped — we reuse the original
  // grouping and just push harder along the same vectors.
  if (best.visible > 0 && round1.moves.length > 0) {
    const survivors = new Set(byModule.keys());
    const round2 = planMoves(PUSH_ESCALATED_MM, survivors);
    if (round2.moves.length > 0) {
      const check2 = await compileAndAnalyze(round2.scad, join(snapDir, "round2"));
      if (check2 && check2.conn.analyzed && check2.conn.visibleFloaterCount < best.visible) {
        best = { scad: round2.scad, visible: check2.conn.visibleFloaterCount, stlPath: check2.stlPath, objPath: check2.objPath, moves: round2.moves, conn: check2.conn };
      }
    }
  }

  const bestSplit = splitVisible(best.conn);
  const changed = best.scad !== args.scad;
  const note = changed
    ? `snap_floaters: visible floaters ${visibleBefore} → ${best.visible} ` +
      `(moved ${best.moves.map((m) => m.module).join(", ")}` +
      `${skipped.length ? `; ${skipped.length} need geometry edits` : ""}).`
    : `snap_floaters: no move improved the count (${visibleBefore} visible remain); buffer unchanged.`;
  log(`  ${note}`);
  return {
    ok: true, scad: best.scad, changed,
    visibleBefore, visibleAfter: best.visible,
    realAfter: bestSplit.real, microAfter: bestSplit.micro,
    moves: best.moves, skipped,
    ...(changed ? { stlPath: best.stlPath, objPath: best.objPath } : {}),
    note,
  };
}
