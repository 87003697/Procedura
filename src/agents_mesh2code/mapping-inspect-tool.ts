import type { JsonObject } from "@harness/template/types";
import type { ToolDescriptor, ToolExecutor, ToolResult } from "@harness/template/tool";
import { inspectMappingPart, type MappingEvidence } from "./mapping-evidence.ts";

const descriptor: ToolDescriptor = {
  name: "inspect_mapping_part",
  description: "Inspect a known candidate part at its coarse parent octree region by default; provide depth=maxDepth or radiusMm for finer local detail, and provide an evidenceId when setting radiusMm. Use localSummary and neighborParts to verify a region, not to discover unrelated part defects; nearby evidence can reflect transport spillover.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      partId: { type: "string" },
      evidenceId: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 8 },
      radiusMm: { type: "number", exclusiveMinimum: 0, maximum: 0.25 },
      depth: { type: "integer", minimum: 3, maximum: 6 },
    },
    required: ["partId"],
  } satisfies JsonObject,
};

function validateInput(input: JsonObject): { partId: string; evidenceId?: string; limit: number; radiusMm?: number; depth?: number } {
  if (Object.keys(input).some((key) => !["partId", "evidenceId", "limit", "radiusMm", "depth"].includes(key))) throw Error("unknown inspect_mapping_part argument");
  if (typeof input.partId !== "string" || !input.partId) throw Error("inspect_mapping_part requires partId");
  if (input.evidenceId !== undefined && (typeof input.evidenceId !== "string" || !input.evidenceId)) throw Error("invalid inspect_mapping_part evidenceId");
  const limit = input.limit === undefined ? 8 : input.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 8) throw Error("invalid inspect_mapping_part limit");
  if (input.radiusMm !== undefined && (typeof input.radiusMm !== "number" || !Number.isFinite(input.radiusMm) || input.radiusMm <= 0)) throw Error("invalid inspect_mapping_part radiusMm");
  if (input.radiusMm !== undefined && input.radiusMm > 0.25) throw Error("inspect_mapping_part radiusMm exceeds 0.25");
  if (input.radiusMm !== undefined && input.evidenceId === undefined) throw Error("inspect_mapping_part radiusMm requires evidenceId");
  if (input.depth !== undefined && (typeof input.depth !== "number" || !Number.isInteger(input.depth) || input.depth < 3 || input.depth > 6)) throw Error("invalid inspect_mapping_part depth");
  return { partId: input.partId, ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}), limit, ...(input.radiusMm !== undefined ? { radiusMm: input.radiusMm } : {}), ...(input.depth !== undefined ? { depth: input.depth } : {}) };
}

export function makeInspectMappingPartTool(evidence: MappingEvidence): ToolExecutor {
  return {
    descriptor,
    async execute(raw: JsonObject): Promise<ToolResult> {
      try {
        const input = validateInput(raw);
        return { ok: true, output: inspectMappingPart(evidence, input.partId, input.evidenceId, input.limit, input.radiusMm, input.depth) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
