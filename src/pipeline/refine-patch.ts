/**
 * The direct refine's ONE edit primitive: parse a patch response into module
 * definitions and/or assembly placements, and apply it to the buffer.
 *
 * The agent-era pipeline offered six ways to change the code — `edit_module`,
 * `edit_modules`, `edit_full`, `move_parts`, `scale_parts`, `snap_floaters` —
 * and spent forty lines of system prompt teaching the model to pick between
 * them. That taxonomy was never about the geometry; it was about what the
 * agent could express without being shown the file. `move_parts` wraps an
 * opaque placement in a translate because the model was never given the
 * placement. `scale_parts` does the same with a scale. `edit_full` exists
 * because sometimes the change spans everything — and it measurably gutted
 * models, re-authoring them at 1/30 the facet count.
 *
 * A patch call that receives the whole SCAD needs none of that. Every one of
 * those six operations is "here is the new text for these named spans", so
 * that is the entire primitive:
 *
 *   === MODULE <name> ===      replace module <name>'s definition
 *   === PLACE <name> ===       replace module <name>'s assembly placement
 *   === ADD <name> ===         define a NEW module (needs a PLACE in the same
 *                              patch — a module nobody calls is invisible)
 *
 * Any number of blocks, applied atomically. A response that names a module the
 * buffer doesn't have is rejected as a whole rather than half-applied — a
 * partial patch is how you get a model that compiles and is wrong.
 */

import {
  listTopLevelModules,
  replaceModuleDefinition,
  replaceAssemblyStatementsOf,
  appendAssemblyStatement,
  insertModuleDefinition,
  extractModuleDefinition,
  extractAssemblyStatementsOf,
} from "../scad/parts.ts";

export interface PatchBlock {
  kind: "module" | "place" | "add";
  name: string;
  /** Replacement text, already unwrapped from any ``` fence. */
  body: string;
}

export interface ParsedPatch {
  blocks: PatchBlock[];
  /** Free text before the first block — the model's stated reasoning. */
  reason: string;
}

/** `=== MODULE name ===` / `=== PLACE name ===`, tolerant of case and spacing. */
const HEADER_RE = /^[ \t]*={2,}[ \t]*(MODULE|PLACE|ADD)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*={2,}[ \t]*$/gim;

/**
 * Remove markdown code fences from a block body.
 *
 * Not just a matched pair: models routinely fence the ENTIRE response, which
 * puts the opening fence before the first header (harmless — it lands in
 * `reason`) and the CLOSING fence after the last block, where it becomes part
 * of that block's body. That spliced a bare fence line into the assembly region
 * and produced a parser error 6800 lines into the file, three attempts in a
 * row. So drop every line that is ONLY a fence marker, wherever it sits.
 */
