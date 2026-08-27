/**
 * check_collisions tool — geometric collision scan of the whole assembly.
 *
 * The vision critic (`diagnose`) reviews the OUTSIDE of the model; it cannot see
 * two parts passing through each other, because the interpenetration is buried
 * inside the solid. This tool fills that blind spot: it compiles every part at
 * its true world position and finds pairs that are NOT in the same rigid group
 * yet interpenetrate — a hand clipping a thigh, a forearm inside the torso.
 *
 * Like `diagnose`, a successful run UNLOCKS one edit: after it reports an
 * unreasonable collision, apply the fix (usually `move_parts` to shift a whole
 * limb) in the same cycle. It is slow (one OpenSCAD compile per part), so the
 * result is memoised for the current buffer — re-calling it without an edit in
 * between returns the cached scan.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import type { SessionProceduraState } from "./state.ts";
import { runCollisionAnalysis } from "./collision-check.ts";

const DESCRIPTOR: ToolDescriptor = {
  name: "check_collisions",
  description:
    "Geometric collision scan: compiles every top-level part at its true " +
    "assembled position and finds UNREASONABLE interpenetrations — pairs that are " +
    "not structurally connected (not the same limb, not a declared joint) yet " +
    "pass through each other (e.g. a hand buried in a thigh). These are invisible " +
    "to diagnose because the overlap is hidden inside the solid. It reports each " +
    "clash's penetration depth + which rigid group to move, and a suggested " +
    "move_parts call to separate them. Run it at least once per refine (after the " +
    "model is structurally complete); fix any UNREASONABLE clash with move_parts " +
    "(preferred — moves a whole limb rigidly) then re-run to confirm. A successful " +
    "run unlocks one edit, exactly like diagnose. Intended mating overlaps within " +
    "one limb or across a real joint are NOT flagged.",
  owner: { kind: "core" },
  inputSchema: { type: "object", properties: {} } satisfies JsonObject,
};

export function makeCheckCollisionsTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute() {
      state.step += 1;
      let analysis;
      try {
        analysis = await runCollisionAnalysis(state, { log: (s) => console.log(s) });
      } catch (e) {
        return {
          ok: false,
          error:
            `Collision scan failed (${(e as Error).message}). The SCAD may not ` +
            `compile — run compile first to fix syntax, then retry check_collisions.`,
        };
      }
      const { result, text, cached } = analysis;

      // A fresh scan is a form of diagnosis: it unlocks exactly one edit so the
      // agent can apply a collision fix (move_parts / edit_module) this cycle.
      state.hasFreshDiagnosis = true;

      const tail = result.unreasonable.length > 0
        ? "\n\nApply the highest-penetration fix with move_parts (moves a whole limb " +
          "group rigidly, preserving its internal connectivity), then compile + " +
          "check_connectivity + check_collisions to confirm the clash is gone and " +
          "nothing detached."
        : "\n\nNo unreasonable collisions — if the vision diagnosis is also clean, finish.";

      return {
        ok: true,
        output: {
          text: text + tail + (cached ? "\n(cached — buffer unchanged since last scan.)" : ""),
          unreasonable_count: result.unreasonable.length,
          part_count: result.parts.length,
          group_count: result.groups.length,
          unreasonable: result.unreasonable.map((p) => ({
            a: p.a, b: p.b,
            penetration_mm: Number(p.penetrationDepth.toFixed(2)),
            volume_ratio: Number(p.volumeRatio.toFixed(3)),
            suggestion: p.suggestion
              ? { move: p.suggestion.move, group: p.suggestion.group, delta: p.suggestion.delta }
              : null,
          })) as unknown as JsonObject[],
        },
      };
    },
  };
}
