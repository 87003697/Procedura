import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { StackIcon as Stack } from "@phosphor-icons/react";

import type { IncrementalPart, RunDetail } from "../../../shared/types.ts";
import { fetchText } from "../../api.ts";
import { fade, useMotion } from "../../lib/motion.ts";
import { ScadPanel } from "../ScadPanel.tsx";
import { ViewGallery } from "../images.tsx";
import { TextBlock } from "../TextBlock.tsx";
import { Chip, Disclosure, Empty, ErrorState, Segmented, Skeleton, SlidingHighlight, cx } from "../ui.tsx";

type Detail = "render" | "code" | "response";

function LazyText({ path, mono = false }: { path: string; mono?: boolean }) {
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

function partState(p: IncrementalPart): { dot: string; label: string | null } {
  if (!p.generated) return { dot: "bg-err", label: "failed" };
  if (p.connected === false) return { dot: "bg-warn", label: "floater" };
  return { dot: "bg-ok", label: null };
}

/**
 * The plan being built, as a timeline: every planned part in order down the
 * left, the selected part's evidence on the right.
 */
export function BuildView({ run }: { run: RunDetail }) {
  const inc = run.incremental;
  const [sel, setSel] = useState(0);
  const [detail, setDetail] = useState<Detail>("render");
  const { v } = useMotion();
  const listRef = useRef<HTMLOListElement>(null);

  if (!inc) {
    return (
      <Empty icon={<Stack size={30} />} title="Not a part-by-part run">
        This run was drafted in one shot, so there is no plan to walk through.
      </Empty>
    );
  }
  const part = inc.parts[Math.min(sel, Math.max(0, inc.parts.length - 1))];
  // A part without a build render (the first one, or a run without 3D
  // feedback) opens on its code instead of an empty pane.
  const shown: Detail = part && detail === "render" && part.contextViews.length === 0 ? (part.scadPath ? "code" : "response") : detail;

  return (
    <div className="grid h-full grid-cols-1 gap-4 px-6 pb-6 lg:grid-cols-[300px_1fr]">
      <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Plan</span>
          <span className="font-mono text-[11px] text-faint">
            {inc.partsGenerated}/{inc.plan.length}
            {inc.floaterParts > 0 && <span className="text-warn"> · {inc.floaterParts} floating</span>}
          </span>
        </div>
        <ol ref={listRef} className="relative min-h-0 flex-1 overflow-auto px-2 pb-2">
          <SlidingHighlight containerRef={listRef} activeKey={sel} deps={[inc.parts.length]} className="rounded-lg bg-accent/10" />
          {inc.parts.map((p, i) => {
            const active = i === sel;
            const st = partState(p);
            return (
              <li key={`${p.index}-${p.name}`}>
                <button
                  type="button"
                  onClick={() => setSel(i)}
                  aria-current={active ? "true" : undefined}
                  data-active={active ? "true" : undefined}
                  className={cx("relative flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors", !active && "hover:bg-elevated/70")}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-elevated font-mono text-[10.5px] text-muted">{p.index}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cx("block truncate font-mono text-[12.5px]", active ? "text-ink" : "text-ink/85")}>{p.placedName ?? p.name}</span>
                    {p.level && <span className="block text-[10.5px] text-faint">{p.level}</span>}
                  </span>
                  <span className={cx("size-1.5 shrink-0 rounded-full", st.dot)} title={st.label ?? "built"} />
                </button>
              </li>
            );
          })}
        </ol>
        {inc.planResponsePath && (
          <div className="border-t border-line px-4 py-2">
            <Disclosure title="Planner output">
              <div className="max-h-56 overflow-auto rounded-lg bg-elevated">
                <LazyText path={inc.planResponsePath} />
              </div>
            </Disclosure>
          </div>
        )}
      </div>

      {part ? (
        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex flex-wrap items-center gap-2 px-5 pb-3 pt-4">
            <h2 className="font-mono text-[14px] font-semibold text-ink">
              {part.index}. {part.placedName ?? part.name}
            </h2>
            {part.level && <Chip>{part.level}</Chip>}
            {!part.generated && <Chip tint="err">failed</Chip>}
            {part.generated && part.connected === false && <Chip tint="warn">floating</Chip>}
            {part.genAttempts > 1 && <Chip>{part.genAttempts} attempts</Chip>}
            <div className="ml-auto">
              <Segmented
                size="sm"
                value={shown}
                onChange={setDetail}
                ariaLabel="Part detail"
                options={[
                  { value: "render", label: "Render", disabled: part.contextViews.length === 0 },
                  { value: "code", label: "Code", disabled: !part.scadPath },
                  { value: "response", label: "Response", disabled: part.genResponsePaths.length === 0 },
                ]}
              />
            </div>
          </div>
          {part.description && <p className="px-5 pb-3 text-[12.5px] leading-relaxed text-muted">{part.description}</p>}
          {part.error && <p className="mx-5 mb-3 rounded-lg bg-err/8 px-3 py-2 font-mono text-[12px] text-err">{part.error}</p>}
          <div className="relative min-h-0 flex-1 border-t border-line">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={`${part.index}-${shown}`} variants={v(fade)} initial="initial" animate="animate" exit="exit" className="absolute inset-0">
                {shown === "render" &&
                  (part.contextViews.length ? (
                    <ViewGallery views={part.contextViews} alt={`build before ${part.name}`} className="h-full p-3" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[13px] text-faint">
                      {part.index <= 1 ? "The first part has nothing to build against." : "No build render for this part — 3D feedback was off."}
                    </div>
                  ))}
                {shown === "code" && (part.scadPath ? <ScadPanel path={part.scadPath} className="h-full" /> : null)}
                {shown === "response" && part.genResponsePaths.length > 0 && (
                  <LazyText path={part.genResponsePaths[part.genResponsePaths.length - 1]!} mono />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      ) : (
        <Empty icon={<Stack size={28} />} title="No parts" />
      )}
    </div>
  );
}
