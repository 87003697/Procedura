#!/usr/bin/env bun

import { importReferenceRun } from "../src/pipeline/mesh-to-cad-reference.ts";

interface Args {
  outputDir: string;
  meshPath?: string;
  referenceHandle?: string;
  referenceRoot?: string;
  runsRoot?: string;
  importOnly: boolean;
}

function help(): never {
  console.log(`
Mesh-to-CAD Plan 1 — private reference import, Z-up normalization, and local Viewer.

Usage:
  bun run mesh-to-cad --import-only --mesh reference.stl -o outputs/reference-import
  bun run mesh-to-cad --import-only --reference-handle HANDLE -o outputs/reference-import

Options:
  --import-only               import/reuse a reference without LLM or CAD generation
  --mesh PATH                 import STL, OBJ, PLY, GLB, glTF, or 3MF
  --reference-handle HANDLE   reuse an existing opaque handle
  --reference-root PATH       private store root (or PROCEDURA_REFERENCE_ROOT)
  --runs-root PATH            Studio runs root (or PROCEDURA_OUTPUTS_ROOT)
  -o, --output PATH           output run directory
`);
  process.exit(0);
}

function parse(argv: string[]): Args {
  const args: Args = { outputDir: "", importOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === "-o" || value === "--output") args.outputDir = argv[++i]!;
    else if (value === "--mesh") args.meshPath = argv[++i]!;
    else if (value === "--reference-handle") args.referenceHandle = argv[++i]!;
    else if (value === "--reference-root") args.referenceRoot = argv[++i]!;
    else if (value === "--runs-root") args.runsRoot = argv[++i]!;
    else if (value === "--import-only") args.importOnly = true;
    else if (value === "-h" || value === "--help") help();
    else throw new Error(`unknown flag: ${value}`);
  }
  if (!args.importOnly) throw new Error("Plan 1 requires --import-only");
  if (!args.outputDir) throw new Error("-o/--output is required");
  if (Boolean(args.meshPath) === Boolean(args.referenceHandle)) {
    throw new Error("pass exactly one of --mesh or --reference-handle");
  }
  return args;
}

const args = parse(process.argv.slice(2));
const result = await importReferenceRun({
  outputDir: args.outputDir,
  ...(args.meshPath ? { meshPath: args.meshPath } : {}),
  ...(args.referenceHandle ? { referenceHandle: args.referenceHandle } : {}),
  ...(args.referenceRoot ? { referenceRoot: args.referenceRoot } : {}),
  ...(args.runsRoot ? { runsRoot: args.runsRoot } : {}),
});
console.log(`reference: ${result.reference.handle}`);
console.log(`dimensions: ${result.summary.dimensions.join(" × ")} ${result.summary.units}`);
