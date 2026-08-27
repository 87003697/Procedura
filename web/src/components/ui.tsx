import type { ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretRightIcon as CaretRight,
  CheckIcon as Check,
  CopyIcon as Copy,
  WarningIcon as Warning,
  XIcon as X,
} from "@phosphor-icons/react";

import type { RunStatus } from "../../shared/types.ts";
import { tintBg, type Tint } from "../lib/meta.tsx";
import { ease, present, slideIn, spring, useMotion } from "../lib/motion.ts";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ── surfaces ────────────────────────────────────────────────────────────────

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-xl border border-line bg-panel", className)}>{children}</div>;
}

export function PanelHeader({ title, right, className }: { title: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex h-11 items-center justify-between gap-3 border-b border-line px-4", className)}>
      <div className="text-[12px] font-medium text-muted">{title}</div>
      {right}
    </div>
  );
}

/** A labelled group in an inspector column. */
export function Section({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("px-4 py-3", className)}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

// ── chips & status ──────────────────────────────────────────────────────────

export function Chip({ children, tint = "muted", className, title }: { children: ReactNode; tint?: Tint; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-[3px] text-[11px] font-medium", tintBg[tint], className)}
    >
      {children}
    </span>
  );
}

export const STATUS_META: Record<RunStatus, { tint: Tint; label: string }> = {
  ok: { tint: "ok", label: "Complete" },
  "max-steps": { tint: "info", label: "Out of budget" },
  give_up: { tint: "warn", label: "Gave up" },
  incomplete: { tint: "muted", label: "Incomplete" },
  error: { tint: "err", label: "Failed" },
  unknown: { tint: "muted", label: "Unknown" },
};

export function StatusPill({ status, className }: { status: RunStatus; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.unknown;
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11px] font-medium", tintBg[m.tint], className)}>
      <span className="inline-block size-1.5 rounded-full bg-current" aria-hidden />
      {m.label}
    </span>
  );
}

/** A coloured dot with a label — the status of a row, without the pill. */
export function StatusDot({ status }: { status: RunStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.unknown;
  const dot: Record<Tint, string> = { ok: "bg-ok", warn: "bg-warn", err: "bg-err", info: "bg-info", accent: "bg-accent", muted: "bg-faint" };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx("inline-block size-1.5 rounded-full", dot[m.tint])} aria-hidden />
      {m.label}
    </span>
  );
}

// ── sliding highlight ───────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the `[data-active="true"]` descendant sits inside `container`, in the
 *  container's content coordinates (so it scrolls with the content). */
function useActiveRect(container: RefObject<HTMLElement | null>, activeKey: string | number | null, deps: unknown[]): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    const c = container.current;
    if (!c) return;
    const measure = () => {
      const el = c.querySelector<HTMLElement>('[data-active="true"]');
      if (!el) return setRect(null);
      const a = el.getBoundingClientRect();
      const b = c.getBoundingClientRect();
      setRect({ x: a.left - b.left + c.scrollLeft, y: a.top - b.top + c.scrollTop, w: a.width, h: a.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    const el = c.querySelector<HTMLElement>('[data-active="true"]');
    if (el) ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, activeKey, ...deps]);
  return rect;
}

/**
 * The selection highlight that slides between items. One absolutely positioned
 * surface, animated to the active item's measured rect with a spring — no
 * shared-layout projection, so it can live inside sheets and switching views
 * without ever holding an exit open. The container must be `relative`; items
 * mark themselves with `data-active`.
 */
export function SlidingHighlight({ containerRef, activeKey, deps = [], className }: { containerRef: RefObject<HTMLElement | null>; activeKey: string | number | null; deps?: unknown[]; className?: string }) {
  const rect = useActiveRect(containerRef, activeKey, deps);
  const { t } = useMotion();
  if (!rect) return null;
  return (
    <motion.span
      aria-hidden
      initial={false}
      animate={{ x: rect.x, y: rect.y, width: rect.w, height: rect.h }}
      transition={t(spring)}
      className={cx("pointer-events-none absolute left-0 top-0", className)}
    />
  );
}

