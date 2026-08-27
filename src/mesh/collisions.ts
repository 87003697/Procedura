/**
 * Mesh collision analysis — find UNREASONABLE interpenetrations between parts.
 *
 * A parametric assembly is authored so neighbouring parts overlap slightly (the
 * SCAD comments in these models say "penetrate by 0.5 mm for a solid union") —
 * that mating overlap is intentional and must NOT be flagged. What IS a defect
 * is two parts that are NOT structurally connected yet pass through each other:
 * a hand buried in a thigh, a forearm clipping the torso. Those never show up in
 * the vision critic (the intersection is hidden inside the solid), so a purely
 * geometric check is the only thing that catches them.
 *
 * Algorithm:
 *   1. Compile every top-level module IN ASSEMBLY (its true world position) and
 *      take its AABB + solid volume.
 *   2. Broad phase: keep part pairs whose AABBs overlap on all three axes.
 *   3. Narrow phase: for each such pair, intersect the two placed meshes in
 *      OpenSCAD and measure the true overlap volume + bbox.
 *   4. Classify each real overlap:
 *        - EXPECTED (same rigid group) → intended mating; not a defect.
 *          "Same group" = connected in the graph of (a) declared kinematic
 *          parent↔child edges and (b) parts that share the same leading world
 *          anchor transform (one limb is authored under one anchor).
 *        - cross-group + deep (penetration ≥ DEEP_MM or volume ratio high)
 *          → UNREASONABLE collision.
 *        - cross-group + shallow → minor surface mate (e.g. an armour plate
 *          sunk a couple mm into the body); reported but not a defect.
 *   5. For each unreasonable pair, suggest which rigid group to move and a
 *      world-space delta that separates them along their least-overlap axis.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { mapPool, COMPILE_CONCURRENCY } from "../util/pool.ts";
import { compileScad } from "../scad/compile.ts";
import { loadSTL, computeBBox } from "../mesh/stl.ts";
import type { STLMesh } from "../mesh/stl.ts";
import {
  listTopLevelModules,
  compileModuleInAssembly,
  assemblyPlacementAnchors,
} from "../scad/parts.ts";

// ── Tunables ────────────────────────────────────────────────────────────────

/** Ignore AABB pairs that overlap less than this on any axis (mm) — below the
 *  intended-mating tolerance, not worth a narrow-phase compile. */
const AABB_EPS_MM = 0.75;
/** A cross-group overlap must be at least this deep (min dim of the intersection
 *  bbox, mm) to count as a structural clash rather than a surface mate. */
const DEEP_MM = 5;
/** …AND enclose at least this fraction of the smaller part's volume. Requiring
 *  BOTH keeps intended thin mating pegs between two multi-part groups (e.g. a
 *  spine peg: deep but ~1% volume) from reading as clashes, while a limb buried
 *  in another limb (both deep and bulky) still trips. */
const VOLUME_RATIO = 0.03;
/** Extra clearance added to a suggested separation delta (mm). */
const SEPARATION_MARGIN_MM = 3;
/** Max concurrent OpenSCAD compiles. */

type Vec3 = [number, number, number];

export interface CollisionPartInfo {
  name: string;
  min: Vec3;
  max: Vec3;
  size: Vec3;
  volume: number;
  stlPath: string;
  /** Rigid-group id (index) this part was folded into. */
  group: number;
}

export interface CollisionPair {
  a: string;
  b: string;
  /** Per-axis AABB overlap (mm); all > 0. */
  aabbOverlap: Vec3;
  /** True solid intersection volume (mm³). */
  intersectionVolume: number;
  /** Intersection bbox size (mm). */
  intersectionSize: Vec3;
  /** Intersection bbox centre in world space (mm). */
  intersectionCenter: Vec3;
  /** Penetration depth ≈ smallest intersection-bbox dimension (mm). */
  penetrationDepth: number;
  /** intersectionVolume / min(volA, volB). */
  volumeRatio: number;
  /** True when a and b are in the same rigid group (intended mating). */
  expected: boolean;
  kind: "unreasonable" | "joint" | "minor";
  /** Present for unreasonable pairs: how to separate them. */
  suggestion?: {
    /** Which part's whole rigid group to translate. */
    move: string;
    /** Members of that rigid group — pass these to move_parts together. */
    group: string[];
    /** World-space translation that clears the overlap (+margin). */
    delta: Vec3;
    axis: "X" | "Y" | "Z";
  };
}

