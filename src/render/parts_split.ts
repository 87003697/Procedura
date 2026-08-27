/**
 * Shared SCAD → per-part coloured-mesh splitter.
 *
 * Compiles each top-level module *in assembly* (every other module stubbed to
 * `{}`, so the part lands at its true assembled world position) and assigns it
 * a colour from a palette, cycling if there are more modules than colours.
 *
 * Used by both the parts-colour renderer (`parts_color.ts`, lit Principled
 * BSDF) and the colour-AO renderer (`ao_color.ts`, AO emission × tint) so the
 * "split a SCAD into coloured parts" logic lives in exactly one place.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { compileModuleInAssembly, listTopLevelModules } from "../scad/parts.ts";
import { mapPool, COMPILE_CONCURRENCY } from "../util/pool.ts";
import { timeStage } from "../pipeline/stage-timer.ts";

// 12-step palette tuned for distinguishability on near-white backdrops.
// Cycled if there are more modules than colours.
export const DEFAULT_PALETTE: ReadonlyArray<[number, number, number]> = [
  [0.86, 0.27, 0.27],  // red
  [0.27, 0.55, 0.86],  // blue
  [0.30, 0.74, 0.40],  // green
  [0.90, 0.65, 0.20],  // amber
  [0.66, 0.40, 0.78],  // purple
  [0.20, 0.72, 0.74],  // teal
  [0.86, 0.46, 0.65],  // pink
  [0.55, 0.50, 0.32],  // olive
  [0.40, 0.35, 0.85],  // indigo
  [0.78, 0.55, 0.40],  // tan
  [0.55, 0.74, 0.25],  // lime
  [0.50, 0.50, 0.50],  // grey
];

export interface ColoredPart {
  name: string;
  rgb: [number, number, number];
  stl: string;
  /** Present only when a per-part PBR material was supplied (paint stage). */
  material?: { roughness: number; metalness: number };
}

export type SplitResult =
  | { ok: true; meshSpecs: string[]; legend: string; parts: ColoredPart[] }
  | { ok: false; error: string };

export interface SplitScadOpts {
  /** SCAD source to split (the working buffer, not a path). */
  scadCode: string;
  /** Directory to write per-part STLs into (a `_parts/` subdir is created). */
  outDir: string;
  /**
   * Put the `_parts/` STL scratch HERE instead of under `outDir`.
   *
   * These meshes are bulk throwaway intermediates — Blender reads them once and
   * nothing else ever does. On this setup `outDir` is the shared output mount,
   * measured at 4.6 MB/s write and 2.4 MB/s read against 1158/7936 MB/s local,
   * and one 26-part run pushes 3.3 GB of STL through it: 12.4 min of write
   * inside the split stage and 23.3 min of read inside the Blender stage, out of
   * 52.7 min of total compute. The same bytes cost 3.6 seconds locally.
   *
   * Only the bulk moves. The PNGs, the legend and every artifact worth keeping
   * still land under `outDir`.
   */
  partsScratchDir?: string;
  palette?: ReadonlyArray<[number, number, number]>;
  /** Override the per-part colour by module name (paint stage's SEMANTIC
   *  colours). Names not present here fall back to the cycled palette. */
  colorByName?: ReadonlyMap<string, [number, number, number]>;
  /** Per-part PBR material by module name. When given for a part, its meshSpec
   *  is emitted as `stl:r,g,b,rough,metal` (5 values) so the Blender renderer
   *  can shade it with the right roughness/metalness; otherwise 3 values. */
  materialByName?: ReadonlyMap<string, { roughness: number; metalness: number }>;
  /**
   * Recompile at this `$fn` instead of the source's own.
   *
   * Tessellation is the dominant cost of these compiles, not OpenSCAD overhead:
   * on a real 26-part model one module measured 2.34s / 303k tris at the
   * scaffold's `$fn = 128`, against 0.34s / 42k tris at 32 — 6.9x, and the STL
   * it hands Blender shrinks 14.4 MB -> 2.0 MB, so the render gets cheaper too.
   * Only worth it for throwaway meshes: a context render is a 512px placement
   * aid where 128-segment cylinders are invisible. NEVER set this for meshes
   * that ship or are judged on appearance.
   *
   * Only a top-level `$fn = N;` is rewritten. A local `$fn` inside a module is
   * a deliberate per-feature choice and is left alone.
   */
  fnOverride?: number;
  log?: (line: string) => void;
}

