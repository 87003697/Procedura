// Consume-side helpers for the incremental-motion sidecar: reconcile the
// build-time part records against the final SCAD's instance-expanded part
// universe, demote records whose geometry drifted since measurement, then
// build a deterministic seed MotionPlan from the surviving records. The seed
// is (a) injected into the motion planner prompt as a draft to correct and
// (b) used as the fallback plan replacing the all-fixed default — it never
// bypasses the LLM planner.
//
// Trust rules: seed coordinates (anchors) come ONLY from build-time
// measurement; declared-only (unmeasured) metadata never becomes a coordinate.
// Measured axes are trusted only at "high" symmetry confidence. A seed joint
// without any measured anchor falls back to the instance bbox center as an
// explicitly low-quality value the planner is expected to correct.
// Stale/invalid/drifted data degrades to categorical priors or "no seed" —
// never a hard failure.

import type {
  IncrementalMotionSidecar,
  MeasuredBBox,
  MotionJointKind,
  MotionLimitHint,
  PartMotionRecord,
} from "../motion/incremental.ts";
import { INSTANCE_ID_PAT } from "../scad/parts.ts";
import {
  normalizeMotionPlan,
  validateMotionPlan,
  type MotionAxis,
  type MotionJointSpec,
  type MotionLinkSpec,
  type MotionPlan,
} from "../motion/types.ts";

export interface MatchedMotionRecord {
  record: PartMotionRecord;
  /** partNames entries this record resolved to (instance-id universe). */
  instanceIds: string[];
  /** partNames entries the declared parent resolved to ([] = absent or unusable). */
  parentInstanceIds: string[];
  /** True when the record declares a parent that failed to resolve (or resolved to itself). */
  parentUnresolved: boolean;
}

export interface ReconciledIncrementalMotion {
  matched: MatchedMotionRecord[];
  /** Records that no longer match any part in the final SCAD (excluded from priors/seed). */
  stale: PartMotionRecord[];
  /** Instance ids whose measured data was demoted because the geometry drifted since measurement. */
  drifted?: string[];
  /** Consume-time reconciliation warnings (stale records, unresolved parents, drift). */
  warnings: string[];
  /** Build-time warnings carried over from the sidecar. */
  sidecarWarnings: string[];
}

/** partNames that are `<moduleName>__i<k>` instances of the given module
 *  (strict instance-id grammar; `wheel__inner` is NOT an instance of `wheel`). */
function instancesOfModule(moduleName: string, partNames: string[]): string[] {
  return partNames.filter((part) => {
    const m = INSTANCE_ID_PAT.exec(part);
    return m !== null && m[1] === moduleName;
  });
}

/** Exact name first (a plain module name shadows the instance-id syntax, see
 *  compilePartsInAssembly), then `<name>__i<k>` instances of the module. */
function resolveByName(name: string | undefined, partNames: string[], nameSet: Set<string>): string[] {
  if (name === undefined || name === "") return [];
  if (nameSet.has(name)) return [name];
  return instancesOfModule(name, partNames);
}

function resolveRecordInstances(record: PartMotionRecord, partNames: string[], nameSet: Set<string>): string[] {
  if (nameSet.has(record.placedName)) return [record.placedName];
  const recordedIds = Array.isArray(record.instanceIds) ? record.instanceIds : [];
  const recorded = recordedIds.filter((id) => typeof id === "string" && nameSet.has(id));
  if (recorded.length > 0) return recorded;
  const placedInstances = instancesOfModule(record.placedName, partNames);
  if (placedInstances.length > 0) return placedInstances;
  return resolveByName(record.planName, partNames, nameSet);
}

/**
 * Match every sidecar record against the final part universe
 * (`listMotionParts` output): exact placedName, recorded instance ids,
 * `placedName__i<k>` instances, then the same three checks with planName.
 * Unmatched records are STALE and excluded from priors and seed. Parents
 * resolve the same way; a parent that is unresolved — or resolves back to the
 * record's own instances (self-parent) — keeps the record as a role prior but
 * disqualifies it from producing a seed joint.
 */
