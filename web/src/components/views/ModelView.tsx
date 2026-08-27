import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DownloadSimpleIcon as Download } from "@phosphor-icons/react";

import type { MaterialEntry, RunDetail } from "../../../shared/types.ts";
import { downloadUrl } from "../../api.ts";
import { fade, useMotion } from "../../lib/motion.ts";
import { MeshViewer, meshPathOf } from "../MeshViewer.tsx";
import { ImageView, ViewGallery } from "../images.tsx";
import { Chip, Section, Segmented, StatusPill, cx } from "../ui.tsx";

type Mode = "3d" | "painted" | "ao" | "pbr";

/**
 * The deliverable, full-bleed, with one control: which face of it to look at.
 * Everything else about the result lives in the inspector column.
 */
export function ModelView({ run }: { run: RunDetail }) {
  const mesh = meshPathOf(run.final) ?? meshPathOf(run.draft);
  const painted = meshPathOf(run.painted);
  const hasAo = run.previewViews.length > 0;
  const hasPbr = run.previewPainted.length > 0;
  const [mode, setMode] = useState<Mode>(painted ? "painted" : mesh ? "3d" : hasPbr ? "pbr" : "ao");
  const { v } = useMotion();

  const modes = [
    ...(mesh ? [{ value: "3d" as const, label: "3D" }] : []),
    ...(painted ? [{ value: "painted" as const, label: "Painted" }] : []),
    ...(hasAo ? [{ value: "ao" as const, label: "Render" }] : []),
    ...(hasPbr ? [{ value: "pbr" as const, label: "PBR" }] : []),
  ];

  return (
    <div className="grid h-full grid-cols-1 gap-4 px-6 pb-6 lg:grid-cols-[1fr_300px]">
      <div className="relative min-h-[320px] overflow-hidden rounded-2xl bg-elevated">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={mode} variants={v(fade)} initial="initial" animate="animate" exit="exit" className="absolute inset-0">
            {mode === "painted" && painted ? (
              <MeshViewer path={painted} mtlPath={run.painted?.mtlPath ?? null} className="h-full" />
            ) : mode === "ao" ? (
              <ViewGallery views={run.previewViews} alt="final render" className="h-full p-3" />
            ) : mode === "pbr" ? (
              <ViewGallery views={run.previewPainted} alt="painted render" className="h-full p-3" />
            ) : (
              <MeshViewer path={mesh} className="h-full" />
            )}
          </motion.div>
        </AnimatePresence>
        {modes.length > 1 && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <div className="pointer-events-auto rounded-lg bg-panel/80 p-0.5 shadow-[var(--shadow-card)] backdrop-blur-xl">
              <Segmented size="sm" options={modes} value={mode} onChange={setMode} ariaLabel="What to show" className="bg-transparent" />
            </div>
          </div>
        )}
      </div>

      <aside className="min-h-0 overflow-auto rounded-2xl border border-line bg-panel">
        <Section title="Result">
          <div className="flex items-center gap-2">
            <StatusPill status={run.status} />
            {run.final?.scadLines != null && <span className="font-mono text-[11px] text-faint">{run.final.scadLines} lines</span>}
          </div>
          {run.finalSummary && <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{summaryOf(run.finalSummary)}</p>}
        </Section>

        {run.hasImage && run.imagePath && (
          <Section title="Reference">
            <ImageView path={run.imagePath} alt="reference image" className="aspect-square w-full rounded-xl" />
          </Section>
        )}

        {run.materials && run.materials.palette.length > 0 && (
          <Section title="Materials" right={<span className="font-mono text-[11px] text-faint">{run.materials.palette.length}</span>}>
            <ul className="-mx-1 max-h-72 overflow-auto">
              {run.materials.palette.map((m) => (
                <MaterialRow key={m.id || m.name} m={m} />
              ))}
            </ul>
          </Section>
        )}

        <Section title="Files">
          <ul className="-mx-1">
            {[
              { label: "final.obj", path: run.final?.objPath },
              { label: "final.scad", path: run.final?.scadPath },
              { label: "final_painted.obj", path: run.painted?.objPath },
              { label: "final_painted.mtl", path: run.painted?.mtlPath },
              { label: "final_motion.usda", path: run.motion?.usdaPath },
              { label: "robot.urdf", path: run.motion?.urdfPath },
            ]
              .filter((f): f is { label: string; path: string } => !!f.path)
              .map((f) => (
                <li key={f.label}>
                  <a
                    href={downloadUrl(f.path)}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 font-mono text-[12px] text-ink transition-colors hover:bg-elevated"
                  >
                    {f.label}
                    <Download size={13} className="text-faint" />
                  </a>
                </li>
              ))}
          </ul>
        </Section>
      </aside>
    </div>
  );
}

/** The summary paragraph of final_summary.txt, without the verdict line. */
function summaryOf(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => /^summary:/i.test(l));
  const body = (i >= 0 ? lines.slice(i + 1) : lines.filter((l) => !/^verdict:/i.test(l))).filter(Boolean);
  return body.join(" ").slice(0, 600);
}

function MaterialRow({ m }: { m: MaterialEntry }) {
  return (
    <li className="flex items-center gap-2.5 rounded-md px-1 py-1.5">
      <span
        className="size-5 shrink-0 rounded-[6px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]"
        style={{ background: m.hex }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-ink">{m.name || m.id}</span>
      </span>
      <Chip tint="muted" className={cx("shrink-0")}>{m.material}</Chip>
    </li>
  );
}
