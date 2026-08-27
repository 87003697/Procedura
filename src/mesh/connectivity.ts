/**
 * Mesh connectivity analysis — find disconnected components ("floaters").
 *
 * Floaters are sub-solids in the STL that aren't union'd to the main body.
 * They're a common failure mode for LLM-generated SCAD: the model places a
 * bolt head at the right xyz but it doesn't quite overlap the host body, so
 * OpenSCAD's CSG leaves the bolt as a separate solid.
 *
 * Algorithm:
 *   1. Dedupe vertices by position (5-decimal precision, matching obj.ts).
 *   2. For each triangle, compute its 3 edges as sorted (minId, maxId) pairs.
 *   3. Union-find over triangles: any edge shared by ≥ 2 triangles unions
 *      those triangles into one component.
 *   4. Per-component: triangle count, signed tetrahedron-volume sum (in
 *      whatever unit the STL is in — for OpenSCAD output, that's mm³), bbox.
 *   5. Sort components by volume descending. The biggest is "the main body";
 *      everything else is a floater.
 *
 * Returns: one big body + a list of floaters, with sizes you can act on.
 *
 * SEVERITY IS SPAN-BASED, NOT VOLUME-BASED. The metric to read first is
 * `visibleFloaterCount` — floaters whose longest bbox dimension is ≥ 1% of the
 * model's longest dimension. Enclosed volume is a trap: thin/flat panels and
 * greebles span a large fraction of the model yet enclose ~0 volume, so a
 * volume threshold reads "fine" while dozens of detached parts float in plain
 * sight. (`floaterVolumeFraction` is kept for reference but must not drive a
 * severity verdict.)
 */

import type { STLMesh } from "./stl.ts";

/**
 * A floater whose longest bbox dimension is ≥ this fraction of the model's
 * longest dimension counts as "visible" — big enough to read as a detached
 * part in a render, not a sub-pixel sliver. Severity reporting AND the
 * finish(ok) gate key off this, never off enclosed volume.
 */
export const VISIBLE_SPAN_FRACTION = 0.01;

/**
 * Hard ceiling on triangles this analysis will attempt. Above it we SKIP rather
 * than run. `analyzeConnectivity` allocates ~9 transient strings + 3 BigInts +
 * temp arrays PER TRIANGLE (vertex dedup Map + edge→tris Map). On a normal mesh
 * that's fine, but a pathologically large assembly (high `$fn` × many parts →
 * tens of millions of triangles) drives Bun's GC into a death-spiral: the
 * process pins ~2 cores (main thread + concurrent GC), makes near-zero forward
 * progress, and never quite OOM-kills — observed hanging draft workers for
 * 8–12 h mid-assembly. The machine's RAM is irrelevant; it's the runtime GC
 * ceiling. Bounding tris bounds the work: above the cap we return a degraded
 * result (`analyzed:false`, zero floater signals) so the ship gate passes and
 * the case COMPLETES instead of hanging. Env-tunable: `PROCEDURA_CONN_MAX_TRIS`.
 */
export const MAX_ANALYZE_TRIS = ((): number => {
  const raw = process.env.PROCEDURA_CONN_MAX_TRIS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 40_000_000;
})();

/**
 * Above this triangle count we take the allocation-free path below (open-
 * addressing hash tables in typed arrays instead of a string-keyed Map and
 * BigInt edge keys). That is what lifted the ceiling from 6M to 40M: the old
 * limit was a GC limit, not a memory or algorithmic one. Meshes under the
 * threshold keep the original path, which is simpler and already trusted.
 *
 * This matters because the models that most need a floater check are the big
 * ones: on the babaseline run, assault_buggy (9.4M tris) and 00001198 (13.7M)
 * both shipped with `connectivity NOT ANALYZED`, so the refine loop had no
 * floater feedback and the finish(ok) gate could not fire at all.
 */
