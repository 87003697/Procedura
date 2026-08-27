/**
 * Run discovery + detail reading. Pure filesystem; imports no pipeline code,
 * so it runs in this worktree without the @harness/template dependency.
 *
 * A "run" is any directory that holds at least one Procedura artifact
 * (image.png / draft.scad / final.scad / initial.scad / a _trajectory dir).
 * Runs may be top-level under the root or nested one level (batch layout:
 * <root>/<batch>/<id>). Subtrees are frequently sparse — every read tolerates
 * absence.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

import { isInside, realInside, symlinksTrusted } from "./safe.ts";

import type {
  ArtifactFile,
  CompileStep,
  DirListing,
  FileKind,
  IncrementalData,
  IncrementalPart,
  MaterialsData,
  MeshArtifact,
  MotionData,
  MotionJoint,
  MotionLink,
  MotionValidation,
  PartLegendEntry,
  RefineCycle,
  RefineStep,
  RenderStep,
  RunDetail,
  RunShape,
  RunStatus,
  RunSummary,
  SubStep,
  ViewImage,
} from "../shared/types.ts";

const MAX_SCAN_DEPTH = 3;
const VIEW_ORDER = ["isometric", "front", "right", "top"];

// ── small fs helpers ────────────────────────────────────────────────────────

function readText(p: string, max = 0): string | null {
  try {
    const t = readFileSync(p, "utf8");
    return max > 0 && t.length > max ? t.slice(0, max) : t;
  } catch {
    return null;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink() || !symlinksTrusted()) return false;
        try {
          return statSync(join(p, e.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function rel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

function stepNum(dirName: string): number {
  const m = /step_(\d+)/.exec(dirName);
  return m ? Number(m[1]) : 0;
}

/**
 * Per-module STL meshes a run already has on disk, from the parts-color renders
 * (`_agent_renders/step_NNN/parts_color/_parts/<module>/output.stl`), each at its
 * true assembled world position. Uses the latest render step that has any. The
 * highlight feature overlays these; returns [] when none exist (feature inactive).
 */
export function findPartMeshes(root: string, dir: string): { module: string; stlPath: string }[] {
  const base = join(dir, "_agent_renders");
  const stepDirs = listDirs(base)
    .filter((d) => d.startsWith("step_"))
    .sort((a, b) => stepNum(b) - stepNum(a)); // newest first
  for (const step of stepDirs) {
    const partsDir = join(base, step, "parts_color", "_parts");
    const mods = listDirs(partsDir);
    const out: { module: string; stlPath: string }[] = [];
    for (const m of mods) {
      const stl = join(partsDir, m, "output.stl");
      if (existsSync(stl) && sizeOf(stl) > 0) out.push({ module: m, stlPath: rel(root, stl) });
    }
    if (out.length) return out.sort((a, b) => a.module.localeCompare(b.module));
  }
  return [];
}

function viewOf(fileName: string): string {
  const m = /-(\w+)\.png$/.exec(fileName);
  return m && m[1] ? m[1] : "other";
}

function sortViews(a: ViewImage, b: ViewImage): number {
  const ia = VIEW_ORDER.indexOf(a.view);
  const ib = VIEW_ORDER.indexOf(b.view);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}

// ── run detection ─────────────────────────────────────────────────────────

const RUN_MARKERS = ["image.png", "draft.scad", "final.scad", "initial.scad"];

function isRunDir(dir: string): boolean {
  if (RUN_MARKERS.some((m) => existsSync(join(dir, m)))) return true;
  return existsSync(join(dir, "_trajectory"));
}

/** Recursively collect run directories under `root` (depth-capped). */
export function findRunDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;
    if (depth > 0 && isRunDir(dir)) {
      found.push(dir);
      return; // a run is a leaf — don't descend into its artifact subtrees
    }
    for (const name of listDirs(dir)) {
      if (name.startsWith("_") || name === "node_modules" || name.startsWith(".")) {
        continue;
      }
      walk(join(dir, name), depth + 1);
    }
  };
  // The root itself can be a single run dir.
  if (isRunDir(root)) {
    found.push(root);
    return found;
  }
  walk(root, 0);
  return found;
}

// ── prompt / status / shape ─────────────────────────────────────────────────

