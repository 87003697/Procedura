/**
 * Procedura Studio server (Bun.serve).
 *
 *   - Serves the React frontend (bundled on the fly from index.html).
 *   - Spawns generations as managed subprocesses of the repo's CLI.
 *   - Exposes a read-only JSON API over a runs directory.
 *   - Streams artifact files (PNG / OBJ / MTL / STL / SCAD / USDA / …) on demand.
 *
 * Repo resolution: --repo / PROCEDURA_REPO, else the parent of this directory
 * (web/ lives inside the repo). Runs root: --root / PROCEDURA_OUTPUTS_ROOT,
 * else <repo>/outputs.
 *
 *   bun run start                              # http://localhost:8080
 *   PORT=10599 bun run start -- --root /data/runs
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";

import index from "./index.html";
import { compileCustom, extractParams, overrideToDefine, resolveScadFile } from "./server/customize.ts";
import { exportCsg } from "./server/csg.ts";
import { analyzeParamModules } from "./server/deps.ts";
import { parseEnvFile } from "./server/env.ts";
import { JobManager } from "./server/jobs.ts";
import {
  findPartMeshes,
  listDirEntries,
  listRuns,
  readRunDetail,
  resolveRunDir,
  trajectoryFiles,
} from "./server/scan.ts";
import { safeJoin, setTrustSymlinks } from "./server/safe.ts";
import { parseTrajectory } from "./server/trajectory.ts";
import type {
  Capabilities,
  CustomizeRequest,
  GenerateRequest,
  JobEvent,
  JobOptions,
  ModelChoice,
  ParamsResponse,
  PartsResponse,
  ScadParam,
  ServerInfo,
  UploadResponse,
} from "./shared/types.ts";
import { ReferenceAuthority } from "../src/reference/authority.ts";
import { referenceMeshHandler } from "./server/reference.ts";

const VERSION = "0.2.0";
/** Matches the CLI's own default refine budget. */
const DEFAULT_MAX_STEPS = 6;
const UPLOAD_MAX_BYTES = 24 * 1024 * 1024;
/** Only gzip mesh responses above this size (compression cost not worth it below). */
const GZIP_MIN_BYTES = 512 * 1024;

function argFlag(name: string): string | null {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
}

/** The checkout to spawn the CLI from: it must have scripts/procedura.ts AND
 *  installed node_modules (so the vendored harness resolves). web/ lives inside
 *  the repo, so the parent directory is the default. */
function resolveRepo(): string | null {
  const candidates: string[] = [];
  const explicit = argFlag("--repo") ?? process.env["PROCEDURA_REPO"];
  if (explicit) candidates.push(resolve(explicit));
  candidates.push(resolve(import.meta.dir, ".."));
  for (const c of candidates) {
    if (existsSync(join(c, "scripts", "procedura.ts")) && existsSync(join(c, "node_modules"))) return c;
  }
  return null;
}

const PROCEDURA_REPO = resolveRepo();

function resolveRoot(): string {
  const flag = argFlag("--root");
  if (flag) return resolve(flag);
  if (process.env["PROCEDURA_OUTPUTS_ROOT"]) return resolve(process.env["PROCEDURA_OUTPUTS_ROOT"]!);
  return resolve(PROCEDURA_REPO ?? process.cwd(), "outputs");
}

const ROOT = resolveRoot();
setTrustSymlinks(
  process.argv.includes("--follow-symlinks") || process.env["PROCEDURA_STUDIO_FOLLOW_SYMLINKS"] === "1",
);
const PORT = Number(process.env["PORT"] ?? 8080);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const DEV = process.env["NODE_ENV"] !== "production";
const MAX_CONCURRENT = Math.max(1, Number(process.env["PROCEDURA_MAX_CONCURRENT"] ?? 2));
const MAX_QUEUED = Math.max(MAX_CONCURRENT, Number(process.env["PROCEDURA_MAX_QUEUED"] ?? 16));
const RETAIN = Math.max(10, Number(process.env["PROCEDURA_JOB_RETAIN"] ?? 500));

