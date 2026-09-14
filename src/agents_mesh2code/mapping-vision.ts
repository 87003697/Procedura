import { readFile } from "node:fs/promises";
import type { CanonicalPart } from "@harness/template/llm/protocol";

export type MappingVisionViewName = "front" | "top" | "right";

export interface MappingVisionView {
  name: MappingVisionViewName;
  partColorPath: string;
  comparisonPath: string;
}

export interface MappingVisionInput {
  legend: string;
  views: readonly MappingVisionView[];
}

const VIEW_ORDER: readonly MappingVisionViewName[] = ["front", "top", "right"];

export async function buildMappingVisionParts(input: MappingVisionInput): Promise<CanonicalPart[]> {
  if (!input.legend.trim()) throw Error("mapping vision legend is required");
  if (input.views.length !== VIEW_ORDER.length) throw Error("mapping vision requires front, top, and right views");
  const views = [...input.views].sort((a, b) => VIEW_ORDER.indexOf(a.name) - VIEW_ORDER.indexOf(b.name));
  if (views.some((view, index) => view.name !== VIEW_ORDER[index])) throw Error("mapping vision views must be unique front, top, and right");
  const parts: CanonicalPart[] = [{
    kind: "text",
    text: "VISION INPUT: Blender per-part-color candidate render plus aligned GT/candidate comparison. Candidate colors identify overlapping candidate geometry; comparison views show visible discrepancy. This is identity and silhouette evidence, not millimetre measurement. Part-color legend:\n" + input.legend,
  }];
  for (const view of views) {
    parts.push({ kind: "text", text: `Blender per-part-color candidate view: ${view.name}` });
    parts.push({ kind: "image", data: (await readFile(view.partColorPath)).toString("base64"), mimeType: "image/png" });
    parts.push({ kind: "text", text: `Aligned GT/candidate comparison view: ${view.name}` });
    parts.push({ kind: "image", data: (await readFile(view.comparisonPath)).toString("base64"), mimeType: "image/png" });
  }
  return parts;
}