// ── controls ────────────────────────────────────────────────────────────────

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** An iOS segmented control: the white thumb slides between segments. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  ariaLabel,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} role="group" aria-label={ariaLabel} className={cx("relative inline-flex items-center rounded-lg bg-elevated p-[3px]", className)}>
      <SlidingHighlight containerRef={ref} activeKey={value} deps={[options.length]} className="rounded-md bg-panel shadow-[var(--shadow-thumb)]" />
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            data-active={active ? "true" : undefined}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150",
              size === "sm" ? "px-2.5 py-1 text-[11.5px]" : "px-3.5 py-1.5 text-[12.5px]",
              o.disabled ? "cursor-not-allowed text-faint/50" : active ? "text-ink" : "text-muted hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className,
  disabled,
  onClick,
  title,
  type = "button",
  ariaLabel,
}: {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  type?: "button" | "submit";
  ariaLabel?: string;
}) {
  const { reduce } = useMotion();
  const look: Record<ButtonVariant, string> = {
    primary: "bg-accent text-accent-ink hover:brightness-110 rounded-full",
    secondary: "bg-elevated text-ink hover:bg-line rounded-lg",
    ghost: "text-muted hover:bg-elevated hover:text-ink rounded-lg",
    danger: "text-err hover:bg-err/10 rounded-lg",
  };
  return (
    <motion.button
      type={type}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled || reduce ? undefined : { scale: 0.97 }}
      transition={ease}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 font-medium transition-[background-color,color,filter] duration-150",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3.5 text-[13px]",
        disabled ? "cursor-not-allowed bg-elevated text-faint hover:bg-elevated hover:brightness-100" : look[variant],
        className,
      )}
    >
      {icon}
      {children}
    </motion.button>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  className,
  size = "md",
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
}) {
  const { reduce } = useMotion();
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled || reduce ? undefined : { scale: 0.94 }}
      className={cx(
        "inline-flex items-center justify-center rounded-lg transition-colors duration-150",
        size === "sm" ? "size-7" : "size-8",
        disabled ? "cursor-not-allowed text-faint/40" : active ? "bg-accent/12 text-accent" : "text-muted hover:bg-elevated hover:text-ink",
        className,
      )}
    >
      {icon}
    </motion.button>
  );
}

/** A collapsible group with an animated reveal. */
export function Disclosure({
  title,
  children,
  defaultOpen = false,
  open: controlled,
  onToggle,
  right,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  right?: ReactNode;
  className?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const { reduce } = useMotion();
  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setOwn(next);
    onToggle?.(next);
  };
  return (
    <div className={className}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-[12.5px] font-medium text-ink hover:text-accent"
        >
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={reduce ? { duration: 0 } : spring} className="text-faint">
            <CaretRight size={12} weight="bold" />
          </motion.span>
          <span className="truncate">{title}</span>
        </button>
        {right}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : ease}
            className="overflow-hidden"
          >
            <div className="pb-1 pt-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A modal sheet. Presents with a spring; the caller owns Escape and focus. */
export function Sheet({ children, onClose, label, className }: { children: ReactNode; onClose: () => void; label: string; className?: string }) {
  const { v, t } = useMotion();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={t(ease)}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/30 p-4 backdrop-blur-md sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        variants={v(present)}
        initial="initial"
        animate="animate"
        exit="exit"
        className={cx("mt-[6vh] w-full rounded-2xl border border-line bg-panel shadow-[var(--shadow-sheet)]", className)}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

/** A panel that slides in over the trailing edge of the content. */
export function SlideOver({ children, onClose, label, title, width = "w-[560px]" }: { children: ReactNode; onClose: () => void; label: string; title: ReactNode; width?: string }) {
  const { v, t } = useMotion();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={t(ease)}
      className="absolute inset-0 z-40 flex justify-end bg-black/20"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        variants={v(slideIn)}
        initial="initial"
        animate="animate"
        exit="exit"
        className={cx("flex h-full max-w-full flex-col border-l border-line bg-panel shadow-[var(--shadow-sheet)]", width)}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line pl-5 pr-3">
          <div className="text-[14px] font-semibold">{title}</div>
          <IconButton icon={<X size={16} />} label="Close" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </motion.div>
    </motion.div>
  );
}

/** A determinate ring, or an indeterminate one when `value` is null. */
export function ProgressRing({ value, size = 28, stroke = 3, className }: { value: number | null; size?: number; stroke?: number; className?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const { t } = useMotion();
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cx(value == null ? "animate-spin text-accent" : "text-accent", className)} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth={stroke} />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        initial={false}
        animate={{ strokeDashoffset: c * (1 - Math.max(0.04, Math.min(1, value ?? 0.28))) }}
        transition={t(ease)}
        style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%" }}
      />
    </svg>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label || (done ? "Copied" : "Copy")}
      title={label || "Copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-ink active:scale-[0.97]"
    >
      {done ? <Check size={13} weight="bold" className="text-ok" /> : <Copy size={13} />}
      {label ?? (done ? "copied" : "copy")}
    </button>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 p-8 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-[15px] font-medium text-ink">{title}</div>
      {children && <div className="max-w-md text-[13px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center">
      <Warning size={26} className="text-err" />
      <div className="text-[14px] font-medium text-ink">Something went wrong</div>
      <div className="max-w-md font-mono text-[12px] leading-relaxed text-muted">{message}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("shimmer rounded-lg", className)} />;
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cx("animate-spin text-accent", className)} aria-label="loading">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Small functional label above a data block. Used sparingly. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{children}</div>;
}