/** Warn if ROOT points somewhere secrets could live — /api/file serves any
 *  allowlisted file under ROOT, so it must be a dedicated outputs directory. */
function rootRiskWarning(): string | null {
  const home = process.env["HOME"];
  if (ROOT === "/") return "the filesystem root";
  if (home && resolve(home) === ROOT) return "your home directory";
  if (PROCEDURA_REPO && resolve(PROCEDURA_REPO) === ROOT) return "the repo itself (source + .env live here)";
  return null;
}

const CHILD_ENV = PROCEDURA_REPO ? parseEnvFile(join(PROCEDURA_REPO, ".env")) : {};
const REFERENCE_ROOT = process.env["PROCEDURA_REFERENCE_ROOT"] || CHILD_ENV["PROCEDURA_REFERENCE_ROOT"];
const referenceAuthority = REFERENCE_ROOT
  ? new ReferenceAuthority(REFERENCE_ROOT, [ROOT, PROCEDURA_REPO ?? resolve(import.meta.dir, "..")])
  : null;
const OPENSCAD = process.env["OPENSCAD_PATH"] || CHILD_ENV["OPENSCAD_PATH"] || "openscad";
// Spawned generation jobs inherit CHILD_ENV (parsed from the main repo's .env)
// and it overrides process.env in jobs.ts. Pin it to the resolved binary so the
// pipeline uses the same (fast, extracted) OpenSCAD the customizer does.
CHILD_ENV["OPENSCAD_PATH"] = OPENSCAD;
const CUSTOMIZE_OK = (() => {
  try {
    const r = Bun.spawnSync([OPENSCAD, "--version"]);
    return r.exitCode === 0 || (r.stderr?.toString() ?? "").includes("OpenSCAD");
  } catch {
    return false;
  }
})();

/** What the host can do. The composer greys out options this cannot back, so
 *  a user never queues a run that fails on its first Blender call. Mirrors the
 *  CLI's own resolution rules (env, then conventional locations, then $PATH). */
function detectCapabilities(): Capabilities {
  const env = (k: string) => process.env[k] || CHILD_ENV[k] || "";
  const home = process.env["HOME"] ?? homedir();
  const firstExisting = (...paths: string[]) => paths.find((p) => p && existsSync(p)) ?? null;
  const blender = env("PROCEDURA_BLENDER_PATH")
    ? existsSync(env("PROCEDURA_BLENDER_PATH"))
    : !!firstExisting(join(home, "opt", "blender", "blender"), "/usr/local/bin/blender", "/opt/blender/blender") ||
      !!Bun.which("blender");
  const isaacDir = env("PROCEDURA_ISAACSIM_PATH") || join(home, "isaacsim");
  return {
    llm: !!(env("OPENAI_API_KEY") || env("GEMINI_API_KEY")),
    imageGen: !!(env("PROCEDURA_IMAGE_MODEL") && env("OPENAI_API_KEY")),
    blender,
    isaac: existsSync(join(isaacDir, "python.sh")),
    openscad: CUSTOMIZE_OK,
  };
}
const CAPABILITIES = detectCapabilities();

// Model catalog, loaded from the repo so the UI selector stays in sync with
// MODEL_CATALOG (single source of truth). Any other id still works (the
// catalog passes unknown keys through), so the form also takes free text.
async function loadModelCatalog(repo: string | null): Promise<{ models: ModelChoice[]; defaultModel: string }> {
  if (!repo) return { models: [], defaultModel: "" };
  try {
    const mod = (await import(join(repo, "src", "config", "models.ts"))) as {
      MODEL_CATALOG: Record<string, { notes?: string }>;
      DEFAULT_MODEL: string;
    };
    const models: ModelChoice[] = Object.entries(mod.MODEL_CATALOG).map(
      ([key, e]) => ({ key, ...(e.notes ? { notes: e.notes } : {}) }),
    );
    return { models, defaultModel: mod.DEFAULT_MODEL ?? "" };
  } catch (e) {
    console.error(`[models] could not load catalog from ${repo}: ${(e as Error).message}`);
    return { models: [], defaultModel: "" };
  }
}
const { models: MODEL_CHOICES, defaultModel: DEFAULT_MODEL_KEY } = await loadModelCatalog(PROCEDURA_REPO);