function readPrompt(dir: string): string {
  for (const f of ["effective_text.txt", "prompt.txt", "caption.txt"]) {
    const t = readText(join(dir, f));
    if (t && t.trim()) return t.trim();
  }
  return "";
}

function titleOf(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? oneLine.slice(0, 140) + "…" : oneLine || "(no prompt)";
}

function detectShape(dir: string): RunShape {
  if (existsSync(join(dir, "draft.scad")) || existsSync(join(dir, "final.scad"))) {
    return "draft-refine";
  }
  if (existsSync(join(dir, "initial.scad")) || existsSync(join(dir, "ortho_reviewed.scad"))) {
    return "ortho";
  }
  if (existsSync(join(dir, "image.png")) || existsSync(join(dir, "_trajectory"))) {
    return "sparse";
  }
  return "unknown";
}

function parseVerdict(summary: string | null): { status: RunStatus; verdict: string | null } {
  if (!summary) return { status: "unknown", verdict: null };
  const firstLine = summary.split("\n").find((l) => l.trim()) ?? "";
  const m = /verdict:\s*(\w[\w-]*)/i.exec(summary);
  if (/no finish summary/i.test(summary)) {
    return { status: "max-steps", verdict: firstLine.trim() || "max-steps" };
  }
  if (m) {
    const v = (m[1] ?? "").toLowerCase();
    if (v === "ok") return { status: "ok", verdict: firstLine.trim() };
    if (v === "give_up") return { status: "give_up", verdict: firstLine.trim() };
    if (v === "max-steps" || v === "max_steps") return { status: "max-steps", verdict: firstLine.trim() };
    return { status: "incomplete", verdict: firstLine.trim() };
  }
  return { status: "incomplete", verdict: firstLine.trim() || null };
}

function deriveStatus(dir: string, shape: RunShape): { status: RunStatus; verdict: string | null } {
  const summary =
    readText(join(dir, "final_summary.txt")) ??
    readText(join(dir, "ortho_review_summary.txt"));
  const parsed = parseVerdict(summary);
  if (parsed.status !== "unknown") return parsed;
  if (existsSync(join(dir, "final.scad")) || existsSync(join(dir, "ortho_reviewed.scad"))) {
    return { status: "incomplete", verdict: null };
  }
  if (shape === "sparse") return { status: "incomplete", verdict: null };
  if (existsSync(join(dir, "draft.scad"))) return { status: "incomplete", verdict: null };
  return { status: "unknown", verdict: null };
}

function pickThumbnail(root: string, dir: string): string | null {
  const candidates = [
    join(dir, "preview_painted", "pbr-isometric.png"),
    join(dir, "preview_final", "ao-isometric.png"),
    join(dir, "preview_final", "ao-front.png"),
    join(dir, "image.png"),
  ];
  for (const c of candidates) if (existsSync(c)) return rel(root, c);
  // fall back to the first render step's parts-color isometric
  const rendersDir = join(dir, "_agent_renders");
  for (const step of listDirs(rendersDir).sort()) {
    for (const sub of ["parts_color", "ao"]) {
      const p = join(rendersDir, step, sub);
      const png = listFiles(p).find((f) => /isometric\.png$/.test(f)) ?? listFiles(p).find((f) => f.endsWith(".png"));
      if (png) return rel(root, join(p, png));
    }
  }
  return null;
}

function countSteps(dir: string): number {
  const refine = listDirs(join(dir, "_refine_steps")).filter((d) => d.startsWith("step_"));
  if (refine.length) return refine.length;
  const renders = listDirs(join(dir, "_agent_renders")).filter((d) => d.startsWith("step_"));
  return renders.length;
}

// ── summaries (cheap, for the list) ─────────────────────────────────────────

