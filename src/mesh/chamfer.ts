/**
 * Symmetric chamfer distance between two OBJ meshes (zero deps).
 *
 * Procedure (deterministic — seeded RNG):
 *   1. normalize EACH mesh independently: center its bbox at the origin and
 *      uniformly scale the longest bbox dimension to 2 — the same canonical
 *      frame normalize.ts applies to final.obj (targetHalfExtent = 1). This
 *      makes meshes at different scales/positions (e.g. a raw draft.obj vs a
 *      normalized final.obj) comparable, and cancels pure translation/scale;
 *   2. area-weighted-sample N points per mesh, uniform over triangles;
 *   3. nearest neighbours via a uniform spatial hash grid, cell ≈ 2/cbrt(N).
 *
 * aToB is the MEAN Euclidean distance from each A sample to its nearest B
 * sample; `chamfer = (aToB + bToA) / 2`. In the canonical frame the model
 * spans [-1, 1] on its longest axis, so 0.05 ≈ 2.5% of the longest dimension.
 * The sampling-noise floor at N = 20k is ≈ 0.01–0.02 (mean spacing of two
 * independent samplings of the same surface) — don't read values below that.
 *
 * This measures geometric DRIFT between two meshes (how much the shape
 * changed), not quality against a reference.
 */

import { loadOBJ } from "./obj.ts";
import { computeBBox, transformInPlace, type STLMesh } from "./stl.ts";

export interface ChamferOpts {
  /** Sample points per mesh. Default 20_000. */
  samples?: number;
  /** Canonicalize each mesh before sampling (default true). Disable only for
   * meshes already in a shared frame; NN cost grows with cloud separation. */
  normalize?: boolean;
  /** RNG seed (default 0x5eed) — results are deterministic for a given seed. */
  seed?: number;
}

export interface ChamferResult {
  /** (aToB + bToA) / 2 — symmetric mean nearest-neighbour distance. */
  chamfer: number;
  aToB: number;
  bToA: number;
  samples: number;
}

/** Deterministic 32-bit PRNG (mulberry32) — no Math.random anywhere here. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Match normalize.ts semantics: center bbox at origin, longest dim → 2. */
function normalizeInPlace(mesh: STLMesh): void {
  const b = computeBBox(mesh);
  const longest = Math.max(...b.size);
  if (longest <= 0) throw new Error("chamfer: zero-size bbox");
  const cx = (b.min[0] + b.max[0]) * 0.5;
  const cy = (b.min[1] + b.max[1]) * 0.5;
  const cz = (b.min[2] + b.max[2]) * 0.5;
  transformInPlace(mesh, [cx, cy, cz], 2 / longest);
}

/** Area-weighted uniform surface sampling: pick a triangle ∝ its area (binary
 * search over cumulative areas), then a uniform barycentric point (√u trick). */
function samplePoints(mesh: STLMesh, n: number, rand: () => number): Float64Array {
  const v = mesh.vertices;
  const cum = new Float64Array(mesh.triCount);
  let total = 0;
  for (let i = 0; i < mesh.triCount; i++) {
    const o = i * 9;
    const ux = v[o + 3]! - v[o]!, uy = v[o + 4]! - v[o + 1]!, uz = v[o + 5]! - v[o + 2]!;
    const wx = v[o + 6]! - v[o]!, wy = v[o + 7]! - v[o + 1]!, wz = v[o + 8]! - v[o + 2]!;
    const cxp = uy * wz - uz * wy, cyp = uz * wx - ux * wz, czp = ux * wy - uy * wx;
    total += Math.hypot(cxp, cyp, czp) * 0.5;
    cum[i] = total;
  }
  if (total <= 0) throw new Error("chamfer: mesh has zero surface area");
  const pts = new Float64Array(n * 3);
  for (let s = 0; s < n; s++) {
    const r = rand() * total;
    // first index with cum[idx] >= r
    let lo = 0, hi = mesh.triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < r) lo = mid + 1; else hi = mid;
    }
    const o = lo * 9;
    const su = Math.sqrt(rand());
    const t = rand();
    const a = 1 - su, b = su * (1 - t), c = su * t;
    pts[s * 3]     = a * v[o]!     + b * v[o + 3]! + c * v[o + 6]!;
    pts[s * 3 + 1] = a * v[o + 1]! + b * v[o + 4]! + c * v[o + 7]!;
    pts[s * 3 + 2] = a * v[o + 2]! + b * v[o + 5]! + c * v[o + 8]!;
  }
  return pts;
}

// ── uniform spatial hash grid ──────────────────────────────────────────────
// Cell indices are offset by +512 and packed into one int (10 bits/axis).
// With cell ≈ 2/cbrt(N) and normalized clouds the index range is tiny; the
// clamp below keeps the packing valid even for unnormalized inputs.

const OFF = 512;
const clampIdx = (i: number): number => (i < -OFF ? -OFF : i > OFF - 1 ? OFF - 1 : i);
const packKey = (ix: number, iy: number, iz: number): number =>
  ((ix + OFF) << 20) | ((iy + OFF) << 10) | (iz + OFF);

interface Grid {
  cells: Map<number, number[]>;
  cell: number;
  // occupied index bounds — lets queries skip rings that cannot intersect any
  // occupied cell (critical when the clouds barely overlap)
  min: [number, number, number];
  max: [number, number, number];
}

