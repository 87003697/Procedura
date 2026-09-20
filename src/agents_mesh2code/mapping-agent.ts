import { applyAutoCache, createLLMClient } from "@harness/template";
import type { CanonicalMessage, CanonicalPart, CanonicalRequest, LLMEvent } from "@harness/template/llm/protocol";
import type { ModelRef, JsonObject } from "@harness/template/types";
import type { RouteDef } from "@harness/template";
import { longTimeoutFetch } from "../llm/long-timeout-fetch.ts";
import { splitThinkTags } from "../llm/think-tags.ts";
import { makeMappingFactsTool, type MappingFactsSource } from "../tools_mesh2code/mapping-facts.ts";
import { buildMappingEvidence, resetMappingEvidenceExposure, type MappingEvidence } from "./mapping-evidence.ts";
import { makeInspectMappingPartTool } from "./mapping-inspect-tool.ts";
import { buildMappingArrowSummaries } from "./mapping-arrow-summary.ts";
import { buildMappingVisionParts, type MappingVisionInput } from "./mapping-vision.ts";

const SYSTEM = [
  "You are a standalone mapping evaluator.",
  "Use semanticPlan descriptions, Blender per-part-color candidate views, aligned GT/candidate comparison views, and bounded part-level arrow summaries. Vision identifies the candidate geometry overlapping a discrepancy; arrow summaries support direction and coherent region merging; bounded mapping evidence supports the final diagnosis. GT has no part provenance, so candidatePartIds are region overlap labels, not claims that every listed part moved.",
  "Each arrow summary aggregates the candidate-to-GT residuals for one candidate part. Treat displacementMm as the correction vector to apply to the candidate: candidate → GT. Never invert its sign or replace it with an ambiguous front/back description. State repairHint with explicit axis deltas when possible. Use direction coherence to down-rank weak residuals and merge adjacent parts with the same direction. When coherence is low or directions conflict, inspect the known part before creating or expanding a region; if the bounded inspection remains incoherent or lacks visual support, do not promote it to a primary region. A displacement is not proof that the owning part moved; use bounded evidence to ground diagnosis and repairHint.",
  "If the initial evidence is insufficient, call inspect_mapping_part with a known partId and evidenceId. Omit radiusMm/depth first to judge the default coarse parent octree region (two levels coarser than finest); use the finest depth or a smaller radius only when that coarse summary remains ambiguous. Continue inspecting known parts as needed; stop when the evidence is sufficient and return the final text diagnosis.",
  "Return at most two region observations as plain text. Use this structure: STATUS: ok|insufficient-evidence, then for each region write REGION N, [modules: ...], [evidence: ...], MAPPING: ..., and FIX: .... status is ok when at least one supported region exists and insufficient-evidence when no region is supported. Output only this diagnosis text with no JSON, Markdown fence, or extra preamble.",
  "If vision and mapping cannot support a region-level conclusion, return insufficient-evidence. Do not claim unsupported source-code locations, raw mesh, or pass/fail authority.",
].join(" ");
const client = createLLMClient({ fetch: longTimeoutFetch, maxAttempts: 1 });

function parseSemanticPlan(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw Error("semantic plan must be a plan.json array");
  const names = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw Error("invalid semantic plan entry");
    const item = entry as JsonObject;
    if (typeof item.name !== "string" || !item.name || names.has(item.name)) throw Error("semantic plan has invalid or duplicate part name");
    names.add(item.name);
    return item;
  });
}

function validatePlanCoverage(partIds: Set<string>, plan: JsonObject[]): void {
  const names = new Set(plan.map((entry) => String(entry.name)));
  const missing = [...partIds].find((partId) => !names.has(partId));
  if (missing) throw Error(`mapping partId not found in plan.json: ${missing}`);
}

