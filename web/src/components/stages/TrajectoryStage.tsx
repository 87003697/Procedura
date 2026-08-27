import { useEffect, useMemo, useState } from "react";
import { CaretRightIcon as CaretRight, PulseIcon as Pulse } from "@phosphor-icons/react";

import type { RunDetail, TrajectoryData, TrajectoryEvent } from "../../../shared/types.ts";
import { api } from "../../api.ts";
import { eventMeta, tintBg } from "../../lib/meta.tsx";
import { fmtDuration, fmtTsDelta } from "../../lib/format.ts";
import { Chip, Empty, ErrorState, Segmented, Skeleton, cx } from "../ui.tsx";

type Filter = "all" | "draft" | "refine";

export function TrajectoryStage({ run }: { run: RunDetail }) {
  const [data, setData] = useState<TrajectoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    api
      .trajectory(run.id, undefined, ctrl.signal)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => {
        if (!cancelled && (e as Error).name !== "AbortError") setError((e as Error).message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [run.id]);

  const events = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.events;
    return data.events.filter((e) => e.phase === filter);
  }, [data, filter]);

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorState message={error} />;
  if (!data || !data.events.length) {
    return (
      <Empty icon={<Pulse size={30} />} title="No trajectory">
        No <span className="font-mono text-muted">_trajectory/*.jsonl</span> was found for this run.
      </Empty>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `all ${data.events.length}` },
            { value: "draft", label: "draft" },
            { value: "refine", label: "refine" },
          ]}
        />
        <div className="flex items-center gap-2 text-[11px] text-faint">
          {data.phases.map((p) => (
            <Chip key={p.index} tint={p.kind === "draft" ? "accent" : p.kind === "refine" ? "info" : "muted"}>
              {p.kind} · {fmtDuration(p.endTs - p.startTs)}
              {p.reason ? ` · ${p.reason}` : ""}
            </Chip>
          ))}
        </div>
        <span className="ml-auto truncate font-mono text-[11px] text-faint" title={data.file}>
          {data.file.split("/").pop()}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {data.truncated && (
          <div className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-[12px] text-warn">
            Event log truncated for display.
          </div>
        )}
        <ol>
          {events.map((e, i) => (
            <EventRow key={`${e.seq}-${i}`} event={e} prevTs={i > 0 ? events[i - 1]!.ts : e.ts} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function summarize(e: TrajectoryEvent): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "tool.requested":
    case "tool.executed":
      return String(p["toolName"] ?? "");
    case "message.append":
      return String(p["role"] ?? "");
    case "part.append":
      return String(p["kind"] ?? "");
    case "run.finished":
      return String(p["reason"] ?? "");
    case "draft.image.started":
      return String(p["model"] ?? "");
    case "draft.image.finished":
      return p["bytes"] ? `${p["bytes"]} bytes` : "";
    case "draft.scad.requested":
    case "draft.scad.extracted":
      return p["chars"] ? `${p["chars"]} chars` : String(p["model"] ?? "");
    case "draft.compile.finished":
      return p["stlBytes"] ? `${p["stlBytes"]} bytes` : "";
    case "draft.connectivity.checked":
      return p["floaterCount"] != null ? `${p["floaterCount"]} floaters` : "";
    default:
      return "";
  }
}

function EventRow({ event, prevTs }: { event: TrajectoryEvent; prevTs: number }) {
  const [open, setOpen] = useState(false);
  const meta = eventMeta(event.type);
  const Icon = meta.Icon;
  const detail = summarize(event);
  const hasPayload = Object.keys(event.payload ?? {}).length > 0;

  return (
    <li className="border-b border-line/60">
      <button
        onClick={() => hasPayload && setOpen((o) => !o)}
        aria-expanded={hasPayload ? open : undefined}
        aria-disabled={!hasPayload}
        className={cx(
          "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-panel/60",
          hasPayload ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span className="w-9 shrink-0 text-right font-mono text-[11px] text-faint">{event.seq}</span>
        <span className="w-12 shrink-0 text-right font-mono text-[10.5px] text-faint">
          {fmtTsDelta(event.ts, prevTs)}
        </span>
        <span className={cx("flex size-6 shrink-0 items-center justify-center rounded-md", tintBg[meta.tint])}>
          <Icon size={14} />
        </span>
        <span className="min-w-0 truncate font-mono text-[12px] text-ink">{event.type}</span>
        {detail && <span className="truncate font-mono text-[12px] text-muted">{detail}</span>}
        {hasPayload && (
          <CaretRight
            size={13}
            className={cx("ml-auto shrink-0 text-faint transition-transform", open && "rotate-90")}
          />
        )}
      </button>
      {open && hasPayload && (
        <pre className="overflow-auto border-t border-line bg-bg/50 px-4 py-2 font-mono text-[11px] leading-relaxed text-muted">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </li>
  );
}
