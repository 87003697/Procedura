/**
 * Per-buffer TRUE connectivity — the single source every consumer reads.
 *
 * Two bugs made the old floater story fiction:
 *
 *  1. (v2 post-mortem) The diagnose block was fed only by full compiles, but
 *     the agent works through candidate dry-runs and cycle-1 diagnose runs
 *     before any compile — so the block reached zero LLM calls across three
 *     complete runs.
 *  2. (root cause, found while testing snap_floaters) Our compiles enable
 *     OpenSCAD's lazy-union: the STL is a concatenation of per-statement
 *     SHELLS, never the boolean union. Parts overlapping by 10mm still export
 *     as two disjoint meshes, so "N visible floaters" counted shells, not
 *     disconnection — mech_robot's "77 floaters" were mostly fine parts.
 *
 * ensureConnectivity fixes both: it compiles the UNION-WRAPPED source (real
 * boolean, real connectivity) once per buffer state, memoized, and everything —
 * diagnose, compile summaries, check_connectivity, the finish gate, snap
 * verification — reads this entry instead of analyzing lazy-union artifacts.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { compileScad } from "../scad/compile.ts";
import { wrapAssemblyInUnion } from "../scad/parts.ts";
import { loadSTL } from "../mesh/stl.ts";
import {
  analyzeConnectivity,
  summarizeConnectivity,
  floaterGapsMm,
  MICRO_GAP_MM,
  VISIBLE_SPAN_FRACTION,
  type ConnectivityResult,
} from "../mesh/connectivity.ts";
import type { SessionProceduraState } from "./state.ts";

export interface ConnectivityEntry {
  scad: string;
  /** STL of the union-wrapped compile (real merged geometry). */
  stlPath: string;
  conn: ConnectivityResult;
  summary: string;
  visibleFloaters: number;
  /** Visible floaters with REAL air gaps (>= MICRO_GAP_MM). */
  realFloaters: number;
  microFloaters: number;
}

// Session-scoped cache lives on the state object; this maps buffer → entry for
// the current buffer only (previous buffers are gone for good).
const entries = new WeakMap<SessionProceduraState, ConnectivityEntry>();

/** Read the cached entry for the CURRENT buffer, if any (sync, no compile). */
export function cachedConnectivity(state: SessionProceduraState): ConnectivityEntry | null {
  const e = entries.get(state);
  return e && e.scad === state.scad ? e : null;
}

/**
 * Ensure a TRUE-connectivity entry exists for the current buffer, compiling the
 * union-wrapped source if needed. Costs one full compile + one analysis per
 * buffer state (memoized). Returns null when the buffer doesn't compile —
 * connectivity is advisory, never a crash.
 */
export async function ensureConnectivity(
  state: SessionProceduraState,
): Promise<ConnectivityEntry | null> {
  const hit = cachedConnectivity(state);
  if (hit) return hit;
  try {
    const dir = join(state.agentCompilesDir, "_conn");
    mkdirSync(dir, { recursive: true });
    const r = await compileScad(wrapAssemblyInUnion(state.scad), { outputDir: dir });
    if (r.empty) return null;
    const conn = analyzeConnectivity(loadSTL(r.stlPath));
    if (!conn.analyzed) return null;
    // Split visible floaters into REAL air gaps vs micro-gap shells: the gate
    // and the critic act on real ones only (mech_robot carries 59 micro-gap
    // shells — treating those as blockers made finish(ok) unreachable).
    const gaps = floaterGapsMm(conn);
    let real = 0;
    for (let i = 1; i < conn.components.length; i++) {
      if (conn.components[i]!.spanFraction >= VISIBLE_SPAN_FRACTION && gaps[i]! >= MICRO_GAP_MM) real += 1;
    }
    const entry: ConnectivityEntry = {
      scad: state.scad,
      stlPath: r.stlPath,
      conn,
      summary: summarizeConnectivity(conn) +
        ` [${real} with real air gaps >= ${MICRO_GAP_MM}mm; ` +
        `${conn.visibleFloaterCount - real} micro-gap shell(s), tolerated]`,
      visibleFloaters: conn.visibleFloaterCount,
      realFloaters: real,
      microFloaters: conn.visibleFloaterCount - real,
    };
    entries.set(state, entry);
    // Keep the legacy mirror for consumers that only need the summary line.
    state.latestConnectivity = {
      scad: state.scad, summary: entry.summary, visibleFloaters: entry.visibleFloaters,
      realFloaters: entry.realFloaters, microFloaters: entry.microFloaters,
    };
    return entry;
  } catch {
    return null;
  }
}
