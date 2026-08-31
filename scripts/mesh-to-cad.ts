#!/usr/bin/env bun

interface Args {
  outputDir: string;
  meshPath: string;
  referenceRoot?: string;
  runsRoot?: string;
  refine: boolean;
}

function help(): never {
  console.log(`
Mesh-to-CAD — private reference import, image-based planning, and optional multi-view refine.

Usage:
  bun run mesh-to-cad --mesh reference.stl -o outputs/reference-cad

Options:
  --mesh PATH                 import STL, OBJ, PLY, GLB, glTF, or 3MF
  --reference-root PATH       private store root (or PROCEDURA_REFERENCE_ROOT)
  --runs-root PATH            Studio runs root (or PROCEDURA_OUTPUTS_ROOT)
  --refine                    refine the generated draft against seven reference views
  -o, --output PATH           output run directory
`);
  process.exit(0);
}

function parse(argv: string[]): Args {
  const args: Args = { outputDir: "", meshPath: "", refine: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === "-o" || value === "--output") args.outputDir = argv[++i]!;
    else if (value === "--mesh") args.meshPath = argv[++i]!;
    else if (value === "--reference-root") args.referenceRoot = argv[++i]!;
    else if (value === "--runs-root") args.runsRoot = argv[++i]!;
    else if (value === "--refine") args.refine = true;
    else if (value === "-h" || value === "--help") help();
    else throw new Error(`unknown flag: ${value}`);
  }
  if (!args.outputDir) throw new Error("-o/--output is required");
  if (!args.meshPath) throw new Error("--mesh is required");
  return args;
}

const args = parse(process.argv.slice(2));
const { runMeshToCadGeneration } = await import("../src/pipeline/mesh-to-cad-generation.ts");
const result = await runMeshToCadGeneration({
  outputDir: args.outputDir,
  meshPath: args.meshPath,
  ...(args.referenceRoot ? { referenceRoot: args.referenceRoot } : {}),
  ...(args.runsRoot ? { runsRoot: args.runsRoot } : {}),
  ...(args.refine ? { refine: true } : {}),
});
console.log(`reference: ${result.reference.handle}`);
console.log(`dimensions: ${result.summary.dimensions.join(" × ")} ${result.summary.units}`);
console.log(`plan: ${result.plan.length} parts`);
console.log(`final: ${result.outputDir}/final.scad ${result.outputDir}/final.obj`);
