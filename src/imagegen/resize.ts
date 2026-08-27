/**
 * Best-effort PNG downscale for reference images.
 *
 * Reference photos come in at ~1254 px; the pipeline normalizes them to a fixed
 * longest-side (default 1024) so every reference and every feedback render the
 * model compares sits at the same resolution. Resizing is done with Pillow
 * (already on the box) via a short python one-liner — zero npm image deps.
 *
 * `loadImageBase64` is the single entry point the pipeline uses: it returns the
 * resized image's base64 when `maxSize > 0` and the resize succeeds, and falls
 * back to the original bytes on any failure (missing PIL, decode error) so a
 * resize problem can never break a run.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";

/** Resize `srcPath` so its longest side is `maxSize`px (only downscales; never
 *  upscales), writing a PNG sibling `<name>.r<maxSize>.png`. Returns the output
 *  path, or null on any failure. Synchronous (Bun.spawnSync) — called rarely
 *  (once per reference image, not per part). */
export function resizeImagePng(srcPath: string, maxSize: number): string | null {
  if (!existsSync(srcPath) || maxSize <= 0) return null;
  const outPath = join(dirname(srcPath), `${basename(srcPath).replace(/\.[^.]+$/, "")}.r${maxSize}.png`);
  const py =
    "import sys\n" +
    "from PIL import Image\n" +
    "src, out, m = sys.argv[1], sys.argv[2], int(sys.argv[3])\n" +
    "im = Image.open(src).convert('RGBA')\n" +
    "w, h = im.size\n" +
    "s = min(1.0, m / max(w, h))\n" +
    "im = im.resize((max(1, round(w*s)), max(1, round(h*s))), Image.LANCZOS) if s < 1.0 else im\n" +
    "im.save(out, 'PNG')\n";
  try {
    const r = Bun.spawnSync(["python3", "-c", py, srcPath, outPath, String(maxSize)], {
      stdout: "ignore", stderr: "pipe",
    });
    if (r.exitCode === 0 && existsSync(outPath)) return outPath;
  } catch { /* fall through */ }
  return null;
}

/** Load an image as base64, downscaling to `maxSize`px longest-side first when
 *  `maxSize > 0`. Falls back to the original bytes if resize is off or fails. */
export function loadImageBase64(path: string, maxSize = 0): string {
  if (maxSize > 0) {
    const resized = resizeImagePng(path, maxSize);
    if (resized) return readFileSync(resized).toString("base64");
  }
  return readFileSync(path).toString("base64");
}
