/**
 * finish tool — terminal. Records the agent's verdict + summary and signals
 * the run loop to break. After the tool returns, the next assistant turn has
 * nothing to do (no pending tool calls), so the stop check in agent.runLoop
 * fires.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";
import type { SessionProceduraState } from "./state.ts";
import { compileScad } from "../scad/compile.ts";
import { evaluateConnectivityGate } from "../mesh/connectivity.ts";
import { ensureConnectivity } from "./connectivity-cache.ts";
import { attributeFloaters, formatAttribution } from "../mesh/floater-attribution.ts";
import { runCollisionAnalysis } from "./collision-check.ts";

const DESCRIPTOR: ToolDescriptor = {
  name: "finish",
  description:
    "Terminal tool — call this when you're done. Either verdict='ok' (the SCAD " +
    "matches the reference well enough to ship) or verdict='give_up' (you can't " +
    "improve it further). Always include a short summary of what you changed " +
    "(or what's still wrong, if giving up). verdict='ok' is gated: it is refused " +
    "while any part visibly floats, and held once while unreasonable collisions " +
    "remain (run check_collisions + move_parts first). give_up is never gated.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    required: ["verdict", "summary"],
    properties: {
      verdict: {
        type: "string",
        enum: ["ok", "give_up"],
        description: "ok = ship; give_up = stop iterating, current buffer is final.",
      },
      summary: {
        type: "string",
        description:
          "1-3 sentences describing the changes you made (or, on give_up, the issues " +
          "you couldn't resolve).",
      },
    },
  } satisfies JsonObject,
};

export interface FinishSignal {
  verdict: "ok" | "give_up";
  summary: string;
  finalScad: string;
}

export function makeFinishTool(
  state: SessionProceduraState,
  onFinish: (signal: FinishSignal) => void,
): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute(input) {
      const verdict = input["verdict"] as "ok" | "give_up";
      const summary = input["summary"] as string;

      // GATE: refuse verdict="ok" while visibly-sized parts float. We check the
      // mesh that actually ships — a fresh compile of the current SCAD (or the
      // latest compile if it already reflects the current SCAD). give_up is the
      // explicit escape hatch and is never gated.
      if (verdict === "ok") {
        let stlPath: string;
        try {
          if (!state.stlIsStale && state.latestStlPath) {
            stlPath = state.latestStlPath;
          } else {
            const dir = join(state.agentCompilesDir, "finish_check");
            mkdirSync(dir, { recursive: true });
            const r = await compileScad(state.scad, { outputDir: dir });
            stlPath = r.stlPath;
            // This compile reflects the current SCAD — record it so a later
            // compile/check doesn't have to redo the work.
            state.latestStlPath = stlPath;
            state.stlIsStale = false;
          }
        } catch (e) {
          return {
            ok: false,
            error:
              `Cannot finish(ok): the current SCAD failed to compile ` +
              `(${(e as Error).message}). The shipped build would fail too — fix ` +
              `the SCAD and recompile, or call finish(verdict="give_up") with an ` +
              `explanation.`,
          };
        }

        let gate;
        let conn;
        try {
          // TRUE connectivity via the per-buffer cache (union-wrapped compile) —
          // gating on the lazy-union artifact would refuse ok for every
          // properly-overlapping part. `stlPath` above is still what ships.
          const entry = await ensureConnectivity(state);
          conn = entry?.conn;
          gate = conn ? evaluateConnectivityGate(conn) : null;
        } catch {
          gate = null; // analysis failure must not wedge the run — let ok through
        }

        if (gate && !gate.ok) {
          // Name the module behind each visible floater so the fix targets the
          // real offender, not a strut bolted on to satisfy the gate.
          let modLines = "";
          try {
            if (conn) {
              const attrs = await attributeFloaters(
                state.scad, conn, join(state.agentCompilesDir, "finish_floater_attr"),
              );
              modLines = formatAttribution(attrs);
            }
          } catch { /* advisory only */ }
          return {
            ok: false,
            error:
              `finish(ok) refused — the shipped mesh still has ${gate.detail}${modLines}\n\n` +
              `A floater "spanning N% of the model" is a detached chunk of geometry, ` +
              `not a sliver: it will read as a separate part in the render. Every ` +
              `part must connect to the body — RE-PLACE the named module so it ` +
              `overlaps its neighbour by ≥ 0.5 mm (fixing the real geometry beats ` +
              `bolting on a thin strut). Fix the largest offender with ` +
              `edit_module, recompile, and call finish again.\nIf the separation ` +
              `is intentional (the reference truly shows detached pieces) or you ` +
              `genuinely cannot connect them, call finish(verdict="give_up") and ` +
              `say so in the summary.`,
          };
        }

        // GATE 2: hold finish(ok) ONCE while unreasonable collisions remain, so
        // the agent is forced to look at (and usually fix) parts passing through
        // each other — a defect diagnose can't see. Overridable: after warning
        // once, a genuinely-intentional overlap can still ship on a re-call.
        if (!state.collisionGateWarned) {
          try {
            const { result, text } = await runCollisionAnalysis(state);
            if (result.unreasonable.length > 0) {
              state.collisionGateWarned = true;
              return {
                ok: false,
                error:
                  `finish(ok) held once — the geometry has ` +
                  `${result.unreasonable.length} UNREASONABLE collision(s): parts that ` +
                  `are not structurally connected yet pass through each other. These ` +
                  `are invisible in the renders (buried inside the solid), so the ` +
                  `vision diagnosis missed them.\n\n${text}\n\n` +
                  `Fix each with move_parts (shift the whole limb clear), then ` +
                  `re-run check_collisions + compile. If a listed overlap is actually ` +
                  `intentional (or genuinely unavoidable), call finish(verdict="ok") ` +
                  `again and it will ship.`,
              };
            }
          } catch {
            /* collision analysis failure must not wedge the run — let ok through */
          }
        }
      }

      onFinish({ verdict, summary, finalScad: state.scad });
      return {
        ok: true,
        output: {
          text: `Acknowledged. verdict=${verdict}. The harness will write outputs now.`,
          verdict, summary,
        },
      };
    },
  };
}