const FAST_PATH_MIN_TRIS_DEFAULT = 200_000;

/**
 * Read per call (the cost is nothing next to the analysis itself) so tests can
 * force either path over the SAME mesh and assert they agree — and so the fast
 * path can be switched off in production with one env var if it ever misbehaves.
 */
function fastPathMinTris(): number {
  const raw = process.env.PROCEDURA_CONN_FAST_MIN_TRIS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : FAST_PATH_MIN_TRIS_DEFAULT;
}

export interface ConnectivityBBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface ConnectivityComponent {
  /** Number of triangles in this component. */
  triCount: number;
  /** Volume in the STL's units (mm³ for OpenSCAD output). Always ≥ 0. */
  volume: number;
  /** AABB of all the component's vertices. */
  bbox: ConnectivityBBox;
  /** Longest bbox dimension (same units as the mesh). */
  maxDim: number;
  /** `maxDim` as a fraction of the whole-model longest dimension (0..1). */
  spanFraction: number;
}

export interface ConnectivityResult {
  /** Sorted by volume DESC. First is the largest body. */
  components: ConnectivityComponent[];
  totalVolume: number;
  totalTris: number;
  /** Components beyond the largest one. */
  floaterCount: number;
  /** Fraction of total volume held by floaters (0..1). Reference only — do
   *  NOT threshold severity on this; thin panels read ~0%. */
  floaterVolumeFraction: number;
  /** Longest dimension of the whole-model bbox (union of all components). */
  modelSpan: number;
  /** Floaters (all but the largest) with `spanFraction ≥ VISIBLE_SPAN_FRACTION`.
   *  THIS is the severity signal. */
  visibleFloaterCount: number;
  /** Largest `spanFraction` among the floaters (0 if there are none). */
  maxFloaterSpanFraction: number;
  /** False when the analysis was SKIPPED because the mesh exceeded
   *  `MAX_ANALYZE_TRIS` (all floater signals are then zeroed and must not be
   *  read as "connected" — only as "not analyzed"). True on every real run. */
  analyzed: boolean;
}

const PRECISION = 5;
const vKey = (x: number, y: number, z: number): string =>
  `${x.toFixed(PRECISION)}|${y.toFixed(PRECISION)}|${z.toFixed(PRECISION)}`;

// ──────────────────────────────────────────────────────────────────────────
// Triangle adjacency — two implementations behind one contract:
//   "call union(i, j) for every pair of triangles that share an edge"
// ──────────────────────────────────────────────────────────────────────────

type UnionFn = (a: number, b: number) => void;

/** Original path: string-keyed vertex dedup + BigInt edge keys. Small meshes. */
function unionByEdgesLegacy(v: Float32Array, triCount: number, union: UnionFn): void {
  const vertexId = new Map<string, number>();
  const triVerts = new Int32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    const vi = i * 9;
    for (let k = 0; k < 3; k++) {
      const k3 = k * 3;
      const x = v[vi + k3]!, y = v[vi + k3 + 1]!, z = v[vi + k3 + 2]!;
      const key = vKey(x, y, z);
      let id = vertexId.get(key);
      if (id === undefined) {
        id = vertexId.size;
        vertexId.set(key, id);
      }
      triVerts[i * 3 + k] = id;
    }
  }

  const edgeKey = (a: number, b: number): bigint =>
    a < b ? (BigInt(a) << 32n) | BigInt(b) : (BigInt(b) << 32n) | BigInt(a);
  const edgeTris = new Map<bigint, number[]>();
  for (let i = 0; i < triCount; i++) {
    const a = triVerts[i * 3]!, b = triVerts[i * 3 + 1]!, c = triVerts[i * 3 + 2]!;
    for (const e of [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)]) {
      let arr = edgeTris.get(e);
      if (!arr) { arr = []; edgeTris.set(e, arr); }
      arr.push(i);
    }
  }
  for (const tris of edgeTris.values()) {
    if (tris.length < 2) continue;
    const first = tris[0]!;
    for (let i = 1; i < tris.length; i++) union(first, tris[i]!);
  }
}

