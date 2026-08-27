import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CubeIcon as Cube,
  ImageSquareIcon as ImageSquare,
  SparkleIcon as Sparkle,
  UploadSimpleIcon as UploadSimple,
  WarningCircleIcon as WarningCircle,
  XIcon as X,
} from "@phosphor-icons/react";

import type { Capabilities, GenerateRequest, JobRecord, Preset, ServerInfo } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ease, useMotion } from "../lib/motion.ts";
import { Button, Disclosure, IconButton, Segmented, Sheet, cx } from "./ui.tsx";

type RefMode = "upload" | "generate" | "none";

interface Pipeline {
  oneShot: boolean;
  contextRenders: boolean;
  assembly: boolean;
  paint: boolean;
  motion: boolean;
  motionUrdf: boolean;
  maxSteps: number;
}

const DEFAULT_PIPELINE = (steps: number): Pipeline => ({
  oneShot: false,
  contextRenders: false,
  assembly: false,
  paint: false,
  motion: false,
  motionUrdf: false,
  maxSteps: steps,
});

/** Everything on — the paper's configuration — trimmed to what this host can
 *  run, so "Best quality" never queues a job that dies on its first render. */
const BEST_PIPELINE = (cap: Capabilities): Pipeline => ({
  oneShot: false,
  contextRenders: cap.blender,
  assembly: true,
  paint: cap.blender,
  motion: true,
  motionUrdf: true,
  maxSteps: 12,
});

const same = (a: Pipeline, b: Pipeline) => (Object.keys(a) as (keyof Pipeline)[]).every((k) => a[k] === b[k]);

/**
 * Three decisions and a button. What to make, what to compare it against, and
 * how hard to try — everything else waits under Options.
 */
