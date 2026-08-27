import { useState } from "react";
import {
  CheckCircleIcon as CheckCircle,
  DownloadSimpleIcon as Download,
  GearSixIcon as GearSix,
  MinusCircleIcon as MinusCircle,
  WarningCircleIcon as WarningCircle,
  XCircleIcon as XCircle,
} from "@phosphor-icons/react";

import type { MotionJoint, RunDetail } from "../../../shared/types.ts";
import { downloadUrl, fileUrl } from "../../api.ts";
import { MeshViewer, meshPathOf } from "../MeshViewer.tsx";
import { ViewGallery } from "../images.tsx";
import { Chip, Empty, Segmented, cx } from "../ui.tsx";

type Visual = "views" | "3d" | "videos";
type Side = "joints" | "links" | "validation";

const JOINT_TINT: Record<string, string> = {
  revolute: "text-accent",
  prismatic: "text-info",
  continuous: "text-accent",
  fixed: "text-faint",
  spherical: "text-warn",
  gear: "text-ok",
  rack: "text-ok",
};

const PHASE_LABEL: Record<string, string> = {
  schemaAudit: "schema audit",
  assetRules: "asset rules",
  simulation: "simulation",
  actuation: "actuation sweep",
  contacts: "rest contacts",
  mobility: "mobility",
  urdfRoundTrip: "URDF round-trip",
};

/**
 * Phase 4. What the planner decided (links, joints, limits, drives), what it
 * looked at to decide it, and whether Isaac agreed.
 */
