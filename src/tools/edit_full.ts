/**
 * edit_full tool — whole-file SCAD rewrite. Small models only.
 *
 * A whole-file rewrite is only honest when the model can actually re-emit the
 * file. Real drafts run 2.5k–15k lines (80 modules at the top end), and asked
 * to re-emit one of those an LLM writes a compact re-imagining instead: the
 * measured worst case turned a 171kB / 68-module projector into 7kB / 37
 * modules, keeping 1.9% of the facets, and it compiled. So this tool now
 * refuses above MAX_BUFFER_CHARS and points at the surgical alternatives, and
 * what it does accept still has to clear the relative safety guard.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";
import { checkEditSafety } from "./edit-guard.ts";
import type { SessionProceduraState } from "./state.ts";
import { beginPendingEdit, pendingEditRefusal } from "./edit-transaction.ts";

/**
 * Above this the file is too big to re-emit faithfully (~200 lines). Override
 * with PROCEDURA_EDIT_FULL_MAX_CHARS for experiments.
 */
const MAX_BUFFER_CHARS = Number(process.env["PROCEDURA_EDIT_FULL_MAX_CHARS"] ?? 8000);

const DESCRIPTOR: ToolDescriptor = {
  name: "edit_full",
  description:
    "Replace the ENTIRE SCAD buffer with new_scad. Only available for SMALL models " +
    `(under ${MAX_BUFFER_CHARS} chars) — above that it is refused, because re-emitting ` +
    "a multi-thousand-line file loses geometry. For everything else: edit_module " +
    "(one module), edit_modules (a group of modules), move_parts (rigid reposition).",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["new_scad", "reason"],
    properties: {
      new_scad: {
        type: "string",
        description: "Complete replacement SCAD source. Must be valid OpenSCAD.",
      },
      reason: {
        type: "string",
        description:
          "One-line justification for needing the full rewrite (cited back to the user).",
      },
      removed_modules: {
        type: "array",
        items: { type: "string" },
        description:
          "Modules you are deliberately DELETING in this rewrite. Any module that " +
          "disappears without being named here is treated as an accident and the " +
          "rewrite is rejected.",
      },
    },
  } satisfies JsonObject,
};

export function makeEditFullTool(state: SessionProceduraState): ToolExecutor {
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

      // Size gate. Refuse before we even look at the payload: on a large model
      // the right move is a targeted edit, not a rewrite.
      if (state.scad.length > MAX_BUFFER_CHARS) {
        return {
          ok: false,
          error:
            `edit_full is disabled for this model: the buffer is ${state.scad.length} ` +
            `chars (limit ${MAX_BUFFER_CHARS}). Rewriting a file this size loses ` +
            `geometry — you would be re-authoring it from memory, not editing it. ` +
            `Use edit_modules to replace just the modules the reviewer flagged ` +
            `(up to 8 at once, applied atomically), move_parts for a rigid ` +
            `reposition, or edit_module for a single part.`,
        };
      }

      // Cycle discipline: every edit must be motivated by a fresh diagnosis
      // (context → critic → fix). Refuse if the reviewer hasn't run since the
      // last edit.
      if (!state.hasFreshDiagnosis) {
        return {
          ok: false,
          error:
            "No fresh diagnosis to act on. Call render_views, then diagnose, then " +
            "apply the issues it reports. One edit per diagnose cycle — re-diagnose " +
            "before the next edit.",
        };
      }

      // Defensive: the model occasionally calls edit_full without the
      // required `new_scad` (or with it set to null / a non-string). Fail
      // gracefully so the loop continues instead of aborting the run.
      const newScadRaw = input["new_scad"];
      if (typeof newScadRaw !== "string" || newScadRaw.length === 0) {
        return {
          ok: false,
          error:
            "edit_full requires a non-empty string `new_scad` (the full replacement " +
            "SCAD source). Got " +
            (newScadRaw === undefined ? "undefined"
              : newScadRaw === null ? "null"
              : `${typeof newScadRaw} of length ${(newScadRaw as { length?: number }).length ?? "n/a"}`) +
            ". Re-call with the full SCAD source as a string, or use edit_module " +
            "for a targeted change.",
        };
      }
      const newScad = newScadRaw;
      const reason = typeof input["reason"] === "string" ? input["reason"] : "(no reason given)";

      if (newScad.length < 100) {
        return {
          ok: false,
          error: `new_scad is only ${newScad.length} chars — refusing to overwrite the ` +
            `working buffer (currently ${state.scad.length} chars) with something that small.`,
        };
      }

      // Relative guard: no part may vanish, no module definition may be dropped
      // undeclared, and the buffer may not collapse.
      const removedRaw = input["removed_modules"];
      const removed = Array.isArray(removedRaw) ? removedRaw.map((x) => String(x)) : [];
      const safety = checkEditSafety(state.scad, newScad, {
        tool: "edit_full",
        allowRemovals: removed,
      });
      if (!safety.ok) return { ok: false, error: `${safety.error} Nothing was changed.` };

      const before = state.scad;
      state.scad = newScad;
      beginPendingEdit(state, "edit_full", before);
      return {
        ok: true,
        output: {
          text: `SCAD buffer fully rewritten (${newScad.length} chars) — PENDING. ` +
            `Reason: ${reason}. Now compile + render_views to verify, then ` +
            `accept_edit or revert_edit.`,
          char_count: newScad.length,
        },
      };
    },
  };
}