export function Composer({ info, onClose, onCreated }: { info: ServerInfo | null; onClose: () => void; onCreated: (job: JobRecord) => void }) {
  const cap: Capabilities = info?.capabilities ?? { llm: false, imageGen: false, blender: false, isaac: false, openscad: false };
  const defaultSteps = info?.defaultMaxSteps ?? 6;
  const { reduce } = useMotion();

  const [prompt, setPrompt] = useState("");
  const [refMode, setRefMode] = useState<RefMode>("none");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline>(() => DEFAULT_PIPELINE(defaultSteps));
  const [options, setOptions] = useState(false);
  const [model, setModel] = useState("");
  const [agentModel, setAgentModel] = useState("");
  const [scadModel, setScadModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (info?.defaultModel) setModel((m) => m || info.defaultModel);
  }, [info?.defaultModel]);

  // The preset is derived from the toggles, never stored: the control reads as
  // a description of the configuration, and any change lands on Custom.
  const preset: Preset = useMemo(() => {
    if (same(pipeline, DEFAULT_PIPELINE(defaultSteps))) return "default";
    if (same(pipeline, BEST_PIPELINE(cap))) return "best";
    return "custom";
  }, [pipeline, defaultSteps, cap]);

  const applyPreset = (p: Preset) => {
    if (p === "default") setPipeline(DEFAULT_PIPELINE(defaultSteps));
    else if (p === "best") {
      setPipeline(BEST_PIPELINE(cap));
      if (refMode === "none" && cap.imageGen) setRefMode("generate");
    }
  };

  // ── reference ─────────────────────────────────────────────────────────────
  const takeFile = useCallback((f: File | null | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    setFile(f);
    setRefMode("upload");
  }, []);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (item) takeFile(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [takeFile]);

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    promptRef.current?.focus();
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  // ── validity + summary ────────────────────────────────────────────────────
  const effectiveRef: RefMode = refMode === "upload" && !file ? "none" : refMode;
  const blockers: string[] = [];
  if (!info?.generation) blockers.push("Generation is disabled on this server.");
  if (info && !cap.llm) blockers.push("No LLM key is configured — set OPENAI_API_KEY or GEMINI_API_KEY in the repo's .env.");
  if (effectiveRef === "generate" && !cap.imageGen) blockers.push("Image generation is not configured on this server.");
  if (pipeline.oneShot && effectiveRef === "none") blockers.push("A one-shot draft needs a reference image.");
  const disabled = !prompt.trim() || submitting || blockers.length > 0;

  const summary = useMemo(() => {
    const bits: string[] = [];
    bits.push(pipeline.oneShot ? "One-shot draft" : "Part by part");
    bits.push(effectiveRef === "upload" ? "from your reference" : effectiveRef === "generate" ? "with a generated reference" : "text only");
    if (!pipeline.oneShot && pipeline.contextRenders) bits.push("3D feedback");
    if (!pipeline.oneShot && pipeline.assembly) bits.push("assembly mates");
    bits.push(pipeline.maxSteps > 0 ? `${pipeline.maxSteps} refine ${pipeline.maxSteps === 1 ? "cycle" : "cycles"}` : "no refine");
    if (pipeline.paint) bits.push("materials");
    if (pipeline.motion) bits.push(pipeline.motionUrdf ? "articulation with URDF" : "articulation");
    return bits.join(" · ");
  }, [pipeline, effectiveRef]);

  const submit = async () => {
    if (disabled) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: GenerateRequest = {
        prompt: prompt.trim(),
        preset,
        maxSteps: pipeline.maxSteps,
        oneShot: pipeline.oneShot,
        contextRenders: !pipeline.oneShot && pipeline.contextRenders,
        assembly: !pipeline.oneShot && pipeline.assembly,
        paint: pipeline.paint,
        motion: pipeline.motion,
        motionUrdf: pipeline.motion && pipeline.motionUrdf,
      };
      if (effectiveRef === "upload" && file) body.imagePath = (await api.upload(file)).path;
      else if (effectiveRef === "none") body.noImage = true;
      const refine = agentModel.trim() || model.trim();
      const draft = scadModel.trim() || model.trim();
      if (refine) body.agentModel = refine;
      if (draft) body.scadModel = draft;
      if (imageModel.trim()) body.imageModel = imageModel.trim();
      onCreated(await api.generate(body));
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  };

  const setP = <K extends keyof Pipeline>(k: K, val: Pipeline[K]) => setPipeline((p) => ({ ...p, [k]: val }));
  const models = info?.models ?? [];

  return (
    <Sheet onClose={onClose} label="New generation" className="max-w-2xl">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          takeFile(e.dataTransfer.files?.[0]);
        }}
      >
        <div className="flex items-center justify-between px-6 pb-2 pt-5">
          <h2 className="text-[17px] font-semibold tracking-tight">New generation</h2>
          <IconButton icon={<X size={16} />} label="Close" onClick={onClose} />
        </div>

        <div className="space-y-6 px-6 pb-5 pt-2">
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
            }}
            rows={4}
            maxLength={8000}
            placeholder="Describe the object — name the parts you care about."
            aria-label="Describe the object"
            className="w-full resize-none rounded-xl bg-elevated px-4 py-3 text-[15px] leading-relaxed text-ink placeholder:text-faint focus:outline-none focus:ring-[3px] focus:ring-accent/25"
          />

          <div>
            <Label>Reference</Label>
            <div className={cx("grid grid-cols-3 gap-2 rounded-xl transition-shadow", dragOver && "ring-[3px] ring-accent/30")}>
              {file && preview ? (
                <div className="col-span-3 flex items-center gap-3 rounded-xl bg-elevated p-2">
                  <img src={preview} alt="" className="size-16 shrink-0 rounded-lg object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">{file.name}</div>
                    <div className="text-[11.5px] text-faint">The run reconstructs this image.</div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
                    Replace
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFile(null);
                      setRefMode(cap.imageGen ? "generate" : "none");
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <>
                  <RefChoice active={effectiveRef === "upload" || dragOver} onClick={() => fileRef.current?.click()} icon={<UploadSimple size={18} />} title="Upload" hint="Drop, paste, or choose" />
                  <RefChoice active={effectiveRef === "generate"} disabled={!cap.imageGen} onClick={() => setRefMode("generate")} icon={<ImageSquare size={18} />} title="Generate" hint={cap.imageGen ? "Render one from the prompt" : "Not configured"} />
                  <RefChoice active={effectiveRef === "none"} onClick={() => setRefMode("none")} icon={<Cube size={18} />} title="None" hint="From the prompt alone" />
                </>
              )}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => takeFile(e.target.files?.[0])} />
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label>Pipeline</Label>
              <Segmented
                size="sm"
                value={preset}
                onChange={(p) => p !== "custom" && applyPreset(p)}
                ariaLabel="Preset"
                options={[
                  { value: "default", label: "Default" },
                  { value: "best", label: "Best quality" },
                  ...(preset === "custom" ? [{ value: "custom" as const, label: "Custom" }] : []),
                ]}
              />
            </div>
            <p className="text-[12.5px] leading-relaxed text-muted">
              {preset === "default"
                ? "The quick run: part by part from the prompt, six refine cycles. Nothing to configure."
                : preset === "best"
                  ? "Everything on — the paper's configuration. Slower and costlier, and the most accurate."
                  : summary + "."}
            </p>
            <Disclosure title="Options" open={options} onToggle={setOptions} className="mt-2">
              <div className="space-y-4 pt-1">
                <div className="divide-y divide-line rounded-xl bg-elevated">
                  <Toggle label="Part-by-part draft" hint="Plan the parts, then generate one at a time against the growing model." on={!pipeline.oneShot} onChange={(x) => setP("oneShot", !x)} />
                  <Toggle label="3D feedback" hint={cap.blender ? "Render the build before each part. One Blender pass per part." : "Needs Blender on this server."} on={!pipeline.oneShot && pipeline.contextRenders} disabled={pipeline.oneShot || !cap.blender} onChange={(x) => setP("contextRenders", x)} />
                  <Toggle label="Assembly mates" hint="Parts join through pegs, sockets and bolt patterns instead of overlap." on={!pipeline.oneShot && pipeline.assembly} disabled={pipeline.oneShot} onChange={(x) => setP("assembly", x)} />
                  <Toggle label="Materials" hint={cap.blender ? "A vision call assigns each part a PBR material." : "Needs Blender on this server."} on={pipeline.paint} disabled={!cap.blender} onChange={(x) => setP("paint", x)} />
                  <Toggle
                    label="Articulation"
                    hint={cap.isaac ? "Plan joints and drives, export OpenUSD, validate in Isaac." : "Plan joints and drives, export OpenUSD. Isaac not found, so no validation."}
                    on={pipeline.motion}
                    onChange={(x) => setP("motion", x)}
                    trailing={
                      pipeline.motion ? (
                        <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
                          <input type="checkbox" checked={pipeline.motionUrdf} onChange={(e) => setP("motionUrdf", e.target.checked)} />
                          URDF
                        </label>
                      ) : null
                    }
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[12.5px]">
                    <span className="font-medium text-ink">Refine cycles</span>
                    <span className="font-mono text-muted">{pipeline.maxSteps === 0 ? "off" : pipeline.maxSteps}</span>
                  </div>
                  <input type="range" min={0} max={24} value={pipeline.maxSteps} onChange={(e) => setP("maxSteps", Number(e.target.value))} aria-label="Refine cycles" className="w-full" />
                  <div className="text-[11px] text-faint">Each cycle renders, critiques and patches — two model calls.</div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Model" value={model} onChange={setModel} placeholder={info?.defaultModel || "any id your endpoint serves"} list="composer-models" />
                  <Field label="Image model" value={imageModel} onChange={setImageModel} placeholder="$PROCEDURA_IMAGE_MODEL" />
                  <Field label="Refine model" value={agentModel} onChange={setAgentModel} placeholder="same as Model" />
                  <Field label="Draft model" value={scadModel} onChange={setScadModel} placeholder="same as Model" />
                  <datalist id="composer-models">
                    {models.map((m) => (
                      <option key={m.key} value={m.key} />
                    ))}
                  </datalist>
                </div>
              </div>
            </Disclosure>
          </div>

          <AnimatePresence initial={false}>
            {(error || blockers.length > 0) && (
              <motion.div key="notes" initial={reduce ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={ease} className="space-y-1.5">
                {error && <div className="rounded-lg bg-err/10 px-3 py-2 text-[12.5px] text-err">{error}</div>}
                {blockers.map((b) => (
                  <div key={b} className="flex items-center gap-2 rounded-lg bg-warn/12 px-3 py-2 text-[12.5px] text-warn">
                    <WarningCircle size={14} /> {b}
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
          <div className="min-w-0 flex-1 truncate text-[12px] text-faint" title={summary}>
            {summary}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={disabled} title="⌘ Enter" icon={<Sparkle size={14} weight="fill" />}>
              {submitting ? (file && effectiveRef === "upload" ? "Uploading…" : "Starting…") : "Generate"}
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[12.5px] font-medium text-ink">{children}</div>;
}

function RefChoice({ active, disabled, onClick, icon, title, hint }: { active: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode; title: string; hint: string }) {
  const { reduce } = useMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      whileTap={disabled || reduce ? undefined : { scale: 0.98 }}
      className={cx(
        "flex flex-col items-start gap-1 rounded-xl px-3.5 py-3 text-left transition-[background-color,box-shadow] duration-150",
        disabled ? "cursor-not-allowed bg-elevated/60 text-faint/60" : active ? "bg-accent/10 text-ink ring-1 ring-inset ring-accent/40" : "bg-elevated text-muted hover:text-ink",
      )}
    >
      <span className={cx("flex items-center gap-2 text-[13px] font-medium", active && !disabled && "text-accent")}>
        {icon} {title}
      </span>
      <span className="text-[11.5px] leading-snug">{hint}</span>
    </motion.button>
  );
}

function Toggle({ label, hint, on, disabled, onChange, trailing }: { label: string; hint: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void; trailing?: React.ReactNode }) {
  const { t } = useMotion();
  return (
    <div className={cx("flex items-center gap-3 px-3.5 py-2.5", disabled && "opacity-55")}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        <div className="text-[11.5px] leading-snug text-muted">{hint}</div>
      </div>
      {trailing}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cx("relative h-[22px] w-9 shrink-0 rounded-full transition-colors duration-200", disabled ? "cursor-not-allowed bg-line" : on ? "bg-accent" : "bg-line-strong")}
      >
        <motion.span
          layout
          transition={t({ type: "spring", stiffness: 700, damping: 40 })}
          className={cx("absolute top-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]", on ? "left-[18px]" : "left-[2px]")}
        />
      </button>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, list }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; list?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium text-muted">{label}</span>
      <input
        value={value}
        list={list}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg bg-elevated px-3 py-2 font-mono text-[12px] text-ink placeholder:text-faint focus:outline-none focus:ring-[3px] focus:ring-accent/25"
      />
    </label>
  );
}