/** Rewrite the top-level `$fn = N;`, or add one if the source has none. */
function applyFnOverride(scadCode: string, fn: number): string {
  const top = /^[ \t]*\$fn[ \t]*=[ \t]*([\d.]+)[ \t]*;/m;
  const m = top.exec(scadCode);
  // An ADAPTIVE model ($fn = 0, facets from $fa/$fs) must not be forced back to
  // a fixed count: that would make small features MORE expensive, not less — a
  // bolt at r=2 gets 12 facets adaptively and would get `fn` of them instead.
  // Coarsen the adaptive knobs instead, which is what a throwaway context
  // render actually wants.
  if (m && Number(m[1]) === 0) {
    return scadCode
      .replace(/^[ \t]*\$fa[ \t]*=[ \t]*[\d.]+[ \t]*;/m, "$fa = 12;")
      .replace(/^[ \t]*\$fs[ \t]*=[ \t]*[\d.]+[ \t]*;/m, "$fs = 2;");
  }
  if (m) return scadCode.replace(top, `$fn = ${fn};`);
  return `$fn = ${fn};\n${scadCode}`;
}

/**
 * Split SCAD into coloured parts. Returns `meshSpecs` ready to hand to a
 * Blender `--meshes <stl>:r,g,b ...` argument, a tab-separated `legend`
 * (module → RGB → STL path) for the model to cite parts by colour, and the
 * structured `parts` list. Fails only if there are no modules or every
 * module compiled to empty geometry.
 */
export async function splitScadToColoredParts(opts: SplitScadOpts): Promise<SplitResult> {
  const palette = opts.palette ?? DEFAULT_PALETTE;
  const log = opts.log ?? (() => undefined);

  const scadCode = opts.fnOverride && opts.fnOverride > 0
    ? applyFnOverride(opts.scadCode, opts.fnOverride)
    : opts.scadCode;

  const modules = listTopLevelModules(scadCode);
  if (modules.length === 0) {
    return { ok: false, error: "no top-level modules in SCAD — nothing to colour-render" };
  }

  const partsDir = join(opts.partsScratchDir ?? opts.outDir, "_parts");
  mkdirSync(partsDir, { recursive: true });

  // Each module is an independent OpenSCAD subprocess reading the same
  // immutable source and writing only into its own `_parts/<module>/` dir — the
  // loop was sequential because it was written as one, not because it had to
  // be. Fold the results in MODULE ORDER afterwards: colours come from the
  // module's index (`palette[i % len]`) and callers read `parts`/`meshSpecs`
  // positionally, so ordering must survive the out-of-order completion.
  const stls = await timeStage("openscad.split", () =>
    mapPool(modules, COMPILE_CONCURRENCY, (name) =>
      compileModuleInAssembly(scadCode, name, join(partsDir, name))));

  const meshSpecs: string[] = [];
  const parts: ColoredPart[] = [];
  for (let i = 0; i < modules.length; i++) {
    const name = modules[i]!;
    const stl = stls[i]!;
    if (stl === null) {
      log(`      [parts-split] skip ${name} — produced no geometry`);
      continue;
    }
    const [r, g, b] = opts.colorByName?.get(name) ?? palette[i % palette.length]!;
    const mat = opts.materialByName?.get(name);
    if (mat) {
      meshSpecs.push(
        `${stl}:${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)},` +
        `${mat.roughness.toFixed(4)},${mat.metalness.toFixed(4)}`,
      );
      parts.push({ name, rgb: [r, g, b], stl, material: mat });
    } else {
      meshSpecs.push(`${stl}:${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)}`);
      parts.push({ name, rgb: [r, g, b], stl });
    }
  }
  if (meshSpecs.length === 0) {
    return { ok: false, error: "all modules produced empty STLs" };
  }

  const legend =
    "module\tR\tG\tB\tstl_path\n" +
    parts
      .map((p) => `${p.name}\t${p.rgb[0].toFixed(4)}\t${p.rgb[1].toFixed(4)}\t${p.rgb[2].toFixed(4)}\t${p.stl}`)
      .join("\n") +
    "\n";

  return { ok: true, meshSpecs, legend, parts };
}
