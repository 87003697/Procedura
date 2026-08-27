/**
 * Per-iteration disk writer for the refine stage.
 *
 *   1 refine step = 1 "diagnose → fix → verify" cycle, bounded by an edit.
 *
 * State machine (mirrored in SessionProceduraState):
 *
 *   refineStepMode = "diagnose":
 *       collecting tool calls (render / read / inspect / check_connectivity)
 *       until an edit_module / edit_full lands.
 *   on edit success → mode flips to "verify", `completedEdits++`
 *   refineStepMode = "verify":
 *       compile + check_connectivity stay in the SAME step (post-edit checks).
 *       Any other tool ⇒ leave verify mode, ADVANCE refineStep, reset substep.
 *
 * Layout per step:
 *
 *   _refine_steps/step_NNN/
 *       sub_001_render_views/   assistant.txt, thinking.txt,
 *                               tool_call.json, tool_result.txt
 *       sub_002_read_scad/
 *       sub_003_edit_module/    + scad.scad (post-edit snapshot)
 *       sub_004_compile/        + tool_result includes connectivity summary
 *       scad.scad               ← step's final SCAD (post-edit + post-verify)
 *       summary.json            ← {edits, tool_counts, started, ended}
 *
 * Abort policy:
 *   When `completedEdits >= maxRefineSteps`, fire the AbortController so the
 *   harness's runLoop breaks at the START of the next iteration. This means
 *   the final edit's verification compile (and an optional render after) can
 *   still complete — the loop only stops at the boundary between steps.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bus, StandardEvents } from "@harness/template/bus";
import type { SessionStore } from "@harness/template/storage";
import type { SessionProceduraState } from "../tools/state.ts";

const VERIFY_TOOLS = new Set([
  "compile", "check_connectivity", "render_views", "accept_edit", "revert_edit",
]);
const EDIT_TOOLS = new Set([
  "edit_module", "edit_modules", "edit_full", "move_parts", "scale_parts", "snap_floaters",
]);

/**
 * Tool calls allowed AFTER the edit budget is spent, so the last edit can still
 * be compiled and checked before the run ends. Enough for
 * compile → check_connectivity → finish.
 */
const VERIFY_TAIL_CALLS = 3;

export interface RefineStepSaverHandle {
  dispose(): Promise<void>;
  stepsDir: string;
  /** Number of step dirs created so far. */
  stepCount(): number;
  /** Number of sub-step dirs created so far. */
  subStepCount(): number;
}

interface StepAcc {
  startedAt: number;
  toolCounts: Record<string, number>;
  edits: { toolName: string; subStep: number }[];
}

