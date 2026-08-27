import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CodeIcon as Code,
  CubeIcon as Cube,
  DownloadSimpleIcon as Download,
  GearSixIcon as GearSix,
  InfoIcon as Info,
  SparkleIcon as Sparkle,
  StackIcon as Stack,
} from "@phosphor-icons/react";

import type { RunDetail } from "../../shared/types.ts";
import { api, downloadUrl } from "../api.ts";
import { fmtClock } from "../lib/format.ts";
import { ease, fade, present, useMotion } from "../lib/motion.ts";
import { Button, Empty, ErrorState, IconButton, Segmented, Skeleton, StatusPill, cx } from "./ui.tsx";
import { ModelView } from "./views/ModelView.tsx";
import { BuildView } from "./views/BuildView.tsx";
import { CodeView } from "./views/CodeView.tsx";
import { DetailsPanel } from "./views/DetailsPanel.tsx";
import { RefineStage } from "./stages/RefineStage.tsx";
import { RefineStageLegacy } from "./stages/RefineStageLegacy.tsx";
import { MotionStage } from "./stages/MotionStage.tsx";

type ViewId = "model" | "build" | "refine" | "motion" | "code";

const VIEWS: { id: ViewId; label: string; Icon: typeof Cube; available: (r: RunDetail) => boolean }[] = [
  { id: "model", label: "Model", Icon: Cube, available: (r) => r.final != null || r.draft != null || r.hasImage },
  { id: "build", label: "Build", Icon: Stack, available: (r) => r.incremental != null },
  { id: "refine", label: "Refine", Icon: Sparkle, available: (r) => r.cycles.length > 0 || r.refineSteps.length > 0 || r.renderSteps.length > 0 },
  { id: "motion", label: "Motion", Icon: GearSix, available: (r) => r.motion != null },
  { id: "code", label: "Code", Icon: Code, available: (r) => !!(r.final?.scadPath || r.draft?.scadPath) },
];

/** One sentence of what this run is, for the header. */
function describe(r: RunDetail): string {
  const bits: string[] = [];
  if (r.incremental) bits.push(`${r.incremental.parts.length} parts`);
  if (r.cycles.length) bits.push(`${r.cycles.length} refine ${r.cycles.length === 1 ? "cycle" : "cycles"}`);
  if (!r.hasImage) bits.push("text-only");
  if (r.hasPaint) bits.push("painted");
  if (r.hasMotion) bits.push("articulated");
  return bits.join(" · ");
}

export function RunView({ runId, customize }: { runId: string; customize: boolean }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewId>("model");
  const [details, setDetails] = useState(false);
  const [downloads, setDownloads] = useState(false);
  const { v } = useMotion();

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setRun(null);
    setDetails(false);
    api
      .run(runId, ctrl.signal)
      .then((d) => {
        if (cancelled) return;
        setRun(d);
        setView(VIEWS.find((vv) => vv.available(d))?.id ?? "model");
      })
      .catch((e: unknown) => {
        if (!cancelled && (e as Error).name !== "AbortError") setError((e as Error).message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [runId]);

  const options = useMemo(
    () => (run ? VIEWS.map((vv) => ({ value: vv.id, label: vv.label, disabled: !vv.available(run) })) : []),
    [run],
  );

  const closeDetails = useCallback(() => setDetails(false), []);

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <Skeleton className="h-14 w-2/3" />
        <Skeleton className="mx-auto h-9 w-96" />
        <Skeleton className="flex-1" />
      </div>
    );
  }
  if (error) return <ErrorState message={error} />;
  if (!run) return <Empty title="Select a run" icon={<Cube size={30} />} />;

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold leading-tight text-ink" title={run.title}>
            {run.title}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <StatusPill status={run.status} />
            <span>{describe(run)}</span>
            <span className="text-faint">·</span>
            <span className="text-faint">{fmtClock(run.mtime)}</span>
          </div>
        </div>
        <div className="relative flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" icon={<Download size={15} />} onClick={() => setDownloads((d) => !d)}>
            Download
          </Button>
          <IconButton icon={<Info size={17} />} label="Details" active={details} onClick={() => setDetails((d) => !d)} />
          <AnimatePresence>{downloads && <DownloadMenu run={run} onClose={() => setDownloads(false)} />}</AnimatePresence>
        </div>
      </header>

      <div className="flex justify-center px-6 pb-3">
        <Segmented options={options} value={view} onChange={setView} ariaLabel="View" />
      </div>

      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={view} variants={v(fade)} initial="initial" animate="animate" exit="exit" className="absolute inset-0">
            <ViewBody view={view} run={run} customize={customize} />
          </motion.div>
        </AnimatePresence>
        <AnimatePresence>{details && <DetailsPanel run={run} onClose={closeDetails} />}</AnimatePresence>
      </div>
    </div>
  );
}

function ViewBody({ view, run, customize }: { view: ViewId; run: RunDetail; customize: boolean }) {
  switch (view) {
    case "model":
      return <ModelView run={run} />;
    case "build":
      return <BuildView run={run} />;
    case "refine":
      return run.cycles.length > 0 ? <RefineStage run={run} /> : <RefineStageLegacy run={run} />;
    case "motion":
      return <MotionStage run={run} />;
    case "code":
      return <CodeView run={run} customize={customize} />;
  }
}

/** The deliverables, one row each. Closes on outside click or Escape. */
function DownloadMenu({ run, onClose }: { run: RunDetail; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { v } = useMotion();
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const items: { label: string; hint: string; path: string | null }[] = [
    { label: "Model", hint: "final.obj", path: run.final?.objPath ?? run.final?.stlPath ?? null },
    { label: "Source", hint: "final.scad", path: run.final?.scadPath ?? run.draft?.scadPath ?? null },
    { label: "Painted model", hint: "final_painted.obj", path: run.painted?.objPath ?? null },
    { label: "Materials", hint: "final_painted.mtl", path: run.painted?.mtlPath ?? null },
    { label: "Articulation", hint: "final_motion.usda", path: run.motion?.usdaPath ?? null },
    { label: "URDF", hint: "robot.urdf", path: run.motion?.urdfPath ?? null },
  ].filter((i) => i.path);

  return (
    <motion.div
      ref={ref}
      role="menu"
      variants={v(present)}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={ease}
      className="absolute right-0 top-10 z-30 w-64 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[var(--shadow-sheet)]"
    >
      {items.length === 0 && <div className="px-3 py-2 text-[12.5px] text-faint">Nothing to download yet.</div>}
      {items.map((i) => (
        <a
          key={i.hint}
          role="menuitem"
          href={downloadUrl(i.path!)}
          onClick={onClose}
          className="flex items-center justify-between gap-3 px-3 py-2 text-[13px] text-ink transition-colors hover:bg-accent hover:text-accent-ink"
        >
          <span>{i.label}</span>
          <span className={cx("font-mono text-[10.5px] opacity-60")}>{i.hint}</span>
        </a>
      ))}
    </motion.div>
  );
}
