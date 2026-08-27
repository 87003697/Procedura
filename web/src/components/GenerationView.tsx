import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRightIcon as ArrowRight,
  CheckIcon as Check,
  ImageSquareIcon as ImageSquare,
  TerminalWindowIcon as TerminalWindow,
  WarningIcon as Warning,
} from "@phosphor-icons/react";

import type { JobOptions, JobPhase, JobProgress, JobRecord, JobStatus, RunDetail } from "../../shared/types.ts";
import { api, subscribeJob } from "../api.ts";
import { fmtDuration } from "../lib/format.ts";
import { tintBg, type Tint } from "../lib/meta.tsx";
import { ease, pop, spring, useMotion } from "../lib/motion.ts";
import { MeshViewer, meshPathOf } from "./MeshViewer.tsx";
import { ImageView } from "./images.tsx";
import { Button, ProgressRing, Spinner, cx } from "./ui.tsx";

const STATUS_TINT: Record<JobStatus, Tint> = {
  queued: "muted",
  running: "accent",
  succeeded: "ok",
  failed: "err",
  canceled: "warn",
  interrupted: "warn",
};
const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Generating",
  succeeded: "Complete",
  failed: "Failed",
  canceled: "Canceled",
  interrupted: "Interrupted",
};

/** The run's configuration as one plain sentence. */
function describe(o: JobOptions): string {
  const bits: string[] = [];
  bits.push(o.oneShot ? "one-shot draft" : "part by part");
  bits.push(o.imagePath ? "from your reference" : o.noImage ? "text only" : "with a generated reference");
  if (o.contextRenders) bits.push("3D feedback");
  if (o.assembly) bits.push("assembly mates");
  if (o.maxSteps != null) bits.push(o.maxSteps === 0 ? "no refine" : `${o.maxSteps} refine ${o.maxSteps === 1 ? "cycle" : "cycles"}`);
  if (o.paint) bits.push("materials");
  if (o.motion) bits.push(o.motionUrdf ? "articulation with URDF" : "articulation");
  return bits.join(" · ");
}

