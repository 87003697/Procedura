import { useMemo, useRef, useState } from "react";
import {
  CubeIcon as Cube,
  FolderOpenIcon as FolderOpen,
  GearSixIcon as GearSix,
  MagnifyingGlassIcon as MagnifyingGlass,
  PaintBrushIcon as PaintBrush,
  PlusIcon as Plus,
  XIcon as X,
} from "@phosphor-icons/react";

import type { JobRecord, JobStatus, RunSummary, ServerInfo } from "../../shared/types.ts";
import { fileUrl } from "../api.ts";
import { fmtRelTime } from "../lib/format.ts";
import { Button, Empty, ErrorState, ProgressRing, STATUS_META, Skeleton, SlidingHighlight, cx } from "./ui.tsx";

export interface Selection {
  kind: "run" | "job";
  id: string;
}

const JOB_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Generating",
  succeeded: "Complete",
  failed: "Failed",
  canceled: "Canceled",
  interrupted: "Interrupted",
};

/**
 * The library. One line of title, one line of state, a thumbnail — and the
 * selection highlight slides between rows rather than blinking.
 */
export function Sidebar({
  runs,
  jobs,
  info,
  selection,
  onSelectRun,
  onSelectJob,
  onNew,
  loading,
  error,
}: {
  runs: RunSummary[];
  jobs: JobRecord[];
  info: ServerInfo | null;
  selection: Selection | null;
  onSelectRun: (id: string) => void;
  onSelectJob: (id: string) => void;
  onNew: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Jobs still in flight, or that ended without a run, get their own section;
  // succeeded ones are simply runs. Active runs are hidden from Runs.
  const genJobs = useMemo(() => jobs.filter((j) => j.status !== "succeeded").slice(0, 12), [jobs]);
  const activeRunIds = useMemo(
    () => new Set(jobs.filter((j) => j.status === "running" || j.status === "queued").map((j) => j.runId)),
    [jobs],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs
      .filter((r) => !activeRunIds.has(r.id))
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || (r.group ?? "").toLowerCase().includes(q));
  }, [runs, query, activeRunIds]);

  // Group by the folder under the root, keeping the newest-first order.
  const groups = useMemo(() => {
    const out: { name: string | null; runs: RunSummary[] }[] = [];
    for (const r of filtered) {
      const last = out[out.length - 1];
      if (last && last.name === r.group) last.runs.push(r);
      else out.push({ name: r.group, runs: [r] });
    }
    return out;
  }, [filtered]);

  return (
    <aside className="glass flex h-full w-full flex-col border-r border-line">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <span className="flex size-8 items-center justify-center rounded-[9px] bg-accent text-accent-ink shadow-[var(--shadow-thumb)]">
          <Cube size={17} weight="fill" />
        </span>
        <div className="min-w-0 leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">Procedura</div>
          <div className="text-[11px] text-faint">{runs.length} runs</div>
        </div>
      </div>

      <div className="px-3 pb-2 pt-1">
        <Button
          variant="primary"
          icon={<Plus size={15} weight="bold" />}
          onClick={onNew}
          disabled={info ? !info.generation : false}
          title={info && !info.generation ? "Generation is unavailable on this server" : "New generation (n)"}
          className="w-full"
        >
          New generation
        </Button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg bg-elevated px-2.5 py-1.5 focus-within:ring-[3px] focus-within:ring-accent/25">
          <MagnifyingGlass size={14} className="text-faint" aria-hidden />
          <input
            id="run-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search runs"
            className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-faint focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-faint hover:text-ink" aria-label="Clear">
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div ref={listRef} className="relative min-h-0 flex-1 overflow-auto pb-3">
        <SlidingHighlight containerRef={listRef} activeKey={selection ? `${selection.kind}:${selection.id}` : null} deps={[runs.length, jobs.length, query]} className="rounded-lg bg-accent/10" />
        <>
          {genJobs.length > 0 && (
            <>
              <GroupLabel>In progress</GroupLabel>
              <ul className="px-2">
                {genJobs.map((j) => (
                  <JobRow key={j.id} job={j} active={selection?.kind === "job" && selection.id === j.id} onSelect={() => onSelectJob(j.id)} />
                ))}
              </ul>
            </>
          )}

          {loading && runs.length === 0 ? (
            <div className="space-y-2 px-3 pt-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[52px]" />
              ))}
            </div>
          ) : error ? (
            <ErrorState message={error} />
          ) : runs.length === 0 && genJobs.length === 0 ? (
            <Empty icon={<FolderOpen size={28} />} title="No runs yet">
              {info ? (
                <>
                  Start one with <span className="font-medium text-ink">New generation</span>. Runs are written to{" "}
                  <span className="break-all font-mono text-[11.5px] text-muted">{info.root}</span>.
                </>
              ) : (
                "Connecting…"
              )}
            </Empty>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-faint">{query ? `Nothing matches “${query}”.` : "No completed runs yet."}</div>
          ) : (
            groups.map((g, gi) => (
              <div key={`${g.name ?? "root"}-${gi}`}>
                <GroupLabel>{g.name ?? (groups.length > 1 || genJobs.length ? "Runs" : "Runs")}</GroupLabel>
                <ul className="px-2">
                  {g.runs.map((r) => (
                    <RunRow key={r.id} run={r} active={selection?.kind === "run" && selection.id === r.id} onSelect={() => onSelectRun(r.id)} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </>
      </div>
    </aside>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="truncate px-4 pb-1 pt-3 text-[11px] font-semibold text-faint">{children}</div>;
}

function JobRow({ job, active, onSelect }: { job: JobRecord; active: boolean; onSelect: () => void }) {
  const live = job.status === "running" || job.status === "queued";
  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        data-active={active ? "true" : undefined}
        className={cx("relative mb-0.5 flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors", !active && "hover:bg-elevated/70")}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-panel shadow-[var(--shadow-thumb)]">
          {live ? <ProgressRing value={null} size={22} stroke={2.5} /> : <Cube size={18} className="text-faint" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-snug text-ink">{job.prompt}</span>
          <span className={cx("block truncate text-[11.5px]", live ? "text-accent" : "text-faint")}>
            {JOB_LABEL[job.status]} · {fmtRelTime(job.startedAt ?? job.createdAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

function RunRow({ run, active, onSelect }: { run: RunSummary; active: boolean; onSelect: () => void }) {
  const meta = STATUS_META[run.status] ?? STATUS_META.unknown;
  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        data-active={active ? "true" : undefined}
        className={cx("relative mb-0.5 flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors", !active && "hover:bg-elevated/70")}
      >
        <Thumb run={run} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-snug text-ink">{run.title}</span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-faint">
            <span className={cx("truncate", meta.tint === "ok" && "text-ok", meta.tint === "err" && "text-err")}>{meta.label}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{fmtRelTime(run.mtime)}</span>
            {run.hasPaint && <PaintBrush size={11} className="ml-auto shrink-0 text-faint" aria-label="painted" />}
            {run.hasMotion && <GearSix size={11} className={cx("shrink-0 text-faint", !run.hasPaint && "ml-auto")} aria-label="articulated" />}
          </span>
        </span>
      </button>
    </li>
  );
}

function Thumb({ run }: { run: RunSummary }) {
  return (
    <span className="relative size-10 shrink-0 overflow-hidden rounded-lg bg-panel shadow-[var(--shadow-thumb)]">
      {run.thumbnail ? (
        <img
          src={fileUrl(run.thumbnail)}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <span className="flex size-full items-center justify-center text-faint">
          <Cube size={16} />
        </span>
      )}
    </span>
  );
}
