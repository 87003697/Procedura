import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { writeOBJ } from "../mesh/obj.ts";
import { computeBBox, loadSTL } from "../mesh/stl.ts";
import { makeMappingCritic, type MappingCritic } from "../pipeline/mapping-critic.ts";
import type { ReferenceAuthority } from "../reference/authority.ts";

const PROCEDURA_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const EXPERIMENT = join(PROCEDURA_ROOT, "experiments", "octree-mapping");
const PYTHON = join(EXPERIMENT, ".venv", "bin", "python");
const PREPARE = join(EXPERIMENT, "scripts", "prepare_mapping_input.py");
const RENDER_REPORT = join(PROCEDURA_ROOT, "src", "tools_mesh2code", "render_mapping_report.py");
const SETUP = "cd experiments/octree-mapping && python3.12 -m venv .venv && .venv/bin/pip install -e . matplotlib";
/** Fraction of the octree root edge filled by the GT/candidate union. */
const ROOT_FILL = 0.9;

async function runCommand(label: string, args: readonly string[], cwd: string): Promise<void> {
  const proc = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${label} failed with exit ${exitCode}: ${(stderr || stdout).trim().split("\n").at(-1)}`);
}

/** Fail before any model call when the octree Mapping environment is missing. */
export async function checkMappingEnvironment(): Promise<void> {
  if (!existsSync(PYTHON)) throw new Error(`Mesh-to-CAD Mapping requires ${PYTHON}; set it up with: ${SETUP}`);
  // Run outside the experiment directory so a source-tree octree_mapping cannot mask a missing install.
  await runCommand(
    `Mapping environment check (set it up with: ${SETUP})`,
    [PYTHON, "-c", "import matplotlib, octree_mapping.mesh_adapter, scipy"],
    PROCEDURA_ROOT,
  );
}

/**
 * Mapping critic for one Mesh-to-CAD run. The canonical reference already uses
 * the normalized frame the draft is built in, so every Mapping length is a SCAD
 * millimetre; all Mapping files stay in the reference's private workspace.
 */
export function makeMeshToCadMappingCritic(authority: ReferenceAuthority, handle: string): MappingCritic {
  const privateWorkspace = authority.privateWorkspace(handle);
  const target = loadSTL(privateWorkspace.canonicalPath);
  const targetBox = computeBBox(target);
  const targetObj = join(privateWorkspace.dir, "gt.obj");
  writeOBJ(targetObj, target);

  return makeMappingCritic(async (context) => {
    const stepDir = join(privateWorkspace.dir, `step_${String(context.cycle).padStart(3, "0")}`);
    mkdirSync(stepDir, { recursive: true });
    const viewPath = (name: "front" | "top" | "right"): string =>
      context.views.find((view) => view.label.endsWith(` ${name}`))!.path;

    // One vertex per STL corner keeps the OBJ triangles identical to the STL,
    // whose bounds prepare_mapping_input.py requires to match within 5e-5.
    const candidate = loadSTL(context.stlPath);
    const candidateObj = join(stepDir, "candidate.obj");
    const lines = ["# generated from the candidate STL", `# faces: ${candidate.triCount}`];
    for (let index = 0; index < candidate.vertices.length; index += 3) {
      lines.push(`v ${candidate.vertices[index]!.toFixed(8)} ${candidate.vertices[index + 1]!.toFixed(8)} ${candidate.vertices[index + 2]!.toFixed(8)}`);
    }
    for (let index = 0; index < candidate.triCount; index++) {
      const base = index * 3 + 1;
      lines.push(`f ${base} ${base + 1} ${base + 2}`);
    }
    writeFileSync(candidateObj, lines.join("\n") + "\n", "utf8");
    const partsMeta = join(stepDir, "parts-meta.tsv");
    writeFileSync(partsMeta, context.partsColorLegend.trim() + "\n", "utf8");

    // A cubic octree root centred on the GT/candidate union.
    const candidateBox = computeBBox(candidate);
    const unionMin = [0, 1, 2].map((axis) => Math.min(targetBox.min[axis]!, candidateBox.min[axis]!));
    const unionMax = [0, 1, 2].map((axis) => Math.max(targetBox.max[axis]!, candidateBox.max[axis]!));
    const rootSide = Math.max(...[0, 1, 2].map((axis) => unionMax[axis]! - unionMin[axis]!)) / ROOT_FILL;
    const rootMin = [0, 1, 2].map((axis) => (unionMin[axis]! + unionMax[axis]!) / 2 - rootSide / 2);

    const inputPath = join(stepDir, "input.json");
    const reportPath = join(stepDir, "report.json");
    await runCommand("Mapping input preparation", [
      PYTHON, PREPARE,
      "--gt-obj", targetObj,
      "--candidate-obj", candidateObj,
      "--candidate-stl", context.stlPath,
      "--parts-meta", partsMeta,
      "--output", inputPath,
      "--metadata", join(stepDir, "preparation-metadata.json"),
      "--root-min", ...rootMin.map(String),
      "--root-side", String(rootSide),
    ], EXPERIMENT);
    await runCommand("Mapping solve", [
      PYTHON, "-m", "octree_mapping",
      "--input", inputPath,
      "--output", reportPath,
      "--profile", "position",
    ], EXPERIMENT);
    await runCommand("Mapping report render", [
      PYTHON, RENDER_REPORT,
      "--report", reportPath,
      "--gt", targetObj,
      "--candidate", candidateObj,
      "--out-dir", stepDir,
    ], PROCEDURA_ROOT);

    return {
      source: {
        input: JSON.parse(readFileSync(inputPath, "utf8")) as unknown,
        report: JSON.parse(readFileSync(reportPath, "utf8")) as unknown,
      },
      semanticPlan: JSON.parse(readFileSync(join(context.workspaceDir, "plan.json"), "utf8")) as unknown,
      vision: {
        legend: context.partsColorLegend,
        views: [
          { name: "front", partColorPath: viewPath("front"), comparisonPath: join(stepDir, "mapping-report-front.png") },
          { name: "top", partColorPath: viewPath("top"), comparisonPath: join(stepDir, "mapping-report-top.png") },
          // The report renderer names the +X orthographic face "side".
          { name: "right", partColorPath: viewPath("right"), comparisonPath: join(stepDir, "mapping-report-side.png") },
        ],
      },
    };
  });
}
