import { applyAutoCache, createLLMClient } from "@harness/template";
import type { CanonicalMessage, CanonicalPart, CanonicalRequest, LLMEvent } from "@harness/template/llm/protocol";
import type { ModelRef, JsonObject } from "@harness/template/types";
import type { RouteDef } from "@harness/template";
import { longTimeoutFetch } from "../llm/long-timeout-fetch.ts";
import { splitThinkTags } from "../llm/think-tags.ts";
import { makeMappingFactsTool, type MappingFactsSource } from "../tools_mesh2code/mapping-facts.ts";
import { buildMappingEvidence, resetMappingEvidenceExposure, type MappingEvidence } from "./mapping-evidence.ts";
import { makeInspectMappingPartTool } from "./mapping-inspect-tool.ts";
import { buildMappingVisionParts, type MappingVisionInput } from "./mapping-vision.ts";
import type { GenerateResult } from "../llm/generate.ts";

const SYSTEM = [
  "You are a standalone mapping evaluator.",
  "Use the complete visual-critic context, semanticPlan descriptions, aligned GT/candidate comparison views, and the bounded per-part cell evidence. The visual context contains the target views, current candidate views, and complete current SCAD source; use it to connect a geometric discrepancy to the actual module and placement expressions. GT has no part provenance, so candidate part ids are region-overlap labels, not claims that every listed part moved.",
  "Treat displacementMm as the correction vector in the mapping frame, candidate → GT. Never invert its sign or replace it with an ambiguous front/back description. The initial facts contain representative cell locations and vectors; preserve their spatial pattern instead of replacing it with a single module-average arrow. A displacement is not proof that the owning part moved: use coherent evidence and the SCAD source before naming a shared parameter or placement expression.",
  "Before writing each issue, classify the supported source-level cause as one of: local-module geometry, shared parameter, parent placement, cumulative downstream placement, or unresolved. If residual magnitude or direction changes progressively along a connected module sequence and the SCAD source shows downstream placements depending on a common angle, length, datum, or ancestor expression, classify it as cumulative downstream placement. In that case identify the shared parameter or placement expression that should be changed and describe one structural repair strategy. The per-cell vectors are evidence for that strategy, not a list of independent edits.",
  "Do not fit or assume a rigid translation, rotation, affine transform, or cumulative-drift model as the repair. A cumulative downstream placement diagnosis is allowed only when the observed spatial pattern and SCAD dependency support it. Do not recommend independent translate() compensation for every affected module when a shared source expression explains the pattern. If no shared source construct is supported, state the affected region and leave the source-level cause unresolved.",
  "Mapping-frame displacement values are not automatically raw SCAD coordinates. Do not copy them into a PLACE block or present them as direct per-module patch values unless the visual context or mapping facts provide the conversion and the source-level cause is local. For shared or cumulative errors, report the range and trend as evidence, then prioritize the shared angle, length, datum, or parent placement instead of emitting one translate correction per module.",
  "If the initial evidence is insufficient, call inspect_mapping_part with a known partId and evidenceId. Omit radiusMm/depth first to judge the default coarse parent octree region (two levels coarser than finest); use the finest depth or a smaller radius only when that coarse summary remains ambiguous. Continue inspecting known parts as needed; stop when the evidence is sufficient and return the final text diagnosis.",
  "Return at most two supported mapping issues as plain text using the same diagnosis format as the visual critic. Order issues from most important to least important and give each a short stable snake_case name. Use: SUMMARY: <one-line verdict>, then ISSUES:, then numbered entries of the form `1. <issue_name> [HIGH|MED|LOW] [modules: ...] PROBLEM: <concrete mapped discrepancy>. EVIDENCE: <supported evidence>. CAUSE: <local-module|shared-parameter|parent-placement|cumulative-downstream-placement|unresolved>. TARGET: <exact supported SCAD parameter, placement expression, or module dependency to inspect/change; use unresolved when the source does not support a name>. CONSTRAINTS: <must-preserve or must-avoid condition, or none>. FIX: <candidate→GT direction and affected region; for shared or cumulative errors describe the trend/range, not independent per-module translate values>.` If no region is supported, return `SUMMARY: no supported mapping issue` followed by `ISSUES: (none — mapping evidence is insufficient for a grounded region-level correction)`. Output only this diagnosis text with no JSON, Markdown fence, STATUS/REGION wrapper, or extra preamble.",
  "Use [HIGH] for a supported wrong placement, wrong orientation, or disconnected region that materially affects the model; use [MED] for a smaller but actionable localized residual; use [LOW] only for a minor residual that should not drive a repair by itself. Severity labels the issue, while issue order determines repair priority. Every issue must name the candidate module(s) from the semantic plan and preserve the candidate→GT sign convention in FIX. Do not claim unsupported source-code locations, raw mesh, or pass/fail authority. Do not name a shared parameter unless the complete SCAD source visibly supports that dependency.",
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

function parseToolCalls(events: LLMEvent[]): { text: string; reasoning: string; calls: Array<{ id: string; name: string; input: JsonObject }> } {
  const text = events.filter((event) => event.kind === "text-delta").map((event) => event.text).join("");
  const reasoning = events.filter((event) => event.kind === "thinking-delta").map((event) => event.text).join("");
  const pending = new Map<string, { name: string; args: string; input?: JsonObject }>();
  for (const event of events) {
    if (event.kind === "tool-call-start") pending.set(event.toolCallId, { name: event.toolName, args: "" });
    else if (event.kind === "tool-call-delta") pending.get(event.toolCallId)!.args += event.argDelta;
    else if (event.kind === "tool-call-finish") pending.set(event.toolCallId, { name: pending.get(event.toolCallId)?.name ?? "inspect_mapping_part", args: JSON.stringify(event.input), input: event.input });
  }
  return {
    text,
    reasoning,
    calls: [...pending].map(([id, call]) => ({
      id,
      name: call.name,
      input: call.input ?? JSON.parse(call.args || "{}") as JsonObject,
    })),
  };
}

async function generateMappingResponse(args: { route: RouteDef<unknown>; model: ModelRef; system: string; facts: JsonObject; visionParts: CanonicalPart[]; evidence: MappingEvidence; inspectTool: ReturnType<typeof makeInspectMappingPartTool>; signal?: AbortSignal }): Promise<GenerateResult> {
  resetMappingEvidenceExposure(args.evidence);
  let messages: CanonicalMessage[] = [{ role: "user", content: [{ kind: "text", text: JSON.stringify(args.facts) }, ...args.visionParts] }];
  let reasoning = "";
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
    reasoning += parsed.reasoning;
    if (parsed.calls.length === 0) {
      const split = splitThinkTags(parsed.text);
      return {
        text: split.text,
        reasoning: reasoning + (split.think ? (reasoning ? "\n\n" : "") + split.think : ""),
      };
    }
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

export async function runMappingAgent(args: { source: MappingFactsSource; semanticPlan: unknown; vision: MappingVisionInput; route: RouteDef<unknown>; model: ModelRef; signal?: AbortSignal }): Promise<GenerateResult> {
  const semanticPlan = parseSemanticPlan(args.semanticPlan);
  const evidence = buildMappingEvidence(await readCells(args.source));
  validatePlanCoverage(evidence.partIds, semanticPlan);
  const inspectTool = makeInspectMappingPartTool(evidence);
  const input = args.source.input as JsonObject;
  const facts: JsonObject = {
    mappingFrame: input.frame ?? null,
    semanticPlan,
    partEvidence: evidence.parts,
  };
  const visionParts = await buildMappingVisionParts(args.vision);
  return generateMappingResponse({ route: args.route, model: args.model, system: SYSTEM, facts, visionParts, evidence, inspectTool, signal: args.signal });
}
