/**
 * Shared mutable state across all six Procedura tools for one run.
 *
 * The harness's ToolContext.state is per-session key/value, but tools that
 * coordinate (render then edit then compile then render) want a richer
 * shared structure. We close over a single `SessionProceduraState` instance
 * when registering each ToolExecutor.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { ProceduraWorkspace } from "../config/workspace.ts";
import type { CollisionResult } from "../mesh/collisions.ts";

/**
 * Refine-step state machine — drives the `_refine_steps/step_NN/` layout
 * and the --max-steps abort policy.
 *
 *   mode = "diagnose":
 *      collecting tool calls (render / read / inspect / check_connectivity)
 *      until an edit lands.
 *   on edit_module/edit_full success → mode = "verify", completedEdits++
 *   mode = "verify":
 *      compile / check_connectivity stay in the same step (post-edit verification)
 *      any other tool ⇒ leave verify mode, start NEXT step
 *
 * `refineStep` advances when the first non-verification tool fires after a verify
 * phase. The step's `scad.scad` snapshot is written at the moment the edit lands.
 */
export type RefineStepMode = "diagnose" | "verify";

export interface SessionProceduraState {
  workspace: ProceduraWorkspace;

  /** Current working SCAD source, mutated by edit_module / edit_full. */
  scad: string;

  /** The most recent `scad` that COMPILED cleanly. Seeded from the (valid)
   *  draft and updated on every successful compile. Fallback so a broken final
   *  edit (e.g. a dropped brace) never ships as final.scad. */
  lastGoodScad: string;

  /** Tool-call counter, incremented at the start of every tool's execute(). */
  step: number;

  /** Path of the latest compiled STL, if any. Used by render_views. */
  latestStlPath: string | null;

  /** Whether the latest STL on disk reflects `scad` (false → must recompile). */
  stlIsStale: boolean;

  /** Cached parts-colour legend (the colour-name table). */
  partsColorLegend: string | null;

  /** Sub-dirs we create under output_dir for per-step artifacts. */
  agentRendersDir: string;
  agentCompilesDir: string;
  trajectoryDir: string;
  /** Base dir for `_refine_steps/step_NNN/`. Honoured by both the refine-step
   *  saver and the diagnose tool so a focused per-part refine keeps its steps
   *  under its own subdir instead of colliding at the workspace root. */
  refineStepsDir: string;

  // ── Refine-step state machine (used by refine-step-saver) ─────────────
  /** Current refine step number (1-indexed). */
  refineStep: number;
  /** Sub-step counter within the current refine step. */
  refineSubStep: number;
  /** "diagnose" before an edit lands; "verify" right after. */
  refineStepMode: RefineStepMode;
  /** Number of successful edits so far (edit_module + edit_full). */
  completedEdits: number;
  /** Hard cap on completedEdits — set by refine.ts from opts.maxSteps. */
  maxRefineSteps: number;
  /** Set by the step saver once completedEdits hits maxRefineSteps. The edit
   *  tools then refuse, but the loop keeps running for a short verification
   *  tail so the LAST edit still gets a compile + connectivity check before the
   *  run ends. Previously the abort fired the instant the final edit landed,
   *  which shipped it unverified in 40 of 72 measured runs. */
  editBudgetExhausted: boolean;

  // ── Context → critic → fix cycle ──────────────────────────────────────
  /** View PNGs (label + path) from the most recent render_views call. The
   *  diagnose (critic) tool consumes these so it reviews the same renders the
   *  agent saw, without paying for a second Blender pass. */
  latestViews: { label: string; path: string }[];
  /** The exact SCAD source `latestViews` were rendered from. diagnose refuses
   *  to review when this differs from the current `scad` (views went stale
   *  after an edit) — the reviewer must always see the current geometry. */
  latestViewsScad: string | null;
  /** Per-cycle critic history — each prior diagnosis, threaded into the next
   *  diagnose call so the reviewer focuses on what's STILL wrong and can spot
   *  regressions instead of re-listing resolved issues. */
  diagnosisHistory: { cycle: number; summary: string; raw: string }[];
  /** True after a successful `diagnose`, false after an edit consumes it.
   *  edit_module/edit_full refuse when false — enforcing context → critic → fix
   *  (one edit per fresh diagnosis), which also stops multi-edit bursts.
   *  `check_collisions` also sets this so a collision fix (move_parts/edit_module)
   *  can follow it without a redundant vision diagnose. */
  hasFreshDiagnosis: boolean;

  // ── Mesh collision detection ──────────────────────────────────────────
  /** Scratch dir for per-part + intersection STLs used by check_collisions. */
  collisionsDir: string;
  /** Memoised collision analysis for the exact SCAD it was run on. Invalidated
   *  implicitly by comparing `scad` — any edit changes the buffer, so a stale
   *  entry is simply ignored. */
  collisionCache: { scad: string; result: CollisionResult; text: string } | null;
  /** finish(ok) refuses ONCE while unreasonable collisions remain, then flips
   *  this so a genuinely-intentional overlap can still be shipped on a re-call. */
  collisionGateWarned: boolean;

