/**
 * SCAD module parsing + per-module compile.
 *
 * TypeScript port of aetherion.tools.scad_parts. Pure text manipulation
 * (regex + brace depth tracking) for module enumeration / edit, plus
 * thin wrappers around src/scad/compile.ts for the per-module isolated
 * compile primitives the parts-colour renderer needs.
 *
 * Public surface (mirrors the Python module):
 *   sanitizeIdentifier(name)              — make a SCAD-safe identifier
 *   findModuleSpans(scadCode)             — every top-level module's source span
 *   extractModuleDefinition(scad, name)   — get the full source of one module
 *   replaceModuleDefinition(scad, name, newDef) — splice in a replacement
 *   stripAssembly(scad)                   — drop everything after the last module
 *   listTopLevelModules(scad)             — names invoked from the assembly
 *   stubModuleBody(scad, name)            — replace a module's body with `{}`
 *   compileModuleStandalone(scad, name, dir) — isolated compile, drops assembly
 *   compileModuleInAssembly(scad, name, dir) — keeps assembly intact, stubs other modules
 *   computeModuleBBox(scad, name, dir)    — load standalone STL + return bbox size
 *   listModuleInstances(scad)             — per-placement-statement instances
 *   listMotionParts(scad)                 — instance-expanded part id universe
 *   compilePartsInAssembly(scad, ids, dir) — compile a mix of module names + instance ids
 */

import { createHash } from "node:crypto";
import { existsSync, statSync, mkdirSync } from "node:fs";
import { compileScad } from "./compile.ts";
import { loadSTL, computeBBox } from "../mesh/stl.ts";

// ──────────────────────────────────────────────────────────────────────────
// Identifier sanitisation
// ──────────────────────────────────────────────────────────────────────────