const jobs = new JobManager({
  root: ROOT,
  repo: PROCEDURA_REPO,
  childEnv: CHILD_ENV,
  maxConcurrent: MAX_CONCURRENT,
  maxQueued: MAX_QUEUED,
  retain: RETAIN,
  defaultMaxSteps: DEFAULT_MAX_STEPS,
  log: (s) => console.log(s),
});

// ── helpers ──────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const err = (message: string, status = 400): Response => json({ error: message }, status);

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".stl": "application/octet-stream",
  ".obj": "text/plain; charset=utf-8",
  ".scad": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mtl": "text/plain; charset=utf-8",
  ".usda": "text/plain; charset=utf-8",
  ".urdf": "application/xml; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Magic-byte sniff so an "image" upload is actually one. */
function imageExt(bytes: Uint8Array): ".png" | ".jpg" | ".webp" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return ".webp";
  return null;
}

function q(req: Request, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

/** Resolve ?id=<run> to its absolute dir, or return an error Response. */
function runDirFromReq(req: Request): { dir: string } | Response {
  const id = q(req, "id");
  if (!id) return err("missing ?id");
  const dir = resolveRunDir(ROOT, id);
  if (!dir) return err(`run not found: ${id}`, 404);
  return { dir };
}

// ── route handlers ─────────────────────────────────────────────────────────

function handleInfo(): Response {
  const rootExists = existsSync(ROOT);
  const info: ServerInfo = {
    root: ROOT,
    rootExists,
    runCount: rootExists ? listRuns(ROOT).length : 0,
    version: VERSION,
    generation: jobs.enabled,
    repo: PROCEDURA_REPO,
    capabilities: CAPABILITIES,
    customize: CUSTOMIZE_OK,
    defaultMaxSteps: DEFAULT_MAX_STEPS,
    models: MODEL_CHOICES,
    defaultModel: DEFAULT_MODEL_KEY,
  };
  return json(info);
}

// ── customization ───────────────────────────────────────────────────────────

function handleParams(req: Request): Response {
  const r = runDirFromReq(req);
  if (r instanceof Response) return r;
  const which = q(req, "which") || "final";
  const scadAbs = resolveScadFile(r.dir, which);
  if (!scadAbs) return err("no SCAD source for this run", 404);
  let params: ScadParam[] = [];
  try {
    params = extractParams(readFileSync(scadAbs, "utf8"));
  } catch (e) {
    return err(`failed to parse SCAD: ${(e as Error).message}`, 500);
  }
  const resp: ParamsResponse = {
    which,
    scadPath: relative(ROOT, scadAbs).split("\\").join("/"),
    params,
    customizable: CUSTOMIZE_OK,
  };
  return json(resp);
}

function handleParts(req: Request): Response {
  const r = runDirFromReq(req);
  if (r instanceof Response) return r;
  const which = q(req, "which") || "final";
  const scadAbs = resolveScadFile(r.dir, which);
  const parts = findPartMeshes(ROOT, r.dir);
  let paramModules: PartsResponse["paramModules"] = {};
  if (scadAbs) {
    try {
      paramModules = analyzeParamModules(readFileSync(scadAbs, "utf8"));
    } catch {
      /* leave empty — highlight simply stays inactive */
    }
  }
  const resp: PartsResponse = { parts, paramModules };
  return json(resp);
}

/** Resolve a customize/csg request to its run dir, SCAD path, and the sanitized
 *  `-D` defines for its overrides. Returns an error Response on any failure. */
function resolveOverrides(
  body: { id?: string; which?: string; overrides?: Record<string, unknown> },
): { dir: string; scadAbs: string; defines: string[] } | Response {
  if (!body?.id) return err("missing id");
  const dir = resolveRunDir(ROOT, body.id);
  if (!dir) return err("run not found", 404);
  const scadAbs = resolveScadFile(dir, body.which || "final");
  if (!scadAbs) return err("no SCAD source for this run", 404);

  const byName = new Map<string, ScadParam>();
  for (const p of extractParams(readFileSync(scadAbs, "utf8"))) byName.set(p.name, p);

  const overrides = body.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const defines: string[] = [];
  for (const [name, value] of Object.entries(overrides)) {
    const p = byName.get(name);
    if (!p) continue;
    const d = overrideToDefine(p, value);
    if (d) defines.push(d);
  }
  return { dir, scadAbs, defines };
}

async function handleCsg(req: Request): Promise<Response> {
  if (!CUSTOMIZE_OK) return err("csg export unavailable: openscad not found", 503);
  let body: { id?: string; which?: string; overrides?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return err("invalid JSON body");
  }
  const r = resolveOverrides(body);
  if (r instanceof Response) return r;
  const out = await exportCsg({ openscad: OPENSCAD, scadAbs: r.scadAbs, defines: r.defines });
  if (out.ok) return json(out.result);
  return err(out.error, 422);
}

async function handleCustomize(req: Request): Promise<Response> {
  if (!CUSTOMIZE_OK) return err("customization unavailable: openscad not found", 503);
  let body: CustomizeRequest;
  try {
    body = (await req.json()) as CustomizeRequest;
  } catch {
    return err("invalid JSON body");
  }
  const r = resolveOverrides(body);
  if (r instanceof Response) return r;
  const { dir, scadAbs, defines } = r;
  if (defines.length === 0) return err("no valid overrides supplied", 400);

  const result = await compileCustom({
    openscad: OPENSCAD,
    root: ROOT,
    runDir: dir,
    scadAbs,
    defines,
    preview: body.preview === true,
  });
  if (result.ok) {
    return json({
      stl: result.stl,
      durationMs: result.durationMs,
      cached: result.cached,
      preview: result.preview,
    });
  }
  return err(result.error, result.busy ? 429 : 422);
}

// ── generation ──────────────────────────────────────────────────────────────

async function handleGenerate(req: Request): Promise<Response> {
  if (!jobs.enabled) {
    return err("generation is unavailable: the repo could not be resolved (bun install in the repo root?)", 503);
  }
  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return err("invalid JSON body");
  }
  const prompt = (body?.prompt ?? "").trim();
  if (!prompt) return err("prompt is required");
  if (prompt.length > 8000) return err("prompt too long (max 8000 chars)");

  const options: JobOptions = {};
  const n = Number(body.maxSteps);
  if (Number.isFinite(n) && n >= 0 && n <= 40) options.maxSteps = Math.floor(n);
  for (const k of ["agentModel", "scadModel", "imageModel"] as const) {
    const v = body[k];
    if (typeof v === "string" && v.trim() && v.length < 200) options[k] = v.trim();
  }
  for (const k of ["noImage", "oneShot", "contextRenders", "assembly", "paint", "motion", "motionUrdf"] as const) {
    if (body[k] === true) options[k] = true;
  }
  if (body.preset === "default" || body.preset === "best" || body.preset === "custom") options.preset = body.preset;
  if (typeof body.imagePath === "string" && body.imagePath) {
    // Only accept what /api/upload handed out: a file directly under _uploads.
    const rel = body.imagePath.replace(/^[/\\]+/, "");
    const abs = safeJoin(ROOT, rel);
    if (!abs || !rel.startsWith("_uploads/") || rel.slice(9).includes("/") || !existsSync(abs)) {
      return err("imagePath must reference a file returned by /api/upload");
    }
    options.imagePath = rel;
  }
  if (options.imagePath && options.noImage) return err("noImage and imagePath are contradictory");
  if (options.noImage && options.oneShot) return err("a one-shot draft needs a reference image");
  if (options.oneShot && (options.contextRenders || options.assembly)) {
    return err("3D feedback and assembly mates need the part-by-part draft");
  }
  if (!options.imagePath && !options.noImage && !CAPABILITIES.imageGen) {
    if (options.oneShot) return err("no reference image and image generation is not configured");
    options.noImage = true; // mirrors the CLI: fall back to text-only
  }
  try {
    return json(jobs.create(prompt, options), 201);
  } catch (e) {
    return err((e as Error).message, 500);
  }
}

