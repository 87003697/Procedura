/**
 * Shared collision-analysis orchestration for the check_collisions tool and the
 * finish gate. Reads the plan's declared kinematic parents (to group joints),
 * runs the geometric collision scan over the current SCAD buffer, and memoises
 * the result on the session state so a finish() right after a check_collisions
 * (the common case) reuses it instead of paying for a second 30-part compile.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeCollisions, formatCollisions, type CollisionResult } from "../mesh/collisions.ts";
import type { SessionProceduraState } from "./state.ts";

/** Declared kinematic parent edges [child, parent] from the run's plan.json.
 *  Used to fold joint parent↔child pairs into one rigid group so their intended
 *  peg-in-socket overlap isn't reported as a collision. Absent plan → []. */
export function readPlanParentEdges(rootDir: string): Array<[string, string]> {
  const p = join(rootDir, "plan.json");
  if (!existsSync(p)) return [];
  try {
    const plan = JSON.parse(readFileSync(p, "utf8")) as Array<{
      name?: string;
      motion?: { parent?: string };
    }>;
    const edges: Array<[string, string]> = [];
    if (Array.isArray(plan)) {
      for (const it of plan) {
        const child = it?.name;
        const parent = it?.motion?.parent;
        if (child && parent) edges.push([child, parent]);
      }
    }
    return edges;
  } catch {
    return [];
  }
}

export async function runCollisionAnalysis(
  state: SessionProceduraState,
  opts?: { log?: (s: string) => void; force?: boolean },
): Promise<{ result: CollisionResult; text: string; cached: boolean }> {
  if (!opts?.force && state.collisionCache && state.collisionCache.scad === state.scad) {
    return { result: state.collisionCache.result, text: state.collisionCache.text, cached: true };
  }
  const parentEdges = readPlanParentEdges(state.workspace.rootDir);
  const result = await analyzeCollisions({
    scadCode: state.scad,
    workDir: state.collisionsDir,
    parentEdges,
    ...(opts?.log ? { log: opts.log } : {}),
  });
  const text = formatCollisions(result);
  state.collisionCache = { scad: state.scad, result, text };
  return { result, text, cached: false };
}
