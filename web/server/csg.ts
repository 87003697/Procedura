/**
 * Stage 3: fast SDF preview front-end.
 *
 * OpenSCAD's `.csg` export runs only the language front-end (full evaluation of
 * for/modules/functions) and serialises the flattened CSG tree — it never
 * invokes the CGAL/Manifold boolean mesher, so it is ~100ms vs seconds for STL
 * and the output is tiny (~50KB vs ~3MB). We parse that flattened grammar into
 * a compact JSON IR the client turns into a raymarching shader.
 *
 * The IR is intentionally lossy: it captures the ops an analytic SDF can render
 * (primitives + affine transforms + booleans) plus the common detailing ops as
 * labelled approximations (hull, rotate_extrude, linear_extrude). Anything else
 * is recorded as `unsupported` so the UI can report coverage and fall back to
 * the authoritative mesh. This is a PREVIEW path; the mesh remains the source of
 * truth for download/export/connectivity.
 */

import { existsSync } from "node:fs";

import type { CsgCoverage, CsgNode, CsgResult } from "../shared/types.ts";

// ── tokenizer ─────────────────────────────────────────────────────────────────
// The .csg grammar is small: `name(arg=val, ...) { children }` or `name(...);`.
// Values are numbers, booleans, strings, or nested [ ... ] vectors/matrices.

