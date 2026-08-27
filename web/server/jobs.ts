/**
 * Generation job manager.
 *
 * The web app does NOT import the pipeline. Each generation runs the Procedura
 * CLI as a managed subprocess with cwd set to the repo root, so the harness,
 * .env (API keys), OpenSCAD and Blender all resolve exactly as they do from a
 * terminal — the Studio adds no second configuration surface.
 *
 * Responsibilities: a concurrency-limited queue, line-buffered log capture,
 * a periodic progress snapshot (artifacts appearing on disk), cancellation,
 * disk persistence of job records, and recovery of orphaned jobs after a
 * server restart.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

import type {
  JobDetail,
  JobEvent,
  JobOptions,
  JobPhase,
  JobProgress,
  JobRecord,
} from "../shared/types.ts";

interface LiveJob extends JobRecord {
  proc?: Bun.Subprocess;
  killTimer?: ReturnType<typeof setTimeout>;
  log: string[];
  subscribers: Set<(ev: JobEvent) => void>;
}

const LOG_CAP = 2000;
const LINE_CAP = 8192;

export interface JobManagerOpts {
  /** Runs root — jobs write to <root>/<runId>. */
  root: string;
  /** Main repo to spawn the CLI from (null disables generation). */
  repo: string | null;
  /** Env merged into the child process (parsed from the main repo's .env). */
  childEnv: Record<string, string>;
  maxConcurrent: number;
  /** Max in-flight jobs (running + queued); create() rejects beyond this. */
  maxQueued: number;
  /** Retain at most this many terminal job records (older are evicted). */
  retain: number;
  defaultMaxSteps: number;
  log?: (s: string) => void;
}

export class JobManager {
  private jobs = new Map<string, LiveJob>();
  private order: string[] = [];
  private running = new Set<string>();

  constructor(private opts: JobManagerOpts) {
    this.loadPersisted();
  }

  get enabled(): boolean {
    return this.opts.repo !== null;
  }

