/**
 * Shared API contract between the Bun server and the React frontend.
 *
 * Everything the server returns is filesystem-derived metadata + relative
 * artifact paths. Binary artifacts (PNG / STL / OBJ) are never inlined; the
 * frontend fetches them lazily from `/api/file?id=<run>&path=<relpath>`.
 */

export type RunStatus =
  | "ok" // refine finished with verdict ok
  | "give_up" // refine finished with verdict give_up
  | "max-steps" // loop hit its budget without a finish call
  | "incomplete" // has draft but no resolved final
  | "error" // draft/compile failed
  | "unknown";

export type RunShape =
  | "draft-refine" // current Procedura layout (draft.* / final.*)
  | "ortho" // legacy ortho-review layout (initial.* / ortho_*)
  | "sparse" // image + prompt + trajectory only
  | "unknown";

export interface RunSummary {
  /** Stable id = run dir path relative to the runs root (forward slashes). */
  id: string;
  /** Last path segment, e.g. "00000591". */
  name: string;
  /** Parent group under the root, e.g. "procedura_batch_v2"; null if top-level. */
  group: string | null;
  /** First line(s) of the prompt, trimmed for display. */
  title: string;
  status: RunStatus;
  shape: RunShape;
  /** Refine cycles if known, else distinct render-step count, else 0. */
  steps: number;
  hasImage: boolean;
  hasDraftMesh: boolean;
  hasFinalMesh: boolean;
  /** final_painted.obj exists (Phase 3 ran). */
  hasPaint: boolean;
  /** motion/final_motion.usda exists (Phase 4 ran). */
  hasMotion: boolean;
  /** Relative path of a representative thumbnail PNG, or null. */
  thumbnail: string | null;
  /** Verdict line from final_summary.txt, or null. */
  verdict: string | null;
  /** Latest mtime among key files (epoch ms). */
  mtime: number;
}

export interface ViewImage {
  /** isometric | front | right | top | other */
  view: string;
  /** relative path under the run dir */
  path: string;
}

export interface PartLegendEntry {
  module: string;
  /** Normalized 0..1 RGB (as written by the pipeline's parts_color_meta.txt). */
  rgb: [number, number, number];
}

export interface MeshArtifact {
  scadPath: string | null;
  stlPath: string | null;
  objPath: string | null;
  /** Material sidecar next to the OBJ (painted deliverable only). */
  mtlPath: string | null;
  scadLines: number | null;
}

export interface RenderStep {
  /** Step index parsed from `_agent_renders/step_NNN`. */
  step: number;
  ao: ViewImage[];
  partsColor: ViewImage[];
  legend: PartLegendEntry[] | null;
}

export interface CompileStep {
  step: number;
  /** Raw dir name, e.g. "step_003_compile" or "step_001_render". */
  label: string;
  stlPath: string | null;
  scadPath: string | null;
  summary: Record<string, unknown> | null;
}

export interface SubStep {
  sub: number;
  tool: string;
  assistant: string | null;
  thinking: string | null;
  toolCall: unknown | null;
  toolResult: string | null;
  isError: boolean;
  /** relative path of the post-edit scad.scad snapshot, if this was an edit. */
  scadPath: string | null;
}

export interface RefineStep {
  step: number;
  subSteps: SubStep[];
  finalScadPath: string | null;
  summary: {
    sub_steps?: number;
    tool_counts?: Record<string, number>;
    edits?: unknown[];
    completed_edits_so_far?: number;
    started_at?: number;
    ended_at?: number;
    duration_ms?: number;
  } | null;
}

/**
 * One cycle of the refine loop (render → critic → patch → compile → gate), as
 * written to `_refine_steps/step_NNN/`. The views are what the critic looked
 * at BEFORE the patch; `scadPath` is the model AFTER it (if accepted).
 */
export interface RefineCycle {
  cycle: number;
  /** null when summary.json is missing (cycle was interrupted). */
  accepted: boolean | null;
  attempt: number | null;
  /** "module <name>" / "place <name>" — what the patch touched. */
  touched: string[];
  reason: string | null;
  facetsBefore: number | null;
  facetsAfter: number | null;
  /** Parts-colour views the critic saw (views/color-*.png). */
  views: ViewImage[];
  legend: PartLegendEntry[] | null;
  /** The critic's verdict text (SUMMARY + severity-tagged ISSUES), inlined. */
  diagnosis: string | null;
  diagnoseThinkingPath: string | null;
  /** One per patch attempt, root-relative. */
  patchResponsePaths: string[];
  patchThinkingPaths: string[];
  /** Post-patch SCAD snapshot. */
  scadPath: string | null;
  /** Modules the loop measured this cycle (measure/m_<name>). */
  measured: string[];
}

