/**
 * Deterministic geometric evidence for articulation planning.
 *
 * Pure TypeScript, zero deps, no OpenSCAD/Isaac. Consumes per-part triangle
 * meshes (STLMesh, world/assembled coordinates) and produces:
 *
 *   - Rotational-symmetry axes (wheels/shafts/knobs are symmetric about their
 *     spin axis). Method: downsample vertices, take area-weighted centroid +
 *     covariance principal axes (Jacobi eigen solve), rotate the point set 90°
 *     and 180° about each candidate axis and score by mean nearest-neighbor
 *     distance to the original set (uniform spatial hash grid).
 *   - Contact regions between part pairs (a hinge's contact strip is
 *     elongated along the hinge axis). Method: sample vertices + triangle
 *     centroids on both meshes, grid-collect A-samples within maxDistance of
 *     any B-sample, then report the close set's centroid / extent / principal
 *     direction / elongation.
 *
 * Everything is deterministic: fixed iteration order, uniform stride
 * downsampling, no randomness. Sampling caps keep 30 parts x 50k tris within
 * a few seconds.
 *
 * Known limits (documented, by design):
 *   - Nearest-neighbor search only inspects the 27 cells around a query
 *     (cell ~2% of the bbox diagonal); anything farther is clamped to the
 *     score-zero distance (5% of the diagonal), which makes scores slightly
 *     conservative for shapes whose symmetry error lands between 2% and 5%.
 *   - Spheres / near-cubes are symmetric about many axes; they are flagged
 *     `degenerate: true` (second-best axis within 0.08 of best) and demoted
 *     to low confidence rather than suppressed.
 *   - Principal axes come from area-weighted triangle-centroid covariance;
 *     for isotropic shapes the eigenvectors are arbitrary (any orthogonal
 *     basis is valid), which is exactly the degenerate case above.
 */

import { computeBBox, type STLMesh } from "../mesh/stl.ts";

type Vec3 = [number, number, number];

export interface SymmetryAxisEvidence {
  part: string;
  axisPoint: [number, number, number];
  axisDir: [number, number, number];
  snappedAxis: "X" | "Y" | "Z" | null;
  radialProfile: { meanRadius: number; radiusStd: number };
  symmetryScore: number;
  confidence: "high" | "medium" | "low";
  /** True when a second axis scores within 0.08 of the best (sphere/cube-like). */
  degenerate: boolean;
}

