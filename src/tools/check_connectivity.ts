/**
 * check_connectivity tool — detailed floater breakdown of the latest STL.
 *
 * compile already prints a one-line connectivity summary. This tool is for
 * when that summary flags floaters and the agent wants per-component
 * triangle counts, volumes, and bboxes so it can find which part isn't
 * touching the host body.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { join } from "node:path";

import { loadSTL } from "../mesh/stl.ts";
import { formatConnectivityDetail } from "../mesh/connectivity.ts";
import { ensureConnectivity } from "./connectivity-cache.ts";
import { attributeFloaters, formatAttribution, type FloaterAttribution } from "../mesh/floater-attribution.ts";
import type { SessionProceduraState } from "./state.ts";

const DESCRIPTOR: ToolDescriptor = {
  name: "check_connectivity",
  description:
    "Per-component breakdown of the latest compiled STL — finds floaters " +
    "(disconnected sub-bodies) and reports each one's triangle count, " +
    "volume, and bbox. For every VISIBLE floater it also NAMES THE MODULE " +
    "that produced it (matched by compiling each module at its placement), so " +
    "you can edit_module the real offender directly instead of guessing from a " +
    "bbox. Use this when compile reports floaters, or when a render shows a " +
    "visible gap between two parts. Catches floaters too small to see in the " +
    "640px renders.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    properties: {},
  } satisfies JsonObject,
};

export function makeCheckConnectivityTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute() {
      state.step += 1;
      if (state.stlIsStale) {
        return {
          ok: false,
          error:
            "Working SCAD has been edited but not yet recompiled — the latest STL " +
            "is stale. Call compile first, then check_connectivity.",
        };
      }
      if (!state.latestStlPath) {
        return {
          ok: false,
          error: "No compiled STL yet. Call compile or render_views first.",
        };
      }
      // TRUE connectivity (union-wrapped compile via the per-buffer cache) —
      // the artifact STL is a lazy-union shell dump and would report every
      // properly-overlapping part as a "floater".
      const entry = await ensureConnectivity(state);
      if (!entry) {
        return {
          ok: false,
          error: "Connectivity analysis failed for the current buffer (union compile).",
        };
      }
      const r = entry.conn;
      let text = formatConnectivityDetail(r);

      // Attribute each floater to the SCAD module that produced it so the agent
      // can edit_module the real offender instead of guessing from a bbox.
      // Best-effort: an attribution failure never breaks the connectivity report.
      let floaterModules: FloaterAttribution[] = [];
      if (r.floaterCount > 0) {
        try {
          floaterModules = await attributeFloaters(
            state.scad, r, join(state.agentCompilesDir, "floater_attr"),
          );
          text += formatAttribution(floaterModules);
        } catch { /* attribution is advisory only */ }
      }

      return {
        ok: true,
        output: {
          text,
          floater_modules: floaterModules.map((a) => ({
            rank: a.rank, span_fraction: a.spanFraction,
            module: a.module, confidence: a.confidence, also_overlaps: a.alsoOverlaps,
          })) as unknown as JsonObject[],
          component_count: r.components.length,
          floater_count: r.floaterCount,
          visible_floater_count: r.visibleFloaterCount,
          max_floater_span_fraction: r.maxFloaterSpanFraction,
          model_span: r.modelSpan,
          floater_volume_fraction: r.floaterVolumeFraction,
          total_volume: r.totalVolume,
          total_triangles: r.totalTris,
          // Compact per-component list for any downstream agent that wants it.
          components: r.components.map((c) => ({
            tri_count: c.triCount,
            volume: c.volume,
            span_fraction: c.spanFraction,
            bbox_size: c.bbox.size,
            bbox_min: c.bbox.min,
            bbox_max: c.bbox.max,
          })) as unknown as JsonObject[],
        },
      };
    },
  };
}