export function GenerationView({ jobId, onOpenRun }: { jobId: string; onOpenRun: (runId: string) => void }) {
  const [rec, setRec] = useState<JobRecord | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [canceling, setCanceling] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const { reduce } = useMotion();

  useEffect(() => {
    setRec(null);
    setProgress(null);
    setLog([]);
    setDetail(null);
    setLogOpen(false);
    follow.current = true;
    let unsub = () => {};
    unsub = subscribeJob(jobId, (ev) => {
      if (ev.type === "log") setLog((l) => [...l, ev.line]);
      else if (ev.type === "progress") setProgress(ev.progress);
      else if (ev.type === "status") {
        setRec(ev.job);
        // A failure is the one time the log is the point — open it.
        if (ev.job.status === "failed") setLogOpen(true);
        if (ev.job.status !== "running" && ev.job.status !== "queued") unsub();
      }
    });
    return () => unsub();
  }, [jobId]);

  const active = rec?.status === "running" || rec?.status === "queued";

  useEffect(() => {
    if (!rec?.runId) return;
    let cancelled = false;
    const fetchDetail = () => {
      api
        .run(rec.runId)
        .then((d) => !cancelled && setDetail(d))
        .catch(() => {
          /* run dir may not exist yet */
        });
    };
    fetchDetail();
    if (!active)
      return () => {
        cancelled = true;
      };
    const t = setInterval(fetchDetail, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [rec?.runId, active]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => {
    if (logOpen && follow.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, logOpen]);

  const elapsed = useMemo(() => (rec?.startedAt ? (rec.endedAt ?? now) - rec.startedAt : null), [rec?.startedAt, rec?.endedAt, now]);

  if (!rec) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }

  const producedModel = !!(progress?.finalReady || progress?.draftReady);
  const tint = STATUS_TINT[rec.status];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold leading-tight text-ink" title={rec.prompt}>
            {rec.prompt}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-medium", tintBg[tint])}>
              {active ? <Spinner size={10} className="text-current" /> : <span className="inline-block size-1.5 rounded-full bg-current" aria-hidden />}
              {STATUS_LABEL[rec.status]}
            </span>
            {elapsed != null && <span className="font-mono text-[11.5px]">{fmtDuration(elapsed)}</span>}
            <span className="text-faint">·</span>
            <span>{describe(rec.options)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" icon={<TerminalWindow size={15} />} onClick={() => setLogOpen((o) => !o)} title="Pipeline output">
            Log
            <span className="rounded-md bg-elevated px-1.5 font-mono text-[10.5px] text-faint">{log.length}</span>
          </Button>
          {active && (
            <Button
              variant="danger"
              disabled={canceling}
              onClick={() => {
                setCanceling(true);
                void api.cancelJob(rec.id);
              }}
            >
              {canceling ? "Canceling…" : "Cancel"}
            </Button>
          )}
          {!!rec.runId && (rec.status === "succeeded" || producedModel) && (
            // Quiet while generating — the run is only partly there; the
            // primary action once it is done.
            <Button variant={active ? "secondary" : "primary"} onClick={() => onOpenRun(rec.runId)} icon={<ArrowRight size={14} weight="bold" />}>
              Open run
            </Button>
          )}
        </div>
      </header>

      {rec.error && (
        <div className="mx-6 mb-3 flex items-center gap-2 rounded-lg bg-err/10 px-3 py-2 text-[12.5px] text-err">
          <Warning size={15} /> {rec.error}
        </div>
      )}

      <PhaseRail options={rec.options} progress={progress} status={rec.status} />

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6">
        <LivePreview detail={detail} progress={progress} active={active} options={rec.options} />
        {!rec.options.oneShot && <PartsStrip detail={detail} progress={progress} active={active} />}

        <AnimatePresence initial={false}>
          {logOpen && (
            <motion.div
              key="log"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: 260, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={reduce ? { duration: 0 } : ease}
              className="shrink-0 overflow-hidden rounded-2xl border border-line bg-panel"
            >
              <div
                ref={logRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                }}
                className="h-[260px] overflow-auto p-4"
              >
                {log.length === 0 ? (
                  <div className="flex items-center gap-2 text-[12px] text-faint">
                    <Spinner size={13} /> Waiting for output…
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink/85">{log.join("\n")}</pre>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

interface Phase {
  id: JobPhase;
  label: string;
  detail?: string;
  done: boolean;
  failed?: boolean;
  /** 0..1 within the phase when it is measurable (parts built). */
  fraction?: number;
}

function phasesOf(o: JobOptions, p: JobProgress | null, status: JobStatus): Phase[] {
  const out: Phase[] = [];
  const terminalFail = status === "failed" || status === "canceled" || status === "interrupted";
  if (!o.noImage) out.push({ id: "reference", label: "Reference", detail: o.imagePath ? "yours" : "generated", done: !!p?.hasImage });
  if (o.oneShot) {
    out.push({ id: "build", label: "Draft", done: !!p?.draftReady });
  } else {
    out.push({ id: "plan", label: "Plan", detail: p?.planned ? `${p.planned} parts` : undefined, done: !!p?.planned });
    out.push({
      id: "build",
      label: "Build",
      detail: p?.planned ? `${p.built} of ${p.planned}` : undefined,
      done: !!p && ((p.planned > 0 && p.built >= p.planned) || p.refineSteps > 0 || p.finalReady),
      fraction: p?.planned ? p.built / p.planned : undefined,
    });
  }
  if ((o.maxSteps ?? 1) > 0) out.push({ id: "refine", label: "Refine", detail: p?.refineSteps ? `${p.refineSteps} ${p.refineSteps === 1 ? "cycle" : "cycles"}` : undefined, done: !!p?.finalReady });
  out.push({ id: "final", label: "Final", done: !!p?.finalReady });
  if (o.paint) out.push({ id: "paint", label: "Materials", done: !!p?.painted });
  if (o.motion) {
    out.push({
      id: "motion",
      label: "Articulation",
      detail: p?.motionValidated === true ? "validated" : p?.motionValidated === false ? "validation failed" : undefined,
      done: !!p?.motionReady,
      failed: p?.motionValidated === false,
    });
  }
  if (terminalFail) {
    const first = out.findIndex((ph) => !ph.done);
    if (first >= 0) out[first]!.failed = true;
  }
  return out;
}

/** The phases in order, each a ring that fills and becomes a check. */
function PhaseRail({ options, progress, status }: { options: JobOptions; progress: JobProgress | null; status: JobStatus }) {
  const phases = phasesOf(options, progress, status);
  const running = status === "running" || status === "queued";
  const activeIdx = phases.findIndex((p) => !p.done);
  const { t } = useMotion();
  return (
    <ol className="mx-6 mb-4 flex items-center gap-2 overflow-x-auto rounded-2xl border border-line bg-panel px-4 py-3" aria-label="Progress">
      {phases.map((ph, i) => {
        const isActive = running && i === activeIdx;
        const state = ph.failed ? "failed" : ph.done ? "done" : isActive ? "active" : "pending";
        return (
          <li key={ph.id} className="flex min-w-0 items-center gap-2">
            <span className="relative flex size-6 shrink-0 items-center justify-center">
              <AnimatePresence mode="wait" initial={false}>
                {state === "done" ? (
                  <motion.span key="done" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={t(spring)} className="flex size-6 items-center justify-center rounded-full bg-ok text-white">
                    <Check size={12} weight="bold" />
                  </motion.span>
                ) : state === "failed" ? (
                  <motion.span key="failed" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={t(spring)} className="flex size-6 items-center justify-center rounded-full bg-err text-white">
                    <Warning size={12} weight="bold" />
                  </motion.span>
                ) : state === "active" ? (
                  <motion.span key="active" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex size-6 items-center justify-center">
                    <ProgressRing value={ph.fraction ?? null} size={22} stroke={2.5} />
                  </motion.span>
                ) : (
                  <span key="pending" className="size-2 rounded-full bg-line-strong" />
                )}
              </AnimatePresence>
            </span>
            <span className="min-w-0 leading-tight">
              <span className={cx("block truncate text-[12.5px] font-medium", state === "pending" ? "text-faint" : "text-ink")}>{ph.label}</span>
              {ph.detail && <span className="block truncate text-[11px] text-faint">{ph.detail}</span>}
            </span>
            {i < phases.length - 1 && <span className="mx-2 h-px w-6 shrink-0 bg-line" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function LivePreview({ detail, progress, active, options }: { detail: RunDetail | null; progress: JobProgress | null; active: boolean; options: JobOptions }) {
  const painted = detail?.painted ? meshPathOf(detail.painted) : null;
  const finalMesh = meshPathOf(detail?.final);
  const lastCycle = detail?.cycles.at(-1);
  const cycleImg = lastCycle?.views.find((vw) => vw.view === "isometric")?.path ?? lastCycle?.views[0]?.path ?? null;
  const draftMesh = meshPathOf(detail?.draft);
  const lastCtx = detail?.incremental?.parts.slice().reverse().find((p) => p.contextViews.length)?.contextViews;
  const ctxImg = lastCtx?.find((vw) => vw.view === "isometric")?.path ?? lastCtx?.[0]?.path ?? null;
  const image = detail?.imagePath ?? null;

  let body: React.ReactNode;
  let label: string;
  if (painted) {
    body = <MeshViewer path={painted} mtlPath={detail?.painted?.mtlPath ?? null} className="h-full" />;
    label = "Painted model";
  } else if (finalMesh) {
    body = <MeshViewer path={finalMesh} className="h-full" />;
    label = "Final model";
  } else if (cycleImg) {
    body = <ImageView path={cycleImg} alt="latest refine render" className="h-full" />;
    label = `Refining · cycle ${lastCycle?.cycle ?? ""}`;
  } else if (detail?.liveBuild && (progress?.phase === "build" || progress?.phase === "plan")) {
    body = <MeshViewer path={`${detail.liveBuild.path}?v=${detail.liveBuild.mtime}`} keepView keepLastOnError className="h-full" />;
    label = `Building · ${progress?.built ?? 0}${progress?.planned ? ` of ${progress.planned}` : ""} parts`;
  } else if (draftMesh) {
    body = <MeshViewer path={draftMesh} className="h-full" />;
    label = "Draft";
  } else if (ctxImg) {
    body = <ImageView path={ctxImg} alt="build so far" className="h-full" />;
    label = "Building";
  } else if (image) {
    body = <ImageView path={image} alt="reference image" className="h-full" />;
    label = "Reference";
  } else {
    const phase = progress?.phase;
    const waiting =
      phase === "reference"
        ? "Rendering the reference image — this can take a minute."
        : phase === "plan"
          ? "Planning the parts."
          : phase === "build"
            ? `Generating parts${progress?.building ? ` · ${progress.building}` : ""}.`
            : options.noImage
              ? "The first picture will be the first part."
              : "Waiting for the first artifact.";
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-faint">
        {active ? <ProgressRing value={null} size={28} /> : <ImageSquare size={26} />}
        <span className="text-[13px]">{active ? waiting : "No artifacts were produced."}</span>
      </div>
    );
    label = "Preview";
  }

  return (
    <div className="relative min-h-[280px] flex-1 overflow-hidden rounded-2xl bg-elevated">
      <div className="absolute inset-0">{body}</div>
      <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-panel/80 px-2 py-1 text-[11px] font-medium text-muted backdrop-blur-xl">{label}</div>
    </div>
  );
}

/** The plan, ticked off as it is built. */
function PartsStrip({ detail, progress, active }: { detail: RunDetail | null; progress: JobProgress | null; active: boolean }) {
  const inc = detail?.incremental;
  const plan = inc?.plan ?? [];
  const { v } = useMotion();
  if (!plan.length && !progress?.planned) {
    return <div className="shrink-0 rounded-2xl border border-line bg-panel px-4 py-3 text-[12.5px] text-faint">{active ? "Waiting for the plan…" : "No plan was produced."}</div>;
  }
  const byName = new Map(inc?.parts.map((p) => [p.name, p]) ?? []);
  const built = progress?.built ?? inc?.partsGenerated ?? 0;
  const building = progress?.building ?? null;
  return (
    <div className="shrink-0 rounded-2xl border border-line bg-panel px-4 py-3">
      <ol className="flex flex-wrap gap-1.5">
        {plan.map((p, i) => {
          const r = byName.get(p.name);
          const isBuilding = active && (building === p.name || (!building && !r && i === built));
          const state = isBuilding ? "building" : r?.generated === false ? "failed" : r?.connected === false ? "floater" : r?.generated || i < built ? "built" : "pending";
          return (
            <motion.li
              key={`${p.name}-${i}`}
              layout
              variants={v(pop)}
              initial="initial"
              animate="animate"
              title={p.description ?? p.name}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px]",
                state === "built" && "border-transparent bg-ok/10 text-ink",
                state === "building" && "border-transparent bg-accent/10 text-accent",
                state === "floater" && "border-transparent bg-warn/12 text-warn",
                state === "failed" && "border-transparent bg-err/10 text-err",
                state === "pending" && "border-line text-faint",
              )}
            >
              {state === "building" ? <ProgressRing value={null} size={11} stroke={2} /> : state === "built" ? <Check size={10} weight="bold" className="text-ok" /> : <span className="text-[10px] opacity-60">{i + 1}</span>}
              {r?.placedName ?? p.name}
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
}
