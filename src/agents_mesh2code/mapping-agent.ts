import type { CanonicalPart } from "@harness/template/llm/protocol";
import type { ModelRef, JsonObject } from "@harness/template/types";
import type { RouteDef } from "@harness/template";
import { generateOnce } from "../llm/generate.ts";
import { makeMappingFactsTool, type MappingFactsSource } from "../tools_mesh2code/mapping-facts.ts";
import { parseMappingFeedbackArtifact, type MappingFeedbackArtifact } from "./mapping-feedback-schema.ts";
export interface MappingAgentResult { artifact: MappingFeedbackArtifact }
const SYSTEM = "You are a standalone mapping evaluator. Use only supplied mapping facts. Return one schemaVersion 1 feedback artifact with status, issues, and evidence. State candidate to GT world direction. Never expose paths, raw mesh, handles, bytes, materials, textures, targets, or pass/fail authority.";
export async function runMappingAgent(args: { source: MappingFactsSource; route: RouteDef<unknown>; model: ModelRef; signal?: AbortSignal }): Promise<MappingAgentResult> {
  const executor = makeMappingFactsTool(args.source).executor; const cells: JsonObject[] = []; let cursor = 0; let frame: JsonObject | undefined;
  do { const result = await executor.execute({ cursor, limit: 256 } as JsonObject, {} as never); if (!result.ok) throw Error(result.error); const page = result.output as JsonObject; frame = page.frame as JsonObject; cells.push(...(page.cells as JsonObject[])); cursor = page.nextCursor === null ? -1 : Number(page.nextCursor); } while (cursor >= 0);
  const request: CanonicalPart[] = [{ kind: "text", text: JSON.stringify({ frame, cells }) }];
  const response = await generateOnce({ route: args.route, model: args.model, system: SYSTEM, parts: request, signal: args.signal });
  const text = response.text.trim().replace(/^```(?:json)?\\s*/, "").replace(/\\s*```$/, "");
  return { artifact: parseMappingFeedbackArtifact(text) };
}
