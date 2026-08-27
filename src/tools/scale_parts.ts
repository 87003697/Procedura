/**
 * scale_parts tool — anchored rescale of one or more rigid groups.
 *
 * The missing lever for proportion-scale mismatches. The critic regularly says
 * things like "each leg chain is ~1.6× too long" or "the sensor head should be
 * twice this size" — and no prior tool could express that: edit_module rescales
 * one module's geometry but not the group's spacing, move_parts only
 * translates. scale_parts wraps each part's assembly placement in
 * `translate(anchor) scale(f) translate(-anchor)`, so a whole kinematic chain
 * shrinks/grows about a fixed world point (the hip, the mount face) — geometry
 * AND inter-part spacing together, staying connected at the anchor.
 *
 * Same transaction rules as every edit: lands PENDING, verify with compile +
 * render, then accept_edit / revert_edit.
 */

import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { scaleAssemblyPlacements } from "../scad/parts.ts";
import type { SessionProceduraState } from "./state.ts";
import { beginPendingEdit, pendingEditRefusal } from "./edit-transaction.ts";

const MAX_GROUPS = 4;
const FACTOR_MIN = 0.4;
const FACTOR_MAX = 2.5;

const DESCRIPTOR: ToolDescriptor = {
  name: "scale_parts",
  description:
    "Rescale one or more rigid groups about a fixed world anchor — the fix for " +
    "proportion issues that span a whole chain ('legs 40% too long', 'head half " +
    "the reference size'). Each group's parts are wrapped in an anchored scale, " +
    "so geometry AND spacing scale together and the group stays attached at the " +
    "anchor. Choose the anchor at the group's MOUNT (hip for a leg chain, mount " +
    "face for a head): that point stays fixed while everything scales toward or " +
    "away from it — get its coordinates from module_context with_measurements " +
    "first, never guess. Non-uniform factors (e.g. [1,1,0.7] to shorten legs) " +
    "are allowed but distort round features on the other axes; prefer uniform " +
    "when the issue is overall size. Symmetric pairs (left+right legs) share one " +
    "group when the anchor is on the mirror plane, or use two groups with " +
    "mirrored anchors. Lands PENDING like every edit: compile + render_views, " +
    "then accept_edit or revert_edit.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["groups", "reason"],
    properties: {
      groups: {
        type: "array",
        minItems: 1,
        maxItems: MAX_GROUPS,
        description: "Groups to rescale, applied atomically as ONE edit.",
        items: {
          type: "object",
          required: ["parts", "factor", "anchor"],
          properties: {
            parts: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "Top-level module names scaling together (the whole chain).",
            },
            factor: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
              description:
                `Per-axis scale [sx, sy, sz], each in [${FACTOR_MIN}, ${FACTOR_MAX}].`,
            },
            anchor: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
              description:
                "World-space fixed point [x, y, z] (mm) — the group's mount, from " +
                "measured bboxes.",
            },
          },
        },
      },
      reason: {
        type: "string",
        description:
          "One line: the measured mismatch this closes (cite the numbers).",
      },
    },
  } satisfies JsonObject,
};

interface ScaleGroup {
  parts: string[];
  factor: [number, number, number];
  anchor: [number, number, number];
}

function parseGroups(input: Record<string, unknown>): ScaleGroup[] | string {
  const raw = input["groups"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return "scale_parts requires a non-empty `groups` array of {parts, factor, anchor}.";
  }
  if (raw.length > MAX_GROUPS) {
    return `scale_parts takes at most ${MAX_GROUPS} groups per call (got ${raw.length}).`;
  }
  const out: ScaleGroup[] = [];
  const seen = new Map<string, number>();
  for (const [i, g] of raw.entries()) {
    if (typeof g !== "object" || g === null) return `groups[${i}] must be an object.`;
    const rec = g as Record<string, unknown>;
    const partsRaw = rec["parts"];
    if (!Array.isArray(partsRaw) || partsRaw.length === 0) {
      return `groups[${i}].parts must be a non-empty array of module names.`;
    }
    const parts = (partsRaw as unknown[]).map((x) => String(x));
    const num3 = (v: unknown, what: string): [number, number, number] | string =>
      Array.isArray(v) && v.length === 3 && (v as unknown[]).every((n) => typeof n === "number" && Number.isFinite(n))
        ? (v as [number, number, number])
        : `groups[${i}].${what} must be three finite numbers.`;
    const factor = num3(rec["factor"], "factor");
    if (typeof factor === "string") return factor;
    const anchor = num3(rec["anchor"], "anchor");
    if (typeof anchor === "string") return anchor;
    for (const f of factor) {
      if (f < FACTOR_MIN || f > FACTOR_MAX) {
        return `groups[${i}].factor component ${f} is outside [${FACTOR_MIN}, ${FACTOR_MAX}] — ` +
          `a change that large is a redesign, not a proportion fix.`;
      }
    }
    if (factor.every((f) => Math.abs(f - 1) < 1e-3)) {
      return `groups[${i}].factor is ~[1,1,1] — nothing to scale.`;
    }
    for (const p of parts) {
      const prev = seen.get(p);
      if (prev !== undefined) {
        return `'${p}' appears in groups[${prev}] and groups[${i}] — a part can only scale once per edit.`;
      }
      seen.set(p, i);
    }
    out.push({ parts, factor, anchor });
  }
  return out;
}

export function makeScalePartsTool(state: SessionProceduraState): ToolExecutor {
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
      if (!state.hasFreshDiagnosis) {
        return {
          ok: false,
          error:
            "No fresh diagnosis to act on. Call render_views, then diagnose, then " +
            "fix the single highest-severity issue it reports. One edit per " +
            "diagnose cycle — re-diagnose before the next edit.",
        };
      }

      const parsed = parseGroups(input as Record<string, unknown>);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      const reason = typeof input["reason"] === "string" ? input["reason"] : "(no reason given)";

      // Atomic: apply to a scratch buffer; any group matching nothing aborts all.
      let scratch = state.scad;
      const applied: { parts: string[]; factor: number[]; anchor: number[] }[] = [];
      for (const [i, g] of parsed.entries()) {
        let r;
        try {
          r = scaleAssemblyPlacements(scratch, new Set(g.parts), g.factor, g.anchor);
        } catch (e) {
          return { ok: false, error: `scale_parts failed on group ${i}: ${(e as Error).message}. Nothing was changed.` };
        }
        if (r.wrappedStatements === 0) {
          return {
            ok: false,
            error:
              `Group ${i}: none of [${g.parts.join(", ")}] are placed in the assembly. ` +
              `Use exact top-level names (inspect_module / module_context). Nothing was changed.`,
          };
        }
        scratch = r.scad;
        applied.push({ parts: r.wrappedNames, factor: [...g.factor], anchor: [...g.anchor] });
      }

      const before = state.scad;
      state.scad = scratch;
      beginPendingEdit(state, "scale_parts", before);
      state.collisionCache = null;

      const lines = applied.map((a, i) =>
        `  group ${i}: ×[${a.factor.join(", ")}] about [${a.anchor.join(", ")}] → ${a.parts.join(", ")}`);
      return {
        ok: true,
        output: {
          text:
            `Scaled ${applied.length} group(s) — PENDING. Reason: ${reason}.\n` +
            `${lines.join("\n")}\n` +
            `Now compile + render_views: check the group hits the measured target ` +
            `AND stayed attached at the anchor, then accept_edit or revert_edit.`,
          groups: applied,
        },
      };
    },
  };
}