export interface ContactRegionEvidence {
  partA: string;
  partB: string;
  anchor: [number, number, number];
  extent: [number, number, number];
  principalDir: [number, number, number] | null;
  snappedAxis: "X" | "Y" | "Z" | null;
  elongation: number;
  sampleCount: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Small vector helpers
// ──────────────────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Flip so the largest-magnitude component is positive (deterministic sign). */
function canonicalizeDir(d: Vec3): Vec3 {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  const dominant = ax >= ay && ax >= az ? d[0] : ay >= az ? d[1] : d[2];
  return dominant < 0 ? [-d[0], -d[1], -d[2]] : [d[0], d[1], d[2]];
}

function snapAxis(d: Vec3): "X" | "Y" | "Z" | null {
  if (Math.abs(d[0]) >= 0.95) return "X";
  if (Math.abs(d[1]) >= 0.95) return "Y";
  if (Math.abs(d[2]) >= 0.95) return "Z";
  return null;
}

/** Rodrigues rotation of p about the axis (origin, unit dir). */
function rotateAboutAxis(p: Vec3, origin: Vec3, dir: Vec3, cos: number, sin: number): Vec3 {
  const vx = p[0] - origin[0], vy = p[1] - origin[1], vz = p[2] - origin[2];
  const [kx, ky, kz] = dir;
  const dot = kx * vx + ky * vy + kz * vz;
  const crx = ky * vz - kz * vy;
  const cry = kz * vx - kx * vz;
  const crz = kx * vy - ky * vx;
  const oc = 1 - cos;
  return [
    origin[0] + vx * cos + crx * sin + kx * dot * oc,
    origin[1] + vy * cos + cry * sin + ky * dot * oc,
    origin[2] + vz * cos + crz * sin + kz * dot * oc,
  ];
}

function distToAxis(p: Vec3, origin: Vec3, dir: Vec3): number {
  const vx = p[0] - origin[0], vy = p[1] - origin[1], vz = p[2] - origin[2];
  const along = vx * dir[0] + vy * dir[1] + vz * dir[2];
  const px = vx - along * dir[0];
  const py = vy - along * dir[1];
  const pz = vz - along * dir[2];
  return Math.hypot(px, py, pz);
}

// ──────────────────────────────────────────────────────────────────────────
// Symmetric 3x3 eigen solver (cyclic Jacobi)
// ──────────────────────────────────────────────────────────────────────────

interface EigenResult {
  /** Eigenvalues, descending. */
  values: [number, number, number];
  /** Unit eigenvectors matching `values`. */
  vectors: [Vec3, Vec3, Vec3];
}

/** Jacobi eigen decomposition of a symmetric 3x3 matrix (row-major). */
function jacobiEigen3(m: number[][]): EigenResult {
  const a = [
    [m[0]![0]!, m[0]![1]!, m[0]![2]!],
    [m[1]![0]!, m[1]![1]!, m[1]![2]!],
    [m[2]![0]!, m[2]![1]!, m[2]![2]!],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const scale =
    Math.abs(a[0]![0]!) + Math.abs(a[1]![1]!) + Math.abs(a[2]![2]!) + 1e-300;
  const pairs: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]];
  for (let sweep = 0; sweep < 64; sweep++) {
    const off =
      Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!);
    if (off < 1e-15 * scale) break;
    for (const [p, q] of pairs) {
      const apq = a[p]![q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const t =
        theta === 0
          ? 1
          : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const app = a[p]![p]!, aqq = a[q]![q]!;
      a[p]![p] = app - t * apq;
      a[q]![q] = aqq + t * apq;
      a[p]![q] = 0;
      a[q]![p] = 0;
      for (let r = 0; r < 3; r++) {
        if (r !== p && r !== q) {
          const arp = a[r]![p]!, arq = a[r]![q]!;
          a[r]![p] = c * arp - s * arq;
          a[p]![r] = a[r]![p]!;
          a[r]![q] = s * arp + c * arq;
          a[q]![r] = a[r]![q]!;
        }
        const vrp = v[r]![p]!, vrq = v[r]![q]!;
        v[r]![p] = c * vrp - s * vrq;
        v[r]![q] = s * vrp + c * vrq;
      }
    }
  }
  // Columns of v are eigenvectors of the diagonal entries of a.
  const entries: Array<{ value: number; vector: Vec3 }> = [0, 1, 2].map((i) => ({
    value: a[i]![i]!,
    vector: [v[0]![i]!, v[1]![i]!, v[2]![i]!] as Vec3,
  }));
  entries.sort((x, y) => y.value - x.value);
  return {
    values: [entries[0]!.value, entries[1]!.value, entries[2]!.value],
    vectors: [entries[0]!.vector, entries[1]!.vector, entries[2]!.vector],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Uniform spatial hash grid
// ──────────────────────────────────────────────────────────────────────────

/**
 * Point index over a uniform grid. Numeric-hash cell keys: hash collisions
 * merge candidate lists, which is harmless because every candidate is
 * distance-checked; points within one cell of a query are always found.
 */
class HashGrid {
  private readonly map = new Map<number, number[]>();

  constructor(
    private readonly points: Vec3[],
    private readonly cellSize: number,
  ) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const key = this.key(
        Math.floor(p[0] / cellSize),
        Math.floor(p[1] / cellSize),
        Math.floor(p[2] / cellSize),
      );
      const bucket = this.map.get(key);
      if (bucket) bucket.push(i);
      else this.map.set(key, [i]);
    }
  }

