/**
 * edit_modules tool — surgical replacement of SEVERAL top-level modules in one
 * call, applied atomically.
 *
 * This is the answer to the fix that spans a group of parts: "raise the film
 * gate, both sprocket housings, both guide rollers and the lens by 30mm" is one
 * coherent change across 13 modules. With only edit_module (one module per
 * cycle) that fix costs 13 diagnose cycles, so the agent used to reach for
 * edit_full and re-author the whole file — which is how models got gutted. Here
 * the untouched 95% of the buffer is never re-emitted at all.
 *
 * Atomic: every replacement is validated and applied to a scratch copy first.
 * If any module is unknown or the combined result trips the safety guard,
 * nothing is committed — the working buffer is left exactly as it was.
 *
 * Counts as ONE edit against the refine budget, like move_parts.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { replaceModuleDefinition, findModuleSpans } from "../scad/parts.ts";
import { checkEditSafety } from "./edit-guard.ts";
import type { SessionProceduraState } from "./state.ts";
import { beginPendingEdit, pendingEditRefusal } from "./edit-transaction.ts";

/** Beyond this many modules in one call it stops being a targeted fix. */
const MAX_EDITS_PER_CALL = 8;

const DESCRIPTOR: ToolDescriptor = {
  name: "edit_modules",
  description:
    "Replace SEVERAL top-level modules' complete definitions in one atomic call. " +
    "Use when the reviewer's single top issue spans a group of parts (a shared " +
    "datum shift, a proportion change across a sub-assembly). Every entry needs a " +
    "complete `module <name>(...) { ... }` block. Untouched modules and the " +
    "assembly stay byte-identical — never re-emit the whole file. Max " +
    `${MAX_EDITS_PER_CALL} modules per call; counts as one edit cycle. If the fix is a ` +
    "pure rigid reposition with no geometry change, prefer move_parts.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["edits", "reason"],
    properties: {
      edits: {
        type: "array",
        minItems: 1,
        maxItems: MAX_EDITS_PER_CALL,
        description:
          "The modules to replace. All applied together or not at all.",
        items: {
          type: "object",
          required: ["name", "new_def"],
          properties: {
            name: { type: "string", description: "Top-level module name to replace." },
            new_def: {
              type: "string",
              description:
                "Complete replacement definition, starting with `module <name>(`.",
            },
          },
        },
      },
      reason: {
        type: "string",
        description:
          "One line: the single reviewer issue this group of edits resolves.",
      },
    },
  } satisfies JsonObject,
};

interface ParsedEdit { name: string; newDef: string }

/** Pull the declared name out of a `module <name>(...)` block. */
function declaredName(def: string): string | null {
  const m = /^\s*module\s+(\w+)\s*\(/.exec(def);
  return m ? m[1]! : null;
}

export function makeEditModulesTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute(input) {
      state.step += 1;

      if (state.editBudgetExhausted) {
        return {
          ok: false,
          error:
            "Edit budget spent — no further edits this run. Run compile (and " +
            "check_connectivity) to verify the edit you just made, then call finish.",
        };
      }

      const pending = pendingEditRefusal(state);
      if (pending) return { ok: false, error: pending };

      // Same cycle discipline as edit_module: context → critic → fix.
      if (!state.hasFreshDiagnosis) {
        return {
          ok: false,
          error:
            "No fresh diagnosis to act on. Call render_views, then diagnose, then " +
            "fix the single highest-severity issue it reports. One edit per " +
            "diagnose cycle — re-diagnose before the next edit.",
        };
      }

      const rawEdits = input["edits"];
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return {
          ok: false,
          error:
            "edit_modules requires a non-empty `edits` array of " +
            "{name, new_def} objects.",
        };
      }
      if (rawEdits.length > MAX_EDITS_PER_CALL) {
        return {
          ok: false,
          error:
            `edit_modules takes at most ${MAX_EDITS_PER_CALL} modules per call ` +
            `(got ${rawEdits.length}). Split the fix, or use move_parts if this is ` +
            `a rigid reposition of a whole limb.`,
        };
      }

      // ── Validate every entry BEFORE touching the buffer ──────────────────
      const parsed: ParsedEdit[] = [];
      const seen = new Set<string>();
      for (const [i, raw] of rawEdits.entries()) {
        if (typeof raw !== "object" || raw === null) {
          return { ok: false, error: `edits[${i}] is not an object with {name, new_def}.` };
        }
        const rec = raw as Record<string, unknown>;
        const name = rec["name"];
        const newDef = rec["new_def"];
        if (typeof name !== "string" || name.length === 0) {
          return { ok: false, error: `edits[${i}].name must be a non-empty string.` };
        }
        if (typeof newDef !== "string" || newDef.trim().length === 0) {
          return {
            ok: false,
            error:
              `edits[${i}].new_def must be the complete replacement module source ` +
              `for '${name}'.`,
          };
        }
        if (seen.has(name)) {
          return {
            ok: false,
            error: `'${name}' appears twice in edits — give one final definition per module.`,
          };
        }
        seen.add(name);
        const decl = declaredName(newDef);
        if (decl === null) {
          return {
            ok: false,
            error:
              `edits[${i}].new_def must start with the keyword \`module\` — it needs ` +
              `to be the complete \`module ${name}(...) { ... }\` block.`,
          };
        }
        if (decl !== name) {
          return {
            ok: false,
            error:
              `edits[${i}] says name='${name}' but the definition declares ` +
              `\`module ${decl}\`. Rename one of them so they agree.`,
          };
        }
        parsed.push({ name, newDef });
      }

      // ── Apply to a scratch copy (atomic) ─────────────────────────────────
      const known = new Set(findModuleSpans(state.scad).map((s) => s.name));
      const unknown = parsed.filter((e) => !known.has(e.name)).map((e) => e.name);
      if (unknown.length > 0) {
        return {
          ok: false,
          error:
            `No such module(s) in the current SCAD: ${unknown.join(", ")}. ` +
            `Call inspect_module (or module_context) for the real names — don't guess.`,
        };
      }

      let revised = state.scad;
      for (const e of parsed) {
        try {
          revised = replaceModuleDefinition(revised, e.name, e.newDef);
        } catch (err) {
          return {
            ok: false,
            error: `edit_modules aborted at '${e.name}': ${(err as Error).message}. ` +
              `Nothing was changed.`,
          };
        }
      }

      const safety = checkEditSafety(state.scad, revised, { tool: "edit_modules" });
      if (!safety.ok) return { ok: false, error: `${safety.error} Nothing was changed.` };

      // ── Land as pending ──────────────────────────────────────────────────
      const beforeLen = state.scad.length;
      const reason = typeof input["reason"] === "string" ? input["reason"] : "(no reason given)";
      const before = state.scad;
      state.scad = revised;
      beginPendingEdit(state, "edit_modules", before);

      const delta = revised.length - beforeLen;
      const sign = delta >= 0 ? "+" : "";
      return {
        ok: true,
        output: {
          text:
            `Edited ${parsed.length} module(s) atomically — PENDING: ` +
            `${parsed.map((e) => e.name).join(", ")}. Reason: ${reason}. ` +
            `SCAD now ${revised.length} chars (${sign}${delta}). ` +
            `Now compile + render_views to verify, then accept_edit or revert_edit.`,
          modules: parsed.map((e) => e.name),
          char_delta: delta,
        },
      };
    },
  };
}
