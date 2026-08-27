/**
 * render_views tool — render the current working SCAD as N PNG views and
 * attach them to the tool result so the model sees them on the next turn.
 *
 * Pipeline per call:
 *   1. If `stlIsStale`, compile state.scad → STL into _agent_compiles/.
 *   2. Invoke the renderer for the chosen mode: renderPartsColorViews (lit
 *      colour parts, the default), renderAOColorViews (AO shading × per-part
 *      colour), renderAOViews (grey AO) — 'both' stacks AO + parts-colour.
 *   3. Return text summary + every PNG path as attachment.
 *
 * All work is in-process via src/scad/* and src/render/* — no subprocess
 * shells out to a separate CLI.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { JsonObject } from "@harness/template/types";
import type { ToolExecutor, ToolDescriptor } from "@harness/template/tool";
import type { ImageAttachment } from "@harness/template/llm/protocol";

import { compileScad } from "../scad/compile.ts";
import { renderAOViews } from "../render/ao.ts";
import { renderAOColorViews } from "../render/ao_color.ts";
import { renderPartsColorViews } from "../render/parts_color.ts";
import { resolveViews, viewMenuText, ALL_VIEW_NAMES } from "../render/views.ts";
import type { SessionProceduraState } from "./state.ts";
import { pad } from "./state.ts";
import { ensureConnectivity } from "./connectivity-cache.ts";

export type RenderMode = "ao-color" | "ao" | "parts-color" | "both";

// Feedback-render resolution shown to the refine agent. DEFAULT 1024 (in sync
// with the draft build-views so every feedback image the model sees sits at one
// resolution); override with PROCEDURA_FEEDBACK_RENDER_SIZE (0 → the old 640).
const FEEDBACK_RENDER_SIZE = Number(process.env["PROCEDURA_FEEDBACK_RENDER_SIZE"] ?? "1024") || 640;

const DESCRIPTOR: ToolDescriptor = {
  name: "render_views",
  description:
    "Render the current SCAD as PNG views so you can see what the geometry " +
    "actually looks like, then compare against the reference image.\n\n" +
    "YOU decide which views and how many. Pass `views` as a list of names from " +
    "the catalog below (any 1–" + ALL_VIEW_NAMES.length + "). Start with a broad " +
    "spread to survey the model (e.g. the hero iso + a few faces + an underside), " +
    "then re-render a focused subset to zoom in on a specific problem. Omit " +
    "`views` to get the default 4 (isometric, front, right, top).\n\n" +
    "View catalog:\n" + viewMenuText() + "\n\n" +
    "Modes: 'parts-color' = flat colour parts under a soft lighting rig (each " +
    "top-level module a distinct colour) plus a legend — this is the default and " +
    "best for most reviewing (clear part segmentation). 'ao-color' = matte " +
    "ambient-occlusion shading with each module tinted its colour, plus edges and " +
    "a legend — form (crevice/contact shading & clean silhouette) AND part " +
    "segmentation in one image. 'ao' = the same AO+edges look but uniform grey " +
    "(no colour). 'both' = the 'ao' and 'parts-color' sets stacked. " +
    "Re-rendering the SAME views with no edit in between returns identical images, " +
    "but switching to a DIFFERENT view selection to inspect something is fine.",
  owner: { kind: "core" },
  inputSchema: {
    type: "object",
    properties: {
      views: {
        type: "array",
        items: { type: "string", enum: [...ALL_VIEW_NAMES] },
        uniqueItems: true,
        maxItems: ALL_VIEW_NAMES.length,
        description:
          "Named camera angles to render (1–" + ALL_VIEW_NAMES.length + "), " +
          "chosen deliberately for what you need to inspect. Omit for the default " +
          "set: isometric, front, right, top.",
      },
      mode: {
        type: "string",
        enum: ["ao-color", "ao", "parts-color", "both"],
        description: "Which view set(s) to render. Default 'parts-color'.",
      },
    },
  } satisfies JsonObject,
};

export function makeRenderViewsTool(state: SessionProceduraState): ToolExecutor {
  return {
    descriptor: DESCRIPTOR,
    async execute(input) {
      const mode = ((input["mode"] as string | undefined) ?? "parts-color") as RenderMode;

      // The model multi-selects which views it wants; resolveViews trims,
      // dedupes, orders, and falls back to the default 4 if none are valid.
      // Accept either an array (the schema) or a comma-string (models sometimes
      // send that); resolveViews trims each token either way.
      const rawViews = input["views"];
      const requestedViews = Array.isArray(rawViews)
        ? (rawViews as unknown[]).map((x) => String(x))
        : typeof rawViews === "string"
          ? rawViews.split(",")
          : undefined;
      const { views, unknown } = resolveViews(requestedViews);

      state.step += 1;
      const stepDir = join(state.agentRendersDir, `step_${pad(state.step)}`);
      mkdirSync(stepDir, { recursive: true });

      // 1. Compile if stale (or if we've never compiled here).
      if (state.stlIsStale || state.latestStlPath === null) {
        const compileDir = join(state.agentCompilesDir, `step_${pad(state.step)}_render`);
        mkdirSync(compileDir, { recursive: true });
        try {
          const r = await compileScad(state.scad, { outputDir: compileDir });
          state.latestStlPath = r.stlPath;
          state.stlIsStale = false;
        } catch (e) {
          return {
            ok: false,
            error: `Compile failed before render: ${(e as Error).message}. ` +
              `Use edit_module (or edit_modules) to fix the syntax error first.`,
          };
        }
      }

      // Refresh the TRUE-connectivity cache for THIS buffer (union-wrapped
      // compile — the render/artifact STLs are lazy-union shell dumps and must
      // never be used for connectivity; see connectivity-cache.ts). render
      // always precedes diagnose, so hooking here guarantees the critic gets
      // real floater data every cycle. Memoized per buffer state.
      await ensureConnectivity(state);

      const attachments: ImageAttachment[] = [];
      const lines: string[] = [];
      // Cache the rendered view paths for the diagnose (critic) tool so it
      // reviews the same images without a second Blender pass.
      state.latestViews = [];

      // 2. AO views.
      if (mode === "ao" || mode === "both") {
        const aoDir = join(stepDir, "ao");
        mkdirSync(aoDir, { recursive: true });
        const r = await renderAOViews({
          stlPath: state.latestStlPath!,
          outDir: aoDir,
          views,
          size: FEEDBACK_RENDER_SIZE, samples: 32, aoSamples: 8,
          // Render-time decimation: keeps 9-14M-tri models inside the Blender
          // timeout (the un-decimated path SIGTERMs at 600s — exit 143).
          decimateAbove: 2_000_000,
        });
        if (!r.ok) {
          return { ok: false, error: `AO render failed: ${r.error}` };
        }
        for (const v of r.views) {
          attachments.push({
            kind: "image",
            data: readFileSync(v.path).toString("base64"),
            mimeType: "image/png",
            label: `AO ${v.view} (step ${state.step})`,
          });
          lines.push(`  AO ${v.view}: ${v.path} (${v.sizeKb} KB)`);
          state.latestViews.push({ label: `CURRENT — AO ${v.view}`, path: v.path });
        }
      }

      // 2b. Colour-AO views — AO shading × per-part colour, one pass. The
      // renderer splits the SCAD into parts, so it needs the source on disk.
      if (mode === "ao-color") {
        const acDir = join(stepDir, "ao_color");
        mkdirSync(acDir, { recursive: true });
        const scadPath = join(acDir, "input.scad");
        writeFileSync(scadPath, state.scad, "utf8");
        const r = await renderAOColorViews({
          scadPath, outDir: acDir, views, size: FEEDBACK_RENDER_SIZE, samples: 32,
        });
        if (!r.ok) {
          return { ok: false, error: `colour-AO render failed: ${r.error}` };
        }
        state.partsColorLegend = r.legend;
        for (const v of r.views) {
          attachments.push({
            kind: "image",
            data: readFileSync(v.path).toString("base64"),
            mimeType: "image/png",
            label: `AO+colour ${v.view} (step ${state.step})`,
          });
          lines.push(`  AO+colour ${v.view}: ${v.path} (${v.sizeKb} KB)`);
          state.latestViews.push({ label: `CURRENT — AO+colour ${v.view}`, path: v.path });
        }
      }

      // 3. Parts-colour views. The renderer expects a SCAD path on disk;
      // we write our working buffer into the per-step dir then point at it.
      if (mode === "parts-color" || mode === "both") {
        const pcDir = join(stepDir, "parts_color");
        mkdirSync(pcDir, { recursive: true });
        const scadPath = join(pcDir, "input.scad");
        writeFileSync(scadPath, state.scad, "utf8");
        const r = await renderPartsColorViews({
          scadPath, outDir: pcDir, views, size: FEEDBACK_RENDER_SIZE, samples: 32,
        });
        if (!r.ok) {
          return { ok: false, error: `parts-colour render failed: ${r.error}` };
        }
        state.partsColorLegend = r.legend;
        for (const v of r.views) {
          attachments.push({
            kind: "image",
            data: readFileSync(v.path).toString("base64"),
            mimeType: "image/png",
            label: `parts-colour ${v.view} (step ${state.step})`,
          });
          lines.push(`  parts-colour ${v.view}: ${v.path} (${v.sizeKb} KB)`);
          state.latestViews.push({ label: `CURRENT — parts-colour ${v.view}`, path: v.path });
        }
      }

      const legend = state.partsColorLegend
        ? `\nColour legend (module → RGB):\n${state.partsColorLegend.trim()}\n`
        : "";

      const warn = unknown.length > 0
        ? `\n⚠ Ignored unknown view name(s): ${unknown.join(", ")}. ` +
          `Valid views: ${ALL_VIEW_NAMES.join(", ")}.`
        : "";

      const summary =
        `Rendered ${attachments.length} view(s) [${views.join(", ")}] of the ` +
        `current SCAD (step ${state.step}):\n` +
        lines.join("\n") + legend + warn +
        `\nCompare these to the reference image. Cite specific modules when you find issues.`;

      // Record which SCAD these views correspond to, so diagnose can detect
      // when an edit has invalidated them.
      state.latestViewsScad = state.scad;

      return {
        ok: true,
        output: { text: summary, step: state.step, n_views: attachments.length },
        attachments,
      };
    },
  };
}