function parseToolCalls(events: LLMEvent[]): { text: string; calls: Array<{ id: string; name: string; input: JsonObject }> } {
  const text = events.filter((event) => event.kind === "text-delta").map((event) => event.text).join("");
  const pending = new Map<string, { name: string; args: string; input?: JsonObject }>();
  for (const event of events) {
    if (event.kind === "tool-call-start") pending.set(event.toolCallId, { name: event.toolName, args: "" });
    else if (event.kind === "tool-call-delta") pending.get(event.toolCallId)!.args += event.argDelta;
    else if (event.kind === "tool-call-finish") pending.set(event.toolCallId, { name: pending.get(event.toolCallId)?.name ?? "inspect_mapping_part", args: JSON.stringify(event.input), input: event.input });
  }
  return {
    text,
    calls: [...pending].map(([id, call]) => ({
      id,
      name: call.name,
      input: call.input ?? JSON.parse(call.args || "{}") as JsonObject,
    })),
  };
}

async function generateMappingResponse(args: { route: RouteDef<unknown>; model: ModelRef; system: string; facts: JsonObject; visionParts: CanonicalPart[]; evidence: MappingEvidence; inspectTool: ReturnType<typeof makeInspectMappingPartTool>; signal?: AbortSignal }): Promise<string> {
  resetMappingEvidenceExposure(args.evidence);
  let messages: CanonicalMessage[] = [{ role: "user", content: [{ kind: "text", text: JSON.stringify(args.facts) }, ...args.visionParts] }];
  for (;;) {
    const request: CanonicalRequest = {
      model: args.model,
      system: [{ text: args.system }],
      messages,
      tools: [{ name: args.inspectTool.descriptor.name, description: args.inspectTool.descriptor.description, inputSchema: args.inspectTool.descriptor.inputSchema }],
      toolChoice: "auto",
      ...(args.signal ? { signal: args.signal } : {}),
    };
    applyAutoCache(request, { protocolId: args.route.protocol.id });
    const events = await client.generate(args.route, request);
    const parsed = parseToolCalls(events);
    if (parsed.calls.length === 0) return splitThinkTags(parsed.text).text;
    const assistantParts: CanonicalPart[] = [];
    if (parsed.text) assistantParts.push({ kind: "text", text: parsed.text });
    for (const call of parsed.calls) assistantParts.push({ kind: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input });
    messages = [...messages, { role: "assistant", content: assistantParts }];
    const toolResults: CanonicalPart[] = [];
    for (const call of parsed.calls) {
      try {
        if (call.name !== args.inspectTool.descriptor.name) throw Error(`unknown mapping tool: ${call.name}`);
        const result = await args.inspectTool.execute(call.input, {} as never);
        if (!result.ok) throw Error(result.error);
        toolResults.push({ kind: "tool-result", toolCallId: call.id, toolName: call.name, output: result.output });
      } catch (error) {
        toolResults.push({ kind: "tool-result", toolCallId: call.id, toolName: call.name, output: { error: error instanceof Error ? error.message : String(error) }, isError: true });
      }
    }
    messages = [...messages, { role: "tool", content: toolResults }];
  }
  throw Error("mapping inspection loop ended without a final response");
}

async function readCells(source: MappingFactsSource): Promise<JsonObject[]> {
  const executor = makeMappingFactsTool(source).executor;
  const cells: JsonObject[] = [];
  let cursor = 0;
  do {
    const result = await executor.execute({ cursor, limit: 256 } as JsonObject, {} as never);
    if (!result.ok) throw Error(result.error);
    const page = result.output as JsonObject;
    cells.push(...(page.cells as JsonObject[]));
    cursor = page.nextCursor === null ? -1 : Number(page.nextCursor);
  } while (cursor >= 0);
  return cells;
}

export async function runMappingAgent(args: { source: MappingFactsSource; semanticPlan: unknown; vision: MappingVisionInput; route: RouteDef<unknown>; model: ModelRef; signal?: AbortSignal }): Promise<string> {
  const semanticPlan = parseSemanticPlan(args.semanticPlan);
  const evidence = buildMappingEvidence(await readCells(args.source));
  validatePlanCoverage(evidence.partIds, semanticPlan);
  const inspectTool = makeInspectMappingPartTool(evidence);
  const facts: JsonObject = { semanticPlan, partArrowSummaries: buildMappingArrowSummaries(evidence) };
  const visionParts = await buildMappingVisionParts(args.vision);
  return generateMappingResponse({ route: args.route, model: args.model, system: SYSTEM, facts, visionParts, evidence, inspectTool, signal: args.signal });
}
