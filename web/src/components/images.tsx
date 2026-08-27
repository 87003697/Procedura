import { useEffect, useState } from "react";
import { ArrowSquareOutIcon as ArrowSquareOut } from "@phosphor-icons/react";

import type { ViewImage } from "../../shared/types.ts";
import { fileUrl } from "../api.ts";
import { basename } from "../lib/format.ts";
import { cx, Segmented, Spinner } from "./ui.tsx";

export function ImageView({
  path,
  alt,
  className,
}: {
  path: string | null;
  alt: string;
  className?: string;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    setState(path ? "loading" : "error");
  }, [path]);

  if (!path) {
    return (
      <div className={cx("grid-backdrop flex items-center justify-center", className)}>
        <span className="text-[13px] text-faint">no image</span>
      </div>
    );
  }

  return (
    <div className={cx("group relative grid-backdrop overflow-hidden", className)}>
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size={20} />
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[13px] text-faint">image unavailable</span>
        </div>
      )}
      <img
        src={fileUrl(path)}
        alt={alt}
        onLoad={() => setState("ready")}
        onError={() => setState("error")}
        className={cx(
          "h-full w-full object-contain transition-opacity duration-300",
          state === "ready" ? "opacity-100" : "opacity-0",
        )}
      />
      <a
        href={fileUrl(path)}
        target="_blank"
        rel="noreferrer"
        title={`open ${basename(path)}`}
        className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-line bg-panel/85 px-2 py-1 text-[11px] text-muted opacity-0 backdrop-blur transition-opacity hover:text-ink group-hover:opacity-100"
      >
        <ArrowSquareOut size={12} /> open
      </a>
    </div>
  );
}

export function ViewGallery({
  views,
  className,
  alt,
}: {
  views: ViewImage[];
  className?: string;
  alt: string;
}) {
  const [active, setActive] = useState(views[0]?.view ?? "");

  useEffect(() => {
    if (views.length && !views.some((v) => v.view === active)) {
      setActive(views[0]!.view);
    }
  }, [views, active]);

  if (!views.length) {
    return (
      <div className={cx("grid-backdrop flex items-center justify-center", className)}>
        <span className="text-[13px] text-faint">no renders</span>
      </div>
    );
  }

  const current = views.find((v) => v.view === active) ?? views[0]!;

  return (
    <div className={cx("flex min-h-0 flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        <Segmented
          size="sm"
          value={current.view}
          onChange={setActive}
          options={views.map((v) => ({ value: v.view, label: v.view }))}
        />
      </div>
      <ImageView path={current.path} alt={`${alt}: ${current.view} view`} className="min-h-0 flex-1 rounded-md border border-line" />
    </div>
  );
}