  private key(ix: number, iy: number, iz: number): number {
    return (
      Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)
    );
  }

  /**
   * Distance to the nearest indexed point, searching only the 27 cells around
   * the query. Returns Infinity when those cells hold no point; distances up
   * to one cell size are always found exactly.
   */
  nearestWithin27(x: number, y: number, z: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.map.get(this.key(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const i of bucket) {
            const p = this.points[i]!;
            const ex = p[0] - x, ey = p[1] - y, ez = p[2] - z;
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 < best) best = d2;
          }
        }
      }
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Sampling
// ──────────────────────────────────────────────────────────────────────────

/** Uniform-stride + dedup sample of mesh vertices, at most `cap` points. */
function sampleVertices(mesh: STLMesh, cap: number): Vec3[] {
  const v = mesh.vertices;
  const nSoup = mesh.triCount * 3;
  const stride = Math.max(1, Math.ceil(nSoup / cap));
  const seen = new Set<string>();
  const out: Vec3[] = [];
  for (let i = 0; i < nSoup; i += stride) {
    const o = i * 3;
    const x = v[o]!, y = v[o + 1]!, z = v[o + 2]!;
    const key = `${x},${y},${z}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([x, y, z]);
    }
  }
  return out;
}

/** Vertices plus per-triangle centroids, uniform-strided to at most `cap`. */
function sampleContactPoints(mesh: STLMesh, cap: number): Vec3[] {
  const v = mesh.vertices;
  const nSoup = mesh.triCount * 3;
  const total = nSoup + mesh.triCount;
  const stride = Math.max(1, Math.ceil(total / cap));
  const out: Vec3[] = [];
  for (let i = 0; i < total; i += stride) {
    if (i < nSoup) {
      const o = i * 3;
      out.push([v[o]!, v[o + 1]!, v[o + 2]!]);
    } else {
      const t = (i - nSoup) * 9;
      out.push([
        (v[t]! + v[t + 3]! + v[t + 6]!) / 3,
        (v[t + 1]! + v[t + 4]! + v[t + 7]!) / 3,
        (v[t + 2]! + v[t + 5]! + v[t + 8]!) / 3,
      ]);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Moments
// ──────────────────────────────────────────────────────────────────────────

interface Moments {
  centroid: Vec3;
  /** 3x3 covariance (row-major). */
  covariance: number[][];
}

/** Area-weighted centroid + covariance of triangle centroids (two-pass). */
function areaWeightedMoments(mesh: STLMesh): Moments | null {
  const v = mesh.vertices;
  const n = mesh.triCount;
  const areas = new Float64Array(n);
  const cents = new Float64Array(n * 3);
  let W = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const ax = v[o]!, ay = v[o + 1]!, az = v[o + 2]!;
    const bx = v[o + 3]!, by = v[o + 4]!, bz = v[o + 5]!;
    const qx = v[o + 6]!, qy = v[o + 7]!, qz = v[o + 8]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = qx - ax, wy = qy - ay, wz = qz - az;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const area = 0.5 * Math.hypot(nx, ny, nz);
    areas[i] = area;
    const gx = (ax + bx + qx) / 3;
    const gy = (ay + by + qy) / 3;
    const gz = (az + bz + qz) / 3;
    const ci = i * 3;
    cents[ci] = gx;
    cents[ci + 1] = gy;
    cents[ci + 2] = gz;
    W += area;
    cx += area * gx;
    cy += area * gy;
    cz += area * gz;
  }
  if (!(W > 0)) return null;
  cx /= W;
  cy /= W;
  cz /= W;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const a = areas[i]!;
    if (a <= 0) continue;
    const ci = i * 3;
    const dx = cents[ci]! - cx;
    const dy = cents[ci + 1]! - cy;
    const dz = cents[ci + 2]! - cz;
    xx += a * dx * dx;
    xy += a * dx * dy;
    xz += a * dx * dz;
    yy += a * dy * dy;
    yz += a * dy * dz;
    zz += a * dz * dz;
  }
  return {
    centroid: [cx, cy, cz],
    covariance: [
      [xx / W, xy / W, xz / W],
      [xy / W, yy / W, yz / W],
      [xz / W, yz / W, zz / W],
    ],
  };
}

/** Uniform-weight centroid + covariance of a point set (two-pass). */
function pointMoments(points: Vec3[]): Moments {
  const n = points.length;
  let cx = 0, cy = 0, cz = 0;
  for (const p of points) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }
  return {
    centroid: [cx, cy, cz],
    covariance: [
      [xx / n, xy / n, xz / n],
      [xy / n, yy / n, yz / n],
      [xz / n, yz / n, zz / n],
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Rotational symmetry
// ──────────────────────────────────────────────────────────────────────────

const SYMMETRY_SAMPLE_CAP = 3000;
const SYMMETRY_MIN_SCORE = 0.55;
const DEGENERATE_GAP = 0.08;
/** Grid cell as a fraction of the bbox diagonal. */
const SYMMETRY_CELL_FRAC = 0.02;
/** Distance (fraction of diagonal) at which the symmetry score reaches 0. */
const SYMMETRY_CAP_FRAC = 0.05;

export function analyzeRotationalSymmetry(
  part: string,
  mesh: STLMesh,
): SymmetryAxisEvidence | null {
  if (mesh.triCount === 0) return null;
  const bbox = computeBBox(mesh);
  const diagonal = Math.hypot(bbox.size[0], bbox.size[1], bbox.size[2]);
  if (!(diagonal > 0)) return null;

  const points = sampleVertices(mesh, SYMMETRY_SAMPLE_CAP);
  if (points.length < 4) return null;

  const moments = areaWeightedMoments(mesh);
  if (!moments) return null;
  const centroid = moments.centroid;
  const axes = jacobiEigen3(moments.covariance).vectors;

  const cellSize = SYMMETRY_CELL_FRAC * diagonal;
  const capDist = SYMMETRY_CAP_FRAC * diagonal;
  const grid = new HashGrid(points, cellSize);

  let bestScore = -Infinity;
  let secondScore = -Infinity;
  let bestAxis: Vec3 = axes[0];
  for (const axis of axes) {
    let sum = 0;
    let count = 0;
    // 90° and 180° about the axis through the centroid.
    for (const [cos, sin] of [[0, 1], [-1, 0]] as Array<[number, number]>) {
      for (const p of points) {
        const r = rotateAboutAxis(p, centroid, axis, cos, sin);
        const d = grid.nearestWithin27(r[0], r[1], r[2]);
        sum += Math.min(d, capDist);
        count++;
      }
    }
    const score = clamp01(1 - sum / count / capDist);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestAxis = axis;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (bestScore < SYMMETRY_MIN_SCORE) return null;

  const axisDir = canonicalizeDir(bestAxis);
  let radiusSum = 0;
  const radii: number[] = [];
  for (const p of points) {
    const r = distToAxis(p, centroid, axisDir);
    radii.push(r);
    radiusSum += r;
  }
  const meanRadius = radiusSum / radii.length;
  let radiusVar = 0;
  for (const r of radii) radiusVar += (r - meanRadius) * (r - meanRadius);
  const radiusStd = Math.sqrt(radiusVar / radii.length);

  const degenerate = bestScore - secondScore <= DEGENERATE_GAP;
  const radiusRatio = meanRadius > 1e-12 ? radiusStd / meanRadius : Infinity;
  let confidence: "high" | "medium" | "low";
  if (bestScore >= 0.85 && radiusRatio < 0.35) confidence = "high";
  else if (bestScore >= 0.7) confidence = "medium";
  else confidence = "low";
  if (degenerate) confidence = "low";

  return {
    part,
    axisPoint: [centroid[0], centroid[1], centroid[2]],
    axisDir,
    snappedAxis: snapAxis(axisDir),
    radialProfile: { meanRadius, radiusStd },
    symmetryScore: bestScore,
    confidence,
    degenerate,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Contact regions
// ──────────────────────────────────────────────────────────────────────────

const CONTACT_SAMPLE_CAP = 4000;
const CONTACT_MIN_POINTS = 8;
const ELONGATION_THRESHOLD = 2;
const ELONGATION_MAX = 1e6;

export function analyzeContactRegion(
  partA: string,
  meshA: STLMesh,
  partB: string,
  meshB: STLMesh,
  opts: { maxDistance: number },
): ContactRegionEvidence | null {
  const maxDistance = opts.maxDistance;
  if (!(maxDistance > 0)) return null;
  if (meshA.triCount === 0 || meshB.triCount === 0) return null;

  const samplesA = sampleContactPoints(meshA, CONTACT_SAMPLE_CAP);
  const samplesB = sampleContactPoints(meshB, CONTACT_SAMPLE_CAP);
  if (samplesA.length === 0 || samplesB.length === 0) return null;

  // Cell size = maxDistance, so the 27-cell neighborhood is guaranteed to
  // contain every B-sample within maxDistance of a query.
  const grid = new HashGrid(samplesB, maxDistance);
  const close: Vec3[] = [];
  for (const p of samplesA) {
    if (grid.nearestWithin27(p[0], p[1], p[2]) <= maxDistance) close.push(p);
  }
  if (close.length < CONTACT_MIN_POINTS) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of close) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }

  const moments = pointMoments(close);
  const eig = jacobiEigen3(moments.covariance);
  const l1 = Math.max(eig.values[0], 0);
  const l2 = Math.max(eig.values[1], 0);
  let elongation: number;
  if (l1 <= 1e-18) {
    elongation = 1;
  } else {
    elongation = Math.min(
      Math.sqrt(l1 / Math.max(l2, l1 / (ELONGATION_MAX * ELONGATION_MAX))),
      ELONGATION_MAX,
    );
  }
  const principalDir =
    elongation >= ELONGATION_THRESHOLD ? canonicalizeDir(eig.vectors[0]) : null;

  return {
    partA,
    partB,
    anchor: [moments.centroid[0], moments.centroid[1], moments.centroid[2]],
    extent: [maxX - minX, maxY - minY, maxZ - minZ],
    principalDir,
    snappedAxis: principalDir ? snapAxis(principalDir) : null,
    elongation,
    sampleCount: close.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Mate registration (static assembly interfaces)
// ──────────────────────────────────────────────────────────────────────────

/** Absolute volume of a (closed) triangle-soup mesh: sum of signed tetrahedra
 *  from the origin to each triangle, |Σ a·(b×c)/6|. Winding-agnostic. 0 for an
 *  empty mesh; meaningful only for watertight solids (OpenSCAD output is). */
export function computeMeshVolume(mesh: STLMesh): number {
  const v = mesh.vertices;
  let vol = 0;
  for (let i = 0; i < mesh.triCount; i++) {
    const o = i * 9;
    const ax = v[o]!, ay = v[o + 1]!, az = v[o + 2]!;
    const bx = v[o + 3]!, by = v[o + 4]!, bz = v[o + 5]!;
    const cx = v[o + 6]!, cy = v[o + 7]!, cz = v[o + 8]!;
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(vol);
}

function meanVec(pts: Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
  const n = Math.max(1, pts.length);
  return [x / n, y / n, z / n];
}

/** Scale-free contact evidence between two placed solids (world frame): what
 *  fraction of A's surface samples lie within `maxDistance` of B (a JoinABLe
 *  C_contact proxy), plus the contact centroid and an interface-normal proxy
 *  (unit vector between the two surface centroids). Returns null when either
 *  mesh is empty. Interpenetration (C_overlap) is measured separately via an
 *  OpenSCAD intersection compile — this is pure mesh proximity. */
export interface MateRegistrationEvidence {
  contactAreaFrac: number;
  contactAnchor: Vec3;
  contactNormal: Vec3 | null;
  sampleCount: number;
}

export function analyzeMateRegistration(
  meshA: STLMesh, meshB: STLMesh, opts: { maxDistance: number },
): MateRegistrationEvidence | null {
  if (meshA.triCount === 0 || meshB.triCount === 0) return null;
  const maxDistance = opts.maxDistance;
  if (!(maxDistance > 0)) return null;
  const samplesA = sampleContactPoints(meshA, CONTACT_SAMPLE_CAP);
  const samplesB = sampleContactPoints(meshB, CONTACT_SAMPLE_CAP);
  if (samplesA.length === 0 || samplesB.length === 0) return null;
  // Symmetric contact: A-samples near B AND B-samples near A. Reporting the MAX
  // of the two directional fractions normalizes against the smaller surface (a
  // small part fully on a big body reads high from the small part's side),
  // rather than being biased by argument order / tessellation density.
  const gridB = new HashGrid(samplesB, maxDistance);
  const closeA: Vec3[] = [];
  for (const p of samplesA) {
    if (gridB.nearestWithin27(p[0], p[1], p[2]) <= maxDistance) closeA.push(p);
  }
  const gridA = new HashGrid(samplesA, maxDistance);
  let closeBCount = 0;
  for (const p of samplesB) {
    if (gridA.nearestWithin27(p[0], p[1], p[2]) <= maxDistance) closeBCount++;
  }
  const fracA = closeA.length / samplesA.length;
  const fracB = closeBCount / samplesB.length;
  const centroidA = meanVec(samplesA);
  const centroidB = meanVec(samplesB);
  const diff: Vec3 = [centroidA[0] - centroidB[0], centroidA[1] - centroidB[1], centroidA[2] - centroidB[2]];
  const norm = Math.hypot(diff[0], diff[1], diff[2]);
  const contactNormal: Vec3 | null = norm > 1e-9 ? [diff[0] / norm, diff[1] / norm, diff[2] / norm] : null;
  return {
    contactAreaFrac: Math.max(fracA, fracB),
    contactAnchor: closeA.length > 0 ? meanVec(closeA) : centroidA,
    contactNormal,
    sampleCount: closeA.length + closeBCount,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Aggregate
// ──────────────────────────────────────────────────────────────────────────

export const DEFAULT_CONTACT_DISTANCE_FRAC = 0.015;

export interface GeometricEvidence {
  symmetryAxes: SymmetryAxisEvidence[];
  contactRegions: ContactRegionEvidence[];
}

export function buildGeometricEvidence(
  parts: Array<{ name: string; mesh: STLMesh }>,
  proximityPairs: Array<{ a: string; b: string }>,
  opts?: { contactMaxDistance?: number },
): GeometricEvidence {
  const byName = new Map<string, STLMesh>();
  let maxDiagonal = 0;
  for (const part of parts) {
    byName.set(part.name, part.mesh);
    const size = computeBBox(part.mesh).size;
    const diagonal = Math.hypot(size[0], size[1], size[2]);
    if (diagonal > maxDiagonal) maxDiagonal = diagonal;
  }
  const contactMaxDistance =
    opts?.contactMaxDistance ?? DEFAULT_CONTACT_DISTANCE_FRAC * maxDiagonal;

  const symmetryAxes: SymmetryAxisEvidence[] = [];
  for (const part of parts) {
    const evidence = analyzeRotationalSymmetry(part.name, part.mesh);
    if (evidence) symmetryAxes.push(evidence);
  }

  const contactRegions: ContactRegionEvidence[] = [];
  for (const pair of proximityPairs) {
    const meshA = byName.get(pair.a);
    const meshB = byName.get(pair.b);
    if (!meshA || !meshB) continue;
    const evidence = analyzeContactRegion(pair.a, meshA, pair.b, meshB, {
      maxDistance: contactMaxDistance,
    });
    if (evidence) contactRegions.push(evidence);
  }

  return { symmetryAxes, contactRegions };
}
