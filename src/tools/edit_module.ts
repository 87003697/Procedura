/**
 * edit_module tool — surgical replacement of one top-level module's
 * full definition. Other modules and the assembly stay untouched.
 *
 * The new_def MUST be a complete `module <name>(...) { ... }` block
 * including the signature.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { replaceModuleDefinition } from "../scad/parts.ts";
import type { SessionProceduraState } from "./state.ts";
import { beginPendingEdit, pendingEditRefusal } from "./edit-transaction.ts";

const DESCRIPTOR: ToolDescriptor = {
  name: "edit_module",
  description:
    "Replace one top-level module's complete definition with new_def. Use this when " +
    "the issue is contained to a SINGLE module — the rest of the file (and the " +
    "assembly) stays intact. If the same fix spans several modules, use " +
    "edit_modules instead of making several passes. new_def must be a complete " +
    "`module <name>(...) { ... }` block starting with the keyword `module`. After " +
    "an edit_module call, run compile to verify the change parses.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["name", "new_def"],
    properties: {
      name: { type: "string", description: "Top-level module name to replace." },
      new_def: {
        type: "string",
        description:
          "Complete replacement module definition. Must start with `module <name>(...)`.",
      },
    },
  } satisfies JsonObject,
};

export function makeEditModuleTool(
  state: SessionProceduraState,
  opts?: {
    /** When set, the tool refuses to edit any module other than this one.
     * Used by the incremental draft stage's focused per-part refine so the
     * agent can only touch the part that was just added. */
    restrictTo?: string;
  },
): ToolExecutor {
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

      // Cycle discipline: every edit must be motivated by a fresh diagnosis
      // (context → critic → fix). Refuse if the reviewer hasn't run since the
      // last edit. This both keeps the critic in the loop and stops edit bursts.
      if (!state.hasFreshDiagnosis) {
        return {
          ok: false,
          error:
            "No fresh diagnosis to act on. Call render_views, then diagnose, then " +
            "fix the single highest-severity issue it reports. One edit per " +
            "diagnose cycle — re-diagnose before the next edit.",
        };
      }

      const name = input["name"] as string;
      const newDef = input["new_def"] as string;

      if (opts?.restrictTo && name !== opts.restrictTo) {
        return {
          ok: false,
          error:
            `Focused refine: you may only edit the module '${opts.restrictTo}' ` +
            `(the part just added). '${name}' is already finalized and frozen — ` +
            `leave it untouched and call finish once '${opts.restrictTo}' matches the reference.`,
        };
      }

      if (!newDef.trim().startsWith("module")) {
        return {
          ok: false,
          error: "new_def must start with the keyword `module` " +
            "(it needs to be the complete `module <name>(...) { ... }` block).",
        };
      }

      let revised: string;
      try {
        revised = replaceModuleDefinition(state.scad, name, newDef);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const charDelta = revised.length - state.scad.length;
      const before = state.scad;
      state.scad = revised;
      beginPendingEdit(state, "edit_module", before);   // pending until accept_edit

      const sign = charDelta >= 0 ? "+" : "";
      return {
        ok: true,
        output: {
          text:
            `Edited module '${name}' — PENDING. SCAD now ${revised.length} chars ` +
            `(${sign}${charDelta} from previous). Now compile, render_views to ` +
            `verify it landed as intended, then accept_edit or revert_edit.`,
          name,
          char_delta: charDelta,
        },
      };
    },
  };
}
