import type { JsonObject } from "@harness/template/types";
import type { ToolDescriptor, ToolExecutor, ToolResult } from "@harness/template/tool";
export interface MappingFactsSource { report: unknown; input: unknown }
export interface MappingFactsTool { descriptor: ToolDescriptor; executor: ToolExecutor }
const descriptor: ToolDescriptor = { name: "mapping_facts", description: "Read bounded finest-depth mapping cells; compute conclusions yourself.", owner: { kind: "core" }, inputSchema: { type: "object", additionalProperties: false, properties: { cursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 256 } } } satisfies JsonObject };
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(label); return value as Record<string, unknown>; }
function number(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw Error(label); return value; }
function center(min: number[], side: number, depth: number, prefix: number): number[] { const xyz = [0, 0, 0]; for (let shift = depth - 1; shift >= 0; shift--) { const child = (prefix >> (3 * shift)) & 7; for (let axis = 0; axis < 3; axis++) xyz[axis] = (xyz[axis]! << 1) | ((child >> (2 - axis)) & 1); } const size = side / 2 ** depth; return xyz.map((value, axis) => min[axis]! + (value + 0.5) * size); }
export function makeMappingFactsTool(source: MappingFactsSource, maxCells = 10000): MappingFactsTool {
  if (!Number.isInteger(maxCells) || maxCells < 1) throw Error("invalid cell budget");
  const input = record(source.input, "invalid input"); const inputFrame = record(input.frame, "invalid input frame"); const report = record(source.report, "invalid report");
  if (Object.keys(input).some((key) => !["candidate", "frame", "gt", "schema"].includes(key)) || Object.keys(inputFrame).some((key) => !["maxDepth", "minMm", "sideMm"].includes(key)) || Object.keys(report).some((key) => !["frame", "levels", "schema", "solver", "runtime"].includes(key))) throw Error("unknown mapping field");
  if (input.schema !== "procedura.octree-mapping-input/2" || report.schema !== "procedura.octree-mapping-report/3") throw Error("unsupported mapping schema");
  const min = inputFrame.minMm; const side = number(inputFrame.sideMm, "sideMm"); const maxDepth = number(inputFrame.maxDepth, "maxDepth");
  if (!Array.isArray(min) || min.length !== 3 || min.some((value) => typeof value !== "number" || !Number.isFinite(value)) || side <= 0 || !Number.isInteger(maxDepth)) throw Error("invalid mapping frame");
  const levels = report.levels; if (!Array.isArray(levels) || !levels.length) throw Error("mapping has no levels");
  const level = levels.find((value) => { const item = record(value, "invalid level"); const summary = record(item.summary, "invalid summary"); return number(summary.depth, "depth") === maxDepth; });
  if (!level) throw Error("finest level missing"); const cells = record(level, "invalid level").candidateCells;
  if (!Array.isArray(cells) || cells.length > maxCells) throw Error("mapping cell budget exceeded");
  const executor: ToolExecutor = { descriptor, async execute(raw: JsonObject): Promise<ToolResult> { try {
    const query = record(raw, "invalid query"); if (Object.keys(query).some((key) => !["cursor", "limit"].includes(key))) throw Error("unknown query field"); const cursor = query.cursor === undefined ? 0 : number(query.cursor, "cursor"); const limit = query.limit === undefined ? 128 : number(query.limit, "limit");
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) throw Error("invalid pagination");
    const page = cells.slice(cursor, cursor + limit).map((value) => { const item = record(value, "invalid cell"); const prefix = number(item.prefix, "prefix"); if (!Number.isInteger(prefix)) throw Error("invalid prefix"); return { depth: maxDepth, prefix, locationMm: center(min as number[], side, maxDepth, prefix), displacementMm: item.displacementMm === undefined ? null : item.displacementMm, spreadCells: item.spreadCells === undefined ? null : item.spreadCells, sourceMarginalRatio: number(item.sourceMarginalRatio, "ratio"), mass: number(item.mass, "mass") } as JsonObject; });
    return { ok: true, output: { frame: { minMm: min, sideMm: side, maxDepth }, cells: page, nextCursor: cursor + page.length < cells.length ? cursor + page.length : null } as JsonObject };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "invalid query" }; } } };
  return { descriptor, executor };
}
