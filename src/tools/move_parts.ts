/**
 * move_parts tool — rigidly shift one or more groups of parts in world space.
 *
 * This is the surgical fix for a placement problem. The part-placement that
 * positions a limb lives in the assembly block (not inside a module), so
 * edit_module can't reach it and a full edit_full rewrite of a multi-thousand-
 * line file is risky. move_parts instead wraps each named part's placement in an
 * OUTERMOST translate(delta) — a pure world-space shift that preserves every
 * internal transform.
 *
 * MULTIPLE GROUPS, ONE EDIT. A symmetric fix needs opposite deltas: narrowing a
 * vehicle's track is left +16 AND right −16. With a single delta per call the
 * agent could only do half of it, which breaks symmetry and costs the next cycle
 * undoing the damage — observed on assault_buggy under BOTH GPT-5.6 and
 * gemini-3.1-pro, which burned 2 of 3 and 5 of 5 cycles respectively walking one
 * corner at a time. So `groups` lets one edit carry a different delta per group,
 * applied atomically.
 *
 * Counts as one edit (subject to the same fresh-diagnosis / edit-cap rules as
 * edit_module).
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { nudgeAssemblyPlacements } from "../scad/parts.ts";
import type { SessionProceduraState } from "./state.ts";
import { beginPendingEdit, pendingEditRefusal } from "./edit-transaction.ts";

/** More than this in one call and it isn't a targeted placement fix any more. */
const MAX_GROUPS = 6;

const DESCRIPTOR: ToolDescriptor = {
  name: "move_parts",
  description:
    "Rigidly translate parts in world space without changing their geometry — the " +
    "fix for a part that is the right shape but in the wrong place, and for an " +
    "UNREASONABLE collision from check_collisions. Pass `groups`: each group is a " +
    "set of parts plus ITS OWN delta, and every group is applied in ONE edit. Use " +
    "several groups whenever the fix is symmetric or opposed — narrowing a track is " +
    "left [+16,0,0] AND right [-16,0,0] in the SAME call; moving only one side " +
    "breaks symmetry and wastes the next cycle undoing it. Within a group pass EVERY " +
    "part of the rigid limb (upper_arm, elbow, forearm, hand) so it moves together " +
    "and stays connected. Keep deltas small. Then compile + check_connectivity " +
    "(still joined?) and check_collisions (clash cleared?). Requires a fresh " +
    "diagnose or check_collisions first (one edit per cycle). The legacy single " +
    "{parts, delta} form is still accepted for a one-group move.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["reason"],
    properties: {
      groups: {
        type: "array",
        minItems: 1,
        maxItems: MAX_GROUPS,
        description:
          "Rigid groups to move, each with its own delta. All applied together as " +
          "one edit. A module may appear in only one group.",
        items: {
          type: "object",
          required: ["parts", "delta"],
          properties: {
            parts: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description:
                "Top-level module names moving together (the whole rigid limb).",
            },
            delta: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
              description: "World-space translation [dx, dy, dz] in mm for THIS group.",
            },
          },
        },
      },
      parts: {
        type: "array",
        items: { type: "string" },
        description: "Legacy single-group form: module names (use `groups` instead).",
      },
      delta: {
        type: "array",
        items: { type: "number" },
        minItems: 3,
        maxItems: 3,
        description: "Legacy single-group form: [dx, dy, dz] in mm.",
      },
      reason: {
        type: "string",
        description: "One line: the reviewer issue this move resolves.",
      },
    },
  } satisfies JsonObject,
};

interface MoveGroup { parts: string[]; delta: [number, number, number] }

/** Parse either the `groups` form or the legacy `{parts, delta}` form. */
function parseGroups(input: Record<string, unknown>): MoveGroup[] | string {
  const raw = input["groups"];
  if (raw === undefined) {
    const parts = input["parts"];
    const delta = input["delta"];
    if (!Array.isArray(parts) || parts.length === 0) {
      return "move_parts requires `groups` (each {parts, delta}), or the legacy " +
        "`parts` + `delta` pair for a single group.";
    }
    const one = parseOne({ parts, delta }, "");
    return typeof one === "string" ? one : [one];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return "`groups` must be a non-empty array of {parts, delta} objects.";
  }
  if (raw.length > MAX_GROUPS) {
    return `move_parts takes at most ${MAX_GROUPS} groups per call (got ${raw.length}).`;
  }
  const out: MoveGroup[] = [];
  const seen = new Map<string, number>();
  for (const [i, g] of raw.entries()) {
    if (typeof g !== "object" || g === null) return `groups[${i}] must be a {parts, delta} object.`;
    const rec = g as Record<string, unknown>;
    const parsed = parseOne({ parts: rec["parts"], delta: rec["delta"] }, `groups[${i}]`);
    if (typeof parsed === "string") return parsed;
    for (const p of parsed.parts) {
      const prev = seen.get(p);
      if (prev !== undefined) {
        return `'${p}' appears in groups[${prev}] and groups[${i}] — a part can only ` +
          `move once per edit. Merge them, or give the part a single net delta.`;
      }
      seen.set(p, i);
    }
    out.push(parsed);
  }
  return out;
}