export function reconcileIncrementalMotion(
  sidecar: IncrementalMotionSidecar,
  partNames: string[],
): ReconciledIncrementalMotion {
  const matched: MatchedMotionRecord[] = [];
  const stale: PartMotionRecord[] = [];
  const warnings: string[] = [];
  const nameSet = new Set(partNames);

  for (const rawRecord of Array.isArray(sidecar.records) ? sidecar.records : []) {
    // The sidecar is untrusted JSON from disk; skip records missing the shape
    // the reconciliation relies on rather than throwing.
    const raw: unknown = rawRecord;
    if (raw === null || typeof raw !== "object") {
      warnings.push("skipped a malformed incremental motion record");
      continue;
    }
    const record = raw as PartMotionRecord;
    if (typeof record.placedName !== "string" || typeof (record.declared as unknown) !== "object" || !record.declared) {
      warnings.push("skipped a malformed incremental motion record");
      continue;
    }
    const instanceIds = resolveRecordInstances(record, partNames, nameSet);
    if (instanceIds.length === 0) {
      stale.push(record);
      warnings.push(`incremental motion record ${record.placedName} matches no part in the final SCAD; excluded as stale`);
      continue;
    }
    const parentName = record.declared.parentPlacedName ?? record.declared.parentPlanName;
    const byPlaced = resolveByName(record.declared.parentPlacedName, partNames, nameSet);
    let parentInstanceIds = byPlaced.length > 0
      ? byPlaced
      : resolveByName(record.declared.parentPlanName, partNames, nameSet);
    let parentUnresolved = parentName !== undefined && parentInstanceIds.length === 0;
    if (parentUnresolved) {
      warnings.push(`incremental motion record ${record.placedName}: declared parent ${parentName} not found; kept as a role prior without a seed joint`);
    } else if (parentInstanceIds.some((id) => instanceIds.includes(id))) {
      // Self-parent: a rename can collapse parent and child onto the same
      // part after the fact; a joint would be nonsensical.
      warnings.push(`incremental motion record ${record.placedName}: declared parent ${parentName} resolves to the record itself; kept as a role prior without a seed joint`);
      parentInstanceIds = [];
      parentUnresolved = true;
    }
    matched.push({ record, instanceIds, parentInstanceIds, parentUnresolved });
  }

  return {
    matched,
    stale,
    warnings,
    sidecarWarnings: Array.isArray(sidecar.warnings) ? sidecar.warnings.filter((w) => typeof w === "string") : [],
  };
}

/** Center moved by more than this fraction of the current bbox diagonal ⇒ drifted. */
const DRIFT_CENTER_FRACTION = 0.10;
/** Any bbox size component changed by more than this fraction ⇒ drifted. */
const DRIFT_SIZE_FRACTION = 0.20;

/**
 * Post-refine geometric drift gate: a name-matched record may carry anchors
 * measured on draft geometry that the refine stage has since moved. Compare
 * the recorded measured bbox against the CURRENT compiled instance bbox and
 * demote drifted records to categorical priors (declared role/jointType/parent
 * survive; measured anchors/axes and the stale agreement are dropped). Records
 * without measured data, or without a current bbox to compare against, pass
 * through unchanged.
 */
export function demoteDriftedRecords(
  matched: MatchedMotionRecord[],
  currentBboxes: Map<string, MeasuredBBox>,
): { matched: MatchedMotionRecord[]; drifted: string[]; warnings: string[] } {
  const out: MatchedMotionRecord[] = [];
  const drifted: string[] = [];
  const warnings: string[] = [];
  for (const m of matched) {
    const recorded = m.record.measured?.bbox;
    const current = m.instanceIds.length === 1 ? currentBboxes.get(m.instanceIds[0]!) : undefined;
    if (recorded === undefined || current === undefined) {
      out.push(m);
      continue;
    }
    const diagonal = Math.max(1e-6, Math.hypot(current.size[0], current.size[1], current.size[2]));
    const centerDelta = vecDistance(bboxCenter(current), bboxCenter(recorded));
    const centerMoved = centerDelta > DRIFT_CENTER_FRACTION * diagonal;
    const sizeChanged = ([0, 1, 2] as const).some((i) =>
      Math.abs(current.size[i] - recorded.size[i]) > DRIFT_SIZE_FRACTION * Math.max(current.size[i], 0.05 * diagonal));
    if (!centerMoved && !sizeChanged) {
      out.push(m);
      continue;
    }
    drifted.push(m.instanceIds[0]!);
    warnings.push(
      `incremental motion record ${m.record.placedName}: as-built geometry drifted since measurement ` +
      `(center moved ${centerDelta.toFixed(2)} vs current diagonal ${diagonal.toFixed(2)}); demoted to a categorical prior`,
    );
    const { measured: _measured, agreement: _agreement, ...rest } = m.record;
    out.push({ ...m, record: rest });
  }
  return { matched: out, drifted, warnings };
}

/** Measured symmetry axis, trusted only at "high" confidence (the same bar
 *  the build-time axisAgrees check uses). Null otherwise. */