export interface CollisionGroup {
  id: number;
  parts: string[];
}

export interface CollisionResult {
  parts: CollisionPartInfo[];
  groups: CollisionGroup[];
  pairs: CollisionPair[];
  unreasonable: CollisionPair[];
  /** Parts that failed to compile in isolation (excluded from analysis). */
  skipped: string[];
  modelSpan: number;
}

// ── Small helpers ─────────────────────────────────────────────────────────

/** Abs solid volume of a triangle-soup mesh via the signed-tetrahedron sum. */
function meshVolume(mesh: STLMesh): number {
  const v = mesh.vertices;
  let vol6 = 0;
  for (let i = 0; i < v.length; i += 9) {
    const x0 = v[i]!, y0 = v[i + 1]!, z0 = v[i + 2]!;
    const x1 = v[i + 3]!, y1 = v[i + 4]!, z1 = v[i + 5]!;
    const x2 = v[i + 6]!, y2 = v[i + 7]!, z2 = v[i + 8]!;
    vol6 +=
      x0 * (y1 * z2 - z1 * y2) -
      y0 * (x1 * z2 - z1 * x2) +
      z0 * (x1 * y2 - y1 * x2);
  }
  return Math.abs(vol6) / 6;
}

// ── Rigid-group union-find ──────────────────────────────────────────────────

function buildGroups(
  names: string[],
  anchors: Map<string, Set<string>>,
  parentEdges: ReadonlyArray<readonly [string, string]>,
): { groupOf: Map<string, number>; groups: CollisionGroup[] } {
  const idx = new Map<string, number>();
  names.forEach((n, i) => idx.set(n, i));
  const parent = names.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const nx = parent[x]!; parent[x] = r; x = nx; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // (a) shared leading anchor transform → same limb/group.
  const byAnchor = new Map<string, number[]>();
  for (const n of names) {
    const keys = anchors.get(n);
    if (!keys) continue;
    for (const k of keys) {
      if (!k) continue; // "" = no anchor (placed at origin) → singleton
      const arr = byAnchor.get(k);
      if (arr) arr.push(idx.get(n)!);
      else byAnchor.set(k, [idx.get(n)!]);
    }
  }
  for (const members of byAnchor.values()) {
    for (let i = 1; i < members.length; i++) union(members[0]!, members[i]!);
  }

  // (b) declared kinematic parent↔child edges → same group (a joint mates).
  for (const [c, p] of parentEdges) {
    const ci = idx.get(c), pi = idx.get(p);
    if (ci !== undefined && pi !== undefined) union(ci, pi);
  }

  const groupOf = new Map<string, number>();
  const rootToId = new Map<number, number>();
  const groups: CollisionGroup[] = [];
  for (const n of names) {
    const root = find(idx.get(n)!);
    let gid = rootToId.get(root);
    if (gid === undefined) {
      gid = groups.length;
      rootToId.set(root, gid);
      groups.push({ id: gid, parts: [] });
    }
    groups[gid]!.parts.push(n);
    groupOf.set(n, gid);
  }
  return { groupOf, groups };
}

/**
 * The movable "limb" each part belongs to: parts that share the same leading
 * world anchor transform move together as one rigid unit (e.g. every lower-arm
 * part begins `translate([-96.5, 5, torso_elevation + 31.5])`). This is NARROWER
 * than a rigid group — it deliberately excludes the mount the limb hangs off
 * (the shoulder has a different anchor), so a move_parts fix shifts just the arm,
 * not the whole torso the arm is kinematically parented to. A part with no
 * anchor is its own singleton limb.
 */
