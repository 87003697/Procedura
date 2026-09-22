import type { ModelRef } from "@harness/template/types";
import type { CanonicalPart } from "@harness/template/llm/protocol";
import type { RouteDef } from "@harness/template";

import type { MappingFactsSource } from "../tools_mesh2code/mapping-facts.ts";
import type { MappingVisionInput } from "../agents_mesh2code/mapping-vision.ts";
import type { GenerateResult } from "../llm/generate.ts";
import { runMappingAgent } from "../agents_mesh2code/mapping-agent.ts";

export interface MappingCriticView {
  label: string;
  path: string;
}

/** The committed CAD state and renders reviewed by one Mapping critic call. */
export interface MappingCriticContext {
  cycle: number;
  workspaceDir: string;
  stepDir: string;
  scad: string;
  stlPath: string;
  views: readonly MappingCriticView[];
  partsColorLegend: string;
}

/** Mapping-specific data prepared from the current CAD state. */
export interface MappingCriticInput {
  source: MappingFactsSource;
  semanticPlan: unknown;
  vision: MappingVisionInput;
}

export type MappingCritic = (args: {
  context: MappingCriticContext;
  /** Same multimodal input supplied to the visual critic this cycle. */
  parts: CanonicalPart[];
  route: RouteDef<unknown>;
  model: ModelRef;
  label?: string;
  signal?: AbortSignal;
}) => Promise<GenerateResult>;

export type PrepareMappingCriticInput =
  (context: MappingCriticContext) => Promise<MappingCriticInput>;

/**
 * Adapt the text-returning Mapping Agent to the direct refine critic seam.
 * `prepare` must build input from the current cycle and must not reuse a report
 * produced for an earlier CAD buffer.
 */
export function makeMappingCritic(prepare: PrepareMappingCriticInput): MappingCritic {
  return async ({ context, parts, route, model, signal }) => {
    const input = await prepare(context);
    const vision = {
      ...input.vision,
      ...(input.vision.criticParts === undefined
        ? { criticParts: parts }
        : {}),
    };
    const result = await runMappingAgent({
      ...input,
      vision,
      route,
      model,
      ...(signal ? { signal } : {}),
    });
    return { ...result, text: result.text.trim() };
  };
}