/** One part of the incremental (part-by-part) draft build. */
export interface IncrementalPart {
  /** Order index parsed from the `_parts/NN_<name>` dir. */
  index: number;
  name: string;
  /** Module name actually placed (may differ from plan name on collision). */
  placedName?: string;
  level?: string;
  description?: string;
  generated: boolean;
  refined: boolean;
  genAttempts: number;
  /** false ⇒ shipped as a visible floater after exhausting retries. */
  connected?: boolean;
  /** visible-floater count of the whole build after this part. */
  floatersAfter?: number;
  error?: string;
  /** after_gen.scad (the accumulated model right after this part landed). */
  scadPath: string | null;
  /** gen_response_*.txt (one per generation attempt), root-relative. */
  genResponsePaths: string[];
  /** context_render build-so-far views (color-* or aoc-*). */
  contextViews: ViewImage[];
}

/** The incremental draft stage: the plan + every per-part build artifact. */
export interface IncrementalData {
  plan: { name: string; level?: string; description?: string }[];
  partsGenerated: number;
  floaterParts: number;
  planResponsePath: string | null;
  planReviewPaths: string[];
  parts: IncrementalPart[];
}

/** One entry of the paint stage's material palette (final_materials.json). */
export interface MaterialEntry {
  id: string;
  name: string;
  hex: string;
  /** painted | metal | plastic | rubber | glass | … (free text from the LLM). */
  material: string;
  roughness: number;
  metalness: number;
  clearcoat?: number;
  wear?: number;
  dirt?: number;
  emission?: number;
  /** Where the LLM said this material goes. */
  where?: string;
}

/** Part → material assignment from final_materials.json. */
export interface PartMaterial {
  name: string;
  hex: string;
  materialId: string | null;
  materialName: string | null;
  material: string;
  roughness: number;
  metalness: number;
}

export interface MaterialsData {
  palette: MaterialEntry[];
  parts: PartMaterial[];
}

export interface MotionJoint {
  name: string;
  type: string;
  parent: string | null;
  child: string;
  axis: string | null;
  /** [lower, upper] in the plan's units (deg for revolute, model units for prismatic). */
  limit: [number, number] | null;
  hasDrive: boolean;
  mimic: string | null;
}

export interface MotionLink {
  name: string;
  /** Top-level SCAD modules folded into this rigid link. */
  parts: string[];
  /** Per-link mesh on disk (motion/links/<name>/<name>.obj), root-relative. */
  objPath: string | null;
}

/** Headless Isaac validation outcome (motion/isaac_validation.json), reduced. */
export interface MotionValidation {
  ran: boolean;
  ok: boolean | null;
  /** phase name → passed (null = phase did not run). */
  phases: Record<string, boolean | null>;
  errors: string[];
  warnings: string[];
  skippedReason: string | null;
  /** MP4 sweeps captured by the validator, root-relative. */
  videos: string[];
}

export interface MotionData {
  usdaPath: string | null;
  urdfPath: string | null;
  planPath: string | null;
  planSource: string | null;
  plannerModel: string | null;
  rootLink: string | null;
  fixedBase: boolean | null;
  metersPerUnit: number | null;
  links: MotionLink[];
  joints: MotionJoint[];
  validation: MotionValidation;
  /** Parts-colour views the planner looked at (motion/render_feedback). */
  feedbackViews: ViewImage[];
  warnings: string[];
}

export type FileKind = "text" | "image" | "mesh" | "scad" | "json" | "other";

export interface ArtifactFile {
  /** relative path under the run dir */
  path: string;
  bytes: number;
  kind: FileKind;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  bytes: number;
  kind: FileKind | "dir";
  /** root-relative path (for /api/file or descending via /api/ls) */
  path: string;
}

export interface DirListing {
  /** the subdirectory listed, relative to the run dir ("" = run root) */
  sub: string;
  entries: DirEntry[];
}

