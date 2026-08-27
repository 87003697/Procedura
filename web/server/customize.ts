/**
 * Live SCAD customization.
 *
 *   - extractParams(): parse a SCAD file's top-level parameters (OpenSCAD
 *     Customizer convention: top-level assignments, optional `// [min:max]` /
 *     `// [a,b,c]` annotations, `/* [Group] *​/` grouping, `/* [Hidden] *​/`).
 *   - compileCustom(): re-render the model with parameter overrides applied via
 *     OpenSCAD's `-D name=value` (no source rewriting → injection-safe), cached
 *     by a hash of the overrides, bounded by a concurrency cap + timeout.
 *
 * Only the installed `openscad` binary is needed — no pipeline/harness import.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { ScadParam, ParamType } from "../shared/types.ts";

// ── parameter extraction ─────────────────────────────────────────────────────

interface ParsedValue {
  type: ParamType;
  value: number | boolean | string;
}

function parseValue(raw: string): ParsedValue | null {
  if (raw === "true" || raw === "false") return { type: "boolean", value: raw === "true" };
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return { type: "number", value: Number(raw) };
  if (/^".*"$/.test(raw)) return { type: "string", value: raw.slice(1, -1) };
  if (/^\[[-0-9.,\seE+]*\]$/.test(raw)) return { type: "vector", value: raw };
  return null; // expression / reference — not directly editable
}

function parseAnnotation(comment: string): Partial<ScadParam> {
  if (!comment) return {};
  const range = /^\[\s*(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)\s*(?::\s*(-?\d+(?:\.\d+)?)\s*)?\]/.exec(comment);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (range[3] !== undefined) return { min: a, step: b, max: Number(range[3]) };
    return { min: a, max: b };
  }
  const opt = /^\[([^\]]+)\]/.exec(comment);
  if (opt && opt[1]!.includes(",")) {
    const items = opt[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    const nums = items.map(Number);
    if (items.length && nums.every((n) => Number.isFinite(n))) return { options: nums };
    return { options: items };
  }
  return { label: comment.trim() };
}

/** Strip comments/strings from a line for brace counting; capture a trailing
 *  line comment and whether a block comment remains open. */
function stripLine(line: string, inBlock: boolean): { code: string; comment: string; block: boolean } {
  let code = "";
  let comment = "";
  let blk = inBlock;
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (blk) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        i = n;
      } else {
        i = end + 2;
        blk = false;
      }
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "//") {
      comment = line.slice(i + 2).trim();
      break;
    }
    if (two === "/*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        blk = true;
        i = n;
      } else {
        i = end + 2;
      }
      continue;
    }
    const ch = line[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && line[j] !== '"') {
        if (line[j] === "\\") j++;
        j++;
      }
      code += line.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    code += ch;
    i++;
  }
  return { code, comment, block: blk };
}

export function extractParams(scad: string): ScadParam[] {
  const out: ScadParam[] = [];
  const seen = new Set<string>();
  let depth = 0;
  let inBlock = false;
  let group: string | undefined;
  let hidden = false;

  for (const rawLine of scad.split("\n")) {
    if (!inBlock) {
      const g = /^\s*\/\*\s*\[([^\]]+)\]\s*\*\/\s*$/.exec(rawLine);
      if (g) {
        const name = g[1]!.trim();
        if (/^hidden$/i.test(name)) hidden = true;
        else {
          hidden = false;
          group = name;
        }
        continue;
      }
    }
    const { code, comment, block } = stripLine(rawLine, inBlock);
    inBlock = block;

    if (depth === 0 && !hidden) {
      const m = /^\s*(\$?[A-Za-z_]\w*)\s*=\s*(.+?)\s*;\s*$/.exec(code);
      if (m && !seen.has(m[1]!)) {
        const name = m[1]!;
        const raw = m[2]!.trim();
        const parsed = parseValue(raw);
        if (parsed) {
          const ann = parseAnnotation(comment);
          let type = parsed.type;
          if (ann.options) type = typeof ann.options[0] === "number" ? "enum-number" : "enum-string";
          seen.add(name);
          out.push({ name, type, value: parsed.value, raw, ...(group ? { group } : {}), ...ann });
        }
      }
    }
    for (const ch of code) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    if (out.length >= 300) break;
  }
  return out;
}

// ── override sanitisation → safe `-D` args ──────────────────────────────────

/** Turn a user override into a safe `name=value` for `-D`, or null if invalid.
 *  Only literal values are emitted — never arbitrary OpenSCAD expressions. */
