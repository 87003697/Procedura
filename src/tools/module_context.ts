/**
 * module_context tool — everything the agent needs to edit a module correctly,
 * including the parts it has to stay aligned with.
 *
 * A part is almost never wrong on its own. "The lens sits too low" is really
 * "the lens, the gate it feeds, the sprockets either side of it and the arm
 * roots share a datum, and that datum is too low". Editing the lens alone
 * detaches it from the cluster. So for each target this returns the target's
 * own definition plus its NEIGHBOURS, from two sources:
 *
 *   1. The plan's assembly graph — every part carries an `assembly` record
 *      ({partner, mate, fit, role, …}) written by the plan stage into
 *      parts_summary.json. Across the hard_surface_v2 batch 92% of parts
 *      declare a partner, so this is a real graph, not a heuristic. Read in
 *      both directions: what this part mounts to, and what mounts to it.
 *   2. Assembly placement proximity — the world-space origin of each part's
 *      `translate([x,y,z])` in the assembly block. Cheap (pure text, no
 *      compiles) and covers the parts the plan graph missed.
 *
 * Read-only: it never touches the buffer and never counts as an edit.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";

import { createHash } from "node:crypto";

import {
  findModuleSpans,
  extractModuleDefinition,
  extractAssemblyStatementsOf,
  compileModuleInAssembly,
} from "../scad/parts.ts";
import { loadSTL, computeBBox } from "../mesh/stl.ts";
import type { SessionProceduraState } from "./state.ts";

/** Default number of body lines shown per neighbour (targets show in full). */
const NEIGHBOUR_BODY_LINES = 12;
/** How many proximity neighbours to add beyond the declared graph. */
const NEAREST_K = 4;
const MAX_TARGETS = 8;

const DESCRIPTOR: ToolDescriptor = {
  name: "module_context",
  description:
    "Get edit-ready context for one or more modules: each target's full definition " +
    "and assembly placement, plus its NEIGHBOURS — the parts it mounts to, the parts " +
    "mounted to it, and the parts nearest it in world space — with their placements " +
    "and plan descriptions. Call this before edit_module/edit_modules whenever the " +
    "fix has to keep parts aligned with each other (shared datum, mating face, " +
    "symmetric pair), so you can move the whole group coherently instead of " +
    "detaching one part from its cluster.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["names"],
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_TARGETS,
        description: "Module name(s) to get context for (max 8).",
      },
      include_neighbour_bodies: {
        type: "boolean",
        description:
          `Include the first ${NEIGHBOUR_BODY_LINES} lines of each neighbour's body, ` +
          "not just its signature. Default true.",
      },
      with_measurements: {
        type: "boolean",
        description:
          "Compile each target and its neighbours at their true assembly placement " +
          "and report MEASURED world bboxes plus pairwise per-axis gap/overlap in mm " +
          "and %. Use this before any move_parts / scale_parts / multi-module edit: " +
          "derive deltas and anchors from these numbers arithmetically instead of " +
          "estimating from renders — show the arithmetic in your edit's reason. " +
          "Costs one small compile per module (cached per buffer). Default false.",
      },
    },
  } satisfies JsonObject,
};

// ── Measured world bboxes ──────────────────────────────────────────────────
// One compile per (buffer, module), cached — measurement calls repeat across a
// cycle and per-module compiles are the expensive part.

interface WorldBox { min: [number, number, number]; max: [number, number, number] }

const measureCache = new Map<string, WorldBox | null>();

async function measureWorldBox(
  scad: string, name: string, workDir: string,
): Promise<WorldBox | null> {
  const key = `${createHash("sha1").update(scad).digest("hex")}:${name}`;
  if (measureCache.has(key)) return measureCache.get(key)!;
  let box: WorldBox | null = null;
  try {
    const stl = await compileModuleInAssembly(scad, name, join(workDir, `_measure_${name}`));
    if (stl) {
      const bb = computeBBox(loadSTL(stl));
      box = { min: bb.min as [number, number, number], max: bb.max as [number, number, number] };
    }
  } catch { /* unmeasurable module → null */ }
  // Bound the cache so long sessions don't accumulate stale buffers.
  if (measureCache.size > 4096) measureCache.clear();
  measureCache.set(key, box);
  return box;
}

const mm = (n: number): string => Number(n.toFixed(1)).toString();