function buildGrid(pts: Float64Array, cell: number): Grid {
  const cells = new Map<number, number[]>();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) {
    const ix = clampIdx(Math.floor(pts[i]! / cell));
    const iy = clampIdx(Math.floor(pts[i + 1]! / cell));
    const iz = clampIdx(Math.floor(pts[i + 2]! / cell));
    if (ix < min[0]) min[0] = ix; if (ix > max[0]) max[0] = ix;
    if (iy < min[1]) min[1] = iy; if (iy > max[1]) max[1] = iy;
    if (iz < min[2]) min[2] = iz; if (iz > max[2]) max[2] = iz;
    const key = packKey(ix, iy, iz);
    const arr = cells.get(key);
    if (arr) arr.push(i); else cells.set(key, [i]);
  }
  return { cells, cell, min, max };
}

/** Nearest-neighbour distance from (qx,qy,qz) to the gridded cloud: expanding
 * Chebyshev rings around the query cell. A ring-r cell can hold no point
 * closer than (r-1)·cell, so the search stops once the best hit beats that
 * bound. Rings that cannot intersect the occupied bounds are skipped. */
function nearestDist(grid: Grid, pts: Float64Array, qx: number, qy: number, qz: number): number {
  const { cells, cell, min, max } = grid;
  const cx = clampIdx(Math.floor(qx / cell));
  const cy = clampIdx(Math.floor(qy / cell));
  const cz = clampIdx(Math.floor(qz / cell));
  // Chebyshev distance from the query cell to the occupied bbox — no ring
  // below this can contain a point.
  const gap = (c: number, lo: number, hi: number): number => (c < lo ? lo - c : c > hi ? c - hi : 0);
  const rStart = Math.max(gap(cx, min[0], max[0]), gap(cy, min[1], max[1]), gap(cz, min[2], max[2]));
  const rMax = Math.max(
    Math.abs(cx - min[0]), Math.abs(cx - max[0]),
    Math.abs(cy - min[1]), Math.abs(cy - max[1]),
    Math.abs(cz - min[2]), Math.abs(cz - max[2]),
  );
  let bestSq = Infinity;
  for (let r = rStart; r <= rMax; r++) {
    if (r > rStart) {
      const bound = (r - 1) * cell;
      if (bestSq <= bound * bound) break; // ring r cannot beat the current best
    }
    const x0 = Math.max(cx - r, min[0]), x1 = Math.min(cx + r, max[0]);
    const y0 = Math.max(cy - r, min[1]), y1 = Math.min(cy + r, max[1]);
    const z0 = Math.max(cz - r, min[2]), z1 = Math.min(cz + r, max[2]);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          // shell only — interior cells were visited at smaller r
          const d = Math.max(Math.abs(ix - cx), Math.abs(iy - cy), Math.abs(iz - cz));
          if (d !== r) continue;
          const arr = cells.get(packKey(ix, iy, iz));
          if (!arr) continue;
          for (const i of arr) {
            const dx = pts[i]! - qx, dy = pts[i + 1]! - qy, dz = pts[i + 2]! - qz;
            const sq = dx * dx + dy * dy + dz * dz;
            if (sq < bestSq) bestSq = sq;
          }
        }
      }
    }
  }
  return Math.sqrt(bestSq);
}

function meanNearest(from: Float64Array, to: Float64Array, cell: number): number {
  const grid = buildGrid(to, cell);
  let sum = 0;
  const n = from.length / 3;
  for (let i = 0; i < n; i++) {
    sum += nearestDist(grid, to, from[i * 3]!, from[i * 3 + 1]!, from[i * 3 + 2]!);
  }
  return sum / n;
}

/** Chamfer between two already-loaded meshes. Mutates BOTH meshes when
 * normalizing (loadOBJ returns private copies, so callers of chamferOBJ are
 * unaffected; pass copies yourself if you reuse the mesh objects). */
export function chamferBetween(a: STLMesh, b: STLMesh, opts: ChamferOpts = {}): ChamferResult {
  if (a.triCount === 0 || b.triCount === 0) throw new Error("chamfer: empty mesh");
  const n = Math.max(16, Math.floor(opts.samples ?? 20_000));
  const normalize = opts.normalize ?? true;
  const seed = opts.seed ?? 0x5eed;
  if (normalize) { normalizeInPlace(a); normalizeInPlace(b); }
  // distinct RNG streams so identical meshes still yield two independent
  // clouds (an exact-0 from shared samples would hide normalization bugs)
  const pa = samplePoints(a, n, mulberry32(seed));
  const pb = samplePoints(b, n, mulberry32(seed ^ 0x9e3779b9));
  const cell = 2 / Math.cbrt(n);
  const aToB = meanNearest(pa, pb, cell);
  const bToA = meanNearest(pb, pa, cell);
  return { chamfer: (aToB + bToA) / 2, aToB, bToA, samples: n };
}

/** Symmetric chamfer distance between two OBJ files. */
export function chamferOBJ(pathA: string, pathB: string, opts: ChamferOpts = {}): ChamferResult {
  return chamferBetween(loadOBJ(pathA), loadOBJ(pathB), opts);
}
