/**
 * Client-side SCAD parsing for the code panel:
 *   - findModuleSpans: top-level module source ranges (ported from the
 *     pipeline's src/scad/parts.ts — same brace/paren-depth algorithm).
 *   - tokenizeScad: a small, stateful tokenizer (handles // and /* *​/ comments
 *     and "strings" across lines) so the panel can colour keywords, builtins,
 *     numbers, comments and strings for legibility.
 */

export interface ModuleSpan {
  name: string;
  start: number;
  end: number;
  startLine: number; // 1-based
  endLine: number; // 1-based
}

const KEYWORDS = new Set([
  "module",
  "function",
  "if",
  "else",
  "for",
  "let",
  "each",
  "include",
  "use",
  "true",
  "false",
  "undef",
  "return",
]);

const BUILTINS = new Set([
  "cube",
  "sphere",
  "cylinder",
  "polyhedron",
  "circle",
  "square",
  "polygon",
  "text",
  "import",
  "surface",
  "children",
  "translate",
  "rotate",
  "scale",
  "mirror",
  "resize",
  "multmatrix",
  "color",
  "offset",
  "hull",
  "minkowski",
  "projection",
  "render",
  "linear_extrude",
  "rotate_extrude",
  "union",
  "difference",
  "intersection",
  "echo",
  "assert",
]);

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

function lineOfIndex(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === "\n") line++;
  }
  return line;
}

export function findModuleSpans(code: string): ModuleSpan[] {
  const sanitized = blankCommentsAndStrings(code);
  const n = sanitized.length;
  const results: ModuleSpan[] = [];
  const pat = /\bmodule\s+(\w+)\s*\(/g;
  let i = 0;
  let depth = 0;
  while (i < n) {
    const ch = sanitized[i]!;
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
    pat.lastIndex = i;
    const m = pat.exec(sanitized);
    if (!m || m.index !== i) {
      i += 1;
      continue;
    }
    const name = m[1]!;
    let j = pat.lastIndex;
    let parenDepth = 1;
    while (j < n && parenDepth > 0) {
      const cj = sanitized[j]!;
      if (cj === "(") parenDepth += 1;
      else if (cj === ")") parenDepth -= 1;
      j += 1;
    }
    while (j < n && /[ \t\r\n]/.test(sanitized[j]!)) j += 1;
    if (j >= n || sanitized[j] !== "{") {
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
      results.push({
        name,
        start: m.index,
        end: j,
        startLine: lineOfIndex(code, m.index),
        endLine: lineOfIndex(code, j),
      });
      i = j;
    } else {
      i = pat.lastIndex;
    }
  }
  return results;
}

export type TokenKind =
  | "plain"
  | "keyword"
  | "builtin"
  | "number"
  | "comment"
  | "string"
  | "special"; // $fn, $fa, ...

export interface Token {
  text: string;
  kind: TokenKind;
}

/** Tokenize the whole source into lines of tokens (block-comment aware). */
export function tokenizeScad(code: string): Token[][] {
  const lines = code.split("\n");
  const out: Token[][] = [];
  let inBlockComment = false;

  for (const line of lines) {
    const tokens: Token[] = [];
    let i = 0;
    const push = (text: string, kind: TokenKind) => {
      if (text) tokens.push({ text, kind });
    };

    while (i < line.length) {
      if (inBlockComment) {
        const close = line.indexOf("*/", i);
        if (close === -1) {
          push(line.slice(i), "comment");
          i = line.length;
        } else {
          push(line.slice(i, close + 2), "comment");
          i = close + 2;
          inBlockComment = false;
        }
        continue;
      }
      const ch = line[i]!;
      // line comment
      if (ch === "/" && line[i + 1] === "/") {
        push(line.slice(i), "comment");
        break;
      }
      // block comment open
      if (ch === "/" && line[i + 1] === "*") {
        const close = line.indexOf("*/", i + 2);
        if (close === -1) {
          push(line.slice(i), "comment");
          inBlockComment = true;
          break;
        }
        push(line.slice(i, close + 2), "comment");
        i = close + 2;
        continue;
      }
      // string
      if (ch === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') {
          if (line[j] === "\\") j++;
          j++;
        }
        push(line.slice(i, Math.min(j + 1, line.length)), "string");
        i = j + 1;
        continue;
      }
      // special var $fn etc.
      if (ch === "$") {
        let j = i + 1;
        while (j < line.length && /\w/.test(line[j]!)) j++;
        push(line.slice(i, j), "special");
        i = j;
        continue;
      }
      // number
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
        let j = i;
        while (j < line.length && /[0-9.eE+\-]/.test(line[j]!)) {
          // stop on a '+'/'-' that isn't an exponent sign
          if ((line[j] === "+" || line[j] === "-") && !/[eE]/.test(line[j - 1] ?? "")) break;
          j++;
        }
        push(line.slice(i, j), "number");
        i = j;
        continue;
      }
      // identifier / keyword
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < line.length && /\w/.test(line[j]!)) j++;
        const word = line.slice(i, j);
        const kind: TokenKind = KEYWORDS.has(word)
          ? "keyword"
          : BUILTINS.has(word)
            ? "builtin"
            : "plain";
        push(word, kind);
        i = j;
        continue;
      }
      // everything else, collect a run of non-word/non-special chars
      let j = i;
      while (
        j < line.length &&
        !/[A-Za-z_0-9$"]/.test(line[j]!) &&
        !(line[j] === "/" && (line[j + 1] === "/" || line[j + 1] === "*"))
      ) {
        j++;
      }
      push(line.slice(i, Math.max(j, i + 1)), "plain");
      i = Math.max(j, i + 1);
    }
    out.push(tokens);
  }
  return out;
}