export function sanitizeIdentifier(name: string): string {
  if (!name) return "part";
  let s = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  s = s.replace(/_{2,}/g, "_");
  if (!s) return "part";
  const first = s.charCodeAt(0);
  const isLetter =
    (first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95;
  return isLetter ? s : `p_${s}`;
}

// ──────────────────────────────────────────────────────────────────────────
// SCAD built-ins to skip when listing user-defined modules
// ──────────────────────────────────────────────────────────────────────────

export const BUILTINS: ReadonlySet<string> = new Set([
  "cube", "sphere", "cylinder", "polyhedron", "circle", "square",
  "polygon", "text", "import", "surface", "children",
  "translate", "rotate", "scale", "mirror", "resize", "multmatrix",
  "color", "offset", "hull", "minkowski", "projection", "render",
  "linear_extrude", "rotate_extrude",
  "union", "difference", "intersection",
  "if", "else", "for", "let", "each",
  "echo", "assert", "abs", "ceil", "floor", "round", "min", "max",
  "pow", "sqrt", "exp", "log", "ln", "sin", "cos", "tan",
  "asin", "acos", "atan", "atan2", "len", "str", "chr", "ord",
  "concat", "lookup", "search", "norm", "cross",
  "module", "function", "include", "use",
]);

// ──────────────────────────────────────────────────────────────────────────
// Comment / string blanking — preserves indices so spans remain valid
// ──────────────────────────────────────────────────────────────────────────

export function stripCommentsAndStrings(code: string): string {
  // Line comments → spaces
  let out = code.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  // Block comments → spaces (preserve newlines so line/col accounting holds)
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    Array.from(m).map((ch) => (ch === "\n" ? "\n" : " ")).join(""),
  );
  // Double-quoted string contents → spaces, keep the quotes themselves
  out = out.replace(/"[^"\n]*"/g, (m) => `"${" ".repeat(m.length - 2)}"`);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Top-level module span finder (regex + brace depth)
// ──────────────────────────────────────────────────────────────────────────

export interface ModuleSpan {
  name: string;
  /** Index of the `m` in `module`. */
  start: number;
  /** One past the closing `}` of the body. */
  end: number;
}

export function findModuleSpans(scadCode: string): ModuleSpan[] {
  const sanitized = stripCommentsAndStrings(scadCode);
  const n = sanitized.length;
  const results: ModuleSpan[] = [];
  const pat = /\bmodule\s+(\w+)\s*\(/g;

  let i = 0;
  let depth = 0;
  while (i < n) {
    const ch = sanitized[i]!;
    if (ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "}") { depth -= 1; i += 1; continue; }
    if (depth !== 0) { i += 1; continue; }

    pat.lastIndex = i;
    const m = pat.exec(sanitized);
    if (!m || m.index !== i) {
      i += 1;
      continue;
    }
    const name = m[1]!;
    let j = pat.lastIndex; // just after the `(`
    let parenDepth = 1;
    while (j < n && parenDepth > 0) {
      const cj = sanitized[j]!;
      if (cj === "(") parenDepth += 1;
      else if (cj === ")") parenDepth -= 1;
      j += 1;
    }
    while (j < n && /[ \t\r\n]/.test(sanitized[j]!)) j += 1;
    if (j >= n || sanitized[j] !== "{") {
      // Malformed / no body — advance past the `module` keyword.
      i = pat.lastIndex;
      continue;
    }
    let braceDepth = 1;
    j += 1;
    while (j < n && braceDepth > 0) {
      const cj = sanitized[j]!;
      if (cj === "{") braceDepth += 1;
      else if (cj === "}") braceDepth -= 1;
      j += 1;
    }
    if (braceDepth === 0) {
      results.push({ name, start: m.index, end: j });
      i = j;
    } else {
      i = pat.lastIndex;
    }
  }
  return results;
}

/** A top-level `function name(args) = expr;` definition.
 *
 *  Structurally the same idea as {@link findModuleSpans}, but a function body
 *  is an EXPRESSION terminated by `;`, not a braced block, so the scan ends at
 *  the first `;` outside any bracket rather than at a matching `}`. Like the
 *  module finder, an unterminated definition (a truncated response) yields no
 *  span at all — callers must not receive half a definition. */
export function findFunctionSpans(scadCode: string): ModuleSpan[] {
  const sanitized = stripCommentsAndStrings(scadCode);
  const n = sanitized.length;
  const results: ModuleSpan[] = [];
  const pat = /\bfunction\s+(\w+)\s*\(/g;

  let i = 0;
  let depth = 0;
  while (i < n) {
    const ch = sanitized[i]!;
    if (ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "}") { depth -= 1; i += 1; continue; }
    if (depth !== 0) { i += 1; continue; }

    pat.lastIndex = i;
    const m = pat.exec(sanitized);
    if (!m || m.index !== i) {
      i += 1;
      continue;
    }
    const name = m[1]!;
    let j = pat.lastIndex; // just after the `(` of the parameter list
    let parenDepth = 1;
    while (j < n && parenDepth > 0) {
      const cj = sanitized[j]!;
      if (cj === "(") parenDepth += 1;
      else if (cj === ")") parenDepth -= 1;
      j += 1;
    }
    while (j < n && /[ \t\r\n]/.test(sanitized[j]!)) j += 1;
    if (j >= n || sanitized[j] !== "=") {
      i = pat.lastIndex;
      continue;
    }
    j += 1;
    // Body: run to the terminating `;` at bracket depth 0. Nested parens,
    // brackets and braces (list comprehensions, `let(...)`, vectors) all nest.
    let bodyDepth = 0;
    let end = -1;
    while (j < n) {
      const cj = sanitized[j]!;
      if (cj === "(" || cj === "[" || cj === "{") bodyDepth += 1;
      else if (cj === ")" || cj === "]" || cj === "}") bodyDepth -= 1;
      else if (cj === ";" && bodyDepth === 0) { end = j + 1; break; }
      if (bodyDepth < 0) break; // ran past our own scope — malformed
      j += 1;
    }
    if (end > 0) {
      results.push({ name, start: m.index, end });
      i = end;
    } else {
      i = pat.lastIndex;
    }
  }
  return results;
}

// ──────────────────────────────────────────────────────────────────────────
// Extract / replace / strip
// ──────────────────────────────────────────────────────────────────────────

export function extractModuleDefinition(
  scadCode: string, name: string,
): string | null {
  for (const sp of findModuleSpans(scadCode)) {
    if (sp.name === name) return scadCode.slice(sp.start, sp.end);
  }
  return null;
}

export function replaceModuleDefinition(
  scadCode: string, name: string, newDef: string,
): string {
  for (const sp of findModuleSpans(scadCode)) {
    if (sp.name === name) {
      return scadCode.slice(0, sp.start) + newDef.trimEnd() + scadCode.slice(sp.end);
    }
  }
  throw new Error(`module '${name}' not found in SCAD source`);
}

export function stripAssembly(scadCode: string): string {
  const spans = findModuleSpans(scadCode);
  if (spans.length === 0) return scadCode;
  const lastEnd = spans[spans.length - 1]!.end;
  return scadCode.slice(0, lastEnd) + "\n";
}

/**
 * Wrap the assembly section (everything after the last module definition) in an
 * explicit `union() { … }`.
 *
 * Why this exists: our compiles pass `--enable all`, which includes OpenSCAD's
 * lazy-union — top-level statements are exported as SEPARATE shells without the
 * final boolean. Two parts overlapping by 10mm still come out as two disjoint
 * meshes, so every connectivity/floater number computed on such an export
 * counts SHELLS, not connectivity (measured: mech_robot "77 visible floaters"
 * where most parts overlap correctly). Any analysis that wants real
 * connectivity must compile the union-wrapped source instead.
 */
export function wrapAssemblyInUnion(scadCode: string): string {
  const spans = findModuleSpans(scadCode);
  if (spans.length === 0) return `union() {\n${scadCode}\n}\n`;
  const lastEnd = spans[spans.length - 1]!.end;
  const defs = scadCode.slice(0, lastEnd);
  const assembly = scadCode.slice(lastEnd);
  if (assembly.trim().length === 0) return scadCode;
  return `${defs}\nunion() {\n${assembly}\n}\n`;
}

// ──────────────────────────────────────────────────────────────────────────
// Top-level module enumeration
// ──────────────────────────────────────────────────────────────────────────

export function listTopLevelModules(scadCode: string): string[] {
  const sanitized = stripCommentsAndStrings(scadCode);
  const spans = findModuleSpans(scadCode);
  const definedNames = new Set(spans.map((s) => s.name));

  // Mask off every character that lies inside ANY module definition.
  const mask = new Uint8Array(sanitized.length); // 0 = inside, 1 = outside
  mask.fill(1);
  for (const sp of spans) {
    for (let k = sp.start; k < sp.end; k++) mask[k] = 0;
  }

  const seen: string[] = [];
  const seenSet = new Set<string>();
  const callPat = /\b([A-Za-z_]\w*)\s*\(/g;
  for (let m: RegExpExecArray | null; (m = callPat.exec(sanitized)); ) {
    const start = m.index;
    if (mask[start] === 0) continue;
    const name = m[1]!;
    if (BUILTINS.has(name)) continue;
    if (!definedNames.has(name)) continue;
    if (seenSet.has(name)) continue;
    seen.push(name);
    seenSet.add(name);
  }
  return seen;
}

/** User-defined modules called inside `sp`'s body, ignoring calls that sit
 *  inside a NESTED module definition (those belong to the nested module). */
function calleesWithin(
  sanitized: string,
  sp: ModuleSpan,
  definedNames: ReadonlySet<string>,
): string[] {
  const open = sanitized.indexOf("{", sp.start);
  if (open < 0 || open >= sp.end) return [];
  const body = sanitized.slice(open + 1, Math.max(open + 1, sp.end - 1));

  const mask = new Uint8Array(body.length);
  mask.fill(1);
  for (const nested of findModuleSpans(body)) {
    for (let k = nested.start; k < nested.end && k < body.length; k++) mask[k] = 0;
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const callPat = /\b([A-Za-z_]\w*)\s*\(/g;
  for (let m: RegExpExecArray | null; (m = callPat.exec(body)); ) {
    if (mask[m.index] === 0) continue;
    const name = m[1]!;
    if (BUILTINS.has(name)) continue;
    if (!definedNames.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Part-level module names — like `listTopLevelModules`, but descending through
 * single-root wrapper modules.
 *
 * `listTopLevelModules` returns exactly what the assembly invokes. That is the
 * right answer for compiling / colouring / splitting placed geometry (and the
 * whole pipeline depends on it), but it is the WRONG answer for the question
 * "into how many parts did this program decompose the object?". A program
 * written as
 *
 *     module widget() { body(); arm(); wheel(); }   widget();
 *
 * invokes ONE module, while an equivalent program that places the same three
 * parts directly at top level invokes THREE. That difference is authoring
 * STYLE, not decomposition, and it silently biases any part-count metric toward
 * flat emitters. Across our benchmark, single-shot generators wrap everything in
 * one root module in 33-86% of cases depending on the model, versus 0% for the
 * part-by-part configs. Any metric built on the unwrapped count therefore
 * measures emission style and flatters whichever generator emits flat.
 *
 * This descends a chain of single-root wrappers to the first level that
 * actually branches, so both authoring styles report the same decomposition.
 * A genuine single-part model still reports its one module: descent stops as
 * soon as a module calls no other user-defined module.
 */
export function listPartModules(scadCode: string): string[] {
  const sanitized = stripCommentsAndStrings(scadCode);
  const spans = findModuleSpans(scadCode);
  const definedNames = new Set(spans.map((s) => s.name));
  const spanByName = new Map(spans.map((s) => [s.name, s] as const));

  let names = listTopLevelModules(scadCode);
  const visited = new Set<string>();
  while (names.length === 1) {
    const root = names[0]!;
    if (visited.has(root)) break; // cycle guard
    visited.add(root);
    const sp = spanByName.get(root);
    if (!sp) break;
    const inner = calleesWithin(sanitized, sp, definedNames);
    if (inner.length === 0) break; // leaf part, not a wrapper
    names = inner;
  }
  return names;
}

// ──────────────────────────────────────────────────────────────────────────
// Body stubbing — replace one module's body with `{}` leaving signature
// ──────────────────────────────────────────────────────────────────────────

export function stubModuleBody(scadCode: string, name: string): string {
  const existing = extractModuleDefinition(scadCode, name);
  if (existing === null) return scadCode;
  const braceIdx = existing.indexOf("{");
  if (braceIdx === -1) return scadCode;
  const newDef = existing.slice(0, braceIdx + 1) + "}";
  return replaceModuleDefinition(scadCode, name, newDef);
}

// ──────────────────────────────────────────────────────────────────────────
// Per-module compile primitives
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compile one module in isolation. Drops the entire assembly and replaces
 * it with a single `<name>();` call at the bottom. Modules without
 * self-positioning translates will land at the origin.
 *
 * Returns the STL path on success, or null if the compile failed / produced
 * no geometry.
 */
export async function compileModuleStandalone(
  scadCode: string, name: string, outputDir: string,
): Promise<string | null> {
  mkdirSync(outputDir, { recursive: true });
  const stripped = stripAssembly(scadCode) + `\n${name}();\n`;
  return compileToStl(stripped, outputDir);
}

/** Compile SCAD text into `<outputDir>/output.stl` (+ `output.obj`).
 *  Returns the STL path, or null on failure / empty geometry. */
async function compileToStl(text: string, outputDir: string): Promise<string | null> {
  try {
    const r = await compileScad(text, { outputDir });
    if (!existsSync(r.stlPath) || statSync(r.stlPath).size === 0) return null;
    return r.stlPath;
  } catch {
    return null;
  }
}

/** Walk backward from a leaf module call to the start of its assembly
 *  statement, skipping the transform-call chain (`translate([..]) rotate([..])
 *  …`) back to the previous `;`/`{`/`}` (or `lowerBound`). Indices are into the
 *  comment/string-blanked source. */
function statementStartBefore(masked: string, callIdx: number, lowerBound: number): number {
  let p = callIdx;
  for (;;) {
    let q = p - 1;
    while (q >= lowerBound && /\s/.test(masked[q]!)) q -= 1;
    if (q < lowerBound) return lowerBound;
    const c = masked[q]!;
    if (c === ")") {
      let depth = 1; let r = q - 1;
      while (r >= lowerBound && depth > 0) {
        const cr = masked[r]!;
        if (cr === ")") depth += 1;
        else if (cr === "(") depth -= 1;
        r -= 1;
      }
      let s = r; // just before the matching "("; skip the transform identifier
      while (s >= lowerBound && /[A-Za-z0-9_$]/.test(masked[s]!)) s -= 1;
      p = s + 1;
      continue;
    }
    if (c === ";" || c === "{" || c === "}") return q + 1;
    return q + 1;
  }
}

/** From a leaf call, find the index just past its terminating `;` (skips the
 *  call's own `(...)` and any nested braces). */
function statementEndAfter(masked: string, callIdx: number, upper: number): number {
  let p = callIdx;
  while (p < upper && masked[p] !== "(") p += 1;        // to the call's "("
  let depth = 0;
  for (; p < upper; p += 1) {                            // skip the balanced (...)
    const c = masked[p]!;
    if (c === "(") depth += 1;
    else if (c === ")") { depth -= 1; if (depth === 0) { p += 1; break; } }
  }
  let d = 0;
  for (; p < upper; p += 1) {                            // scan to the terminating ;
    const c = masked[p]!;
    if (c === "{" || c === "(") d += 1;
    else if (c === "}" || c === ")") d -= 1;
    else if (c === ";" && d === 0) return p + 1;
  }
  return upper;
}

/** Extract the full ASSEMBLY-level placement statement(s) that invoke module
 *  `name` (calls outside any module definition), verbatim from the source. */
export function extractAssemblyStatementsOf(scadCode: string, name: string): string[] {
  const masked = stripCommentsAndStrings(scadCode);
  const spans = findModuleSpans(scadCode);
  const asmStart = spans.length ? spans[spans.length - 1]!.end : 0;
  const inModule = new Uint8Array(masked.length);
  for (const sp of spans) for (let k = sp.start; k < sp.end; k++) inModule[k] = 1;

  const callPat = new RegExp(`\\b${name}\\s*\\(`, "g");
  const out: string[] = [];
  const seen = new Set<string>();
  for (let m: RegExpExecArray | null; (m = callPat.exec(masked)); ) {
    const idx = m.index;
    if (idx < asmStart || inModule[idx] === 1) continue;
    const start = statementStartBefore(masked, idx, asmStart);
    const end = statementEndAfter(masked, idx, masked.length);
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scadCode.slice(start, end));
  }
  return out;
}

/**
 * Rigidly shift the world-space placement of one or more top-level modules by
 * `delta` (mm), without touching their geometry. For every assembly-level
 * placement statement of each named module, the whole statement is wrapped in
 * an OUTERMOST `translate(delta) { ... }`. Because the wrap is applied outside
 * the part's existing transform chain, it is a pure world-space translation:
 * every internal rotate/translate that positions the part is preserved, so the
 * part (and, when several parts of one limb are moved by the SAME delta, the
 * whole limb) moves rigidly and stays internally connected.
 *
 * Returns the rewritten source plus which modules were actually wrapped (a name
 * with no assembly placement is silently skipped and reported in `missing`).
 */
export function nudgeAssemblyPlacements(
  scadCode: string,
  names: ReadonlySet<string>,
  delta: readonly [number, number, number],
): { scad: string; wrappedNames: string[]; wrappedStatements: number; missing: string[] } {
  const ranges = listAssemblyStatementRanges(scadCode).filter((r) => names.has(r.module));
  const wrappedSet = new Set(ranges.map((r) => r.module));
  const missing = [...names].filter((n) => !wrappedSet.has(n));
  if (ranges.length === 0) {
    return { scad: scadCode, wrappedNames: [], wrappedStatements: 0, missing };
  }

  const fmt = (n: number): string => (Number.isFinite(n) ? String(Number(n.toFixed(4))) : "0");
  const prefix = `translate([${fmt(delta[0])}, ${fmt(delta[1])}, ${fmt(delta[2])}]) {\n`;
  const suffix = `\n}`;

  // Rewrite back-to-front so earlier indices stay valid.
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let out = scadCode;
  for (const r of sorted) {
    out = out.slice(0, r.start) + prefix + out.slice(r.start, r.end) + suffix + out.slice(r.end);
  }
  return {
    scad: out,
    wrappedNames: [...wrappedSet],
    wrappedStatements: ranges.length,
    missing,
  };
}

/**
 * Anchored rescale of one or more parts' assembly placements: wraps each
 * placement statement in `translate(anchor) scale(f) translate(-anchor)`, so
 * geometry AND inter-part spacing scale about a fixed world point. This is the
 * missing big lever for proportion-scale mismatches (legs 30% too long, a head
 * half the reference size): a whole kinematic chain shrinks toward its mount
 * point in one rigid operation, staying connected — the coordinated multi-
 * module rescale that per-module edits can't express safely.
 */
export function scaleAssemblyPlacements(
  scadCode: string,
  names: ReadonlySet<string>,
  factor: readonly [number, number, number],
  anchor: readonly [number, number, number],
): { scad: string; wrappedNames: string[]; wrappedStatements: number; missing: string[] } {
  const ranges = listAssemblyStatementRanges(scadCode).filter((r) => names.has(r.module));
  const wrappedSet = new Set(ranges.map((r) => r.module));
  const missing = [...names].filter((n) => !wrappedSet.has(n));
  if (ranges.length === 0) {
    return { scad: scadCode, wrappedNames: [], wrappedStatements: 0, missing };
  }

  const fmt = (n: number): string => (Number.isFinite(n) ? String(Number(n.toFixed(4))) : "0");
  const a = anchor.map(fmt);
  const f = factor.map(fmt);
  const prefix =
    `translate([${a[0]}, ${a[1]}, ${a[2]}]) scale([${f[0]}, ${f[1]}, ${f[2]}]) ` +
    `translate([${fmt(-anchor[0])}, ${fmt(-anchor[1])}, ${fmt(-anchor[2])}]) {\n`;
  const suffix = `\n}`;

  const sorted = [...ranges].sort((x, y) => y.start - x.start);
  let out = scadCode;
  for (const r of sorted) {
    out = out.slice(0, r.start) + prefix + out.slice(r.start, r.end) + suffix + out.slice(r.end);
  }
  return { scad: out, wrappedNames: [...wrappedSet], wrappedStatements: ranges.length, missing };
}

/**
 * Per-module leading world transform key: the FIRST transform call
 * (`translate(...)`, `rotate(...)`, …) that wraps a module's assembly
 * placement, normalised to a whitespace-collapsed string. Parts of one limb
 * share the same anchor transform (e.g. every lower-left-arm part begins
 * `translate([-96.5, 5, torso_elevation + 31.5])`), so an identical key is a
 * strong "these belong to the same rigid group" signal. Parts placed with no
 * wrapping transform map to "" (their own singleton group). A module with
 * several placements maps to the set of its statements' keys.
 */
export function assemblyPlacementAnchors(scadCode: string): Map<string, Set<string>> {
  const TRANSFORMS = new Set([
    "translate", "rotate", "mirror", "scale", "multmatrix", "resize", "color",
  ]);
  const out = new Map<string, Set<string>>();
  for (const name of listTopLevelModules(scadCode)) {
    const keys = new Set<string>();
    for (const stmt of extractAssemblyStatementsOf(scadCode, name)) {
      keys.add(firstTransformCall(stmt, TRANSFORMS));
    }
    out.set(name, keys);
  }
  return out;
}

/** Read the leading transform call of a placement statement (comments stripped,
 *  whitespace collapsed), or "" if the statement starts with the module call. */
function firstTransformCall(statement: string, transforms: ReadonlySet<string>): string {
  const masked = stripCommentsAndStrings(statement);
  let i = 0;
  while (i < masked.length && /\s/.test(masked[i]!)) i += 1;
  const idm = /^([A-Za-z_]\w*)\s*\(/.exec(masked.slice(i));
  if (!idm) return "";
  const ident = idm[1]!;
  if (!transforms.has(ident)) return ""; // starts with the module call → no anchor
  // Balanced-paren scan for the argument list.
  let j = i + idm[0].length; // just past "("
  let depth = 1;
  while (j < masked.length && depth > 0) {
    const c = masked[j]!;
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    j += 1;
  }
  return statement.slice(i, j).replace(/\s+/g, " ").trim();
}

/**
 * Build a compile-ready source that renders ONLY module `name` at its true
 * assembled world position, by KEEPING the entire source — every module
 * definition AND the full assembly structure — and snipping out only the
 * assembly-level placement statements of the OTHER top-level modules.
 *
 * This is correct on the two axes the simpler approaches each got wrong:
 *  - REUSE / MIRROR: a part whose body calls a sibling (e.g.
 *    `module right_wing(){ mirror([1,0,0]) left_wing(); }`) still resolves,
 *    because every definition is kept. (Stubbing the sibling's body emptied it.)
 *  - NESTED / SHARED TRANSFORMS: a part placed inside a wrapping
 *    `translate([...]) { partA(); partB(); }` keeps that enclosing transform,
 *    because we delete only the sibling CALLS and leave the block (and all
 *    parent transforms) around `name` intact. (Extracting just the part's own
 *    leaf statement dropped the shared parent transform and mis-placed the part.)
 */
function isolateAssemblyToModule(scadCode: string, name: string): string {
  return isolateAssemblyToModules(scadCode, new Set([name]));
}

/**
 * The placeholder left where a placement statement is removed.
 *
 * DELETING a statement is only safe when it is a top-level sibling. Inside a
 * CSG operator it changes what the operator MEANS: removing a child from
 * `intersection() { chassis(); cube([2000,2000,2000]); }` leaves an
 * intersection with ONE child, and an intersection of one thing is that thing —
 * so a 2000mm clip tool becomes the result.
 *
 * That is not hypothetical. A GPT-5.6 refine wrapped placements in
 * `intersection()` with 2000mm clip cubes to split-and-compress a chassis
 * (legal, and the full model compiled to 4.8M facets). Every one of the 30
 * per-module isolations then rendered as a 2000mm cube of 24 triangles, so the
 * parts-colour views — what the critic and the reviewer both look at — showed a
 * featureless box for the rest of the run.
 *
 * `union(){}` is a node that yields no geometry, so the operator keeps its
 * arity and correctly evaluates to empty. Verified against both intersection()
 * and difference().
 */
const EMPTY_PLACEMENT = "union(){}";

function isolateAssemblyToModules(scadCode: string, keepNames: ReadonlySet<string>): string {
  const all = listAssemblyStatementRanges(scadCode);

  // ONE statement can call MORE THAN ONE top-level module: an operator module
  // (one that uses children()) wrapping a leaf part, e.g.
  //     crown_orient_z([..]) rotate([..]) bough();
  // `listAssemblyStatementRanges` dedupes per module NAME, not across names, so
  // that statement yields TWO ranges over the SAME span. Two consequences, both
  // of which this function used to get wrong:
  //
  //  1. KEEP a span if ANY kept name appears in it. Otherwise isolating `bough`
  //     is immediately undone by `crown_orient_z`'s identical range stubbing the
  //     very statement we meant to keep.
  //
  //  2. Substitute each span EXACTLY ONCE, merging overlaps first. The previous
  //     code rewrote every range independently, so a duplicated span was
  //     rewritten twice — and the second rewrite used a now-stale `end` offset,
  //     slicing into whatever followed and cascading to EOF. That ate the
  //     assembly's closing brace, so EVERY isolated part failed to parse and the
  //     caller reported "all modules produced empty STLs" — refine then ended at
  //     cycle 1 with verdict=error and zero LLM calls, shipping the draft.
  //     (toys4k tree_019, 2026-08-21: reproduced on two independent drafts.)
  //
  // `snipRanges` below already merges overlaps for exactly this reason.
  const kept = new Set<string>();
  for (const r of all) if (keepNames.has(r.module)) kept.add(`${r.start}:${r.end}`);

  const uniq = new Map<string, { start: number; end: number }>();
  for (const r of all) {
    const key = `${r.start}:${r.end}`;
    if (!kept.has(key)) uniq.set(key, { start: r.start, end: r.end });
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const r of [...uniq.values()].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  // Back-to-front so earlier offsets stay valid.
  let out = scadCode;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    out = out.slice(0, merged[i]!.start) + EMPTY_PLACEMENT + out.slice(merged[i]!.end);
  }
  return out;
}

/** Delete the given source ranges: merge overlaps, then remove back-to-front
 *  so earlier indices stay valid. */
function snipRanges(scadCode: string, ranges: Array<[number, number]>): string {
  const sorted = ranges
    .map((r): [number, number] => [r[0], r[1]])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  let out = scadCode;
  for (let i = merged.length - 1; i >= 0; i--) {
    out = out.slice(0, merged[i]![0]) + out.slice(merged[i]![1]);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Instance-level enumeration
// ──────────────────────────────────────────────────────────────────────────

interface StatementRange {
  module: string;
  /** 0-based index of this statement among THIS module's placements. */
  statementIndex: number;
  start: number;
  end: number;
}

/**
 * Enumerate every assembly-level placement statement of every top-level
 * module, in source order. The statement granularity is exactly what the
 * isolate/snip machinery uses: a statement runs from the previous
 * `;` / `{` / `}` boundary (or the end of the last module definition)
 * through the leaf call's terminating `;`, including its whole transform
 * chain (`translate(..) mirror(..) part();`). Calls inside a `{ ... }`
 * block are individual statements; the enclosing block/transform is NOT
 * part of any one statement (it is shared, and survives snipping).
 *
 * LIMITATION: one statement = one instance, regardless of how many
 * geometric copies it produces. A loop (`for (i=[-1,1]) translate(..)
 * wheel();`) or any repeated call sharing a single statement stays ONE
 * instance — the statement, not the geometric copy, is the unit, because
 * the snipping machinery can only keep/remove whole statements.
 */
function listAssemblyStatementRanges(scadCode: string): StatementRange[] {
  const masked = stripCommentsAndStrings(scadCode);
  const spans = findModuleSpans(scadCode);
  const asmStart = spans.length ? spans[spans.length - 1]!.end : 0;
  const inModule = new Uint8Array(masked.length);
  for (const sp of spans) for (let k = sp.start; k < sp.end; k++) inModule[k] = 1;

  const raw: Array<{ module: string; start: number; end: number }> = [];
  for (const name of listTopLevelModules(scadCode)) {
    const pat = new RegExp(`\\b${name}\\s*\\(`, "g");
    const seen = new Set<string>();
    for (let m: RegExpExecArray | null; (m = pat.exec(masked)); ) {
      const idx = m.index;
      if (idx < asmStart || inModule[idx] === 1) continue;
      const start = statementStartBefore(masked, idx, asmStart);
      const end = statementEndAfter(masked, idx, masked.length);
      const key = `${start}:${end}`;
      if (seen.has(key)) continue; // same statement calling the module twice
      seen.add(key);
      raw.push({ module: name, start, end });
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end || a.module.localeCompare(b.module));
  const perModule = new Map<string, number>();
  return raw.map((r) => {
    const k = perModule.get(r.module) ?? 0;
    perModule.set(r.module, k + 1);
    return { module: r.module, statementIndex: k, start: r.start, end: r.end };
  });
}

export interface ModuleInstance {
  /** The module name when it has exactly one placement statement
   *  (back-compat with module-level part ids), else `<module>__i<k>`. */
  instanceId: string;
  module: string;
  /** 0-based index of this statement among the module's placement
   *  statements — the `<k>` in `<module>__i<k>`. */
  statementIndex: number;
  /** Verbatim source of the placement statement. */
  statement: string;
}

/**
 * Instance-level part enumeration: one entry per assembly placement
 * statement, in overall assembly (source) order, so reused/mirrored
 * modules can become separate rigid links.
 */
export function listModuleInstances(scadCode: string): ModuleInstance[] {
  const ranges = listAssemblyStatementRanges(scadCode);
  const totals = new Map<string, number>();
  for (const r of ranges) totals.set(r.module, (totals.get(r.module) ?? 0) + 1);
  return ranges.map((r) => ({
    instanceId: totals.get(r.module)! > 1 ? `${r.module}__i${r.statementIndex}` : r.module,
    module: r.module,
    statementIndex: r.statementIndex,
    statement: scadCode.slice(r.start, r.end),
  }));
}

/** The instance-expanded part universe: single-placement modules by plain
 *  name, multi-placement modules as `<module>__i<k>` instance ids, in
 *  overall assembly order. */
export function listMotionParts(scadCode: string): string[] {
  return listModuleInstances(scadCode).map((inst) => inst.instanceId);
}

export const INSTANCE_ID_PAT = /^([A-Za-z_]\w*)__i(\d+)$/;


// ──────────────────────────────────────────────────────────────────────────
// Per-module compile cache
// ──────────────────────────────────────────────────────────────────────────

interface DefSpan { name: string; start: number; end: number }

/**
 * Every TOP-LEVEL definition: `module f(){}`, `function f() = ...;`, and plain
 * `x = ...;` parameter assignments. Nested definitions are not returned — a
 * module's interior is skipped wholesale, and only depth-0 text is considered.
 */
function findTopLevelDefs(scadCode: string): DefSpan[] {
  const masked = stripCommentsAndStrings(scadCode);
  const n = masked.length;
  const mods = findModuleSpans(scadCode);
  const inMod = new Uint8Array(n);
  for (const m of mods) for (let k = m.start; k < m.end && k < n; k++) inMod[k] = 1;

  // Bracket depth at each index, ignoring module interiors.
  const depth = new Int32Array(n);
  let d = 0;
  for (let i = 0; i < n; i++) {
    depth[i] = d;
    if (inMod[i]) continue;
    const c = masked[i]!;
    if (c === "{" || c === "(" || c === "[") d++;
    else if (c === "}" || c === ")" || c === "]") d = Math.max(0, d - 1);
  }

  /** Index just past the `;` that ends the statement starting at `from`. */
  const endOfStatement = (from: number): number => {
    let k = from;
    while (k < n) {
      if (!inMod[k] && masked[k] === ";" && depth[k] === 0) return k + 1;
      k++;
    }
    return -1;
  };

  const defs: DefSpan[] = mods.map((m) => ({ name: m.name, start: m.start, end: m.end }));

  const patterns: RegExp[] = [
    /\bfunction\s+([A-Za-z_]\w*)\s*\(/g,
    /(?:^|[;{}\n])\s*([A-Za-z_$][\w]*)\s*=(?!=)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const nameIdx = m.index + m[0].indexOf(m[1]!);
      if (inMod[nameIdx] || depth[nameIdx] !== 0) continue;
      const end = endOfStatement(nameIdx);
      if (end < 0) continue;
      // The statement starts at `function`, or at the name for an assignment —
      // not at the delimiter the second pattern had to consume.
      const start = /^\s*function/.test(m[0]) ? m.index + m[0].search(/function/) : nameIdx;
      defs.push({ name: m[1]!, start, end });
    }
  }
  return defs.sort((a, b) => a.start - b.start);
}

function identsIn(text: string): string[] {
  return text.match(/[A-Za-z_$][\w]*/g) ?? [];
}

/**
 * Drop top-level definitions that nothing reachable references.
 *
 * This exists to make a CACHE KEY stable. `isolateAssemblyToModules` keeps every
 * module definition and snips only other modules' placements, so appending a new
 * part changes the isolated text of EVERY other module — a new (uncalled)
 * definition, and any new params, now appear in it — while the geometry those
 * modules compile to is byte-for-byte what it was. Hashing the raw text would
 * therefore miss every time.
 *
 * Removal is sound because it only ever removes definitions that nothing
 * reachable names, and an unreferenced definition contributes no geometry. It is
 * deliberately CONSERVATIVE: reachability is computed over bare identifiers
 * rather than call syntax, so anything ambiguous is kept. Keeping too much costs
 * a cache miss; removing too much would be a correctness bug, and this direction
 * of error is the safe one.
 */
export function pruneUnreferencedDefs(scadCode: string): string {
  const defs = findTopLevelDefs(scadCode);
  if (defs.length === 0) return scadCode;
  const masked = stripCommentsAndStrings(scadCode);

  // "Rest" = the assembly and any top-level statement that is not a definition.
  const covered = new Uint8Array(masked.length);
  for (const dsp of defs) {
    for (let k = dsp.start; k < dsp.end && k < masked.length; k++) covered[k] = 1;
  }
  const restParts: string[] = [];
  for (let i = 0; i < masked.length; i++) if (!covered[i]) restParts.push(masked[i]!);
  const rest = restParts.join("");

  const live = new Set(identsIn(rest));
  const byName = new Map<string, DefSpan[]>();
  for (const dsp of defs) {
    const arr = byName.get(dsp.name);
    if (arr) arr.push(dsp); else byName.set(dsp.name, [dsp]);
  }

  const expanded = new Set<string>();
  for (;;) {
    let grew = false;
    for (const [name, spans] of byName) {
      if (!live.has(name) || expanded.has(name)) continue;
      expanded.add(name);
      grew = true;
      for (const sp of spans) {
        for (const id of identsIn(masked.slice(sp.start, sp.end))) live.add(id);
      }
    }
    if (!grew) break;
  }

  const snip: Array<[number, number]> = [];
  for (const [name, spans] of byName) {
    if (live.has(name)) continue;
    // NEVER prune an OpenSCAD SPECIAL variable. `$fn`/`$fa`/`$fs` are consumed
    // implicitly by cylinder(), sphere() and friends and are referenced by name
    // nowhere, so reachability cannot see them — yet they change the geometry
    // completely. Pruning `$fn` made the cache key blind to tessellation and
    // served $fn=128 meshes for an $fn=48 request: 14 false hits, 98.9 MB where
    // 24.0 MB was correct. Anything `$`-prefixed is live by definition.
    if (name.startsWith("$")) continue;
    for (const sp of spans) snip.push([sp.start, sp.end]);
  }
  return snip.length === 0 ? scadCode : snipRanges(scadCode, snip);
}

/**
 * Cache of per-module compiles, keyed by the PRUNED isolated source.
 *
 * Two entries with the same key compile the same geometry by construction: the
 * key is the exact text handed to OpenSCAD, minus definitions proven dead. The
 * cached STL lives wherever it was first written, so a hit re-verifies the file
 * still exists — a caller may have cleaned its step directory since.
 */
const moduleStlCache = new Map<string, string>();
const MODULE_CACHE_MAX = 4096;

/** Cache counters, for the stage report. */
export const moduleCacheStats = { hits: 0, misses: 0 };

/**
 * Compile one module *at its true assembled world position* — keeping every
 * module definition and the full assembly structure, removing only the OTHER
 * parts' placements (see isolateAssemblyToModule). Returns null if `name`
 * isn't placed in the assembly or contributes no geometry.
 *
 * Memoised on the pruned isolated source: the incremental draft re-splits the
 * whole model at every part, so without this a run does O(N^2) module compiles
 * where O(N) distinct ones exist. Set PROCEDURA_NO_MODULE_CACHE=1 to disable.
 */
export async function compileModuleInAssembly(
  scadCode: string, name: string, outputDir: string,
): Promise<string | null> {
  mkdirSync(outputDir, { recursive: true });
  if (!listTopLevelModules(scadCode).includes(name)) return null; // not placed
  const isolated = isolateAssemblyToModule(scadCode, name);

  if (process.env["PROCEDURA_NO_MODULE_CACHE"] === "1") {
    return compileToStl(isolated, outputDir);
  }

  const key = createHash("sha1").update(pruneUnreferencedDefs(isolated)).digest("hex");
  const hit = moduleStlCache.get(key);
  if (hit !== undefined && existsSync(hit)) {
    moduleCacheStats.hits += 1;
    return hit;
  }
  moduleCacheStats.misses += 1;
  const stl = await compileToStl(isolated, outputDir);
  if (stl !== null) {
    if (moduleStlCache.size >= MODULE_CACHE_MAX) {
      moduleStlCache.delete(moduleStlCache.keys().next().value!);
    }
    moduleStlCache.set(key, stl);
  }
  return stl;
}

/**
 * Compile several top-level modules together at their true assembled world
 * positions. This is used by the Isaac/USD motion exporter where multiple
 * visual parts can form a single simulated rigid link.
 */
export async function compileModulesInAssembly(
  scadCode: string, names: string[], outputDir: string,
): Promise<string | null> {
  mkdirSync(outputDir, { recursive: true });
  const placed = listTopLevelModules(scadCode);
  const keep = names.filter((name) => placed.includes(name));
  if (keep.length === 0) return null;
  return compileToStl(isolateAssemblyToModules(scadCode, new Set(keep)), outputDir);
}

/**
 * Superset of compileModulesInAssembly: `partIds` may mix plain module
 * names and `<module>__i<k>` instance ids (see listModuleInstances).
 * Keeps ALL module definitions and the whole assembly structure; keeps
 * (a) every placement statement of plain-name modules and (b) exactly the
 * identified statements of instance ids; snips every other placement
 * statement — so enclosing mirror()/multmatrix()/shared parent transforms
 * around the kept statements survive intact.
 *
 * A plain module name shadows the instance-id syntax: if a module is
 * literally named `foo__i0`, the id `foo__i0` selects that module, not
 * instance 0 of `foo`. Ids referencing a module or statement index that
 * does not exist are ignored; if nothing remains, returns null.
 */
export async function compilePartsInAssembly(
  scadCode: string, partIds: string[], outputDir: string,
): Promise<string | null> {
  mkdirSync(outputDir, { recursive: true });
  const ranges = listAssemblyStatementRanges(scadCode);
  const byModule = new Map<string, StatementRange[]>();
  for (const r of ranges) {
    const arr = byModule.get(r.module);
    if (arr) arr.push(r);
    else byModule.set(r.module, [r]);
  }

  const kept: Array<[number, number]> = [];
  for (const id of partIds) {
    const plain = byModule.get(id);
    if (plain) { // plain module name → keep ALL its placement statements
      for (const r of plain) kept.push([r.start, r.end]);
      continue;
    }
    const m = INSTANCE_ID_PAT.exec(id);
    if (!m) continue; // unknown id → filter out
    const inst = byModule.get(m[1]!)?.[Number(m[2]!)];
    if (inst) kept.push([inst.start, inst.end]); // else unknown → filter out
  }
  if (kept.length === 0) return null;

  // Snip every placement statement that does not overlap a kept range.
  // Overlap (rather than exact-key) protection keeps statements shared by
  // two modules — e.g. a children-wrapper call — from being truncated.
  const overlapsKept = (s: number, e: number): boolean =>
    kept.some(([ks, ke]) => s < ke && e > ks);
  const snip: Array<[number, number]> = [];
  for (const r of ranges) {
    if (!overlapsKept(r.start, r.end)) snip.push([r.start, r.end]);
  }
  return compileToStl(snipRanges(scadCode, snip), outputDir);
}

/**
 * Compile a module standalone + load its STL + return `(sx, sy, sz)` of the
 * local AABB. Returns null if the isolated compile fails or the mesh is empty.
 */
export async function computeModuleBBox(
  scadCode: string, name: string, tmpDir: string,
): Promise<[number, number, number] | null> {
  const stlPath = await compileModuleStandalone(scadCode, name, tmpDir);
  if (stlPath === null) return null;
  try {
    const mesh = loadSTL(stlPath);
    if (mesh.triCount === 0) return null;
    const bb = computeBBox(mesh);
    return bb.size;
  } catch {
    return null;
  }
}

/**
 * Replace every assembly-level placement statement of `name` with `replacement`.
 *
 * This is the placement half of the direct refine's single edit primitive: a
 * part's world pose lives in its assembly statement, so "move it", "rotate it",
 * "make it bigger" are all one operation — rewrite the statement. The agent-era
 * pipeline needed `move_parts` and `scale_parts` as separate tools because the
 * model could only WRAP a statement it was never shown; a patch call that is
 * handed the statement can simply emit the corrected one.
 *
 * A module with several placements (a mirrored pair, a bolt circle) collapses
 * to ONE replacement — the caller supplies the complete new placement text,
 * which may itself contain several statements. Returns the rewritten source and
 * how many statements were replaced (0 = no assembly-level placement, which the
 * caller should surface rather than silently accept).
 */
export function replaceAssemblyStatementsOf(
  scadCode: string, name: string, replacement: string,
): { scad: string; replaced: number } {
  const ranges = listAssemblyStatementRanges(scadCode).filter((r) => r.module === name);
  if (ranges.length === 0) return { scad: scadCode, replaced: 0 };
  // Back-to-front so earlier offsets stay valid. The FIRST statement in the file
  // receives the replacement text and the others are dropped, because
  // `replacement` is the complete new placement for this module.
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let out = scadCode;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const isFirstInFile = i === sorted.length - 1;
    // Newline-terminate: a statement range ends at its `;`, so replacement text
    // would otherwise butt straight against the next statement on one line.
    // Legal OpenSCAD, but it makes a parser error report the wrong line, which
    // costs a debugging round trip on a 7000-line file.
    const text = isFirstInFile ? replacement.replace(/\s*$/, "") + "\n" : "";
    out = out.slice(0, r.start) + text + out.slice(r.end);
  }
  return { scad: out, replaced: ranges.length };
}

/**
 * Append a new assembly-level placement statement after the last existing one.
 *
 * Needed so the refine can ADD a part the reviewer says is missing. Anchoring
 * after the last existing statement (rather than at end-of-file) keeps the new
 * call INSIDE whatever wraps the assembly — the seed wraps it in `union() {…}`,
 * and a placement appended after that closing brace would be a sibling of the
 * union rather than a member of it. Same result geometrically today, but it
 * silently breaks the moment the assembly is wrapped in anything that matters
 * (a colour, a transform, a difference).
 *
 * Returns the source unchanged with `ok:false` when there is no assembly
 * statement to anchor against — the caller must surface that, not guess.
 */
export function appendAssemblyStatement(
  scadCode: string, statement: string,
): { scad: string; ok: boolean } {
  const ranges = listAssemblyStatementRanges(scadCode);
  if (ranges.length === 0) return { scad: scadCode, ok: false };
  const last = ranges.reduce((a, b) => (b.end > a.end ? b : a));
  // Match the indentation of the statement we are following.
  const lineStart = scadCode.lastIndexOf("\n", last.start) + 1;
  const indent = /^[ \t]*/.exec(scadCode.slice(lineStart, last.start))?.[0] ?? "  ";
  const text = "\n" + indent + statement.trim();
  return { scad: scadCode.slice(0, last.end) + text + scadCode.slice(last.end), ok: true };
}

/**
 * Insert a new top-level module definition after the last existing one, i.e.
 * immediately before the assembly region. Every module is therefore defined
 * before the assembly that calls it, which OpenSCAD does not require but which
 * keeps a generated file readable and diffable.
 */
export function insertModuleDefinition(scadCode: string, definition: string): string {
  const spans = findModuleSpans(scadCode);
  if (spans.length === 0) return definition.trim() + "\n\n" + scadCode;
  const at = spans[spans.length - 1]!.end;
  return scadCode.slice(0, at) + "\n\n" + definition.trim() + "\n" + scadCode.slice(at);
}