export function overrideToDefine(
  param: ScadParam,
  value: unknown,
): string | null {
  switch (param.type) {
    case "number":
    case "enum-number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      let v = n;
      if (param.name === "$fn" || /(^|_)fn$/i.test(param.name)) v = Math.min(256, Math.max(0, Math.round(v)));
      return `${param.name}=${v}`;
    }
    case "boolean":
      return `${param.name}=${value === true || value === "true" ? "true" : "false"}`;
    case "string":
    case "enum-string": {
      const s = String(value).replace(/["\\\n\r]/g, "").slice(0, 200);
      return `${param.name}="${s}"`;
    }
    case "vector": {
      const s = String(value).trim();
      if (!/^\[[-0-9.,\seE+]*\]$/.test(s)) return null;
      return `${param.name}=${s}`;
    }
    default:
      return null;
  }
}

// ── compilation ──────────────────────────────────────────────────────────────

interface Caps {
  exportFormat: boolean;
  manifold: boolean;
  enableAll: boolean;
}
let _caps: Caps | null = null;
async function caps(bin: string): Promise<Caps> {
  if (_caps) return _caps;
  try {
    const p = Bun.spawn([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    const t = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    _caps = {
      exportFormat: t.includes("--export-format"),
      manifold: t.includes("--backend"),
      enableAll: t.includes("--enable"),
    };
  } catch {
    _caps = { exportFormat: false, manifold: false, enableAll: false };
  }
  return _caps;
}

function fnv(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const MAX_CONCURRENT = 3;
let active = 0;

export type CustomizeResult =
  | { ok: true; stl: string; durationMs: number; cached: boolean; preview: boolean }
  | { ok: false; error: string; busy?: boolean };

/** Facet count used for coarse live-drag previews. The crisp mesh uses the
 *  model's own $fn (no override). Only affects models whose $fn is a top-level
 *  variable; others just compile at full quality. */
const PREVIEW_FN = 48;
const PREVIEW_DEFINES = ["$fn=" + PREVIEW_FN, "$fa=12", "$fs=2"];

export async function compileCustom(opts: {
  openscad: string;
  root: string;
  runDir: string;
  scadAbs: string; // absolute path of the source .scad (already validated inside runDir)
  defines: string[]; // sanitized name=value strings
  preview?: boolean; // coarse $fn for fast drag feedback
  timeoutMs?: number;
}): Promise<CustomizeResult> {
  const { openscad, root, runDir, scadAbs, defines } = opts;
  const preview = !!opts.preview;
  if (!existsSync(scadAbs)) return { ok: false, error: "source SCAD not found" };

  const cacheDir = join(runDir, "_customize");
  // Preview vs full cache as distinct files so they never collide.
  const key = fnv(`${preview ? "p|" : ""}${relative(runDir, scadAbs)}|${[...defines].sort().join("|")}`);
  const stlAbs = join(cacheDir, `${key}.stl`);
  const stlRel = relative(root, stlAbs).split("\\").join("/");

  if (existsSync(stlAbs) && statSync(stlAbs).size > 0) {
    return { ok: true, stl: stlRel, durationMs: 0, cached: true, preview };
  }
  if (active >= MAX_CONCURRENT) {
    return { ok: false, error: "server busy compiling — try again", busy: true };
  }

  active++;
  const t0 = Date.now();
  try {
    mkdirSync(cacheDir, { recursive: true });
    const c = await caps(openscad);
    const args = [scadAbs, "-o", stlAbs];
    if (c.exportFormat) args.push("--export-format", "binstl");
    if (c.manifold) args.push("--backend", "Manifold");
    if (c.enableAll) args.push("--enable", "all");
    args.push("--quiet");
    // -D overrides the model's top-level assignment of that variable, so
    // `-D $fn=48` lowers facets for the common `$fn = N;` form. Preview defines
    // go first; user defines last, so if a user is dragging the $fn parameter
    // itself their value still wins.
    if (preview) for (const d of PREVIEW_DEFINES) args.push("-D", d);
    for (const d of defines) args.push("-D", d);

    const proc = Bun.spawn([openscad, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(9), opts.timeoutMs ?? 60_000);
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(timer);

    if (code !== 0 || !existsSync(stlAbs) || statSync(stlAbs).size === 0) {
      return {
        ok: false,
        error: (stderr.trim().split("\n").slice(-6).join("\n") || `openscad exited ${code}`).slice(0, 1200),
      };
    }
    return { ok: true, stl: stlRel, durationMs: Date.now() - t0, cached: false, preview };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    active--;
  }
}

/** Resolve the source SCAD for a "which" selector within a run dir. */
export function resolveScadFile(runDir: string, which: string): string | null {
  const candidates =
    which === "draft"
      ? ["draft.scad", "initial.scad"]
      : ["final.scad", "ortho_reviewed.scad", "draft.scad", "initial.scad"];
  for (const c of candidates) {
    const p = join(runDir, c);
    if (existsSync(p)) return p;
  }
  return null;
}