function parseOne(
  g: { parts: unknown; delta: unknown }, label: string,
): MoveGroup | string {
  const where = label ? `${label}.` : "";
  if (!Array.isArray(g.parts) || g.parts.length === 0) {
    return `${where}parts must be a non-empty array of module names.`;
  }
  const parts = (g.parts as unknown[]).map((x) => String(x));
  if (
    !Array.isArray(g.delta) || g.delta.length !== 3 ||
    (g.delta as unknown[]).some((n) => typeof n !== "number" || !Number.isFinite(n))
  ) {
    return `${where}delta must be [dx, dy, dz] — three finite numbers (mm).`;
  }
  const delta = g.delta as [number, number, number];
  if (delta.every((n) => n === 0)) {
    return `${where}delta is [0,0,0] — nothing to move. Drop the group or give it a real shift.`;
  }
  return { parts, delta };
}

/** Side a part name reads as, for the one-sided-move hint. */
function sideOf(name: string): "left" | "right" | null {
  const n = name.toLowerCase();
  if (/(^|_)l(eft)?(_|$)/.test(n)) return "left";
  if (/(^|_)r(ight)?(_|$)/.test(n)) return "right";
  return null;
}

export function makeMovePartsTool(state: SessionProceduraState): ToolExecutor {
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

      const pendingErr = pendingEditRefusal(state);
      if (pendingErr) return { ok: false, error: pendingErr };

      // Same cycle discipline as edit_module/edit_full: an edit must follow a
      // fresh diagnose OR check_collisions.
      if (!state.hasFreshDiagnosis) {
        return {
          ok: false,
          error:
            "No fresh diagnosis to act on. Run check_collisions (or diagnose) first, " +
            "then apply the fix it reports. One edit per cycle.",
        };
      }

      const parsed = parseGroups(input as Record<string, unknown>);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      const groups = parsed;
      const reason = typeof input["reason"] === "string" ? input["reason"] : "(no reason given)";

      // Apply every group to a scratch buffer — all of them land or none do, so
      // a bad group can't leave the model half-moved.
      let scratch = state.scad;
      const applied: { delta: [number, number, number]; moved: string[]; missing: string[] }[] = [];
      for (const [i, g] of groups.entries()) {
        let result;
        try {
          result = nudgeAssemblyPlacements(scratch, new Set(g.parts), g.delta);
        } catch (e) {
          return { ok: false, error: `move_parts failed on group ${i}: ${(e as Error).message}. Nothing was moved.` };
        }
        if (result.wrappedStatements === 0) {
          return {
            ok: false,
            error:
              `Group ${i}: none of [${g.parts.join(", ")}] are placed in the assembly, so ` +
              `nothing would move. Use the exact top-level module names (inspect_module / ` +
              `module_context). Nothing was moved.`,
          };
        }
        scratch = result.scad;
        applied.push({ delta: g.delta, moved: result.wrappedNames, missing: result.missing });
      }

      const before = state.scad;
      state.scad = scratch;
      beginPendingEdit(state, "move_parts", before);   // pending until accept_edit
      state.collisionCache = null;       // geometry moved — old scan is stale

      const lines = applied.map((a, i) => {
        const miss = a.missing.length ? ` (skipped, not placed: ${a.missing.join(", ")})` : "";
        return `  group ${i}: [${a.delta.join(", ")}] mm → ${a.moved.join(", ")}${miss}`;
      });

      // One-sided-move hint: a single group that touches only the left (or only
      // the right) of a mirrored pair is usually half of a symmetric fix. Advice
      // only — a genuinely one-sided move is legitimate.
      let hint = "";
      if (groups.length === 1 && groups[0]!.delta[0] !== 0) {
        const sides = new Set(groups[0]!.parts.map(sideOf).filter((s): s is "left" | "right" => s !== null));
        if (sides.size === 1) {
          const side = [...sides][0]!;
          const other = side === "left" ? "right" : "left";
          hint =
            `\nNOTE: every part in this move is a '${side}' part and the delta has an X ` +
            `component, so this shifts one side of a mirrored pair. If the reviewer asked ` +
            `for a symmetric change (track width, stance, shoulder spacing), the ${other} ` +
            `side needs the OPPOSITE delta in this same call — pass both as two groups. ` +
            `Verify symmetry in the next render before spending another cycle.`;
        }
      }

      const totalMoved = applied.reduce((n, a) => n + a.moved.length, 0);
      return {
        ok: true,
        output: {
          text:
            `Moved ${totalMoved} part(s) in ${applied.length} group(s). Reason: ${reason}.\n` +
            `${lines.join("\n")}\n` +
            `Run compile + check_connectivity (still joined to the body?) and ` +
            `check_collisions (clash cleared?).${hint}`,
          groups: applied.map((a) => ({ moved: a.moved, missing: a.missing, delta: a.delta })),
          moved: applied.flatMap((a) => a.moved),
        },
      };
    },
  };
}
