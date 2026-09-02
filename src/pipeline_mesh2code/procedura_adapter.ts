import { runProcedura, type RunProceduraResult } from "../pipeline/procedura.ts";

/** Inputs owned by the Mesh-to-CAD host when invoking the Procedura pipeline. */
export interface MeshToCadProceduraOpts {
  outputDir: string;
  planPath: string;
  planText: string;
  referenceImages: readonly { label: string; path: string }[];
  refine: boolean;
}

/**
 * Run the Mesh-to-CAD build through the existing Procedura implementation.
 *
 * These settings are deliberately kept here: incremental drafting, direct
 * refine, and open-loop promotion are Mesh-to-CAD integration choices, not
 * defaults for ordinary Procedura callers.
 */
export function runMeshToCadProcedura(
  opts: MeshToCadProceduraOpts,
): Promise<RunProceduraResult> {
  return runProcedura({
    text: "Generate editable CAD from this host-produced plan:\n\n" + opts.planText,
    outputDir: opts.outputDir,
    incremental: true,
    externalExecution: {
      inputImages: opts.referenceImages,
      inputPlan: opts.planPath,
      refineMode: "direct",
      draftPromotion: "open-loop",
    },
    redo: true,
    refine: opts.refine,
  });
}