type Tok = { t: "id" | "num" | "str" | "punc" | "bool"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      toks.push({ t: "str", v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      toks.push({ t: word === "true" || word === "false" ? "bool" : "id", v: word });
      i = j;
      continue;
    }
    if (/[0-9.+-]/.test(c) && (/[0-9.]/.test(c) || /[0-9.]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(src[j]!)) {
        if ((src[j] === "+" || src[j] === "-") && j > i && !/[eE]/.test(src[j - 1] ?? "")) break;
        j++;
      }
      toks.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    toks.push({ t: "punc", v: c });
    i++;
  }
  return toks;
}

// ── parser ────────────────────────────────────────────────────────────────────

type ArgVal = number | boolean | string | ArgVal[];

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.p];
  }
  private next(): Tok | undefined {
    return this.toks[this.p++];
  }
  private eat(v: string): void {
    const t = this.next();
    if (!t || t.v !== v) throw new Error(`expected '${v}' got '${t?.v ?? "EOF"}'`);
  }

  /** Parse a sequence of statements until EOF or a closing '}'. */
  parseSeq(): CsgNode[] {
    const out: CsgNode[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || (t.t === "punc" && t.v === "}")) break;
      const node = this.parseStatement();
      if (node) out.push(node);
    }
    return out;
  }

  private parseStatement(): CsgNode | null {
    const t = this.next();
    if (!t) return null;
    if (t.t !== "id") return null; // skip stray punctuation
    const name = t.v;
    const args = this.parseArgs();
    let children: CsgNode[] = [];
    const nx = this.peek();
    if (nx && nx.t === "punc" && nx.v === "{") {
      this.eat("{");
      children = this.parseSeq();
      this.eat("}");
    } else if (nx && nx.t === "punc" && nx.v === ";") {
      this.eat(";");
    }
    return this.build(name, args, children);
  }

  private parseArgs(): Record<string, ArgVal> {
    const args: Record<string, ArgVal> = {};
    const t = this.peek();
    if (!t || t.t !== "punc" || t.v !== "(") return args;
    this.eat("(");
    let idx = 0;
    for (;;) {
      const nx = this.peek();
      if (!nx || (nx.t === "punc" && nx.v === ")")) break;
      // key = value  OR  positional value
      if (nx.t === "id" && this.toks[this.p + 1]?.v === "=") {
        const key = this.next()!.v;
        this.eat("=");
        args[key] = this.parseValue();
      } else {
        args[`$${idx++}`] = this.parseValue();
      }
      const sep = this.peek();
      if (sep && sep.t === "punc" && sep.v === ",") this.eat(",");
    }
    this.eat(")");
    return args;
  }

  private parseValue(): ArgVal {
    const t = this.peek()!;
    if (t.t === "punc" && t.v === "[") {
      this.eat("[");
      const arr: ArgVal[] = [];
      for (;;) {
        const nx = this.peek();
        if (!nx || (nx.t === "punc" && nx.v === "]")) break;
        arr.push(this.parseValue());
        const sep = this.peek();
        if (sep && sep.t === "punc" && sep.v === ",") this.eat(",");
      }
      this.eat("]");
      return arr;
    }
    this.next();
    if (t.t === "num") return Number(t.v);
    if (t.t === "bool") return t.v === "true";
    return t.v;
  }

  private build(name: string, args: Record<string, ArgVal>, children: CsgNode[]): CsgNode {
    const num = (k: string, d = 0): number => {
      const v = args[k];
      return typeof v === "number" ? v : d;
    };
    const bool = (k: string, d = false): boolean => {
      const v = args[k];
      return typeof v === "boolean" ? v : d;
    };
    switch (name) {
      case "group":
      case "union":
      case "difference":
      case "intersection":
      case "hull":
      case "minkowski":
        return { op: name, children };
      case "multmatrix": {
        const m = flat16(args["$0"] ?? args["m"]);
        const child: CsgNode = children.length === 1 ? children[0]! : { op: "group", children };
        return { op: "transform", m, child };
      }
      case "cube": {
        const s = args["size"];
        const size: [number, number, number] = Array.isArray(s)
          ? [num3(s, 0), num3(s, 1), num3(s, 2)]
          : [num("size", 1), num("size", 1), num("size", 1)];
        return { op: "cube", size, center: bool("center") };
      }
      case "sphere":
        return { op: "sphere", r: num("r", num("$0", 1)) };
      case "cylinder": {
        const r = args["r"];
        const r1 = typeof r === "number" ? r : num("r1", 1);
        const r2 = typeof r === "number" ? r : num("r2", r1);
        return { op: "cylinder", h: num("h", 1), r1, r2, center: bool("center") };
      }
      case "circle":
        return { op: "circle", r: num("r", num("$0", 1)) };
      case "square": {
        const s = args["size"];
        const size: [number, number] = Array.isArray(s) ? [num3(s, 0), num3(s, 1)] : [num("size", 1), num("size", 1)];
        return { op: "square", size, center: bool("center") };
      }
      case "polygon": {
        const pts = args["points"];
        const points: [number, number][] = Array.isArray(pts)
          ? pts.map((p) => (Array.isArray(p) ? [num3(p, 0), num3(p, 1)] : [0, 0]) as [number, number])
          : [];
        return { op: "polygon", points };
      }
      case "rotate_extrude": {
        const child: CsgNode = children.length === 1 ? children[0]! : { op: "group", children };
        return { op: "rotate_extrude", angle: num("angle", 360), child };
      }
      case "linear_extrude": {
        const sc = args["scale"];
        const scale: [number, number] =
          typeof sc === "number" ? [sc, sc] : Array.isArray(sc) ? [num3(sc, 0), num3(sc, 1)] : [1, 1];
        const child: CsgNode = children.length === 1 ? children[0]! : { op: "group", children };
        return {
          op: "linear_extrude",
          height: num("height", 1),
          twist: num("twist", 0),
          scale,
          center: bool("center"),
          child,
        };
      }
      default:
        return { op: "unsupported", name };
    }
  }
}

function num3(a: ArgVal, i: number): number {
  if (Array.isArray(a)) {
    const v = a[i];
    return typeof v === "number" ? v : 0;
  }
  return 0;
}

/** Flatten a 4x4 nested matrix into 16 row-major floats (identity on failure). */
function flat16(v: ArgVal | undefined): number[] {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!Array.isArray(v) || v.length !== 4) return id;
  const out: number[] = [];
  for (let r = 0; r < 4; r++) {
    const row = v[r];
    if (!Array.isArray(row) || row.length !== 4) return id;
    for (let c = 0; c < 4; c++) {
      const x = row[c];
      out.push(typeof x === "number" ? x : 0);
    }
  }
  return out;
}

// ── coverage ──────────────────────────────────────────────────────────────────

