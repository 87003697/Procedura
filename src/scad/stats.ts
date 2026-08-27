/**
 * SCAD program-compactness stats — cheap structural signals (token/line
 * counts, module counts, primitive/boolean/transform call tallies) the
 * benchmark harness uses to compare generated .scad programs across
 * pipeline versions. Pure text analysis, no OpenSCAD invocation.
 */

import { stripCommentsAndStrings, listPartModules, BUILTINS } from "./parts.ts";

export interface ScadStats {
  tokens: number;
  lines: number;
  modules: number;
  moduleCalls: number;
  primitives: number;
  booleans: number;
  transforms: number;
  ops: number;
}

const PRIMITIVES: ReadonlySet<string> = new Set([
  "cube", "sphere", "cylinder", "polyhedron", "square", "circle", "polygon", "text",
]);
const BOOLEANS: ReadonlySet<string> = new Set(["union", "difference", "intersection"]);
const TRANSFORMS: ReadonlySet<string> = new Set([
  "translate", "rotate", "scale", "mirror", "multmatrix", "resize", "hull", "minkowski", "offset",
]);
// linear_extrude/rotate_extrude are builtins (→ ops) but deliberately NOT
// classified as transforms here. Also excluded from moduleCalls even though
// parts.ts's BUILTINS doesn't list the *_for looping form.
const KEYWORDS: ReadonlySet<string> = new Set([
  "module", "function", "if", "for", "let", "each", "echo", "assert", "intersection_for",
]);

const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s]/g;
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const DEF_PREFIX_RE = /\b(?:module|function)\s*$/;

export function computeScadStats(source: string): ScadStats {
  const stripped = stripCommentsAndStrings(source);

  const tokens = stripped.match(TOKEN_RE)?.length ?? 0;
  const lines = stripped.split("\n").filter((l) => l.trim().length > 0).length;
  // Part-level count, NOT the raw top-level invocation count: a program that
  // wraps its parts in a single root module invokes one module while an
  // otherwise identical flat program invokes N. That is authoring style, not
  // decomposition — see listPartModules() for the measured cross-config bias.
  const modules = listPartModules(source).length;

  let moduleCalls = 0;
  let primitives = 0;
  let booleans = 0;
  let transforms = 0;
  let ops = 0;

  CALL_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = CALL_RE.exec(stripped)); ) {
    const name = m[1]!;
    // Definition sites (`module foo(` / `function foo(`) are not calls.
    const before = stripped.slice(Math.max(0, m.index - 40), m.index);
    if (DEF_PREFIX_RE.test(before)) continue;

    if (BUILTINS.has(name)) {
      ops += 1;
      if (PRIMITIVES.has(name)) primitives += 1;
      else if (BOOLEANS.has(name)) booleans += 1;
      else if (TRANSFORMS.has(name)) transforms += 1;
    } else if (!KEYWORDS.has(name)) {
      moduleCalls += 1;
    }
  }

  return { tokens, lines, modules, moduleCalls, primitives, booleans, transforms, ops };
}
