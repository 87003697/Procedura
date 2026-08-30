import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { loadOBJ } from "../mesh/obj.ts";
import { loadSTL, writeSTL } from "../mesh/stl.ts";

export type ReferenceFormat = "stl" | "obj" | "ply" | "glb" | "gltf" | "3mf";

function blenderBin(): string {
  const configured = process.env["PROCEDURA_BLENDER_PATH"];
  if (configured && existsSync(configured)) return configured;
  for (const candidate of [
    join(process.env["HOME"] ?? "", "opt", "blender", "blender"),
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/usr/local/bin/blender",
    "/opt/blender/blender",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  const path = Bun.which("blender");
  if (path) return path;
  throw new Error("Blender is required to normalize PLY, glTF, GLB, or 3MF");
}

export async function normalizeReference(
  source: string,
  format: ReferenceFormat,
  output: string,
): Promise<void> {
  if (format === "stl" || format === "obj") {
    const mesh = format === "stl" ? loadSTL(source) : loadOBJ(source);
    if (mesh.triCount === 0) throw new Error("reference mesh contains no triangles");
    writeSTL(output, mesh);
    return;
  }

  const script = resolve(dirname(new URL(import.meta.url).pathname), "../../scripts/_normalize_reference_blender.py");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      blenderBin(),
      ["-b", "--factory-startup", "--python", script, "--", "--input", source, "--format", format, "--output", output],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || "Blender normalization failed (" + code + ")"));
    });
  });
}
