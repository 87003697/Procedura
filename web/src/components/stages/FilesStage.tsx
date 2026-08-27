import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpIcon as ArrowUp,
  BracketsCurlyIcon as Braces,
  CaretRightIcon as CaretRight,
  CodeIcon as Code,
  CubeIcon as Cube,
  DownloadSimpleIcon as Download,
  FileIcon as File,
  FileTextIcon as FileText,
  FolderIcon as Folder,
  ImageSquareIcon as ImageSquare,
} from "@phosphor-icons/react";

import type { DirEntry, DirListing, RunDetail } from "../../../shared/types.ts";
import { api, downloadUrl, fetchText } from "../../api.ts";
import { fmtBytes } from "../../lib/format.ts";
import { MeshViewer } from "../MeshViewer.tsx";
import { ScadPanel } from "../ScadPanel.tsx";
import { ImageView } from "../images.tsx";
import { cx, ErrorState, Skeleton, Spinner } from "../ui.tsx";

const KIND_ICON = {
  dir: Folder,
  image: ImageSquare,
  mesh: Cube,
  scad: Code,
  json: Braces,
  text: FileText,
  other: File,
} as const;

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function FilesStage({ run }: { run: RunDetail }) {
  const [sub, setSub] = useState("");
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<DirEntry | null>(null);

  useEffect(() => {
    // reset to root when the run changes
    setSub("");
    setSelected(null);
  }, [run.id]);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .ls(run.id, sub, ctrl.signal)
      .then((d) => !cancelled && setListing(d))
      .catch((e: unknown) => {
        if (!cancelled && (e as Error).name !== "AbortError") setError((e as Error).message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [run.id, sub]);

  const crumbs = useMemo(() => (sub ? sub.split("/") : []), [sub]);

  const enter = (entry: DirEntry) => {
    if (entry.isDir) {
      setSelected(null);
      setSub(sub ? `${sub}/${entry.name}` : entry.name);
    } else {
      setSelected(entry);
    }
  };

  return (
    <div className="grid h-full grid-rows-[1fr_1fr] gap-3 p-4 lg:grid-cols-[minmax(280px,360px)_1fr] lg:grid-rows-1">
      {/* file tree column */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel">
        {/* breadcrumb */}
        <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-3 py-2 text-[12px]">
          <button
            onClick={() => setSub("")}
            className={cx("rounded px-1.5 py-0.5 font-mono hover:bg-elevated", sub ? "text-accent" : "text-ink")}
          >
            {run.name}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <CaretRight size={11} className="text-faint" aria-hidden />
              <button
                onClick={() => setSub(crumbs.slice(0, i + 1).join("/"))}
                className={cx(
                  "rounded px-1.5 py-0.5 font-mono hover:bg-elevated",
                  i === crumbs.length - 1 ? "text-ink" : "text-accent",
                )}
              >
                {c}
              </button>
            </span>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loading && !listing ? (
            <div className="space-y-1.5 px-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-7" />
              ))}
            </div>
          ) : error ? (
            <ErrorState message={error} />
          ) : (
            <ul>
              {sub && (
                <li>
                  <button
                    onClick={() => setSub(crumbs.slice(0, -1).join("/"))}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted hover:bg-elevated/60"
                  >
                    <ArrowUp size={15} className="text-faint" />
                    <span className="font-mono text-[12px]">..</span>
                  </button>
                </li>
              )}
              {listing?.entries.map((entry) => {
                const Icon = KIND_ICON[entry.kind];
                const active = !entry.isDir && selected?.path === entry.path;
                return (
                  <li key={entry.path}>
                    <button
                      onClick={() => enter(entry)}
                      className={cx(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                        active ? "bg-accent/10 text-ink" : "hover:bg-elevated/60",
                      )}
                    >
                      <Icon
                        size={15}
                        weight={entry.isDir ? "fill" : "regular"}
                        className={entry.isDir ? "text-accent-dim" : "text-faint"}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink/90">
                        {entry.name}
                      </span>
                      {entry.isDir ? (
                        <CaretRight size={12} className="shrink-0 text-faint" />
                      ) : (
                        <span className="shrink-0 font-mono text-[10.5px] text-faint">{fmtBytes(entry.bytes)}</span>
                      )}
                    </button>
                  </li>
                );
              })}
              {listing && listing.entries.length === 0 && (
                <li className="px-3 py-4 text-[13px] text-faint">empty directory</li>
              )}
            </ul>
          )}
        </div>
      </div>

      {/* preview column */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel">
        {selected ? (
          <FilePreview entry={selected} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-faint">
            <Folder size={28} weight="fill" className="text-line-strong" />
            <p className="text-[13px]">Select a file to preview it, or open a folder to browse.</p>
            <p className="max-w-sm text-[12px] leading-relaxed text-faint">
              Every artifact this run wrote is here: the build intermediates
              (<span className="font-mono">_draft_build</span>,{" "}
              <span className="font-mono">_agent_compiles</span>), per-part meshes
              (<span className="font-mono">parts_color/_parts</span>), and the raw logs.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function FilePreview({ entry }: { entry: DirEntry }) {
  const e = ext(entry.name);
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-faint">{fmtBytes(entry.bytes)}</span>
        </div>
        <a
          href={downloadUrl(entry.path)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-ink"
        >
          <Download size={13} /> download
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {entry.kind === "image" ? (
          <ImageView path={entry.path} alt={entry.name} className="h-full" />
        ) : entry.kind === "scad" ? (
          <ScadPanel path={entry.path} className="h-full" />
        ) : e === ".stl" || e === ".obj" ? (
          <MeshViewer path={entry.path} className="h-full rounded-none" />
        ) : entry.kind === "text" || entry.kind === "json" || e === ".log" ? (
          <TextPreview path={entry.path} pretty={entry.kind === "json"} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-faint">
            <File size={26} />
            <p className="text-[13px]">No inline preview for this file type.</p>
            <a href={downloadUrl(entry.path)} className="text-[12px] text-accent hover:underline">
              download {entry.name}
            </a>
          </div>
        )}
      </div>
    </>
  );
}

const TEXT_PREVIEW_LIMIT = 400_000;

function TextPreview({ path, pretty }: { path: string; pretty: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setText(null);
    fetchText(path, ctrl.signal)
      .then((t) => {
        if (cancelled) return;
        let body = t;
        if (pretty) {
          try {
            body = JSON.stringify(JSON.parse(t), null, 2);
          } catch {
            /* keep raw */
          }
        }
        setText(body.length > TEXT_PREVIEW_LIMIT ? body.slice(0, TEXT_PREVIEW_LIMIT) + "\n… (truncated)" : body);
      })
      .catch((err: unknown) => {
        if (!cancelled && (err as Error).name !== "AbortError") setError((err as Error).message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [path, pretty]);

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (error) return <ErrorState message={error} />;
  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap break-words bg-bg/40 p-4 font-mono text-[12px] leading-relaxed text-ink/90">
      {text}
    </pre>
  );
}
