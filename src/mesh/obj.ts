/**
 * Minimal OBJ writer (vertex/face only, zero deps).
 *
 * Takes an STLMesh (with duplicated vertices, one per triangle corner) and
 * emits a deduplicated OBJ file — `v x y z` + `f i1 i2 i3` (1-indexed).
 * Vertices are deduped by exact-equality on a fixed-precision string key
 * so file sizes stay reasonable for downstream tools (Blender, etc.).
 *
 * Why no normals or UVs: OpenSCAD output STLs don't carry meaningful UVs,
 * and Blender recomputes smooth normals for AO renders anyway.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { STLMesh } from "./stl.ts";

/**
 * Parse an OBJ file into the flat per-triangle {@link STLMesh} the rest of the
 * pipeline expects (same shape as loadSTL). Handles `f` polygons (fan-
 * triangulated), the `v`, `v/vt`, `v/vt/vn`, `v//vn` index forms, and negative
 * (relative) indices. Per-triangle face normals are computed (callers that need
 * geometry — bbox, connectivity, chamfer — ignore normals, but we fill them for
 * parity with loadSTL).
 */
export function loadOBJ(path: string): STLMesh {
  const buf = readFileSync(path);
  const n = buf.length;

  // Growable typed arrays. `vx` MUST stay Float64: the original built it from
  // JS numbers and computed face normals in double precision before the single
  // narrowing to Float32 at the end. Storing vertices as Float32 here would
  // round the normal inputs one step early and perturb `normals`.
  let vx = new Float64Array(1 << 15); // flat xyz, 0-based: vertex k → vx[3k..3k+2]
  let outV = new Float32Array(1 << 15);
  let outN = new Float32Array(1 << 15);
  let vn = 0, ov = 0, on = 0, tri = 0;

  const fitV = (extra: number): void => {
    if (vn + extra <= vx.length) return;
    let cap = vx.length; while (cap < vn + extra) cap *= 2;
    const next = new Float64Array(cap); next.set(vx.subarray(0, vn)); vx = next;
  };
  // `extra` is a TRIANGLE count: 9 vertex floats + 3 normal floats each.
  const fitOut = (extra: number): void => {
    if (ov + extra * 9 <= outV.length && on + extra * 3 <= outN.length) return;
    let cv = outV.length; while (cv < ov + extra * 9) cv *= 2;
    const nv2 = new Float32Array(cv); nv2.set(outV.subarray(0, ov)); outV = nv2;
    let cn = outN.length; while (cn < on + extra * 3) cn *= 2;
    const nn2 = new Float32Array(cn); nn2.set(outN.subarray(0, on)); outN = nn2;
  };

  /** Coordinate read with the old out-of-bounds behaviour. The reference
   *  implementation indexed a plain number[], so a face index past the
   *  vertices seen so far (or a NaN from a non-numeric token) read `undefined`
   *  and landed in the Float32Array as NaN. A typed array would quietly return
   *  0 instead, inventing a vertex at the origin for malformed files. */
  const coord = (j: number): number => (j >= 0 && j < vn ? vx[j]! : NaN);

  const idx: number[] = []; // reused per face line

  // Walk the raw bytes and decode ONE LINE AT A TIME. The previous version did
  // `readFileSync(path, "utf8").split("\n")`, which holds every line of the file
  // live as a separate JS string simultaneously; combined with number[]
  // accumulators (8 B/elem, plus a full copy into Float32Array at the end) a
  // 672 MB mesh drove the benchmark past 24 GB RSS and got OOM-killed. Per-line
  // strings are still created, but they are transient garbage rather than a
  // 14M-element live array, and output now goes straight into typed arrays.
  //
  // Slicing [i, eol) reproduces split("\n") exactly: a "\r" from CRLF stays in
  // the string (and is later eaten by \s+ / trim, as before), a trailing
  // newline yields no extra iteration, and a final line without one is kept.
  for (let i = 0; i < n;) {
    let eol = buf.indexOf(10, i);
    if (eol === -1) eol = n;
    if (eol - i >= 2) {
      const c0 = buf[i]!;
      if (c0 === 118 /* v */ && buf[i + 1] === 32) {
        const p = buf.toString("utf8", i, eol).split(/\s+/);
        fitV(3);
        vx[vn] = +p[1]!; vx[vn + 1] = +p[2]!; vx[vn + 2] = +p[3]!;
        vn += 3;
      } else if (c0 === 102 /* f */ && buf[i + 1] === 32) {
        const toks = buf.toString("utf8", i, eol).trim().split(/\s+/).slice(1);
        const nv = vn / 3;
        idx.length = 0;
        for (const t of toks) {
          // parseInt stops at the first non-digit, so it already truncates at
          // the "/" of v/vt/vn — the old `t.split("/")[0]` step was a no-op
          // (and an allocation) for every index form, including malformed ones.
          let k = parseInt(t, 10);
          if (k < 0) k = nv + k; else k -= 1; // → 0-based
          idx.push(k);
        }
        if (idx.length > 2) fitOut(idx.length - 2);
        for (let k = 1; k + 1 < idx.length; k++) {
          const a = idx[0]!, b = idx[k]!, c = idx[k + 1]!;
          const ax = coord(a * 3), ay = coord(a * 3 + 1), az = coord(a * 3 + 2);
          const bx = coord(b * 3), by = coord(b * 3 + 1), bz = coord(b * 3 + 2);
          const cx = coord(c * 3), cy = coord(c * 3 + 1), cz = coord(c * 3 + 2);
          outV[ov] = ax; outV[ov + 1] = ay; outV[ov + 2] = az;
          outV[ov + 3] = bx; outV[ov + 4] = by; outV[ov + 5] = bz;
          outV[ov + 6] = cx; outV[ov + 7] = cy; outV[ov + 8] = cz;
          ov += 9;
          const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
          const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
          const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          const len = Math.hypot(nx, ny, nz) || 1;
          outN[on] = nx / len; outN[on + 1] = ny / len; outN[on + 2] = nz / len;
          on += 3;
          tri++;
        }
      }
    }
    i = eol + 1;
  }

  // slice(), not subarray(): drops the doubling slack so the steady-state
  // footprint is the mesh itself — connectivity/chamfer run right after this.
  return {
    vertices: ov === outV.length ? outV : outV.slice(0, ov),
    normals: on === outN.length ? outN : outN.slice(0, on),
    triCount: tri,
  };
}

