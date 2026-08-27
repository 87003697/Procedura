import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretLeftIcon as CaretLeft, CaretRightIcon as CaretRight, CheckIcon as Check, SparkleIcon as Sparkle, XIcon as X } from "@phosphor-icons/react";

import type { PartLegendEntry, RefineCycle, RunDetail } from "../../../shared/types.ts";
import { fetchText } from "../../api.ts";
import { fmtNum } from "../../lib/format.ts";
import { fade, useMotion } from "../../lib/motion.ts";
import { ScadPanel } from "../ScadPanel.tsx";
import { ViewGallery } from "../images.tsx";
import { TextBlock } from "../TextBlock.tsx";
import { Chip, Disclosure, Empty, ErrorState, IconButton, Segmented, Skeleton, SlidingHighlight, cx } from "../ui.tsx";

type Side = "diagnosis" | "patch" | "code";

interface Issue {
  n: number;
  severity: "HIGH" | "MED" | "LOW" | null;
  modules: string[];
  text: string;
  fix: string | null;
}

/** `SUMMARY: …` then numbered `[HIGH] [modules: a, b] problem … FIX: remedy`
 *  lines. Parsed leniently — anything else stays as prose. */
function parseDiagnosis(text: string): { summary: string | null; issues: Issue[]; rest: string } {
  let summary: string | null = null;
  const issues: Issue[] = [];
  const rest: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^SUMMARY:/i.test(line)) {
      summary = line.replace(/^SUMMARY:\s*/i, "");
      continue;
    }
    if (/^ISSUES:?$/i.test(line)) continue;
    const m = /^(\d+)[.)]\s*(?:\[(HIGH|MED|MEDIUM|LOW)\])?\s*(?:\[modules?:\s*([^\]]*)\])?\s*(.*)$/i.exec(line);
    if (m) {
      const body = m[4] ?? "";
      const fixAt = body.search(/\bFIX:/);
      const sev = (m[2] ?? "").toUpperCase();
      issues.push({
        n: Number(m[1]),
        severity: sev === "HIGH" ? "HIGH" : sev === "MED" || sev === "MEDIUM" ? "MED" : sev === "LOW" ? "LOW" : null,
        modules: (m[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        text: (fixAt >= 0 ? body.slice(0, fixAt) : body).trim(),
        fix: fixAt >= 0 ? body.slice(fixAt + 4).trim() : null,
      });
      continue;
    }
    rest.push(line);
  }
  return { summary, issues, rest: rest.join("\n") };
}

const SEV_TINT = { HIGH: "err", MED: "warn", LOW: "info" } as const;