export function summarizeRun(root: string, dir: string): RunSummary {
  // When the root itself is a run, rel() is "" — use "." so the id round-trips
  // through resolveRunDir(root, ".") back to the root.
  const id = rel(root, dir) || ".";
  const name = basename(dir);
  const parent = rel(root, join(dir, ".."));
  const group = parent && parent !== "." && parent !== "" ? parent : null;
  const shape = detectShape(dir);
  const prompt = readPrompt(dir);
  const { status, verdict } = deriveStatus(dir, shape);

  // STL is no longer exported by default — the OBJ is the mesh deliverable, so
  // accept either extension.
  const hasFinalMesh = existsSync(join(dir, "final.stl")) || existsSync(join(dir, "final.obj")) || existsSync(join(dir, "ortho_reviewed.stl"));
  const hasDraftMesh = existsSync(join(dir, "draft.stl")) || existsSync(join(dir, "draft.obj")) || existsSync(join(dir, "initial.stl"));

  const mtime = Math.max(
    mtimeOf(dir),
    mtimeOf(join(dir, "final_summary.txt")),
    mtimeOf(join(dir, "final.scad")),
    mtimeOf(join(dir, "draft.scad")),
    mtimeOf(join(dir, "image.png")),
  );

  return {
    id,
    name,
    group,
    title: titleOf(prompt),
    status,
    shape,
    steps: countSteps(dir),
    hasImage: existsSync(join(dir, "image.png")),
    hasDraftMesh,
    hasFinalMesh,
    hasPaint: existsSync(join(dir, "final_painted.obj")),
    hasMotion: existsSync(join(dir, "motion", "final_motion.usda")),
    thumbnail: pickThumbnail(root, dir),
    verdict,
    mtime,
  };
}

export function listRuns(root: string): RunSummary[] {
  if (!existsSync(root)) return [];
  const dirs = findRunDirs(root);
  const runs = dirs.map((d) => summarizeRun(root, d));
  runs.sort((a, b) => b.mtime - a.mtime);
  return runs;
}

// ── detail (per-run, lazy on heavy artifacts) ───────────────────────────────

function meshArtifact(root: string, dir: string, base: string): MeshArtifact | null {
  const scad = join(dir, `${base}.scad`);
  const stl = join(dir, `${base}.stl`);
  const obj = join(dir, `${base}.obj`);
  const mtl = join(dir, `${base}.mtl`);
  const hasAny = existsSync(scad) || existsSync(stl) || existsSync(obj);
  if (!hasAny) return null;
  const scadText = readText(scad);
  return {
    scadPath: existsSync(scad) ? rel(root, scad) : null,
    stlPath: existsSync(stl) ? rel(root, stl) : null,
    objPath: existsSync(obj) ? rel(root, obj) : null,
    mtlPath: existsSync(mtl) ? rel(root, mtl) : null,
    scadLines: scadText ? scadText.split("\n").length : null,
  };
}

function parsePartsLegend(metaPath: string): PartLegendEntry[] | null {
  const t = readText(metaPath);
  if (!t) return null;
  const out: PartLegendEntry[] = [];
  for (const line of t.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 4) continue;
    if (cols[0] === "module") continue; // header
    const r = Number(cols[1]);
    const g = Number(cols[2]);
    const b = Number(cols[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
    out.push({ module: cols[0] ?? "", rgb: [r, g, b] });
  }
  return out.length ? out : null;
}

function readRenderSteps(root: string, dir: string): RenderStep[] {
  const base = join(dir, "_agent_renders");
  const steps: RenderStep[] = [];
  for (const stepDir of listDirs(base).filter((d) => d.startsWith("step_"))) {
    const abs = join(base, stepDir);
    const aoDir = join(abs, "ao");
    const pcDir = join(abs, "parts_color");
    const ao: ViewImage[] = listFiles(aoDir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ view: viewOf(f), path: rel(root, join(aoDir, f)) }))
      .sort(sortViews);
    const partsColor: ViewImage[] = listFiles(pcDir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ view: viewOf(f), path: rel(root, join(pcDir, f)) }))
      .sort(sortViews);
    steps.push({
      step: stepNum(stepDir),
      ao,
      partsColor,
      legend: parsePartsLegend(join(pcDir, "parts_color_meta.txt")),
    });
  }
  steps.sort((a, b) => a.step - b.step);
  return steps;
}