export function trustedMeasuredAxis(record: PartMotionRecord): MotionAxis | null {
  const sym = record.measured?.symmetryAxis;
  if (sym === undefined || sym.confidence !== "high") return null;
  return sym.snappedAxis;
}

/**
 * Numeric revolute limits for the categorical limitHint. Continuous joints
 * and prismatic/spherical joints get no seed limits (exporter fallbacks apply).
 */
export function seedJointLimit(
  jointType: MotionJointKind,
  hint: MotionLimitHint | undefined,
): { lower: number; upper: number } | undefined {
  if (jointType !== "revolute") return undefined;
  if (hint === undefined || hint === "continuous") return undefined;
  const span = hint === "small" ? 15 : hint === "medium" ? 45 : 90;
  return { lower: -span, upper: span };
}

/** Per-instance bboxes derivable from the sidecar itself: a single-instance
 *  record's measured world bbox is that instance's bbox (multi-instance
 *  records carry a union-mesh bbox and never produce seed joints). */
export function seedBboxesFromRecords(matched: MatchedMotionRecord[]): Map<string, MeasuredBBox> {
  const out = new Map<string, MeasuredBBox>();
  for (const m of matched) {
    const box = m.record.measured?.bbox;
    if (box === undefined || m.instanceIds.length !== 1) continue;
    out.set(m.instanceIds[0]!, box);
  }
  return out;
}

function bboxCenter(box: MeasuredBBox): [number, number, number] {
  return [
    (box.min[0] + box.max[0]) * 0.5,
    (box.min[1] + box.max[1]) * 0.5,
    (box.min[2] + box.max[2]) * 0.5,
  ];
}

function bboxVolume(box: MeasuredBBox): number {
  return Math.max(0, box.size[0] * box.size[1] * box.size[2]);
}

function vecDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Deterministic seed MotionPlan from reconciled incremental records: one root
 * link absorbing every static part, one link+joint per single-instance moving
 * record. Axes use the MEASURED snapped symmetry axis only at high confidence,
 * else the declared axis; anchors are the measured contact/symmetry point when
 * available, else the instance bbox center (low quality). Multi-instance
 * records produce NO joints (no per-instance measurement) — their categorical
 * prior still reaches the planner via the design brief. A joint that fails the
 * per-joint sanity guards is skipped (its part returns to the root link)
 * instead of discarding the whole seed. No drives, masses, or materials:
 * exporter defaults and the LLM planner fill those.
 *
 * Returns null (with a warning pushed) when there is nothing to articulate or
 * the built plan fails validateMotionPlan (the errors are included in the warning).
 */
