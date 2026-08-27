import type { ReactNode } from "react";

import { CopyButton, cx } from "./ui.tsx";

export function TextBlock({
  text,
  mono = false,
  title,
  icon,
  className,
  bodyClassName,
  emptyLabel = "empty",
}: {
  text: string | null | undefined;
  mono?: boolean;
  title?: ReactNode;
  icon?: ReactNode;
  className?: string;
  bodyClassName?: string;
  emptyLabel?: string;
}) {
  const has = !!text && text.trim().length > 0;
  return (
    <div className={cx("flex min-h-0 flex-col rounded-lg border border-line bg-panel", className)}>
      {title && (
        <div className="flex h-10 items-center justify-between gap-3 border-b border-line px-3.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-muted">
            {icon}
            {title}
          </div>
          {has && <CopyButton text={text!} />}
        </div>
      )}
      <div className={cx("min-h-0 flex-1 overflow-auto p-3.5", bodyClassName)}>
        {has ? (
          <p
            className={cx(
              "whitespace-pre-wrap break-words",
              mono
                ? "font-mono text-[12px] leading-relaxed text-ink/90"
                : "text-[13.5px] leading-relaxed text-ink/90",
            )}
          >
            {text}
          </p>
        ) : (
          <div className="text-[13px] text-faint">{emptyLabel}</div>
        )}
      </div>
    </div>
  );
}