function readCompileSteps(root: string, dir: string): CompileStep[] {
  const base = join(dir, "_agent_compiles");
  const steps: CompileStep[] = [];
  for (const stepDir of listDirs(base).filter((d) => d.startsWith("step_"))) {
    const abs = join(base, stepDir);
    steps.push({
      step: stepNum(stepDir),
      label: stepDir,
      stlPath: existsSync(join(abs, "output.stl")) ? rel(root, join(abs, "output.stl")) : null,
      scadPath: existsSync(join(abs, "input.scad")) ? rel(root, join(abs, "input.scad")) : null,
      summary: readJson(join(abs, "output.summary.json")),
    });
  }
  steps.sort((a, b) => a.step - b.step || a.label.localeCompare(b.label));
  return steps;
}

function readRefineSteps(root: string, dir: string): RefineStep[] {
  const base = join(dir, "_refine_steps");
  const steps: RefineStep[] = [];
  for (const stepDir of listDirs(base).filter((d) => d.startsWith("step_"))) {
    const abs = join(base, stepDir);
    const subSteps: SubStep[] = [];
    for (const subDir of listDirs(abs).filter((d) => d.startsWith("sub_"))) {
      const subAbs = join(abs, subDir);
      const m = /sub_(\d+)_(.+)$/.exec(subDir);
      const errResult = readText(join(subAbs, "tool_result_ERROR.txt"));
      const okResult = readText(join(subAbs, "tool_result.txt"));
      subSteps.push({
        sub: m ? Number(m[1]) : 0,
        tool: m && m[2] ? m[2] : "?",
        assistant: readText(join(subAbs, "assistant.txt")),
        thinking: readText(join(subAbs, "thinking.txt")),
        toolCall: readJson(join(subAbs, "tool_call.json")),
        toolResult: errResult ?? okResult,
        isError: errResult !== null,
        scadPath: existsSync(join(subAbs, "scad.scad")) ? rel(root, join(subAbs, "scad.scad")) : null,
      });
    }
    subSteps.sort((a, b) => a.sub - b.sub);
    steps.push({
      step: stepNum(stepDir),
      subSteps,
      finalScadPath: existsSync(join(abs, "scad.scad")) ? rel(root, join(abs, "scad.scad")) : null,
      summary: (readJson(join(abs, "summary.json")) as RefineStep["summary"]) ?? null,
    });
  }
  steps.sort((a, b) => a.step - b.step);
  return steps;
}

/** The refine loop's cycles from `_refine_steps/step_NNN/` (current layout). */
function readCycles(root: string, dir: string): RefineCycle[] {
  const base = join(dir, "_refine_steps");
  const out: RefineCycle[] = [];
  for (const stepDir of listDirs(base).filter((d) => d.startsWith("step_"))) {
    const abs = join(base, stepDir);
    // The legacy agentic layout has sub_NN_<tool> dirs and no diagnosis.txt;
    // leave those to readRefineSteps.
    if (!existsSync(join(abs, "diagnosis.txt")) && !existsSync(join(abs, "summary.json"))) continue;
    const summary = readJson(join(abs, "summary.json"));
    const facets = (summary?.["facets"] ?? null) as Record<string, unknown> | null;
    const viewsDir = join(abs, "views");
    const views: ViewImage[] = listFiles(viewsDir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ view: viewOf(f), path: rel(root, join(viewsDir, f)) }))
      .sort(sortViews);
    const patchResponsePaths = listFiles(abs)
      .filter((f) => /^patch_response_\d+\.txt$/.test(f))
      .sort()
      .map((f) => rel(root, join(abs, f)));
    const patchThinkingPaths = listFiles(abs)
      .filter((f) => /^patch_thinking_\d+\.txt$/.test(f))
      .sort()
      .map((f) => rel(root, join(abs, f)));
    const n = typeof summary?.["cycle"] === "number" ? (summary["cycle"] as number) : stepNum(stepDir);
    out.push({
      cycle: n,
      accepted: typeof summary?.["accepted"] === "boolean" ? (summary["accepted"] as boolean) : null,
      attempt: typeof summary?.["attempt"] === "number" ? (summary["attempt"] as number) : null,
      touched: (Array.isArray(summary?.["touched"]) ? summary!["touched"] : []).map(String),
      reason: str(summary?.["reason"])?.replace(/^reason:\s*/i, "") ?? null,
      facetsBefore: typeof facets?.["before"] === "number" ? (facets["before"] as number) : null,
      facetsAfter: typeof facets?.["after"] === "number" ? (facets["after"] as number) : null,
      views,
      legend: parsePartsLegend(join(viewsDir, "parts_color_meta.txt")),
      diagnosis: readText(join(abs, "diagnosis.txt"), 40_000),
      diagnoseThinkingPath: existsSync(join(abs, "diagnose_thinking.txt")) ? rel(root, join(abs, "diagnose_thinking.txt")) : null,
      patchResponsePaths,
      patchThinkingPaths,
      scadPath: existsSync(join(abs, "scad.scad")) ? rel(root, join(abs, "scad.scad")) : null,
      measured: listDirs(join(abs, "measure")).map((d) => d.replace(/^m_/, "")).sort(),
    });
  }
  out.sort((a, b) => a.cycle - b.cycle);
  return out;
}

