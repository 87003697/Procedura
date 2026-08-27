/**
 * compile tool — re-compile the current working SCAD to verify it parses.
 *
 * Optionally accepts a candidate `scad` body to test (without committing
 * it to the working buffer). When `scad` is omitted, compiles state.scad.
 * On success, refreshes state.latestStlPath and clears stlIsStale.
 */

import { join } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { compileScad } from "../scad/compile.ts";
import { loadSTL, computeBBox } from "../mesh/stl.ts";
import type { SessionProceduraState } from "./state.ts";
import { ensureConnectivity } from "./connectivity-cache.ts";
import { pad } from "./state.ts";

const DESCRIPTOR: ToolDescriptor = {
  name: "compile",
  description:
    "Compile the current SCAD to STL and report whether it parses, the resulting " +
    "STL size, and the world-space bbox. Use this after every edit to confirm " +
    "your change didn't break the build. You can also " +
    "pass a candidate `scad` body to dry-run a change without committing it.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    properties: {
      scad: {
        type: "string",
        description:
          "Optional candidate SCAD source to compile instead of the working buffer. " +
          "Pass this to dry-run a fix before writing it.",
      },
    },
  } satisfies JsonObject,
};

export function makeCompileTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute(input) {
      state.step += 1;
      // Treat an empty/whitespace candidate as "compile the working buffer".
      // GPT-5.6 calls compile({scad: ""}) meaning exactly that, and v3 turned
      // each one into a hard "no output STL" failure — 13 of assault_buggy's 24
      // tool calls burned on this, which is why its pending edit was never
      // compiled and the whole run ended with 0 accepted edits.
      const candidateRaw = input["scad"] as string | undefined;
      const candidate =
        typeof candidateRaw === "string" && candidateRaw.trim().length > 0
          ? candidateRaw
          : undefined;
      const code = candidate ?? state.scad;

      const dir = join(state.agentCompilesDir, `step_${pad(state.step)}_compile`);
      mkdirSync(dir, { recursive: true });

      try {
        const r = await compileScad(code, { outputDir: dir });
        const sizeKb = Math.floor(statSync(r.stlPath).size / 1024);
        let bbox: [number, number, number] | null = null;
        let connSummary = "";
        let floaterCount = 0;
        let floaterFrac = 0;
        let visibleFloaters = 0;
        try {
          const mesh = loadSTL(r.stlPath);
          if (mesh.triCount > 0) bbox = computeBBox(mesh).size;
        } catch { /* tolerate */ }
        if (candidate === undefined) {
          state.latestStlPath = r.stlPath;
          state.stlIsStale = false;
          // TRUE connectivity (union-wrapped recompile, memoized per buffer).
          // The artifact STL above is a lazy-union shell dump — analyzing IT is
          // how "77 floaters" got reported on models whose parts overlap fine.
          // Candidate dry-runs skip this deliberately: it costs a full compile,
          // and 00001198 once burned 25 candidate compiles in one run.
          const entry = await ensureConnectivity(state);
          if (entry) {
            connSummary = entry.summary;
            floaterCount = entry.conn.floaterCount;
            floaterFrac = entry.conn.floaterVolumeFraction;
            visibleFloaters = entry.visibleFloaters;
          }
          // This buffer compiled → remember it as the last-known-good, so a
          // later broken edit can be reverted from at final-write time.
          state.lastGoodScad = state.scad;
        }
        const bboxStr = bbox
          ? `${bbox[0].toFixed(2)} x ${bbox[1].toFixed(2)} x ${bbox[2].toFixed(2)}`
          : "unknown";
        const hint = visibleFloaters > 0
          ? `\nHint: ${visibleFloaters} VISIBLE floater(s) — call check_connectivity for ` +
            `each one's span% + bbox + position, then use edit_module to overlap / strut ` +
            `the offending part. finish(verdict="ok") is REFUSED while any floater is visible.`
          : (floaterCount > 0
            ? `\nNote: ${floaterCount} sub-visible speck(s) (all < 1% of model span) — tolerated.`
            : "");
        const text =
          `Compile OK — STL ${sizeKb} KB, bbox ${bboxStr}. ${connSummary}` +
          `${hint}\nSTL: ${r.stlPath}`;
        return {
          ok: true,
          output: {
            text, stl_path: r.stlPath, size_kb: sizeKb, bbox,
            floater_count: floaterCount, floater_volume_fraction: floaterFrac,
            visible_floater_count: visibleFloaters,
          },
        };
      } catch (e) {
        return {
          ok: false,
          error: `Compile FAILED: ${(e as Error).message}`,
        };
      }
    },
  };
}
