/**
 * Parameter → module dependency analysis for the highlight feature.
 *
 * Given a generated SCAD source (a clean `union()` of named top-level modules),
 * work out which top-level *assembly* modules each top-level parameter affects —
 * directly, or transitively through helper functions / helper modules that
 * reference the parameter. Pure text analysis; no OpenSCAD invocation.
 *
 *   R_foot_out → {mug_foot_ring}                  (local → highlight that part)
 *   H_total    → flows through r_out()/r_in() used by every wall → global
 *
 * "Local" params highlight their parts; "global" params (touching most of the
 * model, or a render-global like $fn) get an "affects whole model" note instead
 * of lighting everything.
 */

import type { ParamScope } from "../shared/types.ts";

// ── shared parsing (self-contained; mirrors src/scad/parts.ts) ───────────────

function blankCommentsAndStrings(code: string): string {
  let out = code.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    Array.from(m)
      .map((ch) => (ch === "\n" ? "\n" : " "))
      .join(""),
  );
  out = out.replace(/"[^"\n]*"/g, (m) => `"${" ".repeat(Math.max(0, m.length - 2))}"`);
  return out;
}

interface Span {
  name: string;
  start: number; // index of `m`/`f` keyword
  bodyStart: number; // index just after `{` (or `=` for functions)
  end: number; // one past body close
}

/** Find top-level `module name(...) { ... }` and `function name(...) = ...;`. */
function findDefSpans(code: string): { modules: Span[]; functions: Span[] } {
  const s = blankCommentsAndStrings(code);
  const n = s.length;
  const modules: Span[] = [];
  const functions: Span[] = [];
  let i = 0;
  let depth = 0;
  const mod = /\bmodule\s+(\w+)\s*\(/g;
  const fn = /\bfunction\s+(\w+)\s*\(/g;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth !== 0) {
      i += 1;
      continue;
    }
    // try module at i
    mod.lastIndex = i;
    const mm = mod.exec(s);
    if (mm && mm.index === i) {
      let j = closeParen(s, mod.lastIndex);
      while (j < n && /\s/.test(s[j]!)) j++;
      if (s[j] === "{") {
        const bodyStart = j + 1;
        const end = closeBrace(s, bodyStart);
        if (end > 0) {
          modules.push({ name: mm[1]!, start: i, bodyStart, end });
          i = end;
          continue;
        }
      }
      i = mod.lastIndex;
      continue;
    }
    // try function at i
    fn.lastIndex = i;
    const fmm = fn.exec(s);
    if (fmm && fmm.index === i) {
      let j = closeParen(s, fn.lastIndex);
      while (j < n && /\s/.test(s[j]!)) j++;
      if (s[j] === "=") {
        const bodyStart = j + 1;
        let k = bodyStart;
        // function body ends at the first top-level ';'
        let pd = 0;
        while (k < n) {
          const c = s[k]!;
          if (c === "(" || c === "[" || c === "{") pd++;
          else if (c === ")" || c === "]" || c === "}") pd--;
          else if (c === ";" && pd === 0) break;
          k++;
        }
        functions.push({ name: fmm[1]!, start: i, bodyStart, end: k });
        i = k + 1;
        continue;
      }
      i = fn.lastIndex;
      continue;
    }
    i += 1;
  }
  return { modules, functions };
}

function closeParen(s: string, afterOpen: number): number {
  let pd = 1;
  let j = afterOpen;
  while (j < s.length && pd > 0) {
    const c = s[j]!;
    if (c === "(") pd++;
    else if (c === ")") pd--;
    j++;
  }
  return j;
}

function closeBrace(s: string, afterOpen: number): number {
  let bd = 1;
  let j = afterOpen;
  while (j < s.length && bd > 0) {
    const c = s[j]!;
    if (c === "{") bd++;
    else if (c === "}") bd--;
    j++;
  }
  return bd === 0 ? j : -1;
}

/** Identifiers referenced in a code slice (\w+ and $\w+). */
function identsIn(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of blankCommentsAndStrings(code).matchAll(/\$?\b[A-Za-z_]\w*\b/g)) out.add(m[0]);
  return out;
}

/** Top-level modules invoked from the assembly region (after the last def). */
function assemblyModules(code: string, defs: Span[]): Set<string> {
  const defNames = new Set(defs.map((d) => d.name));
  const s = blankCommentsAndStrings(code);
  const lastEnd = defs.reduce((mx, d) => Math.max(mx, d.end), 0);
  const assembly = s.slice(lastEnd);
  const out = new Set<string>();
  for (const m of assembly.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    if (defNames.has(m[1]!)) out.add(m[1]!);
  }
  return out;
}

// ── public: param → affected assembly modules ───────────────────────────────

export interface ParamModuleInfo {
  modules: string[];
  scope: ParamScope;
}

const GLOBAL_FRACTION = 0.6;

