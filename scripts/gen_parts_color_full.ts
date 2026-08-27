/**
 * Regenerate a COMPLETE per-part coloured split from a model's FINAL scad.
 *
 * Some batch runs only exported `_agent_renders/step_NNN/parts_color` at an EARLY
 * step, so that snapshot is missing parts the final model has (the gallery then
 * renders those models incomplete). This recompiles every top-level module of
 * `final.scad` in-assembly (true world positions) → complete per-part STLs + a
 * fresh `parts_color_meta.txt`, written to `<model>/_parts_color_full/`.
 *
 * Usage:  bun --env-file=.env scripts/gen_parts_color_full.ts <model> [<model> ...]
 *         (model = subdir name under outputs/batch_inc_faithful)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { splitScadToColoredParts } from "../src/render/parts_split.ts";

const ROOT = process.env["GALLERY_ROOT"] ?? "outputs/batch_inc_faithful";
const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: gen_parts_color_full.ts <model> [<model> ...]");
  process.exit(2);
}

for (const name of names) {
  const scadPath = join(ROOT, name, "final.scad");
  if (!existsSync(scadPath)) {
    console.error(`SKIP ${name}: no final.scad at ${scadPath}`);
    continue;
  }
  const scadCode = readFileSync(scadPath, "utf8");
  const outDir = resolve(join(ROOT, name, "_parts_color_full"));
  mkdirSync(outDir, { recursive: true });
  const res = await splitScadToColoredParts({
    scadCode,
    outDir,
    log: (l) => console.log(l),
  });
  if (!res.ok) {
    console.error(`FAIL ${name}: ${res.error}`);
    continue;
  }
  const metaPath = join(outDir, "parts_color_meta.txt");
  writeFileSync(metaPath, res.legend, "utf8");
  console.log(`OK ${name}: ${res.parts.length} parts -> ${metaPath}`);
}