// 5 decimal places is enough for mm-scale CAD geometry and stops the
// dedup map exploding for nominally-identical vertices that differ by
// float rounding noise.
const PRECISION = 5;

export function writeOBJ(path: string, mesh: STLMesh): void {
  const dedup = new Map<string, number>();
  const verts: number[] = []; // 1-indexed positions; v0 unused
  const faces: number[] = []; // triplets of vertex indices (1-indexed)

  const v = mesh.vertices;
  for (let i = 0; i < mesh.triCount; i++) {
    const vi = i * 9;
    const a = vertexIndex(dedup, verts, v[vi]!, v[vi + 1]!, v[vi + 2]!);
    const b = vertexIndex(dedup, verts, v[vi + 3]!, v[vi + 4]!, v[vi + 5]!);
    const c = vertexIndex(dedup, verts, v[vi + 6]!, v[vi + 7]!, v[vi + 8]!);
    faces.push(a, b, c);
  }

  // Build the file as one string. For a 100K-tri mesh this is ~3 MB —
  // well within bun's string buffer comfort zone.
  const lines: string[] = [
    `# generated by procedura/src/mesh/obj.ts`,
    `# vertices: ${verts.length / 3}, faces: ${faces.length / 3}`,
  ];
  for (let i = 0; i < verts.length; i += 3) {
    lines.push(`v ${verts[i]!.toFixed(PRECISION)} ${verts[i + 1]!.toFixed(PRECISION)} ${verts[i + 2]!.toFixed(PRECISION)}`);
  }
  for (let i = 0; i < faces.length; i += 3) {
    lines.push(`f ${faces[i]} ${faces[i + 1]} ${faces[i + 2]}`);
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function vertexIndex(
  dedup: Map<string, number>, verts: number[],
  x: number, y: number, z: number,
): number {
  const key = `${x.toFixed(PRECISION)}|${y.toFixed(PRECISION)}|${z.toFixed(PRECISION)}`;
  const cached = dedup.get(key);
  if (cached !== undefined) return cached;
  verts.push(x, y, z);
  const idx = verts.length / 3; // 1-indexed
  dedup.set(key, idx);
  return idx;
}
