// Shared contract between the incremental draft loop (producer) and any
// downstream assembly/BOM/mates consumer: per-part STATIC mating-interface
// metadata declared during planning/generation, then validated against
// measured geometry. Sibling to ./incremental.ts (the MOVING-joint contract);
// the two are deliberately parallel so the producer machinery is a clone.
//
// Trust model (identical to motion): `declared` fields are categorical LLM
// output (soft priors, never coordinates); `measured` fields come from
// deterministic mesh analysis of the as-built assembly and always win. The
// sidecar is a prior — a run without it, or with stale records, must behave
// exactly like today's pipeline.
//
// Relationship to motion: a STATIC mate (0 DOF) and a MOVING joint (1+ DOF)
// share the same measurement backend and parent/partner resolution. Rule: a
// part-pair gets at most one edge — if a part is `motion.moving`, motion owns
// the contact and the assembly layer defers; otherwise the assembly layer owns
// the mate. A static edge maps to a URDF `fixed` joint downstream.

import { join } from "node:path";
import { sanitizeIdentifier } from "../scad/parts";
import { extractBalancedJson, type Vec3, type MeasuredBBox } from "./incremental";

export { extractBalancedJson, type Vec3, type MeasuredBBox };

/** The kind of physical mating feature joining this part to its partner. */
export type InterfaceKind =
  | "bolt_pattern"
  | "peg_socket"
  | "seat_face"
  | "snap_tab"
  | "tab_slot"
  | "flange"
  | "lip_rabbet"
  | "key"
  | "press_fit";

/** Fit class → signed clearance on the female half (see lib/assembly.scad asm_fit). */
export type FitClass = "clearance" | "location" | "press" | "snap";

/** How the pair is fastened (for a later BOM/hardware manifest). */
export type FastenKind = "screw" | "snap" | "dowel" | "none";

/** Plan-level static-interface intent (soft prior, categorical only). */
export interface AssemblyInterfacePlan {
  /** Plan name of the earlier part this one mates to. */
  partner?: string;
  mate?: InterfaceKind;
  fit?: FitClass;
  /** Short semantic role, e.g. "mount bracket to base". */
  role?: string;
  /** Feature multiplicity, e.g. bolt count / tab count. */
  count?: number;
  fasten?: FastenKind;
}

/** Optional gen-stage refinement parsed from the `// INTERFACE` block. */
export type AssemblyGenHint = Partial<AssemblyInterfacePlan> & {
  /** Freeform words locating the interface ("bolt circle on the top flange") — never numbers. */
  locateHint?: string;
};

/** Mating evidence between the part and its declared partner, world frame.
 *  Fractions are normalized against the smaller of the two isolated meshes so
 *  they are scale-free (JoinABLe-style C_contact / C_overlap predicates). */
export interface MeasuredMate {
  /** placedName of the partner whose mesh was used. */
  partner: string;
  /** Centroid of the contact region between the two solids. */
  contactAnchor: Vec3;
  /** Outward normal of the mating interface (null if indeterminate). */
  contactNormal: Vec3 | null;
  /** contact proxy: max over both directions of (surface samples within the
   *  interface tolerance) / (that part's samples). 0 ⇒ not touching. */
  contactAreaFrac: number;
  /** interpenetration proxy: |A ∩ B volume| / min(volume). ~0 wanted; high ⇒ buried.
   *  Only meaningful when `interpenComputed` — else the boolean compile failed. */
  interpenetrationFrac: number;
  /** False ⇒ the intersection() overlap compile FAILED (compile error / timeout),
   *  so interpenetration is UNKNOWN, not zero. A failed overlap must never become
   *  affirmative "not buried" evidence (the verdict goes null instead). */
  interpenComputed: boolean;
  /** For hole/peg mates: coaxial cylinder alignment error, when detectable. */
  coaxial?: { axisOffset: number; radialGap: number };
  /** The placed part's world bbox at measurement time — used downstream to
   *  demote a verdict whose geometry drifted (e.g. after a whole-model refine). */
  partBBox?: MeasuredBBox;
  sampleCount: number;
}

export interface AssemblyInterfaceRecord {
  /** Name from plan.json. */
  planName: string;
  /** Module name actually placed (after any collision rename). */
  placedName: string;
  /** Instance ids in the final draft (listModuleInstances), resolved at finalize. */
  instanceIds: string[];
  declared: {
    partnerPlanName?: string;
    /** Partner resolved against committed parts; absent if it failed/skipped. */
    partnerPlacedName?: string;
    mate?: InterfaceKind;
    fit?: FitClass;
    role?: string;
    count?: number;
    fasten?: FastenKind;
    locateHint?: string;
    source: "plan" | "gen" | "plan+gen";
  };
  measured?: MeasuredMate;
  /** Declared-vs-measured reconciliation; the seed builder prefers measured. */
  agreement?: {
    /** True ⇒ the parts touch and don't grossly interpenetrate. */
    mates: boolean | null;
    note?: string;
  };
  warnings?: string[];
}

