/**
 * Icon + label + tint maps for refine tools and trajectory event types.
 * One icon family (Phosphor), consistent weight.
 */

import type { Icon } from "@phosphor-icons/react";
import {
  ArrowsOutIcon as ArrowsOut,
  CameraIcon as Camera,
  CheckCircleIcon as CheckCircle,
  CircuitryIcon as Circuitry,
  CodeIcon as Code,
  CubeIcon as Cube,
  FlagCheckeredIcon as FlagCheckered,
  GraphIcon as Graph,
  ImageSquareIcon as ImageSquare,
  LightningIcon as Lightning,
  MagnifyingGlassIcon as MagnifyingGlass,
  NotePencilIcon as NotePencil,
  PencilSimpleLineIcon as PencilSimpleLine,
  PlayIcon as Play,
  QuestionIcon as Question,
  StackIcon as Stack,
  TextAlignLeftIcon as TextAlignLeft,
  WrenchIcon as Wrench,
} from "@phosphor-icons/react";

export type Tint = "accent" | "ok" | "warn" | "err" | "muted" | "info";

export const tintClass: Record<Tint, string> = {
  accent: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  muted: "text-muted",
  info: "text-info",
};

export const tintBg: Record<Tint, string> = {
  accent: "bg-accent/10 text-accent",
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/12 text-warn",
  err: "bg-err/10 text-err",
  muted: "bg-elevated text-muted",
  info: "bg-info/12 text-info",
};

interface Meta {
  Icon: Icon;
  label: string;
  tint: Tint;
}

const TOOL_META: Record<string, Meta> = {
  render_views: { Icon: Camera, label: "render views", tint: "accent" },
  compile: { Icon: Wrench, label: "compile", tint: "info" },
  inspect_module: { Icon: MagnifyingGlass, label: "inspect module", tint: "muted" },
  read_scad: { Icon: Code, label: "read scad", tint: "muted" },
  edit_module: { Icon: PencilSimpleLine, label: "edit module", tint: "warn" },
  edit_full: { Icon: NotePencil, label: "edit full", tint: "warn" },
  check_connectivity: { Icon: Graph, label: "check connectivity", tint: "info" },
  finish: { Icon: FlagCheckered, label: "finish", tint: "ok" },
};

export function toolMeta(tool: string): Meta {
  return TOOL_META[tool] ?? { Icon: Circuitry, label: tool, tint: "muted" };
}

const EVENT_META: Record<string, Meta> = {
  "run.started": { Icon: Play, label: "run started", tint: "accent" },
  "run.finished": { Icon: FlagCheckered, label: "run finished", tint: "ok" },
  "message.append": { Icon: TextAlignLeft, label: "message", tint: "muted" },
  "part.append": { Icon: TextAlignLeft, label: "part", tint: "muted" },
  "tool.requested": { Icon: ArrowsOut, label: "tool requested", tint: "info" },
  "tool.executed": { Icon: CheckCircle, label: "tool executed", tint: "ok" },
  "session.created": { Icon: Circuitry, label: "session created", tint: "muted" },
  "compaction.started": { Icon: Stack, label: "compaction started", tint: "warn" },
  "compaction.finished": { Icon: Stack, label: "compaction finished", tint: "warn" },
  "draft.image.started": { Icon: ImageSquare, label: "image gen started", tint: "accent" },
  "draft.image.finished": { Icon: ImageSquare, label: "image gen done", tint: "ok" },
  "draft.image.skipped": { Icon: ImageSquare, label: "image skipped", tint: "muted" },
  "draft.scad.requested": { Icon: Code, label: "scad requested", tint: "accent" },
  "draft.scad.extracted": { Icon: Code, label: "scad extracted", tint: "ok" },
  "draft.scad.failed": { Icon: Code, label: "scad failed", tint: "err" },
  "draft.compile.started": { Icon: Cube, label: "compile started", tint: "info" },
  "draft.compile.finished": { Icon: Cube, label: "compile done", tint: "ok" },
  "draft.compile.failed": { Icon: Cube, label: "compile failed", tint: "err" },
  "draft.connectivity.checked": { Icon: Graph, label: "connectivity checked", tint: "info" },
  "draft.connectivity.fix_requested": { Icon: Graph, label: "connectivity fix", tint: "warn" },
  "draft.connectivity.fix_applied": { Icon: Graph, label: "connectivity fixed", tint: "ok" },
  "draft.connectivity.fix_failed": { Icon: Graph, label: "connectivity fix failed", tint: "err" },
  malformed: { Icon: Question, label: "malformed", tint: "err" },
};

export function eventMeta(type: string): Meta {
  if (EVENT_META[type]) return EVENT_META[type]!;
  if (type.startsWith("tool.")) return { Icon: Lightning, label: type, tint: "info" };
  if (type.startsWith("draft.")) return { Icon: Cube, label: type, tint: "muted" };
  return { Icon: Circuitry, label: type, tint: "muted" };
}
