/**
 * Colour-AO renderer — TypeScript orchestrator.
 *
 * Renders the same matte ambient-occlusion + Freestyle-edge look as the AO
 * renderer (`ao.ts`), but each top-level module is tinted by its palette
 * colour instead of rendering uniform grey. The critic gets form (AO crevice /
 * contact shading) AND part segmentation (colour + legend) in a single image,
 * collapsing what used to be two separate render passes into one.
 *
 * Pipeline:
 *   1. Split the SCAD into per-part STLs with palette colours (parts_split).
 *   2. Write `<outDir>/ao_color_meta.txt` (module → RGB → STL legend).
 *   3. Spawn Blender with `_render_ao_blender.py`, a `--meshes <stl>:r,g,b ...`
 *      argument per part, and `--out-prefix aoc`.
 *   4. Verify the requested aoc-<view>.png files landed.
 *
 * Reuses the AO Blender script + binary discovery from `ao.ts`; the only
 * difference from the grey AO path is the coloured per-part materials, which
 * the script builds when `--meshes` is supplied.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AO_RENDER_SCRIPT, BLENDER_BIN } from "./ao.ts";
import type { RenderedView } from "./ao.ts";
import { DEFAULT_PALETTE, splitScadToColoredParts } from "./parts_split.ts";
import { DEFAULT_VIEWS, type ViewName } from "./views.ts";

export interface RenderAOColorOpts {
  scadPath: string;
  outDir: string;
  size?: number;
  samples?: number;
  aoSamples?: number;
  /** World background value 0..1. Default 0.9 — near-white so colours read. */
  bg?: number;
  edgeThickness?: number;
  palette?: ReadonlyArray<[number, number, number]>;
  gpu?: boolean;
  views?: readonly ViewName[];
  timeoutMs?: number;
  log?: (line: string) => void;
}

export type RenderAOColorResult =
  | { ok: true; views: RenderedView[]; legend: string; metaPath: string }
  | { ok: false; error: string; logPath?: string };

export async function renderAOColorViews(
  opts: RenderAOColorOpts,
): Promise<RenderAOColorResult> {
  const outDir = opts.outDir;
  const log = opts.log ?? (() => undefined);
  const size = opts.size ?? 640;
  const samples = opts.samples ?? 32;
  const aoSamples = opts.aoSamples ?? 8;
  const bg = opts.bg ?? 0.9;
  const edgeThickness = opts.edgeThickness ?? 1.2;
  const palette = opts.palette ?? DEFAULT_PALETTE;
  const gpu = opts.gpu ?? true;
  const views = opts.views ?? DEFAULT_VIEWS;
  const timeoutMs = opts.timeoutMs ?? 900_000;

  mkdirSync(outDir, { recursive: true });

  if (!existsSync(BLENDER_BIN)) {
    return { ok: false, error: `Blender not found at ${BLENDER_BIN}` };
  }
  if (!existsSync(AO_RENDER_SCRIPT)) {
    return { ok: false, error: `AO render script missing at ${AO_RENDER_SCRIPT}` };
  }

  const scadCode = readFileSync(opts.scadPath, "utf8");
  const split = await splitScadToColoredParts({ scadCode, outDir, palette, log });
  if (!split.ok) {
    return { ok: false, error: split.error };
  }

  const metaPath = join(outDir, "ao_color_meta.txt");
  writeFileSync(metaPath, split.legend, "utf8");

  const args = [
    "--background",
    "--python", AO_RENDER_SCRIPT, "--",
    "--out", outDir,
    "--out-prefix", "aoc",
    "--views", views.join(","),
    "--samples", String(samples),
    "--size", String(size),
    "--ao-samples", String(aoSamples),
    "--bg", String(bg),
    "--edges",
    "--edge-thickness", String(edgeThickness),
    "--z-up",
    "--meshes", ...split.meshSpecs,
  ];
  if (gpu) args.push("--gpu");

  const proc = Bun.spawn([BLENDER_BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);

  if (exitCode !== 0) {
    const logPath = join(outDir, "ao_color_blender_stderr.log");
    writeFileSync(logPath, `${stderr}\n---STDOUT---\n${stdout}\n`, "utf8");
    return {
      ok: false,
      error: `colour-AO Blender render failed (exit ${exitCode})`,
      logPath,
    };
  }

  const rendered: RenderedView[] = [];
  const missing: string[] = [];
  for (const v of views) {
    const p = join(outDir, `aoc-${v}.png`);
    if (existsSync(p) && statSync(p).size > 1024) {
      rendered.push({ view: v, path: p, sizeKb: Math.floor(statSync(p).size / 1024) });
    } else {
      missing.push(`aoc-${v}.png`);
    }
  }
  if (missing.length > 0) {
    return { ok: false, error: `colour-AO render incomplete — missing: ${missing.join(", ")}` };
  }
  return { ok: true, views: rendered, legend: split.legend, metaPath };
}