export interface RunDetail extends RunSummary {
  /** Absolute runs root (display only). */
  root: string;
  /** Absolute run directory (display only). */
  dir: string;
  prompt: string;
  /** Root-relative path to image.png, or null. */
  imagePath: string | null;
  reference: {
    handle: string;
    format: "stl";
    summary: {
      coordinateConvention: "Z-up";
      units: "mm";
      triangleCount: number;
      dimensions: [number, number, number];
    };
  } | null;
  imagePrompt: string | null;
  finalSummary: string | null;
  draftResponse: string | null;
  draftThinking: string | null;
  draft: MeshArtifact | null;
  final: MeshArtifact | null;
  /** preview_final/ao-*.png */
  previewViews: ViewImage[];
  /** final_painted.{scad,obj,mtl} — the Phase 3 deliverable, or null. */
  painted: MeshArtifact | null;
  /** preview_painted/pbr-*.png */
  previewPainted: ViewImage[];
  materials: MaterialsData | null;
  motion: MotionData | null;
  /** The growing model during a part-by-part build: draft.obj is rewritten
   *  after every committed part (else the latest `_draft_build` compile).
   *  `mtime` busts the client cache across rewrites of the same path. */
  liveBuild: { path: string; mtime: number } | null;
  /** The refine loop's cycles (current layout). */
  cycles: RefineCycle[];
  /** Legacy agentic-loop transcript (`sub_NN_<tool>` dirs); empty on current runs. */
  refineSteps: RefineStep[];
  renderSteps: RenderStep[];
  compileSteps: CompileStep[];
  /** Incremental part-by-part draft artifacts, or null for non-incremental runs. */
  incremental: IncrementalData | null;
  /** relative paths of every *.jsonl under _trajectory (newest first). */
  trajectoryFiles: string[];
  files: ArtifactFile[];
}

export interface TrajectoryEvent {
  type: string;
  /** Per-phase sequence number (NOT globally unique — each phase restarts at 1). */
  seq: number;
  ts: number;
  sessionId?: string;
  entryId?: string;
  parentEntryId?: string;
  payload: Record<string, unknown>;
  /** Phase this event belongs to, assigned during segmentation. */
  phase?: "draft" | "refine" | "unknown";
  /** True when this line failed to parse cleanly (raw kept in payload._raw). */
  malformed?: boolean;
}

export interface TrajectoryPhase {
  kind: "draft" | "refine" | "unknown";
  index: number;
  startSeq: number;
  endSeq: number;
  startTs: number;
  endTs: number;
  reason: string | null;
}

export interface TrajectoryData {
  /** relative path of the parsed jsonl */
  file: string;
  events: TrajectoryEvent[];
  phases: TrajectoryPhase[];
  truncated: boolean;
}

export interface RunsResponse {
  root: string;
  runs: RunSummary[];
}

// ── SCAD customization ──────────────────────────────────────────────────────

export type ParamType = "number" | "boolean" | "string" | "vector" | "enum-number" | "enum-string";

export interface ScadParam {
  name: string;
  type: ParamType;
  /** current literal value (vector kept as its raw "[...]" string) */
  value: number | boolean | string;
  raw: string;
  group?: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: (number | string)[];
}

export interface ParamsResponse {
  which: string;
  scadPath: string;
  params: ScadParam[];
  /** whether the server can recompile (openscad available) */
  customizable: boolean;
}

// ── CSG IR (Stage 3 SDF preview) ────────────────────────────────────────────
// A flattened CSG tree parsed from OpenSCAD's .csg export, turned into a GLSL
// sphere-tracer on the client. Lossy by design: exact for primitives/transforms/
// booleans, approximate for hull/extrudes, `unsupported` otherwise.

export type CsgNode =
  | { op: "group" | "union" | "difference" | "intersection" | "hull" | "minkowski"; children: CsgNode[] }
  | { op: "transform"; m: number[]; child: CsgNode } // 16 floats, row-major
  | { op: "cube"; size: [number, number, number]; center: boolean }
  | { op: "sphere"; r: number }
  | { op: "cylinder"; h: number; r1: number; r2: number; center: boolean }
  | { op: "circle"; r: number }
  | { op: "square"; size: [number, number]; center: boolean }
  | { op: "polygon"; points: [number, number][] }
  | { op: "rotate_extrude"; angle: number; child: CsgNode }
  | { op: "linear_extrude"; height: number; twist: number; scale: [number, number]; center: boolean; child: CsgNode }
  | { op: "unsupported"; name: string };

export interface CsgCoverage {
  nodes: number;
  supported: number;
  approximated: number;
  unsupported: number;
  byOp: Record<string, number>;
  /** 0..1; <0.5 → recommend the mesh path. */
  fidelity: number;
}

export interface CsgResult {
  tree: CsgNode;
  coverage: CsgCoverage;
}

// ── part highlight (which model parts a parameter affects) ──────────────────

/** local = highlight specific parts; global = "affects whole model"; none = no effect. */
export type ParamScope = "local" | "global" | "none";

export interface PartsResponse {
  /** per-module STL meshes on disk (root-relative paths), or [] if unavailable. */
  parts: { module: string; stlPath: string }[];
  /** parameter name → which assembly modules it affects + scope. */
  paramModules: Record<string, { modules: string[]; scope: ParamScope }>;
}