async function handleUpload(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err("expected multipart form data with a `file` field");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return err("missing `file`");
  if (file.size > UPLOAD_MAX_BYTES) return err(`image too large (max ${UPLOAD_MAX_BYTES / 1024 / 1024} MB)`, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = imageExt(bytes);
  if (!ext) return err("unsupported image (png, jpeg or webp)", 415);
  const dir = join(ROOT, "_uploads");
  mkdirSync(dir, { recursive: true });
  const name = `ref_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${ext}`;
  writeFileSync(join(dir, name), bytes);
  const resp: UploadResponse = { path: `_uploads/${name}`, bytes: bytes.length };
  return json(resp, 201);
}

function handleJobs(): Response {
  return json({ jobs: jobs.list(), generation: jobs.enabled });
}

function handleJob(req: Request): Response {
  const id = q(req, "id");
  if (!id) return err("missing ?id");
  const d = jobs.detail(id);
  return d ? json(d) : err("job not found", 404);
}

function handleCancel(req: Request): Response {
  const id = q(req, "id");
  if (!id) return err("missing ?id");
  return json({ canceled: jobs.cancel(id) });
}

function handleJobStream(req: Request): Response {
  const id = q(req, "id");
  if (!id) return err("missing ?id");
  const snap = jobs.snapshot(id);
  if (!snap) return err("job not found", 404);

  const enc = new TextEncoder();
  // Subscribe FIRST and buffer; the snapshot (taken right after) captures
  // history up to now, the buffer captures anything emitted before start()
  // runs — so we never lose or duplicate an event.
  let live: ((ev: JobEvent) => void) | null = null;
  let buffer: JobEvent[] = [];
  const unsub = jobs.subscribe(id, (ev) => (live ? live(ev) : buffer.push(ev)));
  if (!unsub) return err("job not found", 404);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    unsub();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (ev: JobEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* closed */
        }
      };
      send({ type: "status", job: snap.record });
      send({ type: "progress", progress: snap.progress });
      for (const line of snap.log) send({ type: "log", line });
      for (const ev of buffer) send(ev);
      buffer = [];
      live = send;
      const terminal = snap.record.status !== "running" && snap.record.status !== "queued";
      if (terminal) {
        setTimeout(() => {
          stop();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }, 50);
      }
    },
    cancel() {
      stop();
    },
  });
  req.signal?.addEventListener("abort", stop);
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function handleRuns(): Response {
  return json({ root: ROOT, runs: existsSync(ROOT) ? listRuns(ROOT) : [] });
}