function fmtBox(b: WorldBox): string {
  const size = [0, 1, 2].map((a) => b.max[a]! - b.min[a]!);
  return `x[${mm(b.min[0])}..${mm(b.max[0])}] y[${mm(b.min[1])}..${mm(b.max[1])}] ` +
    `z[${mm(b.min[2])}..${mm(b.max[2])}]  size ${size.map(mm).join(" × ")} mm`;
}

/** Per-axis pairwise relation: positive overlap depth or negative gap. */
function fmtPair(aName: string, a: WorldBox, bName: string, b: WorldBox): string {
  const axes = ["x", "y", "z"] as const;
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const lo = Math.max(a.min[i]!, b.min[i]!);
    const hi = Math.min(a.max[i]!, b.max[i]!);
    const aLen = Math.max(1e-6, a.max[i]! - a.min[i]!);
    if (hi >= lo) {
      const depth = hi - lo;
      parts.push(`${axes[i]}: overlap ${mm(depth)}mm (${(depth / aLen * 100).toFixed(0)}% of ${aName})`);
    } else {
      parts.push(`${axes[i]}: GAP ${mm(lo - hi)}mm`);
    }
  }
  return `${aName} ↔ ${bName}:  ${parts.join("  |  ")}`;
}

interface PlanPart {
  name: string;
  description?: string;
  level?: string;
  assembly?: {
    partner?: string;
    mate?: string;
    fit?: string;
    role?: string;
    count?: number;
    fasten?: string;
  };
}

/** Load the plan's part records, if the draft stage left them on disk. */
function loadPlan(rootDir: string): PlanPart[] {
  const path = join(rootDir, "parts_summary.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { plan?: unknown };
    return Array.isArray(raw.plan) ? (raw.plan as PlanPart[]) : [];
  } catch {
    return [];
  }
}

