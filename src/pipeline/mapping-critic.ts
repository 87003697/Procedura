import type { ModelRef } from "@harness/template/types";
import type { RouteDef } from "@harness/template";

import type { MappingFactsSource } from "../tools_mesh2code/mapping-facts.ts";
import type { MappingVisionInput } from "../agents_mesh2code/mapping-vision.ts";
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

export interface CriticFeedback {
  text: string;
  actionable: boolean;
}

/** Mapping-specific data prepared from the current CAD state. */
export interface MappingCriticInput {
  source: MappingFactsSource;
  semanticPlan: unknown;
  vision: MappingVisionInput;
}

export type MappingCritic = (args: {
  context: MappingCriticContext;
  route: RouteDef<unknown>;
  model: ModelRef;
  signal?: AbortSignal;
}) => Promise<CriticFeedback>;

export type PrepareMappingCriticInput =
  (context: MappingCriticContext) => Promise<MappingCriticInput>;

/**
 * Adapt the text-returning Mapping Agent to the direct refine critic seam.
 * `prepare` must build input from the current cycle and must not reuse a report
 * produced for an earlier CAD buffer.
 */
export function makeMappingCritic(prepare: PrepareMappingCriticInput): MappingCritic {
  return async ({ context, route, model, signal }) => {
    const input = await prepare(context);
    const result = await runMappingAgent({
      ...input,
      route,
      model,
      ...(signal ? { signal } : {}),
    });
    const text = result.trim();
    return { text, actionable: mappingFeedbackHasIssue(text) };
  };
}

/** Keep the direct-refine handoff small: only a supported region can trigger a patch. */
export function mappingFeedbackHasIssue(text: string): boolean {
  return /^\s*STATUS:\s*ok\b/im.test(text) && /^\s*REGION\s+\d+/im.test(text);
}
