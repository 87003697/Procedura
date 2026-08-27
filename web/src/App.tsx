import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { CubeIcon as Cube, ListIcon as List, PlusIcon as Plus, XIcon as X } from "@phosphor-icons/react";

import type { JobRecord, RunSummary, ServerInfo } from "../shared/types.ts";
import { api } from "./api.ts";
import { Sidebar, type Selection } from "./components/Sidebar.tsx";
import { RunView } from "./components/RunView.tsx";
import { GenerationView } from "./components/GenerationView.tsx";
import { Composer } from "./components/Composer.tsx";
import { Empty, cx } from "./components/ui.tsx";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

export function App() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const isMobile = useIsMobile();
  const navWrapRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const loadRuns = useCallback(async () => {
    try {
      const r = await api.runs();
      setRuns(r.runs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const r = await api.jobs();
      setJobs(r.jobs);
    } catch {
      /* jobs are non-critical */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [infoRes, runsRes, jobsRes] = await Promise.all([api.info(), api.runs(), api.jobs()]);
        if (cancelled) return;
        setInfo(infoRes);
        setRuns(runsRes.runs);
        setJobs(jobsRes.jobs);
        setSelection((cur) => cur ?? (runsRes.runs[0] ? { kind: "run", id: runsRes.runs[0].id } : null));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasActive = useMemo(
    () => jobs.some((j) => j.status === "running" || j.status === "queued"),
    [jobs],
  );

  // While anything is in flight, refresh jobs + runs so the sidebar and any
  // open generation/run views reflect progress and completion.
  useEffect(() => {
    if (!hasActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // Self-scheduling so a slow response can't overlap with the next tick.
    const tick = async () => {
      await Promise.all([loadJobs(), loadRuns()]);
      if (!cancelled) timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasActive, loadJobs, loadRuns]);

  // Keyboard: `n` opens the composer, `/` focuses the run filter — only when
  // nothing is being typed into and no dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showForm || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "n" && info?.generation) {
        e.preventDefault();
        setShowForm(true);
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("run-filter")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showForm, info?.generation]);

  // mobile slide-over a11y
  useEffect(() => {
    if (navWrapRef.current) navWrapRef.current.inert = isMobile && !navOpen;
  }, [isMobile, navOpen]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNavOpen(false);
        menuBtnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);
  useEffect(() => {
    if (navOpen && isMobile) closeBtnRef.current?.focus();
  }, [navOpen, isMobile]);

  const selectRun = (id: string) => {
    setSelection({ kind: "run", id });
    setNavOpen(false);
  };
  const selectJob = (id: string) => {
    setSelection({ kind: "job", id });
    setNavOpen(false);
  };
  const onCreated = (job: JobRecord) => {
    setShowForm(false);
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setSelection({ kind: "job", id: job.id });
  };

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* mobile top bar */}
      <div className="glass flex items-center gap-3 border-b border-line px-3 py-2.5 lg:hidden">
        <button
          ref={menuBtnRef}
          onClick={() => setNavOpen(true)}
          aria-expanded={navOpen}
          aria-label="open run list"
          className="flex size-8 items-center justify-center rounded-md border border-line text-muted hover:text-ink"
        >
          <List size={17} />
        </button>
        <span className="flex items-center gap-2 text-[14px] font-semibold">
          <Cube size={16} weight="fill" className="text-accent" /> Procedura
        </span>
        <button
          onClick={() => setShowForm(true)}
          disabled={info ? !info.generation : false}
          className={cx(
            "ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium",
            info && !info.generation ? "bg-elevated text-faint" : "bg-accent text-accent-ink",
          )}
        >
          <Plus size={14} weight="bold" /> New
        </button>
      </div>

      {/* sidebar */}
      <div
        ref={navWrapRef}
        role={isMobile && navOpen ? "dialog" : undefined}
        aria-modal={isMobile && navOpen ? true : undefined}
        aria-label={isMobile && navOpen ? "Run list" : undefined}
        className={cx(
          "z-40 w-[300px] shrink-0",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:transition-transform",
          navOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
        )}
      >
        <div className="relative h-full">
          <button
            ref={closeBtnRef}
            onClick={() => setNavOpen(false)}
            className="absolute right-2 top-3 z-10 flex size-7 items-center justify-center rounded-md text-faint hover:text-ink lg:hidden"
            aria-label="close run list"
          >
            <X size={16} />
          </button>
          <Sidebar
            runs={runs}
            jobs={jobs}
            info={info}
            selection={selection}
            onSelectRun={selectRun}
            onSelectJob={selectJob}
            onNew={() => setShowForm(true)}
            loading={loading}
            error={error}
          />
        </div>
      </div>
      {navOpen && (
        <button
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-label="close overlay"
        />
      )}

      {/* main */}
      <main className="min-h-0 min-w-0 flex-1">
        {selection?.kind === "job" ? (
          <GenerationView key={selection.id} jobId={selection.id} onOpenRun={selectRun} />
        ) : selection?.kind === "run" ? (
          <RunView key={selection.id} runId={selection.id} customize={!!info?.customize} />
        ) : (
          <Empty icon={<Cube size={34} />} title={loading ? "Loading…" : "Nothing selected"}>
            {!loading && (info?.generation ? "Start a generation, or choose a run." : "Choose a run.")}
          </Empty>
        )}
      </main>

      <AnimatePresence>{showForm && <Composer key="composer" info={info} onClose={() => setShowForm(false)} onCreated={onCreated} />}</AnimatePresence>
    </div>
  );
}
