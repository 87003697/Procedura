import { useMemo, useState } from "react";
import {
  CubeIcon as Cube,
  PaletteIcon as Palette,
  PencilSimpleLineIcon as PencilSimpleLine,
  SparkleIcon as Sparkle,
} from "@phosphor-icons/react";

import type {
  CompileStep,
  RefineStep,
  RenderStep,
  RunDetail,
  SubStep,
} from "../../../shared/types.ts";
import { MeshViewer } from "../MeshViewer.tsx";
import { ScadPanel } from "../ScadPanel.tsx";
import { ViewGallery } from "../images.tsx";
import { TextBlock } from "../TextBlock.tsx";
import { Chip, Empty, Segmented, cx } from "../ui.tsx";
import { toolMeta, tintBg } from "../../lib/meta.tsx";
import { fmtDuration } from "../../lib/format.ts";

type RenderMode = "parts" | "ao";
type DetailMode = "transcript" | "scad" | "mesh";

/** Pick the compile step whose index is closest to (and >=) the render step. */
function nearestCompile(compiles: CompileStep[], renderStep: number): CompileStep | null {
  const after = compiles.filter((c) => c.step >= renderStep).sort((a, b) => a.step - b.step);
  if (after.length) return after[0]!;
  const before = compiles.filter((c) => c.step < renderStep).sort((a, b) => b.step - a.step);
  return before[0] ?? null;
}