/**
 * Incremental (part-by-part) draft artifacts: the plan + every `_parts/NN_<name>`
 * dir, enriched with the per-part results from parts_summary.json. Returns null
 * for non-incremental runs (no plan.json / parts_summary.json / _parts dir).
 */
function readIncremental(root: string, dir: string): IncrementalData | null {
  const partsRoot = join(dir, "_parts");
  const summaryRaw = readText(join(dir, "parts_summary.json"));
  const planRaw = readText(join(dir, "plan.json"));
  const partDirs = listDirs(partsRoot)
    .filter((d) => /^\d+_/.test(d))
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  if (!summaryRaw && !planRaw && partDirs.length === 0) return null;

  // parts_summary.json = { plan, parts, partsGenerated, floaterParts }.
  let summary: Record<string, unknown> | null = null;
  try {
    summary = summaryRaw ? (JSON.parse(summaryRaw) as Record<string, unknown>) : null;
  } catch {
    /* tolerate malformed */
  }

  const rawPlan = Array.isArray(summary?.["plan"])
    ? (summary!["plan"] as unknown[])
    : (() => {
        try {
          return planRaw ? (JSON.parse(planRaw) as unknown[]) : [];
        } catch {
          return [];
        }
      })();
  const plan = (Array.isArray(rawPlan) ? rawPlan : []).map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      name: String(o["name"] ?? ""),
      ...(o["level"] ? { level: String(o["level"]) } : {}),
      ...(o["description"] ? { description: String(o["description"]) } : {}),
    };
  });

  const resultByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(summary?.["parts"])) {
    for (const pr of summary!["parts"] as unknown[]) {
      const o = (pr ?? {}) as Record<string, unknown>;
      if (o["name"]) resultByName.set(String(o["name"]), o);
    }
  }

  const parts: IncrementalPart[] = partDirs.map((d) => {
    const m = /^(\d+)_(.+)$/.exec(d);
    const index = m ? Number(m[1]) : 0;
    const name = m && m[2] ? m[2] : d;
    const abs = join(partsRoot, d);
    const pr = resultByName.get(name) ?? {};
    const planItem = plan.find((p) => p.name === name);
    const ctxDir = join(abs, "context_render");
    const contextViews: ViewImage[] = listFiles(ctxDir)
      .filter((f) => f.endsWith(".png") && /^(color|aoc|ao)-/.test(f))
      .map((f) => ({ view: viewOf(f), path: rel(root, join(ctxDir, f)) }))
      .sort(sortViews);
    const genResponsePaths = listFiles(abs)
      .filter((f) => /^gen_response_\d+\.txt$/.test(f))
      .sort()
      .map((f) => rel(root, join(abs, f)));
    return {
      index,
      name,
      ...(pr["placedName"] ? { placedName: String(pr["placedName"]) } : {}),
      ...(planItem?.level ? { level: planItem.level } : {}),
      ...(planItem?.description ? { description: planItem.description } : {}),
      generated: typeof pr["generated"] === "boolean" ? (pr["generated"] as boolean) : existsSync(join(abs, "after_gen.scad")),
      refined: pr["refined"] === true,
      genAttempts: Number(pr["genAttempts"] ?? 0),
      ...(typeof pr["connected"] === "boolean" ? { connected: pr["connected"] as boolean } : {}),
      ...(typeof pr["floatersAfter"] === "number"
        ? { floatersAfter: pr["floatersAfter"] as number }
        : {}),
      ...(pr["error"] ? { error: String(pr["error"]) } : {}),
      scadPath: existsSync(join(abs, "after_gen.scad"))
        ? rel(root, join(abs, "after_gen.scad"))
        : null,
      genResponsePaths,
      contextViews,
    };
  });

  return {
    plan,
    partsGenerated: Number(summary?.["partsGenerated"] ?? parts.filter((p) => p.generated).length),
    floaterParts: Number(
      summary?.["floaterParts"] ?? parts.filter((p) => p.connected === false).length,
    ),
    planResponsePath: existsSync(join(dir, "plan_response.txt"))
      ? rel(root, join(dir, "plan_response.txt"))
      : null,
    planReviewPaths: listFiles(dir)
      .filter((f) => /^plan_review.*\.txt$/.test(f))
      .sort()
      .map((f) => rel(root, join(dir, f))),
    parts,
  };
}

