/**
 * read_scad tool — line-numbered read of the working SCAD buffer.
 *
 * Mirrors the cat -n format the model is familiar with from Claude Code's
 * Read tool. Default reads the whole file; pass offset/limit for slices.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";
import type { SessionProceduraState } from "./state.ts";

const DESCRIPTOR: ToolDescriptor = {
  name: "read_scad",
  description:
    "Read the current working SCAD as numbered lines (1-indexed). Pass offset/limit " +
    "to read a slice; default returns the whole file. Use this before edit_module " +
    "if you need to see the exact module body you're about to replace.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    properties: {
      offset: { type: "number", description: "Starting line (1-indexed). Default 1." },
      limit: { type: "number", description: "Max lines to return. Default 2000." },
    },
  } satisfies JsonObject,
};

export function makeReadScadTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute(input) {
      const offset = Math.max(1, (input["offset"] as number | undefined) ?? 1);
      const limit = Math.max(1, (input["limit"] as number | undefined) ?? 2000);
      const lines = state.scad.split("\n");
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice
        .map((l, i) => `${(offset + i).toString().padStart(5, " ")}\t${l}`)
        .join("\n");
      const text =
        `Working SCAD — lines ${offset}-${offset + slice.length - 1} of ${lines.length} ` +
        `(${state.scad.length} chars total):\n` + numbered;
      return {
        ok: true,
        output: {
          text,
          start_line: offset,
          end_line: offset + slice.length - 1,
          total_lines: lines.length,
        },
      };
    },
  };
}
