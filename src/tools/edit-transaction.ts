/**
 * Transactional edits — accept_edit / revert_edit plus the shared helpers the
 * edit tools use to participate.
 *
 * Why: the refine budget used to count ATTEMPTS. A fixer that guesses a wrong
 * magnitude discovers it one full cycle later (render → diagnose says
 * "regression" → undo), so one bad guess costs two of three cycles — mech_robot
 * did exactly this in BOTH guard runs (a clean symmetric move, then its exact
 * inverse; net zero). Now an edit lands as PENDING: the agent compiles and
 * re-renders, judges its own edit against the critic's stated target, and
 * either accepts (consumes budget) or reverts and amends (bounded, budget-free,
 * same diagnosis stays valid). The critic only ever reviews accepted states.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";
import type { SessionProceduraState } from "./state.ts";

/** Refusal text shared by every edit tool while an edit is pending. */
export function pendingEditRefusal(state: SessionProceduraState): string | null {
  if (!state.pendingEdit) return null;
  return (
    `A ${state.pendingEdit.tool} edit is already pending. Verify it (compile, ` +
    `then render_views and compare against the target), then call accept_edit ` +
    `to commit it or revert_edit to roll it back — one pending edit at a time.`
  );
}

/** Mark a successful edit as pending. Call AFTER mutating state.scad. */
export function beginPendingEdit(
  state: SessionProceduraState, tool: string, scadBefore: string,
): void {
  state.pendingEdit = { scadBefore, tool, landedAtStep: state.step };
  state.stlIsStale = true;
  state.hasFreshDiagnosis = false;   // consumed — the amend path restores it on revert
}

const ACCEPT_DESCRIPTOR: ToolDescriptor = {
  name: "accept_edit",
  description:
    "Commit the pending edit. Only call AFTER you have compiled it and re-rendered " +
    "to confirm it landed as intended (right direction, right magnitude, nothing " +
    "detached). Accepting consumes one edit cycle from the budget. If the render " +
    "shows the edit overshot, undershot, or broke something, call revert_edit " +
    "instead and re-apply a corrected version — reverts are budget-free.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["verified"],
    properties: {
      verified: {
        type: "string",
        description:
          "One line stating WHAT you checked in the post-edit render that confirms " +
          "the edit achieved the critic's target (cite the view).",
      },
    },
  } satisfies JsonObject,
};

const REVERT_DESCRIPTOR: ToolDescriptor = {
  name: "revert_edit",
  description:
    "Roll back the pending edit, restoring the buffer to its pre-edit state. " +
    "Budget-free and keeps the current diagnosis valid, so you can immediately " +
    "re-apply a corrected version of the SAME fix (better delta, fewer modules). " +
    "Bounded — don't dither between a move and its undo; measure (module_context " +
    "with_measurements) and get the arithmetic right instead.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["why"],
    properties: {
      why: {
        type: "string",
        description:
          "One line: what the render showed that was wrong (overshot / wrong " +
          "direction / detached X), and what the corrected attempt will change.",
      },
    },
  } satisfies JsonObject,
};

export function makeAcceptEditTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: ACCEPT_DESCRIPTOR,
    async execute(input) {
      state.step += 1;
      if (!state.pendingEdit) {
        return { ok: false, error: "No pending edit to accept. Make an edit first." };
      }
      if (state.stlIsStale) {
        return {
          ok: false,
          error:
            "The pending edit has not been compiled. Run compile (and ideally " +
            "render_views) first — never accept an edit you haven't seen build.",
        };
      }
      const tool = state.pendingEdit.tool;
      state.pendingEdit = null;
      state.completedEdits += 1;
      const remaining = Number.isFinite(state.maxRefineSteps)
        ? Math.max(0, state.maxRefineSteps - state.completedEdits)
        : null;
      const verified = typeof input["verified"] === "string" ? input["verified"] : "";
      return {
        ok: true,
        output: {
          text:
            `Edit accepted (${tool}). ${verified ? `Verified: ${verified}. ` : ""}` +
            (remaining !== null
              ? remaining > 0
                ? `${remaining} edit cycle(s) remain. Start the next cycle with render_views + diagnose.`
                : `Edit budget now spent — compile/check_connectivity if needed, then call finish.`
              : "Start the next cycle with render_views + diagnose."),
          remaining_edits: remaining,
        },
      };
    },
  };
}

export function makeRevertEditTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: REVERT_DESCRIPTOR,
    async execute(input) {
      state.step += 1;
      if (!state.pendingEdit) {
        return { ok: false, error: "No pending edit to revert." };
      }
      const revertCap = Number.isFinite(state.maxRefineSteps)
        ? Math.max(2, state.maxRefineSteps)
        : 3;
      if (state.revertsUsed >= revertCap) {
        return {
          ok: false,
          error:
            `Revert budget spent (${state.revertsUsed}/${revertCap}). Accept the ` +
            `pending edit if it is a net improvement, or accept and move on — ` +
            `stop oscillating between an edit and its undo.`,
        };
      }
      const tool = state.pendingEdit.tool;
      state.scad = state.pendingEdit.scadBefore;
      state.pendingEdit = null;
      state.stlIsStale = true;
      state.revertsUsed += 1;
      // The amend path: the diagnosis that motivated the edit is still valid.
      state.hasFreshDiagnosis = true;
      const why = typeof input["why"] === "string" ? input["why"] : "";
      return {
        ok: true,
        output: {
          text:
            `Reverted the pending ${tool} edit — buffer restored, no budget spent ` +
            `(${revertCap - state.revertsUsed} revert(s) left). ${why ? `Noted: ${why}. ` : ""}` +
            `The current diagnosis is still valid: measure first (module_context ` +
            `with_measurements), compute the corrected delta arithmetically, and ` +
            `re-apply ONE corrected edit.`,
          reverts_left: revertCap - state.revertsUsed,
        },
      };
    },
  };
}
