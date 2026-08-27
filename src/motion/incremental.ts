// Shared contract between the incremental draft loop (producer) and the
// motion export pipeline (consumer): per-part articulation metadata declared
// during planning/generation, then validated against measured geometry.
//
// Trust model: `declared` fields are categorical LLM output (soft priors,
// never coordinates); `measured` fields come from deterministic mesh analysis
// of the as-built assembly (world/assembly frame) and always win when the two
// disagree. The sidecar is a prior for the motion planner — a run without it,
// or with stale records, must behave exactly like today's pipeline.

import { join } from "node:path";
import type { BBox } from "../mesh/stl";
import { sanitizeIdentifier } from "../scad/parts";
import type { MotionAxis } from "./types";

export type Vec3 = [number, number, number];

export type MotionJointKind = "fixed" | "revolute" | "prismatic" | "spherical";

/** Categorical hint for joint travel; mapped to numeric limits at seed time. */
export type MotionLimitHint = "continuous" | "small" | "medium" | "wide";

export type WorldAxis = MotionAxis;

/** Plan-level articulation intent (soft prior, categorical only). */
export interface PartMotionPlan {
  moving: boolean;
  jointType?: MotionJointKind;
  /** Plan name of the earlier part this one moves relative to. */
  parent?: string;
  /** Intended world axis of the joint after placement. */
  axis?: WorldAxis;
  /** Short semantic role, e.g. "wheel", "turret_yaw", "hinge_door". */
  role?: string;
  limitHint?: MotionLimitHint;
}

/** Optional gen-stage refinement parsed from the `// MOTION` block. */
export type GenMotionHint = Partial<PartMotionPlan> & {
  /** Freeform words locating the pivot ("axle bore at hub center") — never numbers. */
  anchorHint?: string;
};

export type MeasuredBBox = BBox;

/** Rotational-symmetry evidence for the placed instance, world frame. */
export interface MeasuredSymmetryAxis {
  axisPoint: Vec3;
  axisDir: Vec3;
  snappedAxis: WorldAxis | null;
  score: number;
  confidence: "high" | "medium" | "low";
}

/** Contact evidence between the part and its declared parent, world frame. */
export interface MeasuredParentContact {
  /** placedName of the parent whose mesh was used. */
  parent: string;
  anchor: Vec3;
  extent: Vec3;
  principalDir: Vec3 | null;
  snappedAxis: WorldAxis | null;
  elongation: number;
  sampleCount: number;
}

export interface PartMotionRecord {
  /** Name from plan.json. */
  planName: string;
  /** Module name actually placed (after any collision rename). */
  placedName: string;
  /** Instance ids in the final draft (listModuleInstances), resolved at finalize. */
  instanceIds: string[];
  declared: {
    moving: boolean;
    jointType: MotionJointKind;
    parentPlanName?: string;
    /** Parent resolved against committed parts; absent if parent failed/skipped. */
    parentPlacedName?: string;
    axis?: WorldAxis;
    role?: string;
    limitHint?: MotionLimitHint;
    anchorHint?: string;
    source: "plan" | "gen" | "plan+gen";
  };
  measured?: {
    bbox?: MeasuredBBox;
    symmetryAxis?: MeasuredSymmetryAxis;
    parentContact?: MeasuredParentContact;
  };
  /** Declared-vs-measured reconciliation; the seed builder prefers measured. */
  agreement?: {
    axisAgrees: boolean | null;
    note?: string;
  };
  warnings?: string[];
}

export interface IncrementalMotionSidecar {
  version: 1;
  source: "incremental-draft";
  scadFile: "draft.scad";
  records: PartMotionRecord[];
  warnings: string[];
}

export const INCREMENTAL_MOTION_FILE = "motion_incremental.json";

export function createIncrementalMotionSidecar(): IncrementalMotionSidecar {
  return {
    version: 1,
    source: "incremental-draft",
    scadFile: "draft.scad",
    records: [],
    warnings: [],
  };
}

export async function saveIncrementalMotionSidecar(
  outputDir: string,
  sidecar: IncrementalMotionSidecar,
): Promise<void> {
  const path = join(outputDir, INCREMENTAL_MOTION_FILE);
  await Bun.write(path, `${JSON.stringify(sidecar, null, 2)}\n`);
}

export async function loadIncrementalMotionSidecar(
  outputDir: string,
): Promise<IncrementalMotionSidecar | null> {
  const path = join(outputDir, INCREMENTAL_MOTION_FILE);
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const raw = (await file.json()) as IncrementalMotionSidecar;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.records)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Extract the first balanced JSON object from LLM output. String-aware brace
 * scan so trailing prose containing "}" (the failure mode of a naive
 * indexOf/lastIndexOf slice) cannot corrupt the extraction.
 */
export function extractBalancedJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const JOINT_KINDS: readonly MotionJointKind[] = ["fixed", "revolute", "prismatic", "spherical"];
const LIMIT_HINTS: readonly MotionLimitHint[] = ["continuous", "small", "medium", "wide"];
const WORLD_AXES: readonly WorldAxis[] = ["X", "Y", "Z"];

/**
 * Coerce an untrusted LLM-emitted motion object (from the plan JSON or the
 * `// MOTION` block) into a clean PartMotionPlan. Returns null when there is
 * no usable signal. Unknown enum values are dropped, never errors.
 */
export function sanitizeMotionDecl(raw: unknown): PartMotionPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const out: PartMotionPlan = { moving: obj.moving === true };
  if (typeof obj.jointType === "string" && (JOINT_KINDS as readonly string[]).includes(obj.jointType)) {
    out.jointType = obj.jointType as MotionJointKind;
  }
  if (typeof obj.parent === "string" && obj.parent.trim()) {
    // Normalize exactly like plan names (parsePlanJson: sanitizeIdentifier +
    // lowercase) so "wheel hub" / "wheel-hub" still resolves to wheel_hub.
    out.parent = sanitizeIdentifier(obj.parent).toLowerCase().slice(0, 80);
  }
  if (typeof obj.axis === "string") {
    const axis = obj.axis.trim().toUpperCase();
    if ((WORLD_AXES as readonly string[]).includes(axis)) out.axis = axis as WorldAxis;
  }
  if (typeof obj.role === "string" && obj.role.trim()) {
    out.role = obj.role.trim().slice(0, 60);
  }
  if (typeof obj.limitHint === "string" && (LIMIT_HINTS as readonly string[]).includes(obj.limitHint)) {
    out.limitHint = obj.limitHint as MotionLimitHint;
  }
  if (!out.moving && !out.jointType && !out.parent && !out.role) return null;
  return out;
}