  /** Connectivity of the current buffer's compiled mesh. The critic reads this
   *  so floaters enter its ISSUES list: `diagnose` is vision-only and cannot see
   *  a 0.3mm gap, so without this a model can ship dozens of visible floaters
   *  while every diagnosis talks about proportions — which is exactly what
   *  mech_robot did (77 visible floaters, never raised). Maintained by
   *  `ensureConnectivity` (called from render_views — render always precedes
   *  diagnose, so every cycle is covered) and opportunistically by compile.
   *  v2 POST-MORTEM: the first wiring set this only on FULL compiles, but the
   *  agent works almost entirely through candidate dry-runs (00001198: 25/25
   *  compiles were candidates) — so the block never reached a single diagnose
   *  across three full runs. Hence the render-time hook. */
  latestConnectivity: {
    scad: string; summary: string; visibleFloaters: number;
    /** Visible floaters with REAL air gaps (>= MICRO_GAP_MM to any neighbour). */
    realFloaters: number;
    /** Visible-size shells within a hair of a neighbour — tolerated, snappable. */
    microFloaters: number;
  } | null;

  // ── Transactional edits (accept / amend / revert) ─────────────────────
  /** The in-flight edit: set when an edit tool lands, cleared by accept_edit /
   *  revert_edit. While set, further edits and diagnose refuse — the agent must
   *  verify (compile + render) and then judge its own edit. Only ACCEPTED edits
   *  consume the refine budget, so a wrong numeric guess costs an amend inside
   *  the cycle instead of two cycles (edit + next-cycle undo) — the failure
   *  that burned mech_robot twice (v1 AND v2: symmetric move, then exact
   *  inverse next cycle, net zero). */
  pendingEdit: { scadBefore: string; tool: string; landedAtStep: number } | null;
  /** revert_edit calls used so far. Bounded by maxRefineSteps so an agent
   *  can't dither forever between a move and its undo. */
  revertsUsed: number;
}

export function createSessionState(
  workspace: ProceduraWorkspace,
  opts?: {
    /** When set, per-run debug artifacts (renders + compiles) are nested under
     * `<rootDir>/<artifactsSubdir>/` instead of at the root. The incremental
     * draft stage uses this to keep each part's refine artifacts separate
     * (e.g. `_parts/03_left_arm/_agent_renders/`). The trajectory stays at the
     * root since it's shared across the whole run. */
    artifactsSubdir?: string;
  },
): SessionProceduraState {
  const initialScad = readFileSync(workspace.initialScadPath, "utf8");

  const artifactBase = opts?.artifactsSubdir
    ? join(workspace.rootDir, opts.artifactsSubdir)
    : workspace.rootDir;
  const agentRendersDir = join(artifactBase, "_agent_renders");
  const agentCompilesDir = join(artifactBase, "_agent_compiles");
  const refineStepsDir = join(artifactBase, "_refine_steps");
  const collisionsDir = join(artifactBase, "_collisions");
  const trajectoryDir = join(workspace.rootDir, "_trajectory");
  mkdirSync(agentRendersDir, { recursive: true });
  mkdirSync(agentCompilesDir, { recursive: true });
  mkdirSync(trajectoryDir, { recursive: true });

  return {
    workspace,
    scad: initialScad,
    lastGoodScad: initialScad,
    step: 0,
    latestStlPath: existsSync(workspace.initialStlPath) ? workspace.initialStlPath : null,
    stlIsStale: false,
    partsColorLegend: null,
    agentRendersDir,
    agentCompilesDir,
    refineStepsDir,
    trajectoryDir,
    refineStep: 1,
    refineSubStep: 0,
    refineStepMode: "diagnose",
    completedEdits: 0,
    maxRefineSteps: Infinity,    // refine.ts overrides this from opts.maxSteps
    editBudgetExhausted: false,
    latestViews: [],
    latestViewsScad: null,
    diagnosisHistory: [],
    hasFreshDiagnosis: false,
    collisionsDir,
    collisionCache: null,
    collisionGateWarned: false,
    latestConnectivity: null,
    pendingEdit: null,
    revertsUsed: 0,
  };
}

/** Persist the current working SCAD to a per-step sidecar (debug / replay). */
export function snapshotScad(state: SessionProceduraState, suffix: string): string {
  const path = join(state.agentCompilesDir, `step_${pad(state.step)}_${suffix}.scad`);
  writeFileSync(path, state.scad, "utf8");
  return path;
}

export function pad(n: number): string {
  return n.toString().padStart(3, "0");
}
