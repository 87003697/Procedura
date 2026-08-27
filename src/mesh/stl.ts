/**
 * Binary + ASCII STL parser / writer (zero deps).
 *
 * Binary STL layout (the only thing OpenSCAD's --export-format=binstl emits):
 *   80 bytes : header (free-form text, conventionally ignored)
 *   4 bytes  : uint32 little-endian — triangle count
 *   per triangle:
 *     12 bytes : normal (3 × float32 LE)
 *     12 bytes : vertex A
 *     12 bytes : vertex B
 *     12 bytes : vertex C
 *      2 bytes : uint16 "attribute byte count" — almost always 0
 *
 * The triangle stride is 50 bytes. We expose vertices as a Float32Array of
 * length 9 × triCount (xyz × 3 per tri) so callers can transform them in
 * place; faces are implicit (i = 3k, i+1, i+2).
 *
 * Why our own parser: trimesh + numpy is overkill for what we need, and we
 * want zero npm deps in Procedura's hot path. The ASCII fallback exists in case
 * someone hands us an ASCII STL by mistake.
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface STLMesh {
  /** Flat xyz triplets, 3 verts per tri, length = 9 × triCount. */
  vertices: Float32Array;
  /** Per-triangle normals (3 floats each), length = 3 × triCount. */
  normals: Float32Array;
  triCount: number;
}

const STRIDE = 50;
const HEADER = 80;

// ──────────────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────────────

export function loadSTL(path: string): STLMesh {
  const buf = readFileSync(path);
  return parseSTL(buf);
}

export function parseSTL(buf: Buffer): STLMesh {
  if (looksAscii(buf)) return parseASCII(buf.toString("utf8"));
  if (buf.length < HEADER + 4) {
    throw new Error(`STL buffer too short (${buf.length} bytes)`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const triCount = dv.getUint32(HEADER, true);
  const expected = HEADER + 4 + triCount * STRIDE;
  if (buf.length < expected) {
    throw new Error(
      `binary STL truncated: header says ${triCount} tris (need ${expected} B), got ${buf.length} B`,
    );
  }
  const vertices = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);
  let off = HEADER + 4;
  for (let i = 0; i < triCount; i++) {
    const ni = i * 3;
    normals[ni    ] = dv.getFloat32(off,     true);
    normals[ni + 1] = dv.getFloat32(off + 4, true);
    normals[ni + 2] = dv.getFloat32(off + 8, true);
    const vi = i * 9;
    for (let k = 0; k < 9; k++) {
      vertices[vi + k] = dv.getFloat32(off + 12 + k * 4, true);
    }
    off += STRIDE;
  }
  return { vertices, normals, triCount };
}

/** ASCII STL parser — slow but rare in our pipeline. */
function parseASCII(src: string): STLMesh {
  const verts: number[] = [];
  const norms: number[] = [];
  const lines = src.split(/\r?\n/);
  let currentNormal: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!.trim();
    if (ln.startsWith("facet normal")) {
      const parts = ln.split(/\s+/);
      currentNormal = [Number(parts[2]), Number(parts[3]), Number(parts[4])];
    } else if (ln.startsWith("vertex")) {
      const parts = ln.split(/\s+/);
      verts.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (ln === "endfacet") {
      norms.push(...currentNormal);
    }
  }
  return {
    vertices: new Float32Array(verts),
    normals: new Float32Array(norms),
    triCount: verts.length / 9,
  };
}

function looksAscii(buf: Buffer): boolean {
  // Real binary STLs start with arbitrary 80 bytes followed by a uint32; an
  // ASCII STL starts with literal "solid " and contains the word "facet".
  if (buf.length < 84) return false;
  const head = buf.toString("ascii", 0, Math.min(512, buf.length));
  return head.startsWith("solid ") && head.includes("facet");
}

// ──────────────────────────────────────────────────────────────────────────
// Geometry
// ──────────────────────────────────────────────────────────────────────────

export interface BBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export function computeBBox(mesh: STLMesh): BBox {
  if (mesh.triCount === 0) {
    const z: [number, number, number] = [0, 0, 0];
    return { min: z, max: z, size: z };
  }
  const v = mesh.vertices;
  let minX = v[0]!, minY = v[1]!, minZ = v[2]!;
  let maxX = v[0]!, maxY = v[1]!, maxZ = v[2]!;
  for (let i = 3; i < v.length; i += 3) {
    const x = v[i]!, y = v[i + 1]!, z = v[i + 2]!;
    if (x < minX) minX = x; else if (x > maxX) maxX = x;
    if (y < minY) minY = y; else if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

/** Mutate vertices in place: v' = (v - offset) * scale. */
export function transformInPlace(
  mesh: STLMesh, offset: [number, number, number], scale: number,
): void {
  const v = mesh.vertices;
  const [ox, oy, oz] = offset;
  for (let i = 0; i < v.length; i += 3) {
    v[i    ] = (v[i    ]! - ox) * scale;
    v[i + 1] = (v[i + 1]! - oy) * scale;
    v[i + 2] = (v[i + 2]! - oz) * scale;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Write
// ──────────────────────────────────────────────────────────────────────────

export function writeSTL(path: string, mesh: STLMesh): void {
  const triCount = mesh.triCount;
  const buf = Buffer.alloc(HEADER + 4 + triCount * STRIDE);
  // Header — write a short ascii tag so the file is recognisable.
  buf.write("procedura binary STL", 0, "ascii");
  buf.writeUInt32LE(triCount, HEADER);
  let off = HEADER + 4;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < triCount; i++) {
    const ni = i * 3;
    dv.setFloat32(off,     mesh.normals[ni    ] ?? 0, true);
    dv.setFloat32(off + 4, mesh.normals[ni + 1] ?? 0, true);
    dv.setFloat32(off + 8, mesh.normals[ni + 2] ?? 0, true);
    const vi = i * 9;
    for (let k = 0; k < 9; k++) {
      dv.setFloat32(off + 12 + k * 4, mesh.vertices[vi + k] ?? 0, true);
    }
    // 2-byte attribute count, always 0.
    dv.setUint16(off + 48, 0, true);
    off += STRIDE;
  }
  writeFileSync(path, buf);
}
