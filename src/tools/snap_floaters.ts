/**
 * snap_floaters tool — deterministic floater re-seating, exposed to the agent.
 *
 * Wraps src/scad/snap-floaters.ts: attribute every visible floater to its module,
 * translate it onto the main body, verify by recompile, keep only if the count
 * strictly drops. Self-verified and reversible, so it is NOT an edit cycle:
 * costs no budget, needs no fresh diagnosis, and stays available after the
 * budget is spent. Refused only while a manual edit is pending.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { snapFloaters } from "../scad/snap-floaters.ts";
import type { SessionProceduraState } from "./state.ts";
import { pendingEditRefusal } from "./edit-transaction.ts";

const DESCRIPTOR: ToolDescriptor = {
  name: "snap_floaters",
  description:
    "Deterministically re-seat visible floaters: each detached part is attributed " +
    "to its module, translated onto the main body (bbox gap + small overlap), and " +
    "the result is kept ONLY if a verification recompile shows fewer visible " +
    "floaters. No LLM guessing, no budget cost. Call this FIRST whenever compile / " +
    "check_connectivity reports visible floaters — only hand-edit the ones it " +
    "reports as unfixable (multi-piece modules, welded-in modules). Expensive on " +
    "huge models (two full compiles + per-module attribution), so don't spam it.",
  owner: { kind: "core" },
  inputSchema: { type: "object", properties: {} } satisfies JsonObject,
};

export function makeSnapFloatersTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute() {
      state.step += 1;

      const pending = pendingEditRefusal(state);
      if (pending) return { ok: false, error: pending };

      const report = await snapFloaters({
        scad: state.scad,
        workDir: state.agentCompilesDir,
        log: (l) => console.log(l),
      });
      if (!report.ok) return { ok: false, error: report.note };

      if (report.changed) {
        state.scad = report.scad;
        state.lastGoodScad = report.scad;          // verified by the snap recompile
        state.latestStlPath = report.stlPath ?? state.latestStlPath;
        state.stlIsStale = report.stlPath === undefined;
        state.latestConnectivity = null;           // recomputed on next render
        state.collisionCache = null;
      }

      const skippedLines = report.skipped.map(
        (s) => `  - ${s.module ?? "(unowned)"} (span ${s.spanPct.toFixed(1)}%): ${s.reason}`,
      );
      return {
        ok: true,
        output: {
          text:
            `${report.note}` +
            (report.moves.length
              ? `\nMoves applied:\n${report.moves.map((m) => `  - ${m.module}: [${m.delta.join(", ")}] mm`).join("\n")}`
              : "") +
            (skippedLines.length
              ? `\nNOT fixable by snapping (need geometry edits):\n${skippedLines.join("\n")}`
              : "") +
            (report.changed ? `\nBuffer updated and verified. Re-render before diagnosing.` : ""),
          visible_before: report.visibleBefore,
          visible_after: report.visibleAfter,
          moved: report.moves.map((m) => m.module),
          skipped: report.skipped.map((s) => s.module ?? "(unowned)"),
        },
      };
    },
  };
}