export interface CustomizeRequest {
  id: string;
  which: string; // "final" | "draft"
  overrides: Record<string, number | boolean | string>;
  /** Coarse, fast recompile for live dragging (lowers $fn). The crisp mesh is
   *  fetched with preview omitted/false once the slider settles. */
  preview?: boolean;
}

export interface CustomizeResponse {
  stl: string;
  durationMs: number;
  cached: boolean;
  /** Echoes whether this mesh was rendered at coarse preview quality. */
  preview: boolean;
}

/** A selectable chat model, sourced from the main repo's MODEL_CATALOG. */
export interface ModelChoice {
  /** Catalog key passed to the CLI as --agent-model / --scad-model. */
  key: string;
  /** Human-readable note (catalog `notes`), shown in the selector. */
  notes?: string;
}

export interface ServerInfo {
  root: string;
  rootExists: boolean;
  runCount: number;
  version: string;
  /** Whether the server can spawn generation jobs (repo + node_modules resolved). */
  generation: boolean;
  /** Repo the CLI is spawned from (display only). */
  repo: string | null;
  /** What the host can actually do — the composer greys out what it cannot. */
  capabilities: Capabilities;
  /** Whether the server can recompile SCAD with overrides (openscad available). */
  customize: boolean;
  /** Default refine-step budget surfaced to the form. */
  defaultMaxSteps: number;
  /** Chat models available for the refine/draft selectors (from MODEL_CATALOG). */
  models: ModelChoice[];
  /** The pipeline's default chat model key (DEFAULT_MODEL). */
  defaultModel: string;
}

export interface Capabilities {
  /** An LLM key is configured (OPENAI_API_KEY or GEMINI_API_KEY). */
  llm: boolean;
  /** PROCEDURA_IMAGE_MODEL + OPENAI_API_KEY: the run can render its own reference. */
  imageGen: boolean;
  /** A Blender binary resolves: 3D feedback, refine renders, paint previews. */
  blender: boolean;
  /** Isaac Sim resolves: --motion can validate headlessly. */
  isaac: boolean;
  /** OpenSCAD resolves: customizer + CSG preview. */
  openscad: boolean;
}

// ── generation jobs ─────────────────────────────────────────────────────────

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted"; // server restarted while it was running

export type Preset = "default" | "best" | "custom";

export interface JobOptions {
  preset?: Preset;
  maxSteps?: number;
  agentModel?: string;
  scadModel?: string;
  imageModel?: string;
  /** Root-relative path of an uploaded reference image (from /api/upload). */
  imagePath?: string;
  /** Text-only: no reference image anywhere in the run. */
  noImage?: boolean;
  /** Opt out of the part-by-part draft (one call, no plan stage). */
  oneShot?: boolean;
  /** --3d-feedback: render the build-so-far before each part. */
  contextRenders?: boolean;
  /** --assembly: mating-feature library + prompt. */
  assembly?: boolean;
  paint?: boolean;
  motion?: boolean;
  motionUrdf?: boolean;
}

export interface JobRecord {
  id: string;
  prompt: string;
  options: JobOptions;
  /** outDir relative to the runs root (= the run id once artifacts exist). */
  runId: string;
  status: JobStatus;
  pid?: number;
  exitCode?: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export type JobPhase =
  | "starting"
  | "reference"
  | "plan"
  | "build"
  | "refine"
  | "final"
  | "paint"
  | "motion"
  | "done";

export interface JobProgress {
  hasImage: boolean;
  /** plan.json length (0 until the planner returns). */
  planned: number;
  /** _parts/NN_* dirs that reached after_gen.scad. */
  built: number;
  /** Name of the part currently being generated (dir exists, no after_gen yet). */
  building: string | null;
  draftReady: boolean;
  renderSteps: number;
  refineSteps: number;
  finalReady: boolean;
  hasFinalSummary: boolean;
  painted: boolean;
  motionReady: boolean;
  /** null until motion/isaac_validation.json lands. */
  motionValidated: boolean | null;
  /** Coarse phase, derived from the artifacts above + the job's options. */
  phase: JobPhase;
}

export interface JobDetail extends JobRecord {
  log: string[];
  progress: JobProgress;
}

export type GenerateRequest = { prompt: string } & JobOptions;

export interface UploadResponse {
  /** Root-relative path, to pass back as JobOptions.imagePath. */
  path: string;
  bytes: number;
}

/** SSE event shapes streamed from /api/jobs/stream. */
export type JobEvent =
  | { type: "log"; line: string }
  | { type: "status"; job: JobRecord }
  | { type: "progress"; progress: JobProgress };