const EXACT = new Set(["group", "union", "difference", "intersection", "transform", "cube", "sphere", "cylinder", "circle", "square"]);
const APPROX = new Set(["hull", "rotate_extrude", "linear_extrude", "polygon"]);

/** Does a 2D profile subtree contain a polygon or an unsupported op? Those make
 *  a revolve/extrude collapse or distort in the SDF (the mug-wall failure). A
 *  hull-of-circles profile does NOT count — we render that exactly now. */
function profileIsRisky(n: CsgNode): boolean {
  if (n.op === "polygon" || n.op === "unsupported" || n.op === "minkowski") return true;
  if ("children" in n) return n.children.some(profileIsRisky);
  if ("child" in n) return profileIsRisky(n.child);
  return false;
}

function computeCoverage(root: CsgNode): CsgCoverage {
  const byOp: Record<string, number> = {};
  let nodes = 0;
  let supported = 0;
  let approximated = 0;
  let unsupported = 0;
  // "risky" = ops that visually break in the SDF preview, regardless of how many
  // exact transforms surround them. This is what should drive the auto-fallback,
  // not a node-count ratio (363 exact multmatrix nodes must not mask one offset).
  let risky = 0;
  const walk = (n: CsgNode) => {
    nodes++;
    const key = n.op === "unsupported" ? `unsupported:${n.name}` : n.op;
    byOp[key] = (byOp[key] ?? 0) + 1;
    if (n.op === "unsupported" || n.op === "minkowski") {
      unsupported++;
      risky++;
    } else if (APPROX.has(n.op)) {
      approximated++;
      if ((n.op === "rotate_extrude" || n.op === "linear_extrude") && profileIsRisky(n.child)) risky++;
      else if (n.op === "polygon") risky++; // a bare top-level polygon extrude is unreliable
    } else if (EXACT.has(n.op)) {
      supported++;
    }
    if ("children" in n) n.children.forEach(walk);
    else if ("child" in n) walk(n.child);
  };
  walk(root);
  // Visual-reliability fidelity: any risky op caps it well below the client's
  // fallback threshold so those models transparently show the exact mesh; a
  // fully analytic / hull-of-spheres model scores 1.0 and uses the SDF.
  const meaningful = supported + approximated + unsupported || 1;
  const base = (supported + approximated * 0.85) / meaningful;
  const fidelity = risky > 0 ? Math.min(base, 0.35) : base;
  return { nodes, supported, approximated, unsupported, byOp, fidelity };
}

// ── export + parse ──────────────────────────────────────────────────────────

export interface CsgExportOpts {
  openscad: string;
  scadAbs: string;
  defines: string[]; // sanitized name=value
  timeoutMs?: number;
}

export async function exportCsg(opts: CsgExportOpts): Promise<{ ok: true; result: CsgResult } | { ok: false; error: string }> {
  if (!existsSync(opts.scadAbs)) return { ok: false, error: "source SCAD not found" };
  const tmp = `/tmp/procedura-csg-${(Date.now() % 1e9).toString(36)}-${Math.floor(performance.now())}.csg`;
  const args = [opts.scadAbs, "-o", tmp];
  for (const d of opts.defines) args.push("-D", d);
  let text: string;
  try {
    const proc = Bun.spawn([opts.openscad, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(9), opts.timeoutMs ?? 20_000);
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0 || !existsSync(tmp)) {
      return { ok: false, error: (stderr.trim().split("\n").slice(-4).join("\n") || `csg export exited ${code}`).slice(0, 800) };
    }
    text = await Bun.file(tmp).text();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    try {
      await Bun.file(tmp).delete?.();
    } catch {
      /* tolerate */
    }
  }
  try {
    const nodes = new Parser(tokenize(text)).parseSeq();
    const tree: CsgNode = nodes.length === 1 ? nodes[0]! : { op: "group", children: nodes };
    return { ok: true, result: { tree, coverage: computeCoverage(tree) } };
  } catch (e) {
    return { ok: false, error: `csg parse failed: ${(e as Error).message}` };
  }
}