export interface IncrementalAssemblySidecar {
  version: 1;
  source: "incremental-draft";
  scadFile: "draft.scad";
  records: AssemblyInterfaceRecord[];
  warnings: string[];
}

export const ASSEMBLY_INCREMENTAL_FILE = "assembly_incremental.json";

export function createIncrementalAssemblySidecar(): IncrementalAssemblySidecar {
  return {
    version: 1,
    source: "incremental-draft",
    scadFile: "draft.scad",
    records: [],
    warnings: [],
  };
}

export async function saveIncrementalAssemblySidecar(
  outputDir: string,
  sidecar: IncrementalAssemblySidecar,
): Promise<void> {
  const path = join(outputDir, ASSEMBLY_INCREMENTAL_FILE);
  await Bun.write(path, `${JSON.stringify(sidecar, null, 2)}\n`);
}

/** A record is only usable if it has the fields reconcile/seed dereference. */
function isValidAssemblyRecord(r: unknown): r is AssemblyInterfaceRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return typeof o.placedName === "string"
    && Array.isArray(o.instanceIds)
    && !!o.declared && typeof o.declared === "object";
}

export async function loadIncrementalAssemblySidecar(
  outputDir: string,
): Promise<IncrementalAssemblySidecar | null> {
  const path = join(outputDir, ASSEMBLY_INCREMENTAL_FILE);
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const raw = (await file.json()) as IncrementalAssemblySidecar;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.records)) return null;
    // Drop any malformed record so downstream reconcile/seed can dereference
    // record fields without a crash (defends against a hand-edited/old sidecar).
    raw.records = raw.records.filter(isValidAssemblyRecord);
    if (!Array.isArray(raw.warnings)) raw.warnings = [];
    return raw;
  } catch {
    return null;
  }
}

const INTERFACE_KINDS: readonly InterfaceKind[] = [
  "bolt_pattern", "peg_socket", "seat_face", "snap_tab",
  "tab_slot", "flange", "lip_rabbet", "key", "press_fit",
];
const FIT_CLASSES: readonly FitClass[] = ["clearance", "location", "press", "snap"];
const FASTEN_KINDS: readonly FastenKind[] = ["screw", "snap", "dowel", "none"];

/**
 * Coerce an untrusted LLM-emitted assembly object (from the plan JSON or the
 * `// INTERFACE` block) into a clean AssemblyInterfacePlan. Returns null when
 * there is no usable signal. Unknown enum values are dropped, never errors.
 */
export function sanitizeAssemblyDecl(raw: unknown): AssemblyInterfacePlan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const out: AssemblyInterfacePlan = {};
  if (typeof obj.partner === "string" && obj.partner.trim()) {
    // Normalize exactly like plan names so "base plate" / "base-plate" resolve.
    out.partner = sanitizeIdentifier(obj.partner).toLowerCase().slice(0, 80);
  }
  if (typeof obj.mate === "string" && (INTERFACE_KINDS as readonly string[]).includes(obj.mate)) {
    out.mate = obj.mate as InterfaceKind;
  }
  if (typeof obj.fit === "string" && (FIT_CLASSES as readonly string[]).includes(obj.fit)) {
    out.fit = obj.fit as FitClass;
  }
  if (typeof obj.role === "string" && obj.role.trim()) {
    out.role = obj.role.trim().slice(0, 60);
  }
  if (typeof obj.count === "number" && Number.isFinite(obj.count) && obj.count > 0) {
    out.count = Math.min(64, Math.round(obj.count));
  }
  if (typeof obj.fasten === "string" && (FASTEN_KINDS as readonly string[]).includes(obj.fasten)) {
    out.fasten = obj.fasten as FastenKind;
  }
  // Usable only if it says WHO to mate to or WHAT feature to use.
  if (!out.partner && !out.mate) return null;
  return out;
}

/** Parse a categorical `// INTERFACE` gen hint (Partial + locateHint). Mirrors
 *  parseMotionBlock's contract: returns undefined when there's no signal. */
export function parseAssemblyHint(raw: unknown): AssemblyGenHint | undefined {
  const base = sanitizeAssemblyDecl(raw);
  const obj = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  let locateHint: string | undefined;
  if (typeof obj.locateHint === "string" && obj.locateHint.trim()) {
    locateHint = obj.locateHint.trim().slice(0, 120);
  }
  if (!base && !locateHint) return undefined;
  return { ...(base ?? {}), ...(locateHint ? { locateHint } : {}) };
}