function LazyText({ path, mono = true }: { path: string; mono?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setText(null);
    setError(null);
    fetchText(path, ctrl.signal)
      .then((t) => !cancelled && setText(t))
      .catch((e: unknown) => {
        if (!cancelled && (e as Error).name !== "AbortError") setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [path]);
  if (error) return <ErrorState message={error} />;
  if (text == null)
    return (
      <div className="p-4">
        <Skeleton className="h-40" />
      </div>
    );
  return <TextBlock text={text} mono={mono} className="h-full rounded-none border-0" />;
}

/**
 * The refine loop, one cycle at a time: what the critic saw, what it said,
 * what the patch changed, and whether the gate accepted it.
 */
export function RefineStage({ run }: { run: RunDetail }) {
  const cycles = run.cycles;
  const [idx, setIdx] = useState(Math.max(0, cycles.length - 1));
  const [side, setSide] = useState<Side>("diagnosis");
  const [legend, setLegend] = useState(false);
  const { v } = useMotion();
  const scrubRef = useRef<HTMLOListElement>(null);
  const cycle: RefineCycle | undefined = cycles[Math.min(idx, cycles.length - 1)];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setIdx((i) => Math.min(cycles.length - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycles.length]);

  const parsed = useMemo(() => (cycle?.diagnosis ? parseDiagnosis(cycle.diagnosis) : null), [cycle?.diagnosis]);
  const accepted = cycles.filter((c) => c.accepted === true).length;

  if (!cycle) {
    return (
      <Empty icon={<Sparkle size={30} />} title="No refine cycles">
        This run was drafted without refinement.
      </Empty>
    );
  }

  return (
    <div className="flex h-full flex-col px-6 pb-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <IconButton size="sm" icon={<CaretLeft size={14} />} label="Previous cycle" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} />
        <ol ref={scrubRef} className="relative flex flex-wrap items-center gap-1" aria-label="Cycles">
          <SlidingHighlight containerRef={scrubRef} activeKey={idx} deps={[cycles.length]} className="rounded-lg bg-panel shadow-[var(--shadow-thumb)]" />
          {cycles.map((c, i) => {
            const active = i === idx;
            return (
              <li key={c.cycle}>
                <button
                  type="button"
                  onClick={() => setIdx(i)}
                  aria-current={active ? "true" : undefined}
                  data-active={active ? "true" : undefined}
                  title={c.reason ?? `cycle ${c.cycle}`}
                  className={cx("relative inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 font-mono text-[11.5px] transition-colors", active ? "text-ink" : "text-muted hover:text-ink")}
                >
                  {c.cycle}
                  {c.accepted === true ? <Check size={11} weight="bold" className="text-ok" /> : c.accepted === false ? <X size={11} weight="bold" className="text-err" /> : null}
                </button>
              </li>
            );
          })}
        </ol>
        <IconButton size="sm" icon={<CaretRight size={14} />} label="Next cycle" onClick={() => setIdx((i) => Math.min(cycles.length - 1, i + 1))} disabled={idx === cycles.length - 1} />
        <span className="ml-2 text-[12px] text-muted">
          {accepted} of {cycles.length} accepted
          {cycle.facetsBefore != null && cycle.facetsAfter != null && (
            <span className="text-faint">
              {" "}
              · {fmtNum(cycle.facetsBefore)} → {fmtNum(cycle.facetsAfter)} facets
            </span>
          )}
        </span>
        <span className="ml-auto hidden text-[11px] text-faint sm:inline">← → to step</span>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={cycle.cycle} variants={v(fade)} initial="initial" animate="animate" exit="exit" className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1.1fr_1fr]">
          <div className="relative min-h-[280px] overflow-hidden rounded-2xl bg-elevated">
            <ViewGallery views={cycle.views} alt={`what the critic saw in cycle ${cycle.cycle}`} className="h-full p-3" />
            {cycle.legend && (
              <button
                type="button"
                onClick={() => setLegend((l) => !l)}
                aria-pressed={legend}
                className={cx("absolute right-3 top-3 rounded-md px-2 py-1 text-[11px] font-medium backdrop-blur-xl", legend ? "bg-accent text-accent-ink" : "bg-panel/80 text-muted hover:text-ink")}
              >
                Legend
              </button>
            )}
            <AnimatePresence>{legend && cycle.legend && <Legend legend={cycle.legend} highlight={parsed?.issues.flatMap((i) => i.modules) ?? []} />}</AnimatePresence>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Segmented
                size="sm"
                value={side}
                onChange={setSide}
                ariaLabel="Cycle detail"
                options={[
                  { value: "diagnosis", label: "Diagnosis" },
                  { value: "patch", label: "Patch" },
                  { value: "code", label: "Code", disabled: !cycle.scadPath },
                ]}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {side === "diagnosis" && (parsed ? <Diagnosis parsed={parsed} /> : <div className="flex h-full items-center justify-center text-[13px] text-faint">No diagnosis was recorded.</div>)}
              {side === "patch" && <Patch cycle={cycle} />}
              {side === "code" && cycle.scadPath && <ScadPanel path={cycle.scadPath} className="h-full" />}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Legend({ legend, highlight }: { legend: PartLegendEntry[]; highlight: string[] }) {
  const hot = new Set(highlight);
  return (
    <motion.ul
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      className="absolute inset-x-3 bottom-3 flex max-h-28 flex-wrap gap-1 overflow-auto rounded-xl bg-panel/85 p-2 backdrop-blur-xl"
    >
      {legend.map((e) => (
        <li key={e.module} className={cx("inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[10.5px]", hot.has(e.module) ? "bg-elevated text-ink" : "text-faint")}>
          <span className="size-2.5 rounded-sm" style={{ background: `rgb(${e.rgb.map((x) => Math.round(x * 255)).join(",")})` }} aria-hidden />
          {e.module}
        </li>
      ))}
    </motion.ul>
  );
}

function Diagnosis({ parsed }: { parsed: ReturnType<typeof parseDiagnosis> }) {
  return (
    <div className="space-y-4 p-4">
      {parsed.summary && <p className="text-[13.5px] leading-relaxed text-ink">{parsed.summary}</p>}
      {parsed.issues.length > 0 && (
        <ol className="space-y-2">
          {parsed.issues.map((it) => (
            <li key={it.n} className="rounded-xl bg-elevated p-3">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                {it.severity && <Chip tint={SEV_TINT[it.severity]}>{it.severity}</Chip>}
                {it.modules.map((m) => (
                  <span key={m} className="rounded-md bg-panel px-1.5 py-px font-mono text-[10.5px] text-muted">
                    {m}
                  </span>
                ))}
              </div>
              <p className="text-[12.5px] leading-relaxed text-ink/90">{it.text}</p>
              {it.fix && (
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
                  <span className="font-medium text-accent">Fix</span> {it.fix}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {parsed.rest && <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-muted">{parsed.rest}</pre>}
    </div>
  );
}

function Patch({ cycle }: { cycle: RefineCycle }) {
  const last = cycle.patchResponsePaths[cycle.patchResponsePaths.length - 1];
  const thinking = cycle.patchThinkingPaths[cycle.patchThinkingPaths.length - 1] ?? cycle.diagnoseThinkingPath;
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {cycle.accepted === true ? (
            <Chip tint="ok">
              <Check size={11} weight="bold" /> Accepted
            </Chip>
          ) : cycle.accepted === false ? (
            <Chip tint="err">
              <X size={11} weight="bold" /> Reverted
            </Chip>
          ) : (
            <Chip>No verdict</Chip>
          )}
          {cycle.attempt != null && cycle.attempt > 1 && <Chip>attempt {cycle.attempt}</Chip>}
          {cycle.touched.map((x) => (
            <span key={x} className="rounded-md bg-elevated px-1.5 py-px font-mono text-[10.5px] text-muted">
              {x}
            </span>
          ))}
        </div>
        {cycle.reason && <p className="text-[12.5px] leading-relaxed text-ink/90">{cycle.reason}</p>}
        {thinking && (
          <Disclosure title="Model reasoning">
            <div className="max-h-56 overflow-auto rounded-lg bg-elevated">
              <LazyText path={thinking} />
            </div>
          </Disclosure>
        )}
      </div>
      <div className="min-h-0 flex-1">{last ? <LazyText path={last} /> : <div className="flex h-full items-center justify-center text-[12px] text-faint">No patch was written.</div>}</div>
    </div>
  );
}