function buildAnchorSubgroups(
  names: string[], anchors: Map<string, Set<string>>,
): Map<string, string[]> {
  const idx = new Map<string, number>();
  names.forEach((n, i) => idx.set(n, i));
  const parent = names.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const nx = parent[x]!; parent[x] = r; x = nx; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const byAnchor = new Map<string, number[]>();
  for (const n of names) {
    for (const k of anchors.get(n) ?? []) {
      if (!k) continue;
      const arr = byAnchor.get(k);
      if (arr) arr.push(idx.get(n)!);
      else byAnchor.set(k, [idx.get(n)!]);
    }
  }
  for (const members of byAnchor.values()) {
    for (let i = 1; i < members.length; i++) union(members[0]!, members[i]!);
  }
  const members = new Map<number, string[]>();
  for (const n of names) {
    const root = find(idx.get(n)!);
    const arr = members.get(root);
    if (arr) arr.push(n); else members.set(root, [n]);
  }
  const out = new Map<string, string[]>();
  for (const n of names) out.set(n, members.get(find(idx.get(n)!))!);
  return out;
}

// ── Main entry ──────────────────────────────────────────────────────────────

export interface AnalyzeCollisionsOpts {
  scadCode: string;
  /** Working dir for per-part + intersection STLs. */
  workDir: string;
  /** Declared kinematic parent edges [child, parent] (from the plan). Optional
   *  but improves grouping of joints that don't share an anchor transform. */
  parentEdges?: ReadonlyArray<readonly [string, string]>;
  log?: (line: string) => void;
}