  create(prompt: string, options: JobOptions): JobRecord {
    if (!this.opts.repo) {
      throw new Error("generation is not available (repo / node_modules not resolved)");
    }
    const inFlight = this.order.reduce((n, id) => {
      const s = this.jobs.get(id)?.status;
      return n + (s === "running" || s === "queued" ? 1 : 0);
    }, 0);
    if (inFlight >= this.opts.maxQueued) {
      throw new Error(`queue is full (${this.opts.maxQueued} jobs in flight); wait for some to finish`);
    }
    const id = `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const slug = slugify(prompt) || "run";
    // Ensure the output dir is unique so two runs never collide / resume.
    let runId = `${slug}-${id.slice(4)}`;
    while (existsSync(join(this.opts.root, runId))) {
      runId = `${slug}-${id.slice(4)}-${Math.random().toString(36).slice(2, 5)}`;
    }
    const job: LiveJob = {
      id,
      prompt,
      options,
      runId,
      status: "queued",
      createdAt: Date.now(),
      log: [],
      subscribers: new Set(),
    };
    this.jobs.set(id, job);
    this.order.push(id);
    this.persist(job);
    this.evictOld();
    this.pump();
    return this.record(job);
  }

  list(): JobRecord[] {
    return this.order
      .map((id) => this.jobs.get(id))
      .filter((j): j is LiveJob => !!j)
      .map((j) => this.record(j))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  detail(id: string): JobDetail | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { ...this.record(job), log: [...job.log], progress: this.progress(job) };
  }

  /** Resolve a job by its runId (the outDir), newest first. */
  byRunId(runId: string): JobRecord | null {
    const matches = this.order
      .map((id) => this.jobs.get(id))
      .filter((j): j is LiveJob => !!j && j.runId === runId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return matches[0] ? this.record(matches[0]) : null;
  }

  subscribe(id: string, cb: (ev: JobEvent) => void): (() => void) | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.subscribers.add(cb);
    return () => job.subscribers.delete(cb);
  }

  snapshot(id: string): { log: string[]; record: JobRecord; progress: JobProgress } | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { log: [...job.log], record: this.record(job), progress: this.progress(job) };
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "queued") {
      job.status = "canceled";
      job.endedAt = Date.now();
      this.persist(job);
      this.emit(job, { type: "status", job: this.record(job) });
      this.pump();
      return true;
    }
    if (job.status === "running" && job.proc) {
      job.status = "canceled"; // exit handler will respect this
      const proc = job.proc;
      const pid = proc.pid;
      proc.kill(); // SIGTERM the bun child
      killChildren(pid, 15); // best-effort: TERM grandchildren (openscad/blender)
      job.killTimer = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {
          /* already gone */
        }
        killChildren(pid, 9);
      }, 4000);
      return true;
    }
    return false;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private pump(): void {
    if (!this.opts.repo) return;
    for (const id of this.order) {
      if (this.running.size >= this.opts.maxConcurrent) break;
      const job = this.jobs.get(id);
      if (job && job.status === "queued") this.start(job);
    }
  }

  private start(job: LiveJob): void {
    const repo = this.opts.repo!;
    const outDir = join(this.opts.root, job.runId);
    let proc: Bun.Subprocess;
    try {
      mkdirSync(outDir, { recursive: true });
      const promptFile = join(outDir, "prompt_input.txt");
      writeFileSync(promptFile, job.prompt, "utf8");
      const args = ["run", "scripts/procedura.ts", "-o", outDir, "--prompt-file", promptFile];
      const o = job.options;
      // Reference: an uploaded image is copied INTO the run dir first, so the
      // run stays self-contained after _uploads is pruned.
      if (o.imagePath) {
        const src = join(this.opts.root, o.imagePath);
        if (!existsSync(src)) throw new Error(`uploaded reference not found: ${o.imagePath}`);
        const dst = join(outDir, `image_input${extname(src).toLowerCase() || ".png"}`);
        copyFileSync(src, dst);
        args.push("--image", dst);
      } else if (o.noImage) {
        args.push("--no-image");
      }
      if (o.oneShot) args.push("--one-shot");
      if (o.contextRenders) args.push("--3d-feedback");
      if (o.assembly) args.push("--assembly");
      if (o.paint) args.push("--paint");
      if (o.motion) args.push("--motion");
      if (o.motionUrdf) args.push("--motion-urdf");
      if (o.maxSteps != null) args.push("--max-steps", String(o.maxSteps));
      if (o.agentModel) args.push("--agent-model", o.agentModel);
      if (o.scadModel) args.push("--scad-model", o.scadModel);
      if (o.imageModel) args.push("--image-model", o.imageModel);

      this.appendLog(job, `$ bun ${args.join(" ")}`);
      this.appendLog(job, `# cwd ${repo}`);
      proc = Bun.spawn([process.execPath, ...args], {
        cwd: repo,
        env: { ...process.env, ...this.opts.childEnv },
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      job.status = "failed";
      job.error = `failed to start: ${(e as Error).message}`;
      job.endedAt = Date.now();
      this.persist(job);
      this.emit(job, { type: "status", job: this.record(job) });
      this.pump(); // let the next queued job try
      return;
    }

    job.proc = proc;
    job.pid = proc.pid;
    job.status = "running";
    job.startedAt = Date.now();
    this.running.add(job.id);
    this.persist(job);
    this.emit(job, { type: "status", job: this.record(job) });

    void pumpLines(proc.stdout as ReadableStream<Uint8Array>, (l) => this.appendLog(job, l));
    void pumpLines(proc.stderr as ReadableStream<Uint8Array>, (l) => this.appendLog(job, l));

    const ticker = setInterval(() => {
      this.emit(job, { type: "progress", progress: this.progress(job) });
    }, 1500);

    void proc.exited.then((code) => {
      clearInterval(ticker);
      if (job.killTimer) clearTimeout(job.killTimer);
      job.killTimer = undefined;
      job.exitCode = code;
      job.proc = undefined;
      job.endedAt = Date.now();
      this.running.delete(job.id);
      if (job.status !== "canceled") {
        // The CLI exits non-zero when the refine verdict isn't "ok"
        // (e.g. max-steps / give_up) even though a usable model was still
        // produced. Treat the JOB as succeeded whenever a model exists — the
        // run's own quality verdict is surfaced by the inspector. Only a run
        // that produced no mesh at all is a real failure.
        const prog = this.progress(job);
        const producedModel = prog.finalReady || prog.draftReady;
        if (code === 0 || producedModel) {
          job.status = "succeeded";
        } else {
          job.status = "failed";
          if (!job.error) job.error = `pipeline exited with code ${code} without producing a model`;
        }
      }
      this.appendLog(job, `# process exited (code ${code}) — ${job.status}`);
      this.persist(job);
      this.emit(job, { type: "progress", progress: this.progress(job) });
      this.emit(job, { type: "status", job: this.record(job) });
      this.evictOld();
      this.pump();
    });
  }

  private appendLog(job: LiveJob, line: string): void {
    job.log.push(line.length > LINE_CAP ? line.slice(0, LINE_CAP) + " …[truncated]" : line);
    if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
    this.emit(job, { type: "log", line });
  }

  /** Evict the oldest terminal jobs beyond the retention cap (memory + disk). */
  private evictOld(): void {
    const terminal = this.order
      .map((id) => this.jobs.get(id))
      .filter((j): j is LiveJob => !!j && j.status !== "running" && j.status !== "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = terminal.length - this.opts.retain;
    for (let i = 0; i < excess; i++) {
      const job = terminal[i]!;
      job.subscribers.clear();
      this.jobs.delete(job.id);
      this.order = this.order.filter((id) => id !== job.id);
      try {
        rmSync(join(this.jobsDir(), `${job.id}.json`), { force: true });
      } catch {
        /* tolerate */
      }
    }
  }

  private emit(job: LiveJob, ev: JobEvent): void {
    for (const cb of job.subscribers) {
      try {
        cb(ev);
      } catch {
        /* a dead subscriber must not break the others */
      }
    }
  }

  private progress(job: LiveJob): JobProgress {
    const d = join(this.opts.root, job.runId);
    const o = job.options;
    const stepCount = (sub: string) =>
      safeDirs(join(d, sub)).filter((n) => n.startsWith("step_")).length;
    const meshAt = (base: string) =>
      existsSync(join(d, `${base}.obj`)) || existsSync(join(d, `${base}.stl`));

    // Part-by-part build: plan.json appears when the planner returns; each
    // part gets a _parts/NN_<name> dir when generation starts and an
    // after_gen.scad when it is committed.
    let planned = 0;
    try {
      const plan = JSON.parse(readFileSync(join(d, "plan.json"), "utf8")) as unknown;
      if (Array.isArray(plan)) planned = plan.length;
    } catch {
      /* no plan yet */
    }
    const partDirs = safeDirs(join(d, "_parts")).filter((n) => /^\d+_/.test(n)).sort();
    let built = 0;
    let building: string | null = null;
    for (const n of partDirs) {
      if (existsSync(join(d, "_parts", n, "after_gen.scad"))) built++;
      else building = n.replace(/^\d+_/, "");
    }

    const hasImage = existsSync(join(d, "image.png"));
    const draftReady = meshAt("draft");
    const finalReady = meshAt("final");
    const hasFinalSummary = existsSync(join(d, "final_summary.txt"));
    const painted = meshAt("final_painted");
    const motionReady = existsSync(join(d, "motion", "final_motion.usda"));
    let motionValidated: boolean | null = null;
    try {
      const rep = JSON.parse(readFileSync(join(d, "motion", "isaac_validation.json"), "utf8")) as { ok?: unknown };
      motionValidated = rep.ok === true;
    } catch {
      /* not validated (yet) */
    }
    const refineSteps = stepCount("_refine_steps");

    const terminal = job.status !== "running" && job.status !== "queued";
    const wantRef = !o.noImage && !o.imagePath;
    // draft.obj is rewritten after EVERY committed part, so its existence does
    // not mean the draft is done — the part count does.
    const stillBuilding = !o.oneShot && planned > 0 && built < planned && refineSteps === 0 && !finalReady;
    let phase: JobPhase;
    if (terminal) phase = "done";
    else if (o.motion && (painted || (!o.paint && finalReady))) phase = motionReady ? "done" : "motion";
    else if (o.paint && finalReady) phase = "paint";
    else if (finalReady) phase = "final";
    else if (stillBuilding) phase = "build";
    else if (draftReady || refineSteps > 0) phase = "refine";
    else if (planned > 0 || partDirs.length > 0) phase = "build";
    else if (hasImage || !wantRef) phase = o.oneShot ? "build" : "plan";
    else phase = wantRef ? "reference" : "starting";

    return {
      hasImage,
      planned,
      built,
      building,
      draftReady,
      renderSteps: stepCount("_agent_renders"),
      refineSteps,
      finalReady,
      hasFinalSummary,
      painted,
      motionReady,
      motionValidated,
      phase,
    };
  }

  private record(job: LiveJob): JobRecord {
    const { proc: _proc, log: _log, subscribers: _subs, ...rest } = job;
    void _proc;
    void _log;
    void _subs;
    return { ...rest };
  }

  private jobsDir(): string {
    return join(this.opts.root, "_web_jobs");
  }

  private persist(job: LiveJob): void {
    try {
      mkdirSync(this.jobsDir(), { recursive: true });
      writeFileSync(
        join(this.jobsDir(), `${job.id}.json`),
        JSON.stringify(this.record(job), null, 2),
        "utf8",
      );
    } catch (e) {
      this.opts.log?.(`[jobs] persist failed: ${(e as Error).message}`);
    }
  }

  private loadPersisted(): void {
    const dir = this.jobsDir();
    if (!existsSync(dir)) return;
    const records: JobRecord[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as JobRecord;
        // Validate the essential shape before trusting it.
        if (typeof rec.id !== "string" || !rec.id || typeof rec.runId !== "string" || !rec.runId) {
          continue;
        }
        if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt)) rec.createdAt = 0;
        // A job that was running when the server died is orphaned — its
        // subprocess is gone. Mark it so the UI doesn't show a fake spinner.
        if (rec.status === "running" || rec.status === "queued") {
          rec.status = "interrupted";
          if (!rec.endedAt) rec.endedAt = Date.now();
        } else if (rec.status === "failed") {
          // Reconcile records written before the produced-model check above:
          // a non-zero exit that still produced a mesh is a success.
          const d = join(this.opts.root, rec.runId);
          const has = (b: string) => existsSync(join(d, `${b}.obj`)) || existsSync(join(d, `${b}.stl`));
          if (has("final") || has("draft")) rec.status = "succeeded";
        }
        records.push(rec);
      } catch {
        /* skip corrupt record */
      }
    }
    records.sort((a, b) => a.createdAt - b.createdAt);
    for (const rec of records) {
      this.jobs.set(rec.id, { ...rec, log: [], subscribers: new Set() });
      this.order.push(rec.id);
    }
    this.evictOld();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Best-effort: signal the direct children of `pid` (the pipeline's openscad /
 *  blender subprocesses) so a canceled job doesn't leave orphaned compute. */
function killChildren(pid: number, signal: number): void {
  try {
    Bun.spawnSync(["pkill", `-${signal}`, "-P", String(pid)]);
  } catch {
    /* pkill unavailable — the parent kill is the primary mechanism */
  }
}

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, idx).replace(/\r$/, ""));
        buf = buf.slice(idx + 1);
      }
    }
  } catch {
    /* stream closed */
  } finally {
    if (buf.trim()) onLine(buf);
    reader.releaseLock();
  }
}

function safeDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || ""
  );
}