function readPaintedViews(root: string, dir: string): ViewImage[] {
  const abs = join(dir, "preview_painted");
  return listFiles(abs)
    .filter((f) => f.endsWith(".png"))
    .map((f) => ({ view: viewOf(f), path: rel(root, join(abs, f)) }))
    .sort(sortViews);
}


/** final_materials.json → palette + per-part assignment. Tolerates absence and
 *  partial shapes (the file is LLM-derived and has evolved). */
function readMaterials(dir: string): MaterialsData | null {
  const raw = readJson(join(dir, "final_materials.json"));
  if (!raw) return null;
  const palette = (Array.isArray(raw["palette"]) ? raw["palette"] : []).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return {
      id: str(o["id"]) ?? "",
      name: str(o["name"]) ?? "",
      hex: str(o["hex"]) ?? "#888888",
      material: str(o["material"]) ?? "unknown",
      roughness: num(o["roughness"], 0.5),
      metalness: num(o["metalness"], 0),
      ...(typeof o["clearcoat"] === "number" ? { clearcoat: o["clearcoat"] as number } : {}),
      ...(typeof o["wear"] === "number" ? { wear: o["wear"] as number } : {}),
      ...(typeof o["dirt"] === "number" ? { dirt: o["dirt"] as number } : {}),
      ...(typeof o["emission"] === "number" ? { emission: o["emission"] as number } : {}),
      ...(str(o["where"]) ? { where: str(o["where"])! } : {}),
    };
  });
  const parts = (Array.isArray(raw["parts"]) ? raw["parts"] : []).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return {
      name: str(o["name"]) ?? "",
      hex: str(o["hex"]) ?? "#888888",
      materialId: str(o["materialId"]),
      materialName: str(o["materialName"]),
      material: str(o["material"]) ?? "unknown",
      roughness: num(o["roughness"], 0.5),
      metalness: num(o["metalness"], 0),
    };
  });
  if (!palette.length && !parts.length) return null;
  return { palette, parts };
}