export async function analyzeCollisions(opts: AnalyzeCollisionsOpts): Promise<CollisionResult> {
  const log = opts.log ?? (() => undefined);
  const scad = opts.scadCode;
  const workDir = opts.workDir;
  mkdirSync(workDir, { recursive: true });
  const partsDir = join(workDir, "parts");
  const interDir = join(workDir, "inter");
  mkdirSync(partsDir, { recursive: true });
  mkdirSync(interDir, { recursive: true });

  const moduleNames = listTopLevelModules(scad);

  // 1. Per-part placed meshes (bounded concurrency). Retry once: an isolated
  // compile can transiently fail (OpenSCAD killed by a timeout / OOM under
  // concurrent load) and return null even though the part has real geometry;
  // dropping it would silently hide any collision it's in.
  const compiled = await mapPool(moduleNames, COMPILE_CONCURRENCY, async (name) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const stl = await compileModuleInAssembly(scad, name, join(partsDir, name));
      if (!stl) continue;
      try {
        const mesh = loadSTL(stl);
        if (mesh.triCount === 0) return null; // genuinely empty — don't retry
        const bb = computeBBox(mesh);
        return { name, stl, bb, volume: meshVolume(mesh) };
      } catch {
        /* fall through to retry */
      }
    }
    return null;
  });

  const anchors = assemblyPlacementAnchors(scad);
  const skipped: string[] = [];
  const infoByName = new Map<string, CollisionPartInfo>();
  const kept: string[] = [];
  for (let i = 0; i < moduleNames.length; i++) {
    const c = compiled[i];
    if (!c) { skipped.push(moduleNames[i]!); continue; }
    kept.push(c.name);
  }

  const { groupOf, groups } = buildGroups(kept, anchors, opts.parentEdges ?? []);
  const anchorSubgroups = buildAnchorSubgroups(kept, anchors);
  for (let i = 0; i < moduleNames.length; i++) {
    const c = compiled[i];
    if (!c) continue;
    infoByName.set(c.name, {
      name: c.name,
      min: c.bb.min, max: c.bb.max, size: c.bb.size,
      volume: c.volume, stlPath: c.stl,
      group: groupOf.get(c.name) ?? -1,
    });
  }
  const parts = kept.map((n) => infoByName.get(n)!);
  log(`  [collisions] ${parts.length} placed parts, ${groups.length} rigid groups` +
      (skipped.length ? `, ${skipped.length} skipped (empty)` : ""));

  // whole-model span for context.
  let gmin: Vec3 = [Infinity, Infinity, Infinity];
  let gmax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let a = 0; a < 3; a++) {
      if (p.min[a]! < gmin[a]!) gmin[a] = p.min[a]!;
      if (p.max[a]! > gmax[a]!) gmax[a] = p.max[a]!;
    }
  }
  const modelSpan = parts.length
    ? Math.max(gmax[0]! - gmin[0]!, gmax[1]! - gmin[1]!, gmax[2]! - gmin[2]!)
    : 0;

  // 2. Broad phase — AABB overlap on all three axes.
  const axisOverlap = (a: CollisionPartInfo, b: CollisionPartInfo, i: number): number =>
    Math.min(a.max[i]!, b.max[i]!) - Math.max(a.min[i]!, b.min[i]!);
  interface Broad { a: CollisionPartInfo; b: CollisionPartInfo; ov: Vec3; }
  const broad: Broad[] = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i]!, b = parts[j]!;
      const ov: Vec3 = [axisOverlap(a, b, 0), axisOverlap(a, b, 1), axisOverlap(a, b, 2)];
      if (ov[0]! > AABB_EPS_MM && ov[1]! > AABB_EPS_MM && ov[2]! > AABB_EPS_MM) {
        broad.push({ a, b, ov });
      }
    }
  }
  log(`  [collisions] ${broad.length} AABB-overlapping pair(s) → narrow phase`);

  // 3. Narrow phase — true solid intersection volume.
  const pairs: CollisionPair[] = [];
  const narrow = await mapPool(broad, COMPILE_CONCURRENCY, async (pr, k) => {
    const src =
      `intersection() {\n` +
      `  import("${pr.a.stlPath}");\n` +
      `  import("${pr.b.stlPath}");\n` +
      `}\n`;
    try {
      const r = await compileScad(src, { outputDir: join(interDir, `p${k}`) });
      const mesh = loadSTL(r.stlPath);
      if (mesh.triCount === 0) return null;
      const bb = computeBBox(mesh);
      return { vol: meshVolume(mesh), size: bb.size, center: [
        (bb.min[0]! + bb.max[0]!) / 2, (bb.min[1]! + bb.max[1]!) / 2, (bb.min[2]! + bb.max[2]!) / 2,
      ] as Vec3 };
    } catch {
      return null;
    }
  });

  for (let k = 0; k < broad.length; k++) {
    const pr = broad[k]!;
    const nr = narrow[k];
    if (!nr || nr.vol <= 0) continue; // AABBs overlapped but solids don't touch
    const penetrationDepth = Math.min(nr.size[0]!, nr.size[1]!, nr.size[2]!);
    const smallVol = Math.max(1e-6, Math.min(pr.a.volume, pr.b.volume));
    const volumeRatio = nr.vol / smallVol;
    const expected = pr.a.group === pr.b.group;
    // A singleton rigid group is a lone accessory (antenna, dial, armour plate,
    // side pod) whose whole structural job is to plug into the host it overlaps —
    // that deep overlap is the intended mount, not a clash.
    const singletonAttach = !expected &&
      (groups[pr.a.group]!.parts.length === 1 || groups[pr.b.group]!.parts.length === 1);
    let kind: CollisionPair["kind"];
    if (expected || singletonAttach) {
      kind = "joint";
    } else if (penetrationDepth >= DEEP_MM && volumeRatio >= VOLUME_RATIO) {
      kind = "unreasonable";
    } else {
      kind = "minor";
    }

    const pair: CollisionPair = {
      a: pr.a.name, b: pr.b.name,
      aabbOverlap: pr.ov,
      intersectionVolume: nr.vol,
      intersectionSize: nr.size,
      intersectionCenter: nr.center,
      penetrationDepth,
      volumeRatio,
      expected: expected || singletonAttach,
      kind,
    };

    if (kind === "unreasonable") {
      pair.suggestion = suggestSeparation(pr.a, pr.b, pr.ov, anchorSubgroups, infoByName);
    }
    pairs.push(pair);
  }

  // Order: unreasonable (deepest first), then joints/minor by depth.
  const rank = (k: CollisionPair["kind"]): number =>
    k === "unreasonable" ? 0 : k === "joint" ? 2 : 1;
  pairs.sort((x, y) => rank(x.kind) - rank(y.kind) || y.penetrationDepth - x.penetrationDepth);
  const unreasonable = pairs.filter((p) => p.kind === "unreasonable");

  return { parts, groups, pairs, unreasonable, skipped, modelSpan };
}

/** Suggest which limb to move and by how much to clear an overlap. Moves the
 *  LIGHTER limb (the anchor-subgroup with smaller summed part volume — an arm,
 *  not the leg it hangs beside; never the body) away from the other along the
 *  least-overlap axis (the cheapest separation direction). */
