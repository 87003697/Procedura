// Consumer-side seed for the STATIC assembly interfaces recorded during the
// incremental draft (assembly_incremental.json). Mirrors motion-seed.ts: it
// reconciles the sidecar against the final part universe and builds a
// deterministic fixed-joint skeleton — the explicit static edges the motion
// seed otherwise collapses into one anonymous root link. Never a bypass: the
// output enriches the planner's context (fixed anchorCandidates) and is written
// as an artifact; a missing/stale sidecar degrades to today's exact behavior.

import type {
  IncrementalAssemblySidecar, AssemblyInterfaceRecord, InterfaceKind, FitClass, MeasuredBBox,
} from "../motion/assembly";

export interface MatchedAssemblyRecord {
  record: AssemblyInterfaceRecord;
  /** partNames entries this record resolved to (instance-id universe). */
  instanceIds: string[];
  /** partNames entries the declared partner resolved to ([] = absent/unusable). */
  partnerInstanceIds: string[];
}

export interface ReconciledIncrementalAssembly {
  matched: MatchedAssemblyRecord[];
  /** Records that no longer match any part in the final SCAD. */
  stale: AssemblyInterfaceRecord[];
  warnings: string[];
}

/** Reconcile the assembly sidecar against the final instance-expanded part
 *  universe: keep records whose placed module still exists, resolve the partner
 *  to committed instances. Prefers the finalize-resolved instanceIds; falls
 *  back to the plain placed name (mirrors reconcileIncrementalMotion). */
export function reconcileIncrementalAssembly(
  sidecar: IncrementalAssemblySidecar, partNames: string[],
): ReconciledIncrementalAssembly {
  const nameSet = new Set(partNames);
  const resolve = (placed: string | undefined, ids: string[]): string[] => {
    const present = ids.filter((id) => nameSet.has(id));
    if (present.length) return present;
    if (placed && nameSet.has(placed)) return [placed];
    return [];
  };
  const matched: MatchedAssemblyRecord[] = [];
  const stale: AssemblyInterfaceRecord[] = [];
  const warnings: string[] = [];
  for (const record of sidecar.records) {
    const instanceIds = resolve(record.placedName, record.instanceIds);
    if (instanceIds.length === 0) { stale.push(record); continue; }
    const partnerPlaced = record.declared.partnerPlacedName;
    const partnerInstanceIds = partnerPlaced ? resolve(partnerPlaced, []) : [];
    if (record.declared.partnerPlanName && partnerInstanceIds.length === 0) {
      warnings.push(
        `assembly: partner of ${record.placedName} ` +
        `(${record.declared.partnerPlanName}) is not in the final build`,
      );
    }
    matched.push({ record, instanceIds, partnerInstanceIds });
  }
  if (stale.length) warnings.push(`assembly: ${stale.length} stale record(s) dropped`);
  return { matched, stale, warnings };
}

const DRIFT_CENTER_FRACTION = 0.10;
const DRIFT_SIZE_FRACTION = 0.20;

/**
 * Demote records whose part geometry drifted since draft-time measurement (a
 * whole-model refine runs AFTER the draft writes the sidecar, so an unchanged
 * module name can carry a stale verdict/anchor). Compares each single-instance
 * record's stored `partBBox` against a freshly compiled bbox; on drift, the
 * verdict is set to null (unverified). Mirrors motion's demoteDriftedRecords.
 */
export function demoteDriftedAssembly(
  matched: MatchedAssemblyRecord[],
  currentBBoxes: Map<string, MeasuredBBox>,
): { matched: MatchedAssemblyRecord[]; drifted: string[]; warnings: string[] } {
  const drifted: string[] = [];
  const warnings: string[] = [];
  const center = (b: MeasuredBBox, i: number): number => (b.min[i]! + b.max[i]!) / 2;
  const out = matched.map((m) => {
    const recorded = m.record.measured?.partBBox;
    const id = m.instanceIds.length === 1 ? m.instanceIds[0] : undefined;
    if (!recorded || id === undefined) return m;
    const current = currentBBoxes.get(id);
    if (!current) return m;
    const diagonal = Math.hypot(recorded.size[0]!, recorded.size[1]!, recorded.size[2]!) || 1;
    const centerMoved = Math.hypot(
      center(current, 0) - center(recorded, 0),
      center(current, 1) - center(recorded, 1),
      center(current, 2) - center(recorded, 2),
    ) > DRIFT_CENTER_FRACTION * diagonal;
    const sizeMoved = [0, 1, 2].some((i) =>
      Math.abs(current.size[i]! - recorded.size[i]!) > DRIFT_SIZE_FRACTION * Math.max(current.size[i]!, 0.05 * diagonal));
    if (!centerMoved && !sizeMoved) return m;
    drifted.push(m.record.placedName);
    warnings.push(`assembly: ${m.record.placedName} geometry drifted since measurement — verdict demoted to unverified`);
    return {
      ...m,
      record: { ...m.record, agreement: { mates: null, note: "geometry drifted since draft-time measurement" } },
    };
  });
  return { matched: out, drifted, warnings };
}

/** One fixed-joint edge of the static skeleton: `child` is rigidly attached to
 *  `parent` (its mating partner). `parent === null` ⇒ the base/root. */
export interface AssemblyFixedEdge {
  child: string;
  parent: string | null;
  mate: InterfaceKind | null;
  fit: FitClass | null;
  /** Measured mate verdict: touches without gross interpenetration. */
  mates: boolean | null;
  /** Measured contact centroid (single-instance records only). */
  anchor?: [number, number, number];
}

export interface SeedAssemblyGraph {
  edges: AssemblyFixedEdge[];
  warnings: string[];
}

/** Deterministic fixed-joint skeleton from the matched records. One edge per
 *  child instance; the anchor is carried only for single-instance records
 *  (a reused module's measured anchor came from the union mesh). */
export function buildSeedAssemblyGraph(matched: MatchedAssemblyRecord[]): SeedAssemblyGraph {
  const edges: AssemblyFixedEdge[] = [];
  const warnings: string[] = [];
  for (const m of matched) {
    const parent = m.partnerInstanceIds[0] ?? null;
    const anchor = m.record.measured?.contactAnchor;
    const single = m.instanceIds.length === 1;
    for (const child of m.instanceIds) {
      edges.push({
        child,
        parent,
        mate: m.record.declared.mate ?? null,
        fit: m.record.declared.fit ?? null,
        mates: m.record.agreement?.mates ?? null,
        ...(anchor && single ? { anchor: [anchor[0], anchor[1], anchor[2]] as [number, number, number] } : {}),
      });
    }
    if (m.record.agreement?.mates === false) {
      warnings.push(
        `assembly: ${m.record.placedName} declared a mate that did not register ` +
        `(${m.record.agreement.note ?? "no detail"})`,
      );
    }
  }
  return { edges, warnings };
}