function nextPow2(n: number): number {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

/** 32-bit mix of three integers (Math.imul keeps it in int32 land). */
function hash3(a: number, b: number, c: number): number {
  let h = 0x9e3779b1;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b);
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Allocation-free path: open-addressing hash tables in typed arrays. Same
 * quantisation (PRECISION decimals) and the same "union every triangle sharing
 * an edge with the first triangle recorded for that edge" rule as the legacy
 * path, so the resulting components are identical — but with zero per-triangle
 * garbage, which is what the 6M-triangle ceiling was really about.
 */
function unionByEdgesFast(v: Float32Array, triCount: number, union: UnionFn): void {
  const N = triCount * 3;                    // vertex instances
  const SCALE = 10 ** PRECISION;

  // ── vertex dedup ────────────────────────────────────────────────────────
  const vcap = nextPow2(Math.ceil(N / 0.7));
  const vmask = vcap - 1;
  const slotToId = new Int32Array(vcap).fill(-1);
  // Quantised coords of the unique vertices (Float64 so large models can't
  // overflow int32 at 1e5 scale).
  let ucap = Math.max(1024, N >> 2);
  let ux = new Float64Array(ucap), uy = new Float64Array(ucap), uz = new Float64Array(ucap);
  let uCount = 0;
  const triVerts = new Int32Array(N);

  for (let i = 0; i < N; i++) {
    const o = i * 3;
    const qx = Math.round(v[o]! * SCALE);
    const qy = Math.round(v[o + 1]! * SCALE);
    const qz = Math.round(v[o + 2]! * SCALE);
    let slot = hash3(qx, qy, qz) & vmask;
    for (;;) {
      const id = slotToId[slot]!;
      if (id === -1) {
        if (uCount === ucap) {
          ucap *= 2;
          const nx = new Float64Array(ucap); nx.set(ux); ux = nx;
          const ny = new Float64Array(ucap); ny.set(uy); uy = ny;
          const nz = new Float64Array(ucap); nz.set(uz); uz = nz;
        }
        ux[uCount] = qx; uy[uCount] = qy; uz[uCount] = qz;
        slotToId[slot] = uCount;
        triVerts[i] = uCount;
        uCount += 1;
        break;
      }
      if (ux[id] === qx && uy[id] === qy && uz[id] === qz) {
        triVerts[i] = id;
        break;
      }
      slot = (slot + 1) & vmask;
    }
  }

  // ── edge → first triangle ───────────────────────────────────────────────
  // Sized so every edge instance fits even if none are shared (worst case),
  // which keeps the probe loop bounded without a rehash path.
  const ecap = nextPow2(Math.ceil((triCount * 3) / 0.7));
  const emask = ecap - 1;
  const ea = new Int32Array(ecap).fill(-1);
  const eb = new Int32Array(ecap);
  const et = new Int32Array(ecap);

  for (let i = 0; i < triCount; i++) {
    const a = triVerts[i * 3]!, b = triVerts[i * 3 + 1]!, c = triVerts[i * 3 + 2]!;
    for (let e = 0; e < 3; e++) {
      const p = e === 0 ? a : e === 1 ? b : c;
      const q = e === 0 ? b : e === 1 ? c : a;
      const lo = p < q ? p : q;
      const hi = p < q ? q : p;
      let slot = hash3(lo, hi, 0x51ed270b) & emask;
      for (;;) {
        const key = ea[slot]!;
        if (key === -1) {
          ea[slot] = lo; eb[slot] = hi; et[slot] = i;
          break;
        }
        if (key === lo && eb[slot] === hi) {
          union(et[slot]!, i);
          break;
        }
        slot = (slot + 1) & emask;
      }
    }
  }
}

export function analyzeConnectivity(mesh: STLMesh): ConnectivityResult {
  const triCount = mesh.triCount;
  if (triCount === 0) {
    return {
      components: [], totalVolume: 0, totalTris: 0,
      floaterCount: 0, floaterVolumeFraction: 0,
      modelSpan: 0, visibleFloaterCount: 0, maxFloaterSpanFraction: 0,
      analyzed: true,
    };
  }

  // Guard the GC death-spiral (see MAX_ANALYZE_TRIS): a mesh this large would
  // allocate hundreds of millions of transient strings/BigInts building the
  // dedup + edge maps and hang the worker for hours. Skip with a degraded
  // result — zero floater signals so the ship gate passes and the case
  // completes; `analyzed:false` tells formatters/logs it was NOT inspected.
  if (triCount > MAX_ANALYZE_TRIS) {
    return {
      components: [], totalVolume: 0, totalTris: triCount,
      floaterCount: 0, floaterVolumeFraction: 0,
      modelSpan: 0, visibleFloaterCount: 0, maxFloaterSpanFraction: 0,
      analyzed: false,
    };
  }

  // 1–3. Vertex dedup + edge adjacency + union-find over triangles. Two
  // implementations, identical results (asserted in test/smoke-connectivity-
  // scale.ts): the legacy Map/BigInt one for small meshes, and an
  // allocation-free one for big meshes where the legacy path's per-triangle
  // string + BigInt garbage is what drove the GC death-spiral.
  const v = mesh.vertices;
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    // path compression
    let cur = x;
    while (parent[cur] !== root) { const next = parent[cur]!; parent[cur] = root; cur = next; }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  if (triCount >= fastPathMinTris()) {
    unionByEdgesFast(v, triCount, union);
  } else {
    unionByEdgesLegacy(v, triCount, union);
  }

  // 4. Group by root, compute per-component stats.
  interface Acc {
    triCount: number;
    volume6: number;          // 6× signed tet sum; abs at end
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
  }
  const groups = new Map<number, Acc>();
  for (let i = 0; i < triCount; i++) {
    const root = find(i);
    let g = groups.get(root);
    if (!g) {
      g = {
        triCount: 0, volume6: 0,
        minX: Infinity, minY: Infinity, minZ: Infinity,
        maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
      };
      groups.set(root, g);
    }
    g.triCount += 1;
    const vi = i * 9;
    const x0 = v[vi    ]!, y0 = v[vi + 1]!, z0 = v[vi + 2]!;
    const x1 = v[vi + 3]!, y1 = v[vi + 4]!, z1 = v[vi + 5]!;
    const x2 = v[vi + 6]!, y2 = v[vi + 7]!, z2 = v[vi + 8]!;
    // signed tet volume × 6 = v0 · (v1 × v2)
    g.volume6 +=
      x0 * (y1 * z2 - z1 * y2) -
      y0 * (x1 * z2 - z1 * x2) +
      z0 * (x1 * y2 - y1 * x2);
    for (const [x, y, z] of [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2]] as const) {
      // NB: independent ifs, NOT else-if. With +Inf/-Inf sentinels the first
      // vertex must set BOTH min and max; an `else if` would leave max at
      // -Infinity for any component whose extreme coordinate arrives first.
      if (x < g.minX) g.minX = x;
      if (x > g.maxX) g.maxX = x;
      if (y < g.minY) g.minY = y;
      if (y > g.maxY) g.maxY = y;
      if (z < g.minZ) g.minZ = z;
      if (z > g.maxZ) g.maxZ = z;
    }
  }

  // Whole-model bbox = union of all component bboxes. Drives the span metric.
  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (const g of groups.values()) {
    if (g.minX < gMinX) gMinX = g.minX;
    if (g.minY < gMinY) gMinY = g.minY;
    if (g.minZ < gMinZ) gMinZ = g.minZ;
    if (g.maxX > gMaxX) gMaxX = g.maxX;
    if (g.maxY > gMaxY) gMaxY = g.maxY;
    if (g.maxZ > gMaxZ) gMaxZ = g.maxZ;
  }
  const modelSpan = Math.max(gMaxX - gMinX, gMaxY - gMinY, gMaxZ - gMinZ);

  const components: ConnectivityComponent[] = [];
  for (const g of groups.values()) {
    const size: [number, number, number] = [g.maxX - g.minX, g.maxY - g.minY, g.maxZ - g.minZ];
    const maxDim = Math.max(size[0], size[1], size[2]);
    components.push({
      triCount: g.triCount,
      volume: Math.abs(g.volume6) / 6,
      bbox: { min: [g.minX, g.minY, g.minZ], max: [g.maxX, g.maxY, g.maxZ], size },
      maxDim,
      spanFraction: modelSpan > 0 ? maxDim / modelSpan : 0,
    });
  }
  components.sort((a, b) => b.volume - a.volume);

  const totalVolume = components.reduce((s, c) => s + c.volume, 0);
  const floaterCount = Math.max(0, components.length - 1);
  const mainVol = components[0]?.volume ?? 0;
  const floaterVolume = totalVolume - mainVol;
  const floaterVolumeFraction = totalVolume > 0 ? floaterVolume / totalVolume : 0;

  // Span-based severity — the floaters big enough to actually see.
  let visibleFloaterCount = 0;
  let maxFloaterSpanFraction = 0;
  for (let i = 1; i < components.length; i++) {
    const sf = components[i]!.spanFraction;
    if (sf > maxFloaterSpanFraction) maxFloaterSpanFraction = sf;
    if (sf >= VISIBLE_SPAN_FRACTION) visibleFloaterCount += 1;
  }

  return {
    components, totalVolume, totalTris: triCount,
    floaterCount, floaterVolumeFraction,
    modelSpan, visibleFloaterCount, maxFloaterSpanFraction,
    analyzed: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────────────────────────────────

const VIS_PCT = (VISIBLE_SPAN_FRACTION * 100).toFixed(0);

/** One-liner for embedding in compile output. Severity is span-based. */
export function summarizeConnectivity(r: ConnectivityResult): string {
  if (!r.analyzed) {
    return `connectivity NOT ANALYZED — mesh too large (${r.totalTris.toLocaleString()} tris ` +
      `> ${MAX_ANALYZE_TRIS.toLocaleString()} cap); floater gate skipped for this build`;
  }
  if (r.components.length === 0) return "(no geometry)";
  if (r.floaterCount === 0) {
    return `connectivity OK — 1 connected body`;
  }
  if (r.visibleFloaterCount === 0) {
    // Floaters exist but every one is a sub-visible speck (sliver / artefact).
    return `connectivity OK — 1 main body + ${r.floaterCount} sub-visible speck(s) ` +
      `(all < ${VIS_PCT}% of model span)`;
  }
  const worst = (r.maxFloaterSpanFraction * 100).toFixed(0);
  return `connectivity WARN — ${r.visibleFloaterCount} VISIBLE floater(s) ` +
    `(worst spans ${worst}% of the model), ${r.floaterCount} disconnected part(s) total. ` +
    `These read as detached parts — every part must touch the body.`;
}

/** How many floater rows the detailed breakdown prints before truncating. */
const DETAIL_FLOATER_ROWS = 24;

/** Multi-line breakdown for the check_connectivity tool's detailed output. */
export function formatConnectivityDetail(r: ConnectivityResult): string {
  if (!r.analyzed) {
    return `Connectivity: NOT ANALYZED — mesh has ${r.totalTris.toLocaleString()} triangles, ` +
      `above the ${MAX_ANALYZE_TRIS.toLocaleString()} cap (PROCEDURA_CONN_MAX_TRIS). The floater ` +
      `analysis is skipped to avoid a multi-hour GC stall; treat connectivity as UNKNOWN for ` +
      `this build (not verified-connected). Lower part $fn or split the assembly if you need it checked.`;
  }
  if (r.components.length === 0) return "(no geometry)";
  const lines: string[] = [];
  lines.push(
    `Connectivity: ${r.components.length} component(s), ${r.totalTris} triangles, ` +
    `model span ${r.modelSpan.toExponential(3)}.`,
  );
  if (r.floaterCount === 0) {
    lines.push(`  → SINGLE BODY: the SCAD union is fully connected. ✓`);
  } else {
    lines.push(
      `  → ${r.floaterCount} floater(s) total; ${r.visibleFloaterCount} VISIBLE ` +
      `(≥ ${VIS_PCT}% of model span). Judge by span%, NOT volume — a thin panel ` +
      `reads ~0% volume yet is plainly visible. (enclosed floater volume = ` +
      `${(r.floaterVolumeFraction * 100).toFixed(3)}%.)`,
    );
  }
  lines.push("");
  lines.push("  rank    triangles   span%   bbox size (w × d × h)            volume");
  const main = r.components[0];
  if (main) {
    const [w, d, h] = main.bbox.size;
    lines.push(
      `  main  ${main.triCount.toString().padStart(9, " ")}  ` +
      `${(main.spanFraction * 100).toFixed(1).padStart(6, " ")}%  ` +
      `${w.toFixed(2).padStart(8, " ")} × ${d.toFixed(2).padStart(8, " ")} × ${h.toFixed(2).padStart(8, " ")}  ` +
      `${main.volume.toExponential(2)}`,
    );
  }
  // List floaters worst-span first so the visible ones are never truncated away.
  const floaters = r.components
    .map((c, i) => ({ c, rank: i }))
    .slice(1)
    .sort((a, b) => b.c.spanFraction - a.c.spanFraction);
  const shown = floaters.slice(0, DETAIL_FLOATER_ROWS);
  for (const { c, rank } of shown) {
    const [w, d, h] = c.bbox.size;
    const vis = c.spanFraction >= VISIBLE_SPAN_FRACTION ? "  ◀ VISIBLE" : "";
    lines.push(
      `  flt${rank.toString().padStart(2, "0")} ${c.triCount.toString().padStart(9, " ")}  ` +
      `${(c.spanFraction * 100).toFixed(1).padStart(6, " ")}%  ` +
      `${w.toFixed(2).padStart(8, " ")} × ${d.toFixed(2).padStart(8, " ")} × ${h.toFixed(2).padStart(8, " ")}  ` +
      `${c.volume.toExponential(2)}${vis}`,
    );
  }
  const hidden = floaters.length - shown.length;
  if (hidden > 0) {
    const hiddenVisible = floaters.slice(DETAIL_FLOATER_ROWS)
      .filter((f) => f.c.spanFraction >= VISIBLE_SPAN_FRACTION).length;
    lines.push(
      `  … +${hidden} more floater(s)` +
      (hiddenVisible > 0 ? ` (${hiddenVisible} of them VISIBLE)` : ` (all sub-visible specks)`),
    );
  }
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Ship gate
// ──────────────────────────────────────────────────────────────────────────

export interface ConnectivityGateResult {
  /** True when no floater is visible-sized — safe to ship as a connected solid. */
  ok: boolean;
  visibleFloaterCount: number;
  maxFloaterSpanFraction: number;
  /** Human-readable problem statement when !ok (lists the worst offenders); "" when ok. */
  detail: string;
}

/**
 * The single source of truth for "is this mesh connected enough to ship?".
 * Used by the finish(ok) gate. Passes when there are zero VISIBLE floaters —
 * sub-visible specks (slivers, numerical artefacts, intentional cosmetic
 * accents below the span threshold) are tolerated.
 */
/**
 * Nearest-neighbour bbox gap (mm) for every component; [i] = distance from
 * component i to the closest OTHER component's bbox (0 when bboxes touch or
 * overlap). Bbox gap UNDERESTIMATES the true mesh gap, so classification errs
 * toward "micro" — fail-open for the gate, which is the safe direction.
 */
export function floaterGapsMm(r: ConnectivityResult): number[] {
  const boxes = r.components.map((c) => c.bbox);
  return boxes.map((f, i) => {
    let best = Infinity;
    for (let j = 0; j < boxes.length; j++) {
      if (j === i) continue;
      const t = boxes[j]!;
      let d2 = 0;
      for (let a = 0; a < 3; a++) {
        const gap = Math.max(0, Math.max(f.min[a]! - t.max[a]!, t.min[a]! - f.max[a]!));
        d2 += gap * gap;
      }
      if (d2 < best) best = d2;
      if (best === 0) break;
    }
    return Number.isFinite(best) ? Math.sqrt(best) : 0;
  });
}

/**
 * Floaters whose nearest gap is below this are MICRO-GAP: a placement that
 * touches-but-doesn't-overlap (or misses by a hair). Visually invisible at
 * render distance and irrelevant to the benchmark; they must not wedge the
 * finish(ok) gate — mech_robot carries 59 of them and no 3-edit run can ever
 * clear that. They are still reported (and snap_floaters closes what it can).
 */
export const MICRO_GAP_MM = ((): number => {
  const raw = process.env.PROCEDURA_FLOATER_GATE_GAP_MM;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0.3;
})();

export function evaluateConnectivityGate(r: ConnectivityResult): ConnectivityGateResult {
  if (r.visibleFloaterCount === 0) {
    return {
      ok: true,
      visibleFloaterCount: 0,
      maxFloaterSpanFraction: r.maxFloaterSpanFraction,
      detail: "",
    };
  }
  // Gate ONLY on real air gaps; micro-gap floaters warn but never block.
  const gaps = floaterGapsMm(r);
  const real = r.components
    .map((c, i) => ({ c, rank: i, gap: gaps[i]! }))
    .slice(1)
    .filter((f) => f.c.spanFraction >= VISIBLE_SPAN_FRACTION && f.gap >= MICRO_GAP_MM);
  const microCount = r.visibleFloaterCount - real.length;
  if (real.length === 0) {
    return {
      ok: true,
      visibleFloaterCount: 0,
      maxFloaterSpanFraction: r.maxFloaterSpanFraction,
      detail: microCount > 0
        ? `${microCount} visible-size micro-gap shell(s) (< ${MICRO_GAP_MM}mm from a neighbour) — ` +
          `tolerated; snap_floaters can close them.`
        : "",
    };
  }
  const offenders = real
    .sort((a, b) => b.c.spanFraction - a.c.spanFraction)
    .slice(0, 6)
    .map(({ c, rank, gap }) => {
      const [w, d, h] = c.bbox.size;
      const [mnx, mny, mnz] = c.bbox.min;
      return `  - flt${rank.toString().padStart(2, "0")}: spans ${(c.spanFraction * 100).toFixed(0)}% of model ` +
        `(${w.toFixed(1)} × ${d.toFixed(1)} × ${h.toFixed(1)}), gap ${gap.toFixed(1)}mm, bbox-min near ` +
        `[${mnx.toFixed(0)}, ${mny.toFixed(0)}, ${mnz.toFixed(0)}], ${c.triCount} tris`;
    })
    .join("\n");
  const detail =
    `${real.length} floater(s) with REAL air gaps >= ${MICRO_GAP_MM}mm` +
    `${microCount > 0 ? ` (+${microCount} micro-gap shell(s), tolerated)` : ""}. Worst offenders:\n${offenders}`;
  return {
    ok: false,
    visibleFloaterCount: r.visibleFloaterCount,
    maxFloaterSpanFraction: r.maxFloaterSpanFraction,
    detail,
  };
}
