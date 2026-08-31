import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import { computeBBox, loadSTL } from "../mesh/stl.ts";
import { renderAOViews } from "../render/ao.ts";
import type { ViewName } from "../render/views.ts";
import { normalizeReference, type ReferenceFormat } from "./normalization.ts";

export type { ReferenceFormat } from "./normalization.ts";

interface PrivateManifest {
  schemaVersion: 2;
  handle: string;
  originalFormat: ReferenceFormat;
  sourceFile: string;
  canonicalFile: "canonical.stl";
}

export interface ReferenceDescriptor {
  handle: string;
}

export interface ReferenceSummary {
  coordinateConvention: "Z-up";
  units: "mm";
  triangleCount: number;
  dimensions: [number, number, number];
}

export interface ReferenceViewerMesh {
  format: "stl";
  bytes: ArrayBuffer;
}

export interface RenderedReferenceImage {
  view: ViewName;
  bytes: Uint8Array;
}

export function formatOf(path: string): ReferenceFormat {
  const ext = extname(path).toLowerCase();
  if (ext === ".stl") return "stl";
  if (ext === ".obj") return "obj";
  if (ext === ".ply") return "ply";
  if (ext === ".glb") return "glb";
  if (ext === ".gltf") return "gltf";
  if (ext === ".3mf") return "3mf";
  throw new Error("reference mesh must be STL, OBJ, PLY, GLB, glTF, or 3MF");
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class ReferenceAuthority {
  readonly #root: string;

  constructor(root: string, forbiddenRoots: readonly string[]) {
    const privateRoot = resolve(root);
    for (const forbidden of forbiddenRoots.map((value) => resolve(value))) {
      if (isInside(privateRoot, forbidden) || isInside(forbidden, privateRoot)) {
        throw new Error("reference root must be disjoint from runs and workspace roots");
      }
    }
    this.#root = privateRoot;
  }

  async importReference(sourcePath: string): Promise<ReferenceDescriptor> {
    const source = resolve(sourcePath);
    if (!existsSync(source)) throw new Error("reference mesh not found: " + source);
    const format = formatOf(source);
    mkdirSync(this.#root, { recursive: true });
    const staging = mkdtempSync(join(this.#root, ".import-"));

    try {
      const canonical = join(staging, "canonical.stl");
      await normalizeReference(source, format, canonical);
      const mesh = loadSTL(canonical);
      const dimensions = computeBBox(mesh).size;
      if (mesh.triCount === 0 || !dimensions.every(Number.isFinite)) {
        throw new Error("reference geometry is not measurable");
      }
      const handle = "ref_" + randomUUID();
      const sourceFile = "source." + format;
      copyFileSync(source, join(staging, sourceFile));
      const manifest: PrivateManifest = {
        schemaVersion: 2,
        handle,
        originalFormat: format,
        sourceFile,
        canonicalFile: "canonical.stl",
      };
      writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      renameSync(staging, join(this.#root, handle));
      return { handle };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  discardReference(handle: string): void {
    if (!/^ref_[0-9a-f-]+$/.test(handle)) throw new Error("invalid reference handle");
    rmSync(join(this.#root, handle), { recursive: true, force: true });
  }

  inspectReferenceSummary(handle: string): ReferenceSummary {
    const record = this.#record(handle);
    const mesh = loadSTL(record.canonicalPath);
    const dimensions = computeBBox(mesh).size;
    if (mesh.triCount === 0 || !dimensions.every(Number.isFinite)) {
      throw new Error("reference geometry is not measurable");
    }
    return {
      coordinateConvention: "Z-up",
      units: "mm",
      triangleCount: mesh.triCount,
      dimensions,
    };
  }

  readReferenceViewerMesh(handle: string): ReferenceViewerMesh {
    const bytes = readFileSync(this.#record(handle).canonicalPath);
    return {
      format: "stl",
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }

  async renderReferenceImages(
    handle: string,
    views: readonly ViewName[],
  ): Promise<RenderedReferenceImage[]> {
    const record = this.#record(handle);
    const renderDir = join(record.dir, "render");
    const result = await renderAOViews({
      stlPath: record.canonicalPath,
      outDir: renderDir,
      views,
    });
    if (!result.ok) throw new Error(result.error);
    return views.map((view) => ({
      view,
      bytes: readFileSync(join(renderDir, `ao-${view}.png`)),
    }));
  }

  #record(handle: string): PrivateManifest & { dir: string; canonicalPath: string } {
    if (!/^ref_[0-9a-f-]+$/.test(handle)) throw new Error("invalid reference handle");
    const dir = join(this.#root, handle);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("reference not found: " + handle);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<PrivateManifest>;
    if (
      manifest.schemaVersion !== 2 ||
      manifest.canonicalFile !== "canonical.stl" ||
      typeof manifest.originalFormat !== "string"
    ) {
      throw new Error("reference handle uses unsupported schema; re-import required");
    }
    return {
      ...(manifest as PrivateManifest),
      dir,
      canonicalPath: join(dir, "canonical.stl"),
    };
  }
}