export function buildSeedMotionPlan(
  matchedRecords: MatchedMotionRecord[],
  partNames: string[],
  partBboxes: Map<string, MeasuredBBox>,
  warnings: string[] = [],
): MotionPlan | null {
  if (matchedRecords.length === 0 || partNames.length === 0) return null;

  // Joint-producing records: declared moving with a non-fixed joint type, a
  // usable parent, and exactly one resolved instance (multi-instance records
  // stay categorical priors — there is no per-instance measurement to anchor them).
  const byInstance = new Map<string, MatchedMotionRecord>();
  for (const m of matchedRecords) {
    const declared = m.record.declared;
    if (!declared.moving || declared.jointType === undefined || declared.jointType === "fixed" || m.parentUnresolved) continue;
    if (m.instanceIds.length !== 1) {
      warnings.push(
        `incremental seed: ${m.record.placedName} matched ${m.instanceIds.length} instances; ` +
        `seed joints skipped (no per-instance measurement) — kept as a categorical prior`,
      );
      continue;
    }
    const instanceId = m.instanceIds[0]!;
    if (byInstance.has(instanceId)) {
      warnings.push(`incremental seed: ${instanceId} is claimed by more than one moving record; kept the first`);
      continue;
    }
    byInstance.set(instanceId, m);
  }
  if (byInstance.size === 0) return null;

  const claimed = new Set(byInstance.keys());
  const rootParts = partNames.filter((part) => !claimed.has(part));
  if (rootParts.length === 0) {
    warnings.push("incremental seed: every part is claimed by a moving record; no root link possible");
    return null;
  }
  const rootPartSet = new Set(rootParts);

  // Root link name: first non-moving parentless record, else the largest
  // non-moving part by bbox volume, else the first unclaimed part.
  const rootRecord = matchedRecords.find((m) =>
    !m.record.declared.moving
    && m.record.declared.parentPlanName === undefined
    && m.record.declared.parentPlacedName === undefined
    && m.instanceIds.some((id) => rootPartSet.has(id)));
  let rootName = rootRecord?.instanceIds.find((id) => rootPartSet.has(id));
  if (rootName === undefined) {
    let bestVolume = -1;
    for (const part of rootParts) {
      const box = partBboxes.get(part);
      if (box === undefined) continue;
      const volume = bboxVolume(box);
      if (volume > bestVolume) {
        bestVolume = volume;
        rootName = part;
      }
    }
  }
  const root = rootName ?? rootParts[0]!;

  const joints: MotionJointSpec[] = [];
  const absorbed: string[] = []; // ids whose joint failed a guard → back into the root link

  for (const [instanceId, m] of byInstance) {
    const declared = m.record.declared;
    const measured = m.record.measured;

    const parentFirst = m.parentInstanceIds[0];
    if (m.parentInstanceIds.length > 1 && parentFirst !== undefined && !rootPartSet.has(parentFirst)) {
      warnings.push(`incremental seed: parent of ${m.record.placedName} resolves to ${m.parentInstanceIds.length} instances; using ${parentFirst}`);
    }
    const parentLink = parentFirst === undefined || rootPartSet.has(parentFirst) ? root : parentFirst;

    // Per-joint sanity guards (defensive; reconcile catches the common cases):
    // skip the offending joint, never the whole seed.
    if (parentLink === instanceId) {
      warnings.push(`incremental seed: ${instanceId} would be its own joint parent; joint skipped, part kept in the root link`);
      absorbed.push(instanceId);
      continue;
    }
    if (parentLink !== root && !claimed.has(parentLink)) {
      warnings.push(`incremental seed: ${instanceId} has an unknown parent link ${parentLink}; joint skipped, part kept in the root link`);
      absorbed.push(instanceId);
      continue;
    }

    const sym = measured?.symmetryAxis;
    const trustedAxis = trustedMeasuredAxis(m.record);
    if (sym !== undefined && sym.confidence === "high" && sym.snappedAxis === null) {
      warnings.push(`incremental seed: ${m.record.placedName} has a skewed measured axis; using the declared/default axis without rotation authoring`);
    }
    const axis = trustedAxis ?? declared.axis;
    const measuredAnchor = measured?.parentContact?.anchor ?? measured?.symmetryAxis?.axisPoint;
    let anchor: [number, number, number] | undefined;
    if (measuredAnchor !== undefined) {
      anchor = [measuredAnchor[0], measuredAnchor[1], measuredAnchor[2]];
    } else {
      const box = partBboxes.get(instanceId) ?? measured?.bbox;
      if (box !== undefined) anchor = bboxCenter(box); // low-quality seed anchor; planner corrects
      else warnings.push(`incremental seed: no anchor evidence for ${instanceId}; joint frame defaults to the origin`);
    }
    const limit = seedJointLimit(declared.jointType!, declared.limitHint);

    joints.push({
      name: `${parentLink}_to_${instanceId}`,
      type: declared.jointType!,
      parent: parentLink,
      child: instanceId,
      ...(axis !== undefined ? { axis } : {}),
      ...(anchor !== undefined ? { localPos0: anchor, localPos1: [...anchor] as [number, number, number] } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }
  if (joints.length === 0) return null;

  // Joints whose parent instance was absorbed into the root keep articulating
  // against the root link (the parent part is rigidly inside it now).
  const childLinks = new Set(joints.map((joint) => joint.child));
  for (const joint of joints) {
    if (joint.parent !== undefined && joint.parent !== root && !childLinks.has(joint.parent)) {
      warnings.push(`incremental seed: joint ${joint.name} parent ${joint.parent} was absorbed into the root link; reparented to ${root}`);
      joint.parent = root;
    }
  }

  const links: MotionLinkSpec[] = [
    { name: root, parts: [...rootParts, ...absorbed] },
    ...[...childLinks].map((id) => ({ name: id, parts: [id] })),
  ];

  // Normalize so the seed carries the same defaults (axis, mirrored frames,
  // collision, rootLink) whether it feeds the planner prompt or the exporter.
  const seed = normalizeMotionPlan({
    version: 1,
    name: "incremental_seed",
    rootLink: root,
    links,
    joints,
  } as unknown, partNames);

  const validation = validateMotionPlan(seed, partNames);
  if (!validation.ok) {
    warnings.push(`incremental seed failed validation and was discarded: ${validation.errors.join("; ")}`);
    return null;
  }
  return seed;
}
