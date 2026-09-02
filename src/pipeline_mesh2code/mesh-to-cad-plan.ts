import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Buffer } from "node:buffer";

import type { CanonicalPart } from "@harness/template/llm/protocol";

import { DEFAULT_MODEL, resolveModel } from "../config/models.ts";
import { generateOnce } from "../llm/generate.ts";
import { routeForModel } from "../llm/routes.ts";
import {
  DEFAULT_MAX_PARTS,
  DEFAULT_PLAN_REVIEW_ITERS,
  PLAN_MAX_ATTEMPTS,
  mergeReviewedPlan,
  parsePlanJson,
  parsePlanReview,
  type PartPlanItem,
} from "../pipeline/draft-incremental.ts";
import {
  importReferenceRun,
  type ImportReferenceRunResult,
} from "./mesh-to-cad-reference.ts";
import { ReferenceAuthority } from "../reference/authority.ts";
import { ALL_VIEW_NAMES, type ViewName } from "../render/views.ts";

const PROCEDURA_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const PLAN_SYSTEM = readFileSync(join(PROCEDURA_ROOT, "prompts", "plan_system.md"), "utf8");
const PLAN_REVIEW_SYSTEM = readFileSync(join(PROCEDURA_ROOT, "prompts", "plan_review_system.md"), "utf8");
const DEFAULT_REFERENCE_VIEWS = ["isometric"] as const;

export interface PlanReferenceRunResult extends ImportReferenceRunResult {
  plan: PartPlanItem[];
  referenceImages: Array<{ view: ViewName; path: string }>;
}

export interface PlanReferenceRunOpts {
  outputDir: string;
  meshPath: string;
  referenceRoot?: string;
  runsRoot?: string;
  maxParts?: number;
  /** Ordered render views. The first view is the authoritative image.png. */
  referenceViews?: readonly ViewName[];
}

async function generate(
  system: string,
  text: string,
  images: readonly { view: ViewName; bytes: Uint8Array }[],
): Promise<string> {
  const model = resolveModel(DEFAULT_MODEL);
  const parts: CanonicalPart[] = [{ kind: "text", text }];
  images.forEach((image, index) => {
    parts.push({
      kind: "text",
      text: index === 0
        ? `View 1 (${image.view}, primary):`
        : `View ${index + 1} (${image.view}, supplementary):`,
    });
    parts.push({
      kind: "image",
      data: Buffer.from(image.bytes).toString("base64"),
      mimeType: "image/png",
    });
  });
  const result = await generateOnce({
    route: routeForModel(DEFAULT_MODEL),
    model,
    system,
    parts,
  });
  return result.text;
}

export async function planReferenceRun(opts: PlanReferenceRunOpts): Promise<PlanReferenceRunResult> {
  const imported = await importReferenceRun(opts);
  const runsRoot = resolve(
    opts.runsRoot ?? process.env["PROCEDURA_OUTPUTS_ROOT"] ?? join(PROCEDURA_ROOT, "outputs"),
  );
  const configuredRoot = opts.referenceRoot ?? process.env["PROCEDURA_REFERENCE_ROOT"];
  if (!configuredRoot) throw new Error("Mesh-to-CAD requires --reference-root or PROCEDURA_REFERENCE_ROOT");
  const authority = new ReferenceAuthority(resolve(configuredRoot), [runsRoot, PROCEDURA_ROOT]);
  for (const view of ALL_VIEW_NAMES) {
    rmSync(join(imported.outputDir, `image-${view}.png`), { force: true });
  }
  const images = await authority.renderReferenceImages(
    imported.reference.handle,
    opts.referenceViews ?? DEFAULT_REFERENCE_VIEWS,
  );
  const referenceImages = images.map((image, index) => {
    const path = join(
      imported.outputDir,
      index === 0 ? "image.png" : `image-${image.view}.png`,
    );
    writeFileSync(path, image.bytes);
    return { view: image.view, path };
  });

  const summary = JSON.stringify(imported.summary);
  const planPrompt =
    "Object to decompose:\n\n" +
    "=== TEXT DESCRIPTION ===\nNo text description was provided. Use the reference views.\n\n" +
    `=== HOST GEOMETRY SUMMARY ===\n${summary}\n\n` +
    "=== REFERENCE VIEWS ===\nView 1 is authoritative; later views are supplementary.\n\n";

  let plan: PartPlanItem[] = [];
  let parseError = "unparseable response";
  for (let attempt = 1; attempt <= PLAN_MAX_ATTEMPTS; attempt++) {
    const retryNote = attempt > 1
      ? `Your previous reply could not be parsed (${parseError}). `
      : "";
    const response = await generate(
      PLAN_SYSTEM,
      planPrompt + retryNote + "Produce the ordered JSON build plan now. Return ONLY the JSON array.",
      images,
    );
    try {
      plan = parsePlanJson(response, opts.maxParts ?? DEFAULT_MAX_PARTS);
      break;
    } catch (error) {
      parseError = (error as Error).message;
    }
  }
  if (plan.length === 0) throw new Error(`planning failed: ${parseError}`);

  for (let iteration = 0; iteration < DEFAULT_PLAN_REVIEW_ITERS; iteration++) {
    const listed = plan
      .map((part, index) => `${index + 1}. ${part.name} (${part.level ?? "L?"}): ${part.description}`)
      .join("\n");
    const reviewPrompt =
      "Review this build plan against the reference views and text. " +
      "ADD-AND-SHARPEN ONLY: add genuinely missing parts and sharpen vague " +
      "descriptions — never merge, remove, rename, or reorder the planned " +
      "parts, and keep the planner's left/right assignments.\n\n" +
      "=== TEXT DESCRIPTION ===\nNo text description was provided. Use the reference views.\n\n" +
      `=== HOST GEOMETRY SUMMARY ===\n${summary}\n\n` +
      `=== CURRENT PLAN (${plan.length} parts) ===\n${listed}\n\n` +
      "Return ONLY the JSON object {ok, notes, plan}.";
    try {
      const review = parsePlanReview(
        await generate(PLAN_REVIEW_SYSTEM, reviewPrompt, images),
        opts.maxParts ?? DEFAULT_MAX_PARTS,
      );
      if (!review) break;
      if (review.plan) plan = mergeReviewedPlan(plan, review.plan).plan;
      if (review.ok) break;
    } catch {
      break;
    }
  }

  writeFileSync(join(imported.outputDir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");
  return { ...imported, plan, referenceImages };
}