function handleRun(req: Request): Response {
  const r = runDirFromReq(req);
  if (r instanceof Response) return r;
  try {
    return json(readRunDetail(ROOT, r.dir));
  } catch (e) {
    return err(`failed to read run: ${(e as Error).message}`, 500);
  }
}

function handleTrajectory(req: Request): Response {
  const r = runDirFromReq(req);
  if (r instanceof Response) return r;
  // ?file=<relpath> selects a specific jsonl; otherwise newest. (No full
  // readRunDetail here — just the cheap trajectory listing.)
  const fileRel = q(req, "file") ?? trajectoryFiles(ROOT, r.dir)[0];
  if (!fileRel) return json({ file: "", events: [], phases: [], truncated: false });
  const abs = safeJoin(ROOT, fileRel);
  if (!abs || !existsSync(abs)) return err("trajectory file not found", 404);
  return json(parseTrajectory(abs, fileRel));
}

function handleLs(req: Request): Response {
  const r = runDirFromReq(req);
  if (r instanceof Response) return r;
  const listing = listDirEntries(ROOT, r.dir, q(req, "sub") ?? "");
  if (!listing) return err("directory not found", 404);
  return json(listing);
}

function handleFile(req: Request): Response {
  const path = q(req, "path");
  if (!path) return err("missing ?path");
  // Defense in depth: never serve dotfiles (.env/.git/…) and only serve known
  // artifact types, so security doesn't hinge solely on ROOT placement.
  if (path.split(/[/\\]/).some((seg) => seg.startsWith("."))) return err("forbidden", 403);
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) return err("unsupported file type", 415);
  const abs = safeJoin(ROOT, path); // safeJoin also rejects symlink escapes
  if (!abs) return err("path escapes root", 403);
  if (!existsSync(abs) || !statSync(abs).isFile()) return err("file not found", 404);
  const headers: Record<string, string> = {
    "content-type": mime,
    "cache-control": "public, max-age=60",
  };
  if (q(req, "download") !== null) {
    headers["content-disposition"] = `attachment; filename="${basename(abs).replace(/"/g, "")}"`;
  }
  // gzip large binary meshes when the client accepts it — binary STL compresses
  // ~3.6x, a real win over a network (negligible on localhost). Small files and
  // already-text artifacts skip it (not worth the CPU).
  const ext = extname(abs).toLowerCase();
  const size = statSync(abs).size;
  const acceptsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
  if (acceptsGzip && (ext === ".stl" || ext === ".obj") && size > GZIP_MIN_BYTES) {
    try {
      const gz = Bun.gzipSync(new Uint8Array(readFileSync(abs)));
      headers["content-encoding"] = "gzip";
      headers["vary"] = "accept-encoding";
      return new Response(gz, { headers });
    } catch {
      /* fall through to the uncompressed stream */
    }
  }
  return new Response(Bun.file(abs), { headers });
}