export function MotionStage({ run }: { run: RunDetail }) {
  const m = run.motion;
  const [visual, setVisual] = useState<Visual>(m?.feedbackViews.length ? "views" : "3d");
  const [side, setSide] = useState<Side>("joints");

  if (!m) {
    return (
      <Empty icon={<GearSix size={30} />} title="No articulation">
        This run did not go through the motion pass. Re-run it with{" "}
        <span className="font-mono text-muted">--motion</span>, or articulate a finished run with{" "}
        <span className="font-mono text-muted">scripts/motion.ts &lt;runDir&gt;</span>.
      </Empty>
    );
  }

  const v = m.validation;
  const movable = m.joints.filter((j) => j.type !== "fixed").length;
  const finalMesh = meshPathOf(run.final);
  const hasVideos = v.videos.length > 0;

  return (
    <div className="flex h-full flex-col gap-3 px-6 pb-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
        <span className="font-medium text-ink">
          {m.links.length} links · {m.joints.length} joints
          {movable !== m.joints.length && <span className="font-normal text-muted"> ({movable} movable)</span>}
        </span>
        {m.fixedBase != null && (
          <>
            <span className="text-faint">·</span>
            <span>{m.fixedBase ? "fixed base" : "floating base"}</span>
          </>
        )}
        {m.plannerModel && (
          <>
            <span className="text-faint">·</span>
            <span>
              planned by <span className="font-mono text-[11.5px]">{m.plannerModel}</span>
            </span>
          </>
        )}
        <span className="text-faint">·</span>
        <ValidationPill v={v} />
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-2 gap-4 lg:grid-cols-[1.1fr_1fr] lg:grid-rows-1">
        <div className="flex min-h-0 flex-col gap-2 rounded-2xl bg-elevated p-3">
          <Segmented
            size="sm"
            value={visual}
            onChange={setVisual}
            className="self-start"
            options={[
              { value: "views", label: "Planner views", disabled: m.feedbackViews.length === 0 },
              { value: "3d", label: "3D", disabled: !finalMesh },
              { value: "videos", label: hasVideos ? `Sweeps · ${v.videos.length}` : "Sweeps", disabled: !hasVideos },
            ]}
          />
          {visual === "views" ? (
            <ViewGallery views={m.feedbackViews} alt="parts-colour views the planner saw" className="min-h-0 flex-1" />
          ) : visual === "videos" ? (
            <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-auto rounded-xl">
              {v.videos.map((p) => (
                <video key={p} src={fileUrl(p)} controls muted loop playsInline className="w-full rounded-md border border-line bg-bg" />
              ))}
            </div>
          ) : (
            <MeshViewer path={finalMesh} className="min-h-0 flex-1 rounded-xl" />
          )}
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Segmented
              size="sm"
              value={side}
              onChange={setSide}
              options={[
                { value: "joints", label: "Joints" },
                { value: "links", label: "Links" },
                { value: "validation", label: "Validation" },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {side === "joints" && <JointsTable joints={m.joints} root={m.rootLink} />}
            {side === "links" && (
              <ul className="divide-y divide-line">
                {m.links.map((l) => (
                  <li key={l.name} className="flex items-start gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[12.5px] text-ink">{l.name}</span>
                        {l.name === m.rootLink && <Chip tint="accent">root</Chip>}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] leading-relaxed text-faint">
                        {l.parts.length ? l.parts.join(" · ") : "no parts listed"}
                      </span>
                    </span>
                    {l.objPath && (
                      <a href={downloadUrl(l.objPath)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] text-muted hover:bg-elevated hover:text-ink">
                        <Download size={12} /> obj
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {side === "validation" && <ValidationPanel run={run} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ValidationPill({ v }: { v: RunDetail["motion"] extends infer M ? (M extends { validation: infer V } ? V : never) : never }) {
  if (!v || !v.ran) {
    return (
      <Chip tint="muted" title={v?.skippedReason ?? undefined}>
        <MinusCircle size={12} /> not validated{v?.skippedReason ? ` · ${v.skippedReason}` : ""}
      </Chip>
    );
  }
  if (v.ok === true)
    return (
      <Chip tint="ok">
        <CheckCircle size={12} weight="fill" /> Isaac validated
      </Chip>
    );
  if (v.ok === false)
    return (
      <Chip tint="err">
        <XCircle size={12} weight="fill" /> validation failed
      </Chip>
    );
  return (
    <Chip tint="warn">
      <WarningCircle size={12} /> validated · verdict unknown
    </Chip>
  );
}

function fmtLimit(j: MotionJoint): string {
  if (!j.limit) return j.type === "continuous" ? "∞" : "—";
  const unit = j.type === "prismatic" ? "" : "°";
  return `${j.limit[0]}${unit} … ${j.limit[1]}${unit}`;
}

function JointsTable({ joints, root }: { joints: MotionJoint[]; root: string | null }) {
  if (!joints.length) {
    return <div className="flex h-full items-center justify-center text-[13px] text-faint">the plan has no joints</div>;
  }
  return (
    <table className="w-full text-[12px]">
      <thead className="sticky top-0 bg-panel text-left font-mono text-[10.5px] uppercase tracking-wide text-faint">
        <tr>
          <th className="px-3 py-2 font-medium">joint</th>
          <th className="px-3 py-2 font-medium">type</th>
          <th className="px-3 py-2 font-medium">parent → child</th>
          <th className="px-3 py-2 font-medium">axis</th>
          <th className="px-3 py-2 font-medium">limits</th>
          <th className="px-3 py-2 font-medium">drive</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line/70">
        {joints.map((j) => (
          <tr key={j.name} className="hover:bg-elevated/40">
            <td className="px-3 py-1.5 font-mono text-ink">{j.name}</td>
            <td className={cx("px-3 py-1.5 font-mono", JOINT_TINT[j.type] ?? "text-muted")}>{j.type}</td>
            <td className="px-3 py-1.5 font-mono text-muted">
              <span className={cx(j.parent === root && "text-accent")}>{j.parent ?? "world"}</span>
              <span className="text-faint"> → </span>
              {j.child}
            </td>
            <td className="px-3 py-1.5 font-mono text-muted">{j.axis ?? "—"}</td>
            <td className="px-3 py-1.5 font-mono text-muted">{fmtLimit(j)}</td>
            <td className="px-3 py-1.5 font-mono text-muted">
              {j.mimic ? <span title={`mimics ${j.mimic}`}>mimic · {j.mimic}</span> : j.hasDrive ? "yes" : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ValidationPanel({ run }: { run: RunDetail }) {
  const m = run.motion!;
  const v = m.validation;
  const phaseEntries = Object.entries(v.phases);
  return (
    <div className="space-y-4 p-4 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <ValidationPill v={v} />
      </div>
      {phaseEntries.length > 0 && (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {phaseEntries.map(([k, ok]) => (
            <li key={k} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
              {ok === true ? (
                <CheckCircle size={14} weight="fill" className="text-ok" />
              ) : ok === false ? (
                <XCircle size={14} weight="fill" className="text-err" />
              ) : (
                <MinusCircle size={14} className="text-faint" />
              )}
              <span className={ok == null ? "text-faint" : "text-ink"}>{PHASE_LABEL[k] ?? k}</span>
            </li>
          ))}
        </ul>
      )}
      {v.errors.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-err">errors</div>
          <ul className="space-y-1 font-mono text-[11.5px] leading-relaxed text-err/90">
            {v.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {(v.warnings.length > 0 || m.warnings.length > 0) && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-warn">warnings</div>
          <ul className="space-y-1 font-mono text-[11.5px] leading-relaxed text-muted">
            {[...m.warnings, ...v.warnings].map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {!v.ran && v.errors.length === 0 && (
        <p className="leading-relaxed text-muted">
          Headless validation loads the exported USD into Isaac Sim, audits the physics schema, simulates it for a
          few hundred frames, and sweeps every drive. It runs when Isaac Sim is installed and{" "}
          <span className="font-mono">--motion</span> is on; set{" "}
          <span className="font-mono">PROCEDURA_ISAACSIM_PATH</span> if it is somewhere unusual.
        </p>
      )}
    </div>
  );
}