/** World origin of a placement statement, from its leading translate([...]). */
function placementOrigin(statements: readonly string[]): [number, number, number] | null {
  for (const stmt of statements) {
    const m = /translate\s*\(\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/.exec(stmt);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

function firstLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return `${lines.slice(0, n).join("\n")}\n    … (${lines.length - n} more lines — read_scad for the rest)`;
}

function signatureOf(def: string): string {
  const brace = def.indexOf("{");
  return (brace === -1 ? def : def.slice(0, brace)).trim();
}

export function makeModuleContextTool(state: SessionProceduraState): ToolExecutor {
  // The plan is written once by the draft stage; cache it for the run.
  let planCache: PlanPart[] | null = null;

  return {
    descriptor: DESCRIPTOR,
    async execute(input) {
      state.step += 1;

      const rawNames = input["names"];
      if (!Array.isArray(rawNames) || rawNames.length === 0) {
        return { ok: false, error: "module_context requires a non-empty `names` array." };
      }
      if (rawNames.length > MAX_TARGETS) {
        return {
          ok: false,
          error: `module_context takes at most ${MAX_TARGETS} names per call (got ${rawNames.length}).`,
        };
      }
      const targets = rawNames.map((n) => String(n));
      const withBodies = input["include_neighbour_bodies"] !== false;
      const withMeasurements = input["with_measurements"] === true;

      const scad = state.scad;
      const defined = new Set(findModuleSpans(scad).map((s) => s.name));
      const unknown = targets.filter((n) => !defined.has(n));
      if (unknown.length === targets.length) {
        return {
          ok: false,
          error:
            `No such module(s): ${unknown.join(", ")}. Call inspect_module for the ` +
            `real names.`,
        };
      }

      planCache ??= loadPlan(state.workspace.rootDir);
      const plan = planCache;
      const planByName = new Map(plan.map((p) => [p.name, p]));

      // Placement statements + origins for every defined module (one pass).
      const placements = new Map<string, string[]>();
      const origins = new Map<string, [number, number, number]>();
      for (const name of defined) {
        const stmts = extractAssemblyStatementsOf(scad, name);
        if (stmts.length > 0) placements.set(name, stmts);
        const o = placementOrigin(stmts);
        if (o) origins.set(name, o);
      }

      const sections: string[] = [];
      for (const target of targets) {
        if (!defined.has(target)) {
          sections.push(`## ${target}\n(no such module — skipped)`);
          continue;
        }

        // ── Neighbours ───────────────────────────────────────────────────
        const neighbours = new Map<string, string[]>(); // name → why
        const note = (n: string, why: string): void => {
          if (n === target || !defined.has(n)) return;
          const cur = neighbours.get(n) ?? [];
          cur.push(why);
          neighbours.set(n, cur);
        };
        const own = planByName.get(target);
        if (own?.assembly?.partner) {
          note(own.assembly.partner,
            `this part mounts to it (${own.assembly.mate ?? "mate"}/${own.assembly.fit ?? "fit"})`);
        }
        for (const p of plan) {
          if (p.assembly?.partner === target) {
            note(p.name, `mounts onto this part (${p.assembly.mate ?? "mate"}/${p.assembly.fit ?? "fit"})`);
          }
        }
        const here = origins.get(target);
        if (here) {
          const ranked = [...origins.entries()]
            .filter(([n]) => n !== target)
            .map(([n, o]) => {
              const d = Math.hypot(o[0] - here[0], o[1] - here[1], o[2] - here[2]);
              return { n, d };
            })
            .sort((a, b) => a.d - b.d)
            .slice(0, NEAREST_K);
          for (const { n, d } of ranked) note(n, `placed ${d.toFixed(0)}mm away`);
        }

        // ── Render the section ───────────────────────────────────────────
        const def = extractModuleDefinition(scad, target) ?? "(definition not found)";
        const lines: string[] = [];
        lines.push(`## ${target}`);
        if (own?.description) lines.push(`plan: ${own.description}`);
        if (own?.assembly) {
          const a = own.assembly;
          const bits = [
            a.partner ? `partner=${a.partner}` : null,
            a.mate ? `mate=${a.mate}` : null,
            a.fit ? `fit=${a.fit}` : null,
            a.role ? `role=${a.role}` : null,
            a.count !== undefined ? `count=${a.count}` : null,
            a.fasten ? `fasten=${a.fasten}` : null,
          ].filter(Boolean);
          if (bits.length) lines.push(`assembly: ${bits.join("  ")}`);
        }
        const ownPlacement = placements.get(target);
        if (ownPlacement) {
          lines.push(`placement: ${ownPlacement.map((s) => s.replace(/\s+/g, " ").trim()).join("  |  ")}`);
        } else {
          lines.push(`placement: (not placed directly in the assembly — called from another module)`);
        }
        lines.push(`definition:\n${def}`);

        // Measured world geometry — the numbers deltas/anchors are derived from.
        if (withMeasurements) {
          const tBox = await measureWorldBox(scad, target, state.agentCompilesDir);
          if (tBox) {
            lines.push(`MEASURED world bbox:  ${fmtBox(tBox)}`);
            const pairLines: string[] = [];
            for (const n of [...neighbours.keys()].slice(0, 5)) {
              const nBox = await measureWorldBox(scad, n, state.agentCompilesDir);
              if (nBox) {
                pairLines.push(`  ${fmtPair(target, tBox, n, nBox)}`);
                pairLines.push(`    ${n}: ${fmtBox(nBox)}`);
              }
            }
            if (pairLines.length) {
              lines.push(`MEASURED relations (derive deltas/anchors from these):`);
              lines.push(...pairLines);
            }
          } else {
            lines.push(`MEASURED world bbox: (module failed to compile in isolation)`);
          }
        }

        if (neighbours.size === 0) {
          lines.push(`neighbours: (none found — no declared partner, no placement origin)`);
        } else {
          lines.push(`neighbours (${neighbours.size}):`);
          for (const [n, whys] of neighbours) {
            const np = planByName.get(n);
            const nplace = placements.get(n);
            lines.push(`- ${n} — ${[...new Set(whys)].join("; ")}`);
            if (np?.description) lines.push(`    plan: ${np.description}`);
            if (nplace) {
              lines.push(`    placement: ${nplace.map((s) => s.replace(/\s+/g, " ").trim()).join("  |  ")}`);
            }
            const ndef = extractModuleDefinition(scad, n);
            if (ndef) {
              lines.push(withBodies
                ? `    ${firstLines(ndef, NEIGHBOUR_BODY_LINES).split("\n").join("\n    ")}`
                : `    ${signatureOf(ndef)}`);
            }
          }
        }
        sections.push(lines.join("\n"));
      }

      const header = plan.length === 0
        ? "(no parts_summary.json — neighbours come from placement proximity only)\n\n"
        : "";
      return {
        ok: true,
        output: {
          text: header + sections.join("\n\n"),
          targets,
        },
      };
    },
  };
}