/** The motion/ dir: plan (links + joints), manifest, validation, feedback views. */
function readMotion(root: string, dir: string): MotionData | null {
  const mdir = join(dir, "motion");
  const usda = join(mdir, "final_motion.usda");
  const manifest = readJson(join(mdir, "manifest.json"));
  if (!existsSync(usda) && !manifest) return null;

  // The refined plan supersedes the generated one, which supersedes a resolved
  // sidecar; the manifest names the one that actually drove the export.
  const planCandidates = [
    manifest?.["planPath"] ? basename(String(manifest["planPath"])) : null,
    "motion_plan.refined.json",
    "motion_plan.generated.json",
    "motion_plan.resolved.json",
  ].filter((f): f is string => !!f);
  let plan: Record<string, unknown> | null = null;
  let planFile: string | null = null;
  for (const f of planCandidates) {
    const j = readJson(join(mdir, f));
    if (j) {
      plan = j;
      planFile = f;
      break;
    }
  }

  const links: MotionLink[] = (Array.isArray(plan?.["links"]) ? plan!["links"] : []).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const name = str(o["name"]) ?? "";
    const obj = join(mdir, "links", name, `${name}.obj`);
    return {
      name,
      parts: (Array.isArray(o["parts"]) ? o["parts"] : []).map(String),
      objPath: existsSync(obj) ? rel(root, obj) : null,
    };
  });
  const joints: MotionJoint[] = (Array.isArray(plan?.["joints"]) ? plan!["joints"] : []).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const lim = (o["limit"] ?? null) as Record<string, unknown> | null;
    const mimic = (o["mimic"] ?? null) as Record<string, unknown> | null;
    return {
      name: str(o["name"]) ?? "",
      type: str(o["type"]) ?? "fixed",
      parent: str(o["parent"]),
      child: str(o["child"]) ?? "",
      axis: str(o["axis"]),
      limit:
        lim && typeof lim["lower"] === "number" && typeof lim["upper"] === "number"
          ? ([lim["lower"], lim["upper"]] as [number, number])
          : null,
      hasDrive: !!o["drive"],
      mimic: mimic ? (str(mimic["joint"]) ?? str(mimic["reference"])) : null,
    };
  });

  const report = readJson(join(mdir, "isaac_validation.json"));
  const summary = (manifest?.["validation"] ?? null) as Record<string, unknown> | null;
  const phases: Record<string, boolean | null> = {};
  if (report && typeof report["phases"] === "object" && report["phases"]) {
    for (const [k, v] of Object.entries(report["phases"] as Record<string, unknown>)) {
      const ok = (v as Record<string, unknown> | null)?.["ok"];
      phases[k] = typeof ok === "boolean" ? ok : null;
    }
  }
  const videos = (Array.isArray(report?.["videos"]) ? report!["videos"] : [])
    .map((v) => str((v as Record<string, unknown>)?.["path"]))
    .filter((v): v is string => !!v)
    .map((v) => (v.startsWith("/") ? v : join(mdir, v)))
    .filter((v) => existsSync(v) && isInside(dir, resolve(v)))
    .map((v) => rel(root, v));
  const validation: MotionValidation = {
    ran: !!report || summary?.["ran"] === true,
    ok: typeof report?.["ok"] === "boolean" ? (report["ok"] as boolean)
      : typeof summary?.["ok"] === "boolean" ? (summary["ok"] as boolean) : null,
    phases,
    errors: (Array.isArray(report?.["errors"]) ? report!["errors"] : []).map(String),
    warnings: (Array.isArray(report?.["warnings"]) ? report!["warnings"] : []).map(String),
    skippedReason: str(summary?.["skippedReason"]),
    videos,
  };

  const fbDir = join(mdir, "render_feedback");
  const feedbackViews: ViewImage[] = listFiles(fbDir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => ({ view: viewOf(f), path: rel(root, join(fbDir, f)) }))
    .sort(sortViews);
  const urdf = join(mdir, "urdf", "robot.urdf");
  const planner = (manifest?.["planner"] ?? null) as Record<string, unknown> | null;

  return {
    usdaPath: existsSync(usda) ? rel(root, usda) : null,
    urdfPath: existsSync(urdf) ? rel(root, urdf) : null,
    planPath: planFile ? rel(root, join(mdir, planFile)) : null,
    planSource: str(manifest?.["planSource"]),
    plannerModel: str(planner?.["model"]),
    rootLink: str(plan?.["rootLink"]),
    fixedBase: typeof manifest?.["fixedBase"] === "boolean" ? (manifest["fixedBase"] as boolean)
      : typeof plan?.["fixedBase"] === "boolean" ? (plan["fixedBase"] as boolean) : null,
    metersPerUnit: typeof manifest?.["metersPerUnit"] === "number" ? (manifest["metersPerUnit"] as number) : null,
    links,
    joints,
    validation,
    feedbackViews,
    warnings: (Array.isArray(manifest?.["warnings"]) ? manifest!["warnings"] : []).map(String),
  };
}

function readPreviewViews(root: string, dir: string): ViewImage[] {
  for (const previewDir of ["preview_final", "preview_ao", "preview_ao_ortho"]) {
    const abs = join(dir, previewDir);
    const pngs = listFiles(abs).filter((f) => f.endsWith(".png"));
    if (pngs.length) {
      return pngs.map((f) => ({ view: viewOf(f), path: rel(root, join(abs, f)) })).sort(sortViews);
    }
  }
  return [];
}

/** List one directory inside a run (for the file browser). Guards against
 *  escaping the run dir. `sub` is relative to the run dir ("" = run root). */
