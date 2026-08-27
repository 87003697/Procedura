export function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtRelTime(epochMs: number): string {
  if (!epochMs) return "n/a";
  const diff = Date.now() - epochMs;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtClock(epochMs: number): string {
  if (!epochMs) return "n/a";
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Compact duration from a millisecond span. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/** "+1.2s" style delta relative to a previous timestamp. */
export function fmtTsDelta(ts: number, prevTs: number): string {
  if (!ts || !prevTs) return "";
  const d = ts - prevTs;
  if (d <= 0) return "+0";
  if (d < 1000) return `+${d}ms`;
  return `+${(d / 1000).toFixed(d < 10000 ? 1 : 0)}s`;
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

export function fmtNum(n: number): string {
  return n.toLocaleString();
}