function suggestSeparation(
  a: CollisionPartInfo, b: CollisionPartInfo, ov: Vec3,
  anchorSubgroups: Map<string, string[]>,
  info: Map<string, CollisionPartInfo>,
): NonNullable<CollisionPair["suggestion"]> {
  const limbVol = (part: string): number =>
    (anchorSubgroups.get(part) ?? [part]).reduce((s, n) => s + (info.get(n)?.volume ?? 0), 0);
  // Prefer moving the lighter limb; a lone part is its own limb.
  const mover = limbVol(a.name) <= limbVol(b.name) ? a : b;
  const other = mover === a ? b : a;
  const limb = anchorSubgroups.get(mover.name) ?? [mover.name];

  // Least-overlap axis is the cheapest separation direction.
  let axisI = 0;
  for (let i = 1; i < 3; i++) if (ov[i]! < ov[axisI]!) axisI = i;
  const moverCenter = (mover.min[axisI]! + mover.max[axisI]!) / 2;
  const otherCenter = (other.min[axisI]! + other.max[axisI]!) / 2;
  const dir = moverCenter >= otherCenter ? 1 : -1;
  const dist = (ov[axisI]! + SEPARATION_MARGIN_MM) * dir;

  const delta: Vec3 = [0, 0, 0];
  delta[axisI] = Number(dist.toFixed(2));
  return {
    move: mover.name,
    group: limb,
    delta,
    axis: (["X", "Y", "Z"] as const)[axisI]!,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

const f1 = (n: number): string => n.toFixed(1);
const v3 = (v: Vec3): string => `[${v.map(f1).join(", ")}]`;

/** Human-readable report for the check_collisions tool + the finish gate. */
export function formatCollisions(r: CollisionResult): string {
  const lines: string[] = [];
  lines.push(
    `Collision scan: ${r.parts.length} placed parts in ${r.groups.length} rigid ` +
    `group(s), model span ${f1(r.modelSpan)} mm.`,
  );
  if (r.skipped.length) lines.push(`  (skipped, empty geometry: ${r.skipped.join(", ")})`);

  if (r.unreasonable.length === 0) {
    lines.push(`  → No UNREASONABLE collisions. ✓ (parts only overlap where they mate.)`);
  } else {
    lines.push(
      `  → ${r.unreasonable.length} UNREASONABLE collision(s): parts that are NOT in the ` +
      `same rigid group yet interpenetrate deeply. These are usually invisible in ` +
      `renders (buried inside the solid). Fix by moving one part's whole group with ` +
      `move_parts so they no longer clash.`,
    );
  }
  lines.push("");

  const show = (p: CollisionPair): void => {
    const s = p.suggestion;
    lines.push(
      `  [${p.kind.toUpperCase()}] ${p.a} ∩ ${p.b}: penetration ${f1(p.penetrationDepth)} mm, ` +
      `overlap vol ${p.intersectionVolume.toExponential(2)} mm³ ` +
      `(${(p.volumeRatio * 100).toFixed(0)}% of the smaller part), ` +
      `AABB overlap ${v3(p.aabbOverlap)} mm.`,
    );
    if (s) {
      lines.push(
        `        FIX: move_parts(parts=[${s.group.map((n) => `"${n}"`).join(", ")}], ` +
        `delta=${v3(s.delta)})  — shifts the ${s.move} group ~${f1(Math.abs(s.delta[
          s.axis === "X" ? 0 : s.axis === "Y" ? 1 : 2
        ]!))} mm along ${s.axis} to clear ${p.a === s.move ? p.b : p.a}. Tune the delta, ` +
        `then re-run check_collisions + compile (keep it connected).`,
      );
    }
  };

  for (const p of r.unreasonable) show(p);

  const minors = r.pairs.filter((p) => p.kind === "minor");
  const joints = r.pairs.filter((p) => p.kind === "joint");
  if (minors.length) {
    lines.push("");
    lines.push(`  ${minors.length} shallow surface-mate(s) across groups (not defects):`);
    for (const p of minors.slice(0, 8)) {
      lines.push(`    - ${p.a} ∩ ${p.b}: ${f1(p.penetrationDepth)} mm deep`);
    }
    if (minors.length > 8) lines.push(`    … +${minors.length - 8} more`);
  }
  if (joints.length) {
    lines.push(`  ${joints.length} in-group joint mate(s) (intended overlap).`);
  }
  return lines.join("\n");
}