export function listDirEntries(root: string, runDir: string, sub: string): DirListing | null {
  const cleaned = sub.replace(/^[/\\]+/, "");
  const target = resolve(runDir, cleaned);
  const within = relative(runDir, target);
  if (within.startsWith("..")) return null;
  if (!existsSync(target) || !statSync(target).isDirectory()) return null;
  // Don't follow a directory symlink that escapes the run dir.
  if (!realInside(runDir, target)) return null;
  const entries: DirListing["entries"] = [];
  try {
    for (const e of readdirSync(target, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // hide dotfiles
      if (e.isSymbolicLink() && !symlinksTrusted()) continue; // never follow links out of the run
      const abs = join(target, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(abs).isDirectory();
        } catch {
          continue;
        }
      }
      entries.push({
        name: e.name,
        isDir,
        bytes: isDir ? 0 : sizeOf(abs),
        kind: isDir ? "dir" : classifyFile(e.name),
        path: rel(root, abs),
      });
    }
  } catch {
    return null;
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { sub: within.split("\\").join("/"), entries };
}

function classifyFile(name: string): FileKind {
  const ext = extname(name).toLowerCase();
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") return "image";
  if (ext === ".stl" || ext === ".obj") return "mesh";
  if (ext === ".scad") return "scad";
  if (ext === ".json") return "json";
  if (ext === ".txt" || ext === ".md" || ext === ".jsonl" || ext === ".mtl" || ext === ".usda" || ext === ".urdf" || ext === ".log") return "text";
  return "other";
}

function topLevelFiles(root: string, dir: string): ArtifactFile[] {
  return listFiles(dir)
    .map((f) => ({ path: rel(root, join(dir, f)), bytes: sizeOf(join(dir, f)), kind: classifyFile(f) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function trajectoryFiles(root: string, dir: string): string[] {
  const tdir = join(dir, "_trajectory");
  return listFiles(tdir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ rel: rel(root, join(tdir, f)), m: mtimeOf(join(tdir, f)) }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.rel);
}

export function readRunDetail(root: string, dir: string): RunDetail {
  const summary = summarizeRun(root, dir);
  return {
    ...summary,
    root,
    dir,
    prompt: readPrompt(dir),
    imagePath: existsSync(join(dir, "image.png")) ? rel(root, join(dir, "image.png")) : null,
    imagePrompt: readText(join(dir, "image_prompt.txt")),
    finalSummary:
      readText(join(dir, "final_summary.txt")) ?? readText(join(dir, "ortho_review_summary.txt")),
    draftResponse: readText(join(dir, "response.txt")),
    draftThinking: readText(join(dir, "thinking.txt")),
    draft: meshArtifact(root, dir, "draft") ?? meshArtifact(root, dir, "initial"),
    final: meshArtifact(root, dir, "final") ?? meshArtifact(root, dir, "ortho_reviewed"),
    previewViews: readPreviewViews(root, dir),
    painted: meshArtifact(root, dir, "final_painted"),
    previewPainted: readPaintedViews(root, dir),
    materials: readMaterials(dir),
    motion: readMotion(root, dir),
    liveBuild: (() => {
      for (const p of [join(dir, "draft.obj"), join(dir, "draft.stl"), join(dir, "_draft_build", "output.stl")]) {
        if (existsSync(p) && sizeOf(p) > 0) return { path: rel(root, p), mtime: mtimeOf(p) };
      }
      return null;
    })(),
    cycles: readCycles(root, dir),
    refineSteps: readRefineSteps(root, dir),
    renderSteps: readRenderSteps(root, dir),
    compileSteps: readCompileSteps(root, dir),
    incremental: readIncremental(root, dir),
    trajectoryFiles: trajectoryFiles(root, dir),
    files: topLevelFiles(root, dir),
  };
}

/** Resolve a run id (relative path) back to an absolute dir under root. */
export function resolveRunDir(root: string, id: string): string | null {
  const cleaned = id.replace(/^[/\\]+/, "");
  const abs = join(root, cleaned);
  if (!existsSync(abs)) return null;
  if (rel(root, abs).startsWith("..")) return null; // lexical guard
  // realpath guard: the run dir must not be a symlink pointing out of root
  // (unless symlinks under the root are explicitly trusted).
  if (!realInside(root, abs)) return null;
  return abs;
}
