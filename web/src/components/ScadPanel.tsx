import { useEffect, useMemo, useRef, useState } from "react";

import { fetchText } from "../api.ts";
import { findModuleSpans, tokenizeScad, type TokenKind } from "../lib/scad.ts";
import { CopyButton, cx, ErrorState, Skeleton } from "./ui.tsx";

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "text-ink/90",
  keyword: "text-accent",
  builtin: "text-info",
  number: "text-warn",
  comment: "text-faint italic",
  string: "text-ok",
  special: "text-accent-dim",
};

export function ScadPanel({
  path,
  text: textProp,
  className,
}: {
  path?: string | null;
  text?: string | null;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(textProp ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (textProp != null) {
      setText(textProp);
      return;
    }
    if (!path) {
      setText(null);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetchText(path, ctrl.signal)
      .then((t) => !cancelled && setText(t))
      .catch((e: unknown) => {
        if (!cancelled && (e as Error).name !== "AbortError") setError((e as Error).message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [path, textProp]);

  const { lines, modules } = useMemo(() => {
    if (!text) return { lines: [] as ReturnType<typeof tokenizeScad>, modules: [] };
    return { lines: tokenizeScad(text), modules: findModuleSpans(text) };
  }, [text]);

  const jump = (line: number) => {
    const el = lineRefs.current.get(line);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (loading && text == null) {
    return (
      <div className={cx("space-y-2 p-4", className)}>
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-3.5" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorState message={error} />;
  if (!text) {
    return (
      <div className={cx("flex items-center justify-center p-6 text-[13px] text-faint", className)}>
        no SCAD source
      </div>
    );
  }

  return (
    <div className={cx("flex min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
          <span className="shrink-0 font-mono text-[11px] text-faint">
            {lines.length} lines · {modules.length} modules
          </span>
          {modules.slice(0, 40).map((m) => (
            <button
              key={`${m.name}-${m.start}`}
              onClick={() => jump(m.startLine)}
              className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-muted transition-colors hover:text-accent"
              title={`jump to ${m.name} (line ${m.startLine})`}
            >
              {m.name}
            </button>
          ))}
        </div>
        <CopyButton text={text} />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-bg/40">
        <pre className="min-w-full font-mono text-[12px] leading-[1.55]">
          <code>
            {lines.map((tokens, idx) => {
              const lineNo = idx + 1;
              return (
                <div
                  key={lineNo}
                  ref={(el) => {
                    if (el) lineRefs.current.set(lineNo, el);
                  }}
                  className="group flex hover:bg-panel/60"
                >
                  <span className="sticky left-0 w-12 shrink-0 select-none bg-bg/60 px-3 text-right text-faint group-hover:text-muted">
                    {lineNo}
                  </span>
                  <span className="whitespace-pre px-3">
                    {tokens.length === 0 ? (
                      " "
                    ) : (
                      tokens.map((t, ti) => (
                        <span key={ti} className={TOKEN_CLASS[t.kind]}>
                          {t.text}
                        </span>
                      ))
                    )}
                  </span>
                </div>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}