export function analyzeParamModules(code: string): Record<string, ParamModuleInfo> {
  const { modules, functions } = findDefSpans(code);
  const allDefs = [...modules, ...functions];
  const sliceOf = (sp: Span) => code.slice(sp.bodyStart, sp.end);

  // direct references: which symbols each def's body mentions
  const refOf = new Map<string, Set<string>>();
  for (const d of allDefs) refOf.set(d.name, identsIn(sliceOf(d)));

  // top-level parameters = top-level `NAME = ...;` assignments (outside any def)
  const params = topLevelParams(code, allDefs);

  // Top-level derived params: `R_in_top = R_out_top - Wall_th;` — a base param
  // taints any top-level var whose RHS mentions it (and transitively). So a
  // module referencing R_in_top is reached by Wall_th too.
  const derivedFrom = topLevelDerivations(code, allDefs, new Set(params));

  // assembly modules (the highlightable parts)
  const asm = assemblyModules(code, allDefs);

  // For each param: find defs that reference it transitively, then keep the
  // assembly modules among them (or whose callees reference it).
  const fnNames = new Set(functions.map((f) => f.name));
  const result: Record<string, ParamModuleInfo> = {};

  for (const param of params) {
    // a param's "reach" = itself + every top-level var derived from it.
    const reach = new Set<string>([param, ...(derivedFrom.get(param) ?? [])]);
    // seed: defs that directly reference the param (or anything derived from it)
    const tainted = new Set<string>();
    for (const d of allDefs) {
      const refs = refOf.get(d.name)!;
      for (const sym of reach) {
        if (refs.has(sym)) {
          tainted.add(d.name);
          break;
        }
      }
    }
    // propagate: a def that calls a tainted function/module is tainted too
    for (let pass = 0; pass < 6; pass++) {
      let grew = false;
      for (const d of allDefs) {
        if (tainted.has(d.name)) continue;
        for (const ref of refOf.get(d.name)!) {
          if (tainted.has(ref) && (fnNames.has(ref) || asm.has(ref) || isModuleName(ref, modules))) {
            tainted.add(d.name);
            grew = true;
            break;
          }
        }
      }
      if (!grew) break;
    }
    // which highlightable assembly modules are tainted
    const hit = [...asm].filter((m) => tainted.has(m)).sort();
    let scope: ParamScope;
    if (param.startsWith("$")) scope = "global"; // $fn etc. affect everything
    else if (hit.length === 0) scope = "none";
    else if (hit.length >= Math.ceil(asm.size * GLOBAL_FRACTION)) scope = "global";
    else scope = "local";
    result[param] = { modules: scope === "local" ? hit : scope === "global" ? hit : [], scope };
  }
  return result;
}

function isModuleName(name: string, modules: Span[]): boolean {
  return modules.some((m) => m.name === name);
}

/**
 * For each base parameter, the set of top-level derived variables that depend on
 * it transitively. e.g. `R_in_top = R_out_top - Wall_th;` and
 * `R_in_bot = R_out_bot - Wall_th;` → Wall_th ⇒ {R_in_top, R_in_bot, …}.
 */
function topLevelDerivations(code: string, defs: Span[], _params: Set<string>): Map<string, Set<string>> {
  const s = blankCommentsAndStrings(code);
  const inDef = (idx: number) => defs.some((d) => idx >= d.start && idx < d.end);
  // every top-level assignment: name → identifiers on its RHS
  const rhsOf = new Map<string, Set<string>>();
  const order: string[] = [];
  const pat = /(^|\n)\s*(\$?[A-Za-z_]\w*)\s*=\s*([^;\n]*)/g;
  for (let m: RegExpExecArray | null; (m = pat.exec(s)); ) {
    const nameIdx = m.index + m[0].indexOf(m[2]!);
    if (inDef(nameIdx)) continue;
    const name = m[2]!;
    if (!rhsOf.has(name)) order.push(name);
    rhsOf.set(name, identsIn(m[3] ?? ""));
  }
  // forward closure: var v depends on base b if b is reachable through RHS refs
  const dependsOn = new Map<string, Set<string>>(); // var → all top-level vars it transitively references
  const resolve = (v: string, seen: Set<string>): Set<string> => {
    if (dependsOn.has(v)) return dependsOn.get(v)!;
    if (seen.has(v)) return new Set();
    seen.add(v);
    const acc = new Set<string>();
    for (const r of rhsOf.get(v) ?? []) {
      if (rhsOf.has(r)) {
        acc.add(r);
        for (const x of resolve(r, seen)) acc.add(x);
      }
    }
    dependsOn.set(v, acc);
    return acc;
  };
  for (const v of order) resolve(v, new Set());
  // invert: base → vars derived from it
  const derived = new Map<string, Set<string>>();
  for (const v of order) {
    for (const base of dependsOn.get(v) ?? []) {
      if (!derived.has(base)) derived.set(base, new Set());
      derived.get(base)!.add(v);
    }
  }
  return derived;
}

/** Top-level `NAME = ...;` (and `$fn = ...;`) outside any def body. */
function topLevelParams(code: string, defs: Span[]): string[] {
  const s = blankCommentsAndStrings(code);
  const inDef = (idx: number) => defs.some((d) => idx >= d.start && idx < d.end);
  const out: string[] = [];
  const seen = new Set<string>();
  const pat = /(^|\n)\s*(\$?[A-Za-z_]\w*)\s*=/g;
  for (let m: RegExpExecArray | null; (m = pat.exec(s)); ) {
    const nameIdx = m.index + m[0].indexOf(m[2]!);
    if (inDef(nameIdx)) continue;
    const name = m[2]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