function unfence(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*```[a-zA-Z0-9_+-]*\s*$/.test(line))
    .join("\n")
    .trim();
}

/**
 * Parse a patch response. Returns `null` when the response contains no block at
 * all — the caller treats that as "the model declined to edit", which is a
 * legitimate outcome (nothing left to fix) and not an error.
 */
export function parsePatchResponse(raw: string): ParsedPatch | null {
  const headers: { kind: PatchBlock["kind"]; name: string; start: number; end: number }[] = [];
  HEADER_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = HEADER_RE.exec(raw)); ) {
    headers.push({
      kind: m[1]!.toUpperCase() === "MODULE" ? "module"
        : m[1]!.toUpperCase() === "ADD" ? "add" : "place",
      name: m[2]!,
      start: m.index,
      end: m.index + m[0]!.length,
    });
  }
  if (headers.length === 0) return null;

  const blocks: PatchBlock[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1]!.start : raw.length;
    const body = unfence(raw.slice(h.end, bodyEnd));
    if (body) blocks.push({ kind: h.kind, name: h.name, body });
  }
  if (blocks.length === 0) return null;
  return { blocks, reason: raw.slice(0, headers[0]!.start).trim() };
}

export type ApplyResult =
  | { ok: true; scad: string; touched: string[] }
  | { ok: false; error: string };

/**
 * Apply a parsed patch atomically.
 *
 * Validation is deliberately strict and up-front, before a single byte is
 * written: a module name that isn't in the buffer, a MODULE body that doesn't
 * actually define that module, or a PLACE for a module with no assembly-level
 * placement all reject the WHOLE patch. The failure text is fed straight back
 * to the model as the next attempt's prompt, so it has to be specific enough to
 * act on.
 */
export function applyPatch(scad: string, patch: ParsedPatch): ApplyResult {
  const known = new Set(listTopLevelModules(scad));
  const problems: string[] = [];

  for (const b of patch.blocks) {
    if (b.body.includes("```")) {
      problems.push(
        `the ${b.kind === "module" ? "MODULE" : "PLACE"} ${b.name} block still contains a ` +
        "markdown code fence. Emit raw OpenSCAD inside the block, with no fences.",
      );
      continue;
    }
    if (b.kind === "add") {
      if (known.has(b.name)) {
        problems.push(
          `ADD ${b.name}: that module already exists. Use a MODULE block to change it.`,
        );
      } else {
        if (!new RegExp(`\\bmodule\\s+${b.name}\\s*\\(`).test(b.body)) {
          problems.push(
            `the ADD ${b.name} block does not contain 'module ${b.name}(...)'. ` +
            `Emit the complete module definition.`,
          );
        }
        // An added module nobody calls is invisible geometry — require the
        // placement in the same patch so the part actually lands in the model.
        if (!patch.blocks.some((x) => x.kind === "place" && x.name === b.name)) {
          problems.push(
            `ADD ${b.name} has no matching '=== PLACE ${b.name} ===' block. ` +
            `A module that is never called adds nothing to the model — emit its ` +
            `assembly placement in the same patch.`,
          );
        }
      }
      continue;
    }
    // A PLACE for a module being ADDed in this same patch is legitimate even
    // though the name is not in the buffer yet.
    const addedHere = patch.blocks.some((x) => x.kind === "add" && x.name === b.name);
    if (!known.has(b.name) && !addedHere) {
      // Observed twice in one run: the model reaches for MODULE when it means
      // ADD, burning a whole patch call on the round trip. Naming the fix in
      // the rejection costs nothing and saves that call.
      problems.push(
        `'${b.name}' is not a top-level module in this model` +
        (b.kind === "module"
          ? `. If you meant to CREATE it, use '=== ADD ${b.name} ===' with the ` +
            `definition plus '=== PLACE ${b.name} ===' with its placement. If you ` +
            `meant to edit an existing part, pick one of: ${[...known].join(", ")}`
          : `. Available: ${[...known].join(", ")}`),
      );
      continue;
    }
    if (b.kind === "module") {
      // The body must define the module it claims to. Catching this here is what
      // stops a "helpful" response that returns a call site, a fragment, or a
      // differently-named module from silently corrupting the buffer.
      const defines = new RegExp(`\\bmodule\\s+${b.name}\\s*\\(`).test(b.body);
      if (!defines) {
        problems.push(
          `the MODULE ${b.name} block does not contain 'module ${b.name}(...)'. ` +
          `Emit the complete module definition, not a fragment or a call.`,
        );
      }
    } else {
      if (!addedHere && extractAssemblyStatementsOf(scad, b.name).length === 0) {
        problems.push(
          `'${b.name}' has no assembly-level placement statement to replace. ` +
          `Edit it with a MODULE block instead.`,
        );
      } else if (!new RegExp(`\\b${b.name}\\s*\\(`).test(b.body)) {
        problems.push(
          `the PLACE ${b.name} block never calls ${b.name}(). ` +
          `Emit the full placement statement, e.g. translate([...]) rotate([...]) ${b.name}();`,
        );
      }
    }
  }
  if (problems.length) {
    return { ok: false, error: problems.map((p) => `- ${p}`).join("\n") };
  }

  // Apply modules first, then placements: a MODULE rewrite can shift the offsets
  // the placement scan depends on, and re-scanning per block keeps every
  // replacement anchored to the buffer it is actually being applied to.
  let out = scad;
  const touched: string[] = [];
  // Additions first: their PLACE block below needs the definition to exist so
  // listTopLevelModules can see the name when the placement is anchored.
  for (const b of patch.blocks.filter((x) => x.kind === "add")) {
    out = insertModuleDefinition(out, b.body);
    touched.push(`add ${b.name}`);
  }
  for (const b of patch.blocks.filter((x) => x.kind === "module")) {
    const before = extractModuleDefinition(out, b.name);
    if (before === null) {
      return { ok: false, error: `- module '${b.name}' vanished mid-patch (internal error)` };
    }
    out = replaceModuleDefinition(out, b.name, b.body);
    touched.push(`module ${b.name}`);
  }
  for (const b of patch.blocks.filter((x) => x.kind === "place")) {
    const isNew = patch.blocks.some((x) => x.kind === "add" && x.name === b.name);
    if (isNew) {
      const r = appendAssemblyStatement(out, b.body);
      if (!r.ok) {
        return {
          ok: false,
          error: `- this model has no assembly statement to anchor '${b.name}' after`,
        };
      }
      out = r.scad;
      touched.push(`place ${b.name} (new)`);
      continue;
    }
    const r = replaceAssemblyStatementsOf(out, b.name, b.body);
    if (r.replaced === 0) {
      return { ok: false, error: `- placement for '${b.name}' vanished mid-patch (internal error)` };
    }
    out = r.scad;
    touched.push(`place ${b.name}${r.replaced > 1 ? ` (${r.replaced} statements → 1)` : ""}`);
  }
  return { ok: true, scad: out, touched };
}