export function RefineStageLegacy({ run }: { run: RunDetail }) {
  const renderSteps = run.renderSteps;
  const hasRender = renderSteps.length > 0;
  const hasRefine = run.refineSteps.length > 0;

  const [idx, setIdx] = useState(0);
  const [renderMode, setRenderMode] = useState<RenderMode>("parts");
  const [detail, setDetail] = useState<DetailMode>("transcript");

  if (!hasRender && !hasRefine) {
    return (
      <Empty icon={<Sparkle size={30} />} title="No refine activity">
        This run has no <span className="font-mono text-muted">_agent_renders</span> or{" "}
        <span className="font-mono text-muted">_refine_steps</span>. It may be a draft-only run, or
        refine produced no per-step snapshots. The full event order is still on the Trajectory tab.
      </Empty>
    );
  }

  const safeIdx = Math.min(idx, Math.max(0, renderSteps.length - 1));
  const step: RenderStep | undefined = renderSteps[safeIdx];
  const compile = step ? nearestCompile(run.compileSteps, step.step) : null;

  // Match a _refine_steps entry to this render step by proximity of step index.
  const refineForStep: RefineStep | null = useMemo(() => {
    const s = step;
    if (!s || !run.refineSteps.length) return null;
    return (
      [...run.refineSteps].sort(
        (a, b) => Math.abs(a.step - s.step) - Math.abs(b.step - s.step),
      )[0] ?? null
    );
  }, [step, run.refineSteps]);

  const partsViews = step?.partsColor ?? [];
  const aoViews = step?.ao ?? [];
  const chosen = renderMode === "parts" ? partsViews : aoViews;
  const renderViews = chosen.length ? chosen : partsViews.length ? partsViews : aoViews;

  return (
    <div className="flex h-full flex-col">
      {/* step scrubber */}
      {hasRender && (
        <StepScrubber
          steps={renderSteps}
          active={safeIdx}
          onSelect={setIdx}
          refineSteps={run.refineSteps}
        />
      )}

      <div className="grid min-h-0 flex-1 grid-rows-2 gap-3 p-4 lg:grid-cols-2 lg:grid-rows-1">
        {/* left: renders the agent saw */}
        <div className="flex min-h-0 flex-col gap-2 rounded-lg border border-line bg-panel p-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <Segmented
              size="sm"
              value={renderMode}
              onChange={setRenderMode}
              options={[
                { value: "parts", label: <span className="flex items-center gap-1"><Palette size={12} /> parts</span>, disabled: !step?.partsColor.length },
                { value: "ao", label: <span className="flex items-center gap-1"><Cube size={12} /> AO</span>, disabled: !step?.ao.length },
              ]}
            />
            {step && <span className="font-mono text-[11px] text-faint">render step {step.step}</span>}
          </div>
          <ViewGallery views={renderViews} alt={`refine step ${step?.step ?? ""}`} className="min-h-0 flex-1" />
          {renderMode === "parts" && step?.legend && step.legend.length > 0 && (
            <PartsLegend legend={step.legend} />
          )}
        </div>

        {/* right: per-step detail */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Segmented
              size="sm"
              value={detail}
              onChange={(v) => setDetail(v as DetailMode)}
              options={[
                { value: "transcript", label: "agent" },
                { value: "scad", label: "scad" },
                { value: "mesh", label: "mesh" },
              ]}
            />
            {compile?.summary && <CompileChips summary={compile.summary} />}
          </div>
          <div className="min-h-0 flex-1">
            {detail === "transcript" &&
              (refineForStep ? (
                <Transcript step={refineForStep} />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-faint">
                  No <span className="mx-1 font-mono">_refine_steps</span> transcript for this run.
                  See the Trajectory tab for the event order.
                </div>
              ))}
            {detail === "scad" && (
              <ScadPanel
                path={refineForStep?.finalScadPath ?? compile?.scadPath ?? null}
                className="h-full"
              />
            )}
            {detail === "mesh" && (
              <MeshViewer path={compile?.stlPath ?? null} className="h-full rounded-none" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepScrubber({
  steps,
  active,
  onSelect,
  refineSteps,
}: {
  steps: RenderStep[];
  active: number;
  onSelect: (i: number) => void;
  refineSteps: RefineStep[];
}) {
  const editedSteps = new Set(refineSteps.filter((r) => r.summary?.edits?.length).map((r) => r.step));
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">
        steps
      </span>
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto pb-1">
        {steps.map((s, i) => {
          const isActive = i === active;
          const edited = editedSteps.has(s.step);
          return (
            <button
              key={s.step}
              onClick={() => onSelect(i)}
              title={`render step ${s.step}${edited ? " · had an edit" : ""}`}
              className={cx(
                "flex h-7 min-w-[2.4rem] shrink-0 items-center justify-center gap-1 rounded-md border px-2 font-mono text-[11px] transition-colors",
                isActive
                  ? "border-accent-dim bg-accent/15 text-accent"
                  : "border-line bg-bg text-muted hover:border-line-strong hover:text-ink",
              )}
            >
              {edited && <PencilSimpleLine size={11} />}
              {s.step}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PartsLegend({ legend }: { legend: NonNullable<RenderStep["legend"]> }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5 rounded-md border border-line bg-bg/50 px-3 py-2">
      {legend.map((p) => (
        <span key={p.module} className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
          <span
            className="inline-block size-2.5 rounded-[3px] ring-1 ring-inset ring-black/20"
            style={{
              // rgb is normalized 0..1; tolerate a stray 0..255 source too.
              background: `rgb(${p.rgb.map((c) => Math.round(c <= 1 ? c * 255 : c)).join(",")})`,
            }}
          />
          {p.module}
        </span>
      ))}
    </div>
  );
}

function CompileChips({ summary }: { summary: Record<string, unknown> }) {
  const geom = (summary["geometry"] ?? summary) as Record<string, unknown>;
  const facets = num(geom["facets"] ?? geom["triangles"]);
  const bbox = geom["bounding_box"] ?? geom["bbox"];
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {facets != null && (
        <Chip tint="muted" className="font-mono">
          {facets.toLocaleString()} facets
        </Chip>
      )}
      {Array.isArray(bbox) && (
        <Chip tint="muted" className="font-mono" title="bounding box">
          bbox
        </Chip>
      )}
    </div>
  );
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function Transcript({ step }: { step: RefineStep }) {
  const dur = step.summary?.duration_ms;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11px] text-muted">
        <span className="font-mono">refine step {step.step}</span>
        {step.summary?.tool_counts && (
          <span className="font-mono text-faint">
            {Object.entries(step.summary.tool_counts)
              .map(([k, v]) => `${k}×${v}`)
              .join("  ")}
          </span>
        )}
        {dur != null && <span className="ml-auto font-mono text-faint">{fmtDuration(dur)}</span>}
      </div>
      <div className="min-h-0 flex-1 divide-y divide-line overflow-auto">
        {step.subSteps.length === 0 && (
          <div className="p-4 text-[13px] text-faint">no sub-steps recorded</div>
        )}
        {step.subSteps.map((s) => (
          <SubStepRow key={s.sub} sub={s} />
        ))}
      </div>
    </div>
  );
}

function SubStepRow({ sub }: { sub: SubStep }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(sub.tool);
  const Icon = meta.Icon;
  return (
    <div className="px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className={cx("flex size-6 items-center justify-center rounded-md", tintBg[meta.tint])}>
          <Icon size={14} />
        </span>
        <span className="font-mono text-[12px] text-ink">{meta.label}</span>
        {sub.isError && <Chip tint="err" className="!py-0">error</Chip>}
        <span className="ml-auto font-mono text-[10.5px] text-faint">sub {sub.sub}</span>
      </button>
      {(sub.thinking || sub.assistant || sub.toolResult || sub.toolCall != null) && (
        <div className={cx("mt-2 space-y-2", open ? "" : "line-clamp-3")}>
          {sub.thinking && (
            <Field label="thinking" tone="muted">
              {sub.thinking}
            </Field>
          )}
          {sub.assistant && <Field label="assistant">{sub.assistant}</Field>}
          {sub.toolCall != null && (
            <Field label="call" mono>
              {JSON.stringify(sub.toolCall, null, open ? 2 : 0)}
            </Field>
          )}
          {sub.toolResult && (
            <Field label="result" mono tone={sub.isError ? "err" : "default"}>
              {sub.toolResult}
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
  mono,
  tone = "default",
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  tone?: "default" | "muted" | "err";
}) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-faint">
        {label}
      </div>
      <div
        className={cx(
          "whitespace-pre-wrap break-words rounded-md bg-bg/50 px-2.5 py-1.5 text-[12px] leading-relaxed",
          mono ? "font-mono text-[11.5px]" : "",
          tone === "muted" ? "text-muted" : tone === "err" ? "text-err" : "text-ink/90",
        )}
      >
        {children}
      </div>
    </div>
  );
}