function handleReferenceMesh(req: Request): Response {
  return referenceMeshHandler(referenceAuthority, req);
}

// ── serve ────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  development: DEV ? { hmr: true } : false,
  routes: {
    "/api/info": { GET: handleInfo },
    "/api/runs": { GET: handleRuns },
    "/api/run": { GET: handleRun },
    "/api/trajectory": { GET: handleTrajectory },
    "/api/ls": { GET: handleLs },
    "/api/file": { GET: handleFile },
    "/api/reference/mesh": { GET: handleReferenceMesh },
    "/api/params": { GET: handleParams },
    "/api/parts": { GET: handleParts },
    "/api/customize": { POST: handleCustomize },
    "/api/csg": { POST: handleCsg },
    "/api/generate": { POST: handleGenerate },
    "/api/upload": { POST: handleUpload },
    "/api/jobs": { GET: handleJobs },
    "/api/job": { GET: handleJob },
    "/api/jobs/cancel": { POST: handleCancel },
    "/api/jobs/stream": { GET: handleJobStream },
    "/*": index,
  },
});

const cap = (ok: boolean) => (ok ? "yes" : "no");
console.log(`\n  Procedura Studio  →  http://localhost:${server.port}  (bind ${HOST})`);
console.log(`  runs root         →  ${ROOT}${existsSync(ROOT) ? "" : "  (does not exist yet)"}`);
console.log(`  mode              →  ${DEV ? "development (hmr)" : "production"}`);
console.log(
  `  generation        →  ${
    PROCEDURA_REPO
      ? `enabled (repo: ${PROCEDURA_REPO}, ${MAX_CONCURRENT} concurrent / ${MAX_QUEUED} queued)`
      : "DISABLED (repo not resolved — run \`bun install\` in the repo root, or pass --repo)"
  }`,
);
console.log(
  `  capabilities      →  llm ${cap(CAPABILITIES.llm)} · image-gen ${cap(CAPABILITIES.imageGen)} · ` +
    `blender ${cap(CAPABILITIES.blender)} · isaac ${cap(CAPABILITIES.isaac)} · openscad ${cap(CAPABILITIES.openscad)}`,
);
const risk = rootRiskWarning();
if (risk) {
  console.log(
    `\n  ⚠ runs root is ${risk}. /api/file serves allowlisted files under it to\n` +
      `    unauthenticated clients — point --root at a dedicated outputs directory.`,
  );
}
console.log("");
