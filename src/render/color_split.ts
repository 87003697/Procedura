/**
 * Colour-region SCAD splitter.
 *
 * Given a SCAD whose geometry is partitioned into non-overlapping `color([r,g,b])`
 * blocks (the paint stage wraps each part's geometry — and each sub-feature that
 * has its own material, like a brass wheel hub — in a colour block), this
 * produces ONE mesh per distinct colour by compiling the whole assembly with
 * every OTHER colour block DISABLED via OpenSCAD's `*` modifier.
 *
 * `*color([...]) { ... }` tells OpenSCAD to skip that subtree, so a per-colour
 * compile yields exactly the geometry of that colour at its true world position
 * (across all instances / reused modules — the disable is on the shared module
 * body, so it applies everywhere the module is instantiated).
 *
 * This is how paint reaches finer than a whole top-level module: a wheel module
 * whose hub is wrapped in `color([gold]) { ... }` splits into a body mesh + a
 * hub mesh, each rendered with its own material.
 */

import { mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { compileScad } from "../scad/compile.ts";
import { mapPool, COMPILE_CONCURRENCY } from "../util/pool.ts";

const COLOR_RE = /\bcolor\(\s*\[([^\]]*)\]\s*\)/g;

/** Canonical key for an `[r,g,b]` argument (3 decimals, first 3 components). */
function normColor(inner: string): string {
  const nums = inner.split(",").map((s) => parseFloat(s.trim()));
  if (nums.length < 3 || nums.slice(0, 3).some((n) => !Number.isFinite(n))) return inner.trim();
  return nums.slice(0, 3).map((n) => (Math.round(n * 1000) / 1000).toString()).join(",");
}

/** Distinct numeric `color([...])` values used in the source (canonical keys). */
export function distinctColors(scad: string): string[] {
  const seen = new Set<string>();
  COLOR_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = COLOR_RE.exec(scad)); ) seen.add(normColor(m[1]!));
  return [...seen];
}

/** Prefix `*` (disable) to every numeric `color([...])` whose colour != keep. */
export function disableOtherColors(scad: string, keep: string): string {
  COLOR_RE.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m: RegExpExecArray | null; (m = COLOR_RE.exec(scad)); ) {
    out += scad.slice(last, m.index);
    if (normColor(m[1]!) !== keep) {
      const prevChar = out.replace(/\s+$/, "").slice(-1);
      out += (prevChar === "*" ? "" : "*") + m[0];   // avoid a double '**'
    } else {
      out += m[0];
    }
    last = m.index + m[0].length;
  }
  return out + scad.slice(last);
}

export interface ColorMesh { color: [number, number, number]; key: string; stl: string }

/**
 * Split `scad` into one STL per distinct colour. Each is compiled with the other
 * colours disabled. Colours that produce no geometry are dropped.
 *
 * This is the one cost in the paint stage that scales with the FEATURE: deeper
 * texturing means more distinct materials, and each material is a full-assembly
 * OpenSCAD compile. At the 31-colour median of the 36-model study that is 31
 * compiles — and they ran one after another.
 *
 * Nothing forced that. Each variant is an independent subprocess reading its own
 * immutable source string and writing only into its own `c<i>/` directory, so
 * they run `COMPILE_CONCURRENCY`-wide like every other per-module compile in
 * this codebase. Results fold back IN KEY ORDER: callers pair a mesh with its
 * material through the colour key, and `c<i>` must keep meaning the i-th key.
 */
export async function splitScadByColor(scad: string, outDir: string): Promise<ColorMesh[]> {
  mkdirSync(outDir, { recursive: true });
  const keys = distinctColors(scad);
  const out = await mapPool(keys, COMPILE_CONCURRENCY, async (key, i) => {
    const variant = disableOtherColors(scad, key);
    const dir = join(outDir, `c${i}`);
    try {
      const r = await compileScad(variant, { outputDir: dir });
      if (existsSync(r.stlPath) && statSync(r.stlPath).size > 0) {
        const rgb = key.split(",").map(Number) as [number, number, number];
        return { color: rgb, key, stl: r.stlPath } as ColorMesh;
      }
    } catch (e) {
      // Loud: a parse error here silently costs the whole colour split (and with
      // it the painted OBJ and the final render), so it must never be invisible.
      console.error(`[color_split] colour c${i} (${key}) failed to compile: ${(e as Error).message}`);
    }
    return null;
  });
  return out.filter((m): m is ColorMesh => m !== null);
}