export function subscribeRefineStepSaver(opts: {
  bus: Bus<StandardEvents & Record<string, unknown>>;
  store: SessionStore;
  state: SessionProceduraState;
  workspaceDir: string;
  sessionId: string;
  /** Aborts when state.completedEdits reaches state.maxRefineSteps. */
  abortController: AbortController;
  /** Override the `_refine_steps` directory location. The incremental draft
   * stage points this at a per-part subdir so each part's steps stay separate
   * instead of overwriting `step_001` on every part. */
  stepsDirOverride?: string;
  log?: (line: string) => void;
}): RefineStepSaverHandle {
  const stepsDir = opts.stepsDirOverride ?? join(opts.workspaceDir, "_refine_steps");
  mkdirSync(stepsDir, { recursive: true });
  const log = opts.log ?? (() => undefined);

  let totalSubSteps = 0;
  let currentStepAcc: StepAcc = {
    startedAt: Date.now(),
    toolCounts: {},
    edits: [],
  };

  let inFlight: Promise<void> = Promise.resolve();
  /** Tool calls spent in the post-budget verification tail. */
  let tailCalls = 0;

  const sub = opts.bus.on("tool.executed", (payload) => {
    const p = payload as { sessionId: string; toolCallId: string; toolName: string };
    if (p.sessionId !== opts.sessionId) return;

    // SYNCHRONOUS edit-cap check. Must run BEFORE the runLoop's next iteration
    // signal check (which is synchronous right after the bus.emit returns). If
    // we deferred this to the async snapshot work, the next iteration's LLM
    // call would already be in flight and the abort would surface as a fetch
    // error instead of a clean break.
    //
    // We do NOT abort the moment the budget is spent: that ends the run before
    // the model can compile what it just wrote, which shipped an unverified
    // final edit in 40 of 72 measured runs. Instead we close the edit tools
    // (they check state.editBudgetExhausted) and allow a short verification
    // tail, aborting when it runs out or when `finish` lands.
    // Order matters: once exhausted, EVERY further call spends the tail —
    // including refused edit attempts, so a model that keeps trying to edit
    // can't stall the run.
    //
    // With transactional edits the budget is consumed by accept_edit (edits land
    // as pending and only count when accepted), so the exhausted check watches
    // completedEdits on EVERY call rather than keying on the edit tools.
    if (opts.state.editBudgetExhausted) {
      tailCalls += 1;
      if (p.toolName === "finish" || tailCalls >= VERIFY_TAIL_CALLS) {
        log(`[refine-step-saver] verification tail done (${tailCalls} call(s), ` +
            `last=${p.toolName}); aborting`);
        opts.abortController.abort();
      }
    } else if (opts.state.completedEdits >= opts.state.maxRefineSteps) {
      opts.state.editBudgetExhausted = true;
      log(`[refine-step-saver] completedEdits=${opts.state.completedEdits} ` +
          `reached maxRefineSteps=${opts.state.maxRefineSteps}; edits closed, ` +
          `${VERIFY_TAIL_CALLS} verification call(s) remain`);
    }

    inFlight = inFlight.then(async () => {
      try { await handle(p); } catch (e) {
        log(`[refine-step-saver] failed: ${(e as Error).message}`);
      }
    });
  });

  async function handle(p: { toolCallId: string; toolName: string }): Promise<void> {
    const tool = p.toolName;
    const isVerify = VERIFY_TOOLS.has(tool);
    const isEdit = EDIT_TOOLS.has(tool);

    // STATE MACHINE: if we were verifying and this is NOT a verification tool,
    // close out the current step and advance to the next. `finish` is exempt:
    // it's terminal, and with the connectivity-gated finish(ok) a REFUSED finish
    // can fire mid-loop — advancing on it would spuriously inflate the step count
    // and drop a stray sub_NNN_finish dir. Snapshot it in the current step instead.
    if (opts.state.refineStepMode === "verify" && !isVerify && tool !== "finish") {
      await finalizeCurrentStep();
      opts.state.refineStep += 1;
      opts.state.refineSubStep = 0;
      opts.state.refineStepMode = "diagnose";
      currentStepAcc = {
        startedAt: Date.now(), toolCounts: {}, edits: [],
      };
    }

    // Allocate this tool's sub-step number.
    opts.state.refineSubStep += 1;
    totalSubSteps += 1;
    currentStepAcc.toolCounts[tool] = (currentStepAcc.toolCounts[tool] ?? 0) + 1;

    const stepDir = join(stepsDir, `step_${pad3(opts.state.refineStep)}`);
    const subDir = join(stepDir, `sub_${pad3(opts.state.refineSubStep)}_${tool}`);
    mkdirSync(subDir, { recursive: true });

    const resultIsError = await snapshotSubStep(subDir, p.toolCallId);

    // If this tool was a SUCCESSFUL edit, capture the post-edit SCAD inside its
    // sub-dir (the step's top-level scad.scad lands when the step finalises). A
    // rejected edit (e.g. no fresh diagnosis) must NOT advance the cycle or count.
    // The edit-cap abort is handled synchronously in the bus subscription above.
    if (isEdit && !resultIsError) {
      writeFileSync(join(subDir, "scad.scad"), opts.state.scad, "utf8");
      currentStepAcc.edits.push({
        toolName: tool, subStep: opts.state.refineSubStep,
      });
      opts.state.refineStepMode = "verify";
    }
  }

  async function snapshotSubStep(subDir: string, toolCallId: string): Promise<boolean> {
    const msgs = await opts.store.listMessages(opts.sessionId as never);
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return false;
    const parts = await opts.store.listParts(lastAssistant.id);

    const textChunks: string[] = [];
    const reasoningChunks: string[] = [];
    let toolCallPart: typeof parts[number] | undefined;
    let toolResultPart: typeof parts[number] | undefined;
    for (const part of parts) {
      if (part.kind === "text") {
        textChunks.push((part.data as { text?: string }).text ?? "");
      } else if (part.kind === "reasoning") {
        reasoningChunks.push((part.data as { text?: string }).text ?? "");
      } else if (part.kind === "tool-call") {
        const d = part.data as { toolCallId?: string };
        if (d.toolCallId === toolCallId) toolCallPart = part;
      } else if (part.kind === "tool-result") {
        const d = part.data as { toolCallId?: string };
        if (d.toolCallId === toolCallId) toolResultPart = part;
      }
    }

    const text = textChunks.join("");
    const reasoning = reasoningChunks.join("");
    if (text) writeFileSync(join(subDir, "assistant.txt"), text, "utf8");
    if (reasoning) writeFileSync(join(subDir, "thinking.txt"), reasoning, "utf8");
    if (toolCallPart) {
      writeFileSync(join(subDir, "tool_call.json"),
        JSON.stringify(toolCallPart.data, null, 2), "utf8");
    }
    let resultIsError = false;
    if (toolResultPart) {
      const d = toolResultPart.data as { output: unknown; isError?: boolean; attachments?: unknown[] };
      resultIsError = d.isError === true;
      const out = typeof d.output === "string" ? d.output : JSON.stringify(d.output, null, 2);
      const fname = d.isError ? "tool_result_ERROR.txt" : "tool_result.txt";
      writeFileSync(join(subDir, fname), out, "utf8");
      if (d.attachments && d.attachments.length > 0) {
        writeFileSync(
          join(subDir, "attachments_note.txt"),
          `${d.attachments.length} image attachment(s) — see ` +
          `_agent_renders/step_${pad3(opts.state.step)}/ for the PNG files.`,
          "utf8",
        );
      }
    }
    return resultIsError;
  }

  async function finalizeCurrentStep(): Promise<void> {
    const stepDir = join(stepsDir, `step_${pad3(opts.state.refineStep)}`);
    // Top-level scad.scad = the final SCAD of this step (post-edit, post-verify).
    writeFileSync(join(stepDir, "scad.scad"), opts.state.scad, "utf8");
    writeFileSync(join(stepDir, "summary.json"), JSON.stringify({
      step: opts.state.refineStep,
      sub_steps: opts.state.refineSubStep,
      tool_counts: currentStepAcc.toolCounts,
      edits: currentStepAcc.edits,
      completed_edits_so_far: opts.state.completedEdits,
      started_at: currentStepAcc.startedAt,
      ended_at: Date.now(),
      duration_ms: Date.now() - currentStepAcc.startedAt,
    }, null, 2), "utf8");
  }

  return {
    stepsDir,
    stepCount: () => opts.state.refineStep - (opts.state.refineSubStep === 0 ? 1 : 0),
    subStepCount: () => totalSubSteps,
    async dispose() {
      await inFlight;
      // Always finalise the in-progress step on shutdown so its summary +
      // final scad land on disk even if the run ended mid-cycle.
      try { await finalizeCurrentStep(); } catch { /* tolerate */ }
      await sub.dispose();
    },
  };
}

function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}
