/**
 * inspect_module tool — list top-level modules and optionally their bboxes.
 *
 * Two modes:
 *   - no `name`: list every top-level module name.
 *   - `name` provided: also compile that one module in isolation and return
 *     its local-space AABB. Useful for sanity-checking proportions before
 *     editing.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { listTopLevelModules, computeModuleBBox } from "../scad/parts.ts";
import type { SessionProceduraState } from "./state.ts";
import { pad } from "./state.ts";

const DESCRIPTOR: ToolDescriptor = {
  name: "inspect_module",
  description:
    "List the top-level modules in the current SCAD, optionally with each module's " +
    "local AABB (size in x/y/z). Pass {name: '...', with_bbox: true} to inspect one " +
    "module's geometry. Pass {} to list all module names. Use this to ground your " +
    "edits in real module names — don't guess.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Optional — inspect only this module (still returns the full list).",
      },
      with_bbox: {
        type: "boolean",
        description:
          "If true, also computes each module's local-space AABB. Slow — one OpenSCAD " +
          "compile per module. Default false.",
      },
    },
  } satisfies JsonObject,
};

export function makeInspectModuleTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute(input) {
      state.step += 1;
      const targetName = input["name"] as string | undefined;
      const withBbox = (input["with_bbox"] as boolean | undefined) ?? false;

      const names = listTopLevelModules(state.scad);

      interface ModInfo { name: string; bbox?: [number, number, number] | null }
      let mods: ModInfo[];
      if (withBbox) {
        const bboxDir = join(state.agentCompilesDir, `step_${pad(state.step)}_bbox`);
        mkdirSync(bboxDir, { recursive: true });
        mods = [];
        for (const name of names) {
          const bbox = await computeModuleBBox(
            state.scad, name, join(bboxDir, name),
          );
          mods.push({ name, bbox });
        }
      } else {
        mods = names.map((name) => ({ name }));
      }

      if (targetName && !names.includes(targetName)) {
        return {
          ok: false,
          error: `Module '${targetName}' not found in current SCAD. ` +
            `Known modules: ${names.join(", ")}`,
        };
      }

      const lines: string[] = [];
      lines.push(`Found ${mods.length} top-level module(s):`);
      for (const m of mods) {
        const here = targetName && m.name === targetName ? " <-- focus" : "";
        if (m.bbox) {
          const [w, d, h] = m.bbox;
          lines.push(
            `  ${m.name}: bbox ${w.toFixed(2)} x ${d.toFixed(2)} x ${h.toFixed(2)}${here}`,
          );
        } else if (withBbox) {
          lines.push(`  ${m.name}: bbox unavailable${here}`);
        } else {
          lines.push(`  ${m.name}${here}`);
        }
      }

      return {
        ok: true,
        output: { text: lines.join("\n"), modules: mods as unknown as JsonObject[] },
      };
    },
  };
}
