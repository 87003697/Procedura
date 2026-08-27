/**
 * TypeScript wrapper for the headless Isaac Sim validation harness
 * (src/motion/isaac_validate.py). Spawns `python.sh` inside the Isaac Sim
 * install, streams stdout/stderr to a log file, and parses the JSON report
 * written by the Python side.
 *
 * The environment is critical: proxies must be unset (they break loopback and
 * the LLM relay), and LD_LIBRARY_PATH must point at the bundled nvjitlink dir —
 * without it the user shell's cuda-12.4 libnvJitLink breaks the bundled torch
 * and SimulationApp exits code 0 silently before user code runs.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface IsaacSchemaAuditPhase {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  errors?: string[];
  warnings?: string[];
  stats?: {
    links?: number;
    joints?: number;
    articulationRoots?: number;
    metersPerUnit?: number;
    kilogramsPerUnit?: number | null;
    gravityMagnitude?: number | null;
    worldFixedJoint?: boolean;
  };
}

export interface IsaacAssetRuleIssue {
  severity: string;
  rule: string | null;
  message: string;
  prim: string | null;
}

export interface IsaacAssetRulesPhase {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  rulesEnabled?: number;
  rulesSkipped?: string[];
  issues?: IsaacAssetRuleIssue[];
}

export interface IsaacSimulationJoint {
  name: string;
  initialPosition: number;
  finalPosition: number;
  withinLimits: boolean;
}

export interface IsaacSimulationPhase {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  framesRun?: number;
  nanDetected?: boolean;
  maxLinearVelocity?: number;
  maxAngularVelocity?: number;
  rootDrift?: number;
  modelDiagonal?: number;
  dofCount?: number;
  joints?: IsaacSimulationJoint[];
  errors?: string[];
  warnings?: string[];
}

export interface IsaacUrdfRoundTripPhase {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  importedUsd?: string;
  errors?: string[];
  warnings?: string[];
}

/** One driven-joint sweep result (position or velocity mode). */
export interface IsaacActuationJointResult {
  name: string;
  mode?: "position" | "velocity" | string;
  /** Position mode: commanded limits (degrees / model units) and what was reached. */
  lower?: number | null;
  upper?: number | null;
  reachedLow?: number;
  reachedHigh?: number;
  rangeFraction?: number;
  /** Velocity mode: commanded vs final velocity (deg/s or units/s). */
  commandedVelocity?: number;
  finalVelocity?: number;
  ok?: boolean;
  skipped?: boolean;
  note?: string;
}

export interface IsaacActuationMimicResult {
  follower: string;
  reference: string;
  expected?: number;
  actual?: number;
  trackingOk?: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface IsaacActuationPhase {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  joints?: IsaacActuationJointResult[];
  mimics?: IsaacActuationMimicResult[];
  errors?: string[];
  warnings?: string[];
}

export interface IsaacContactPair {
  bodyA: string;
  bodyB: string;
  adjacent: boolean;
}

export interface IsaacSweepContactPair extends IsaacContactPair {
  joint: string;
}

export interface IsaacContactsPhase {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  restContacts?: IsaacContactPair[];
  sweepContacts?: IsaacSweepContactPair[];
  nonAdjacentRestCount?: number;
  nonAdjacentSweepCount?: number;
  totalContactEvents?: number;
  warnings?: string[];
}

export interface IsaacMobilityPhase {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  baseDisplacement?: number;
  diagonalFraction?: number;
  commandedWheels?: string[];
  warnings?: string[];
}

export interface IsaacCapturedFrame {
  path: string;
  label: string;
}

/**
 * Joint hints handed to the actuation/contacts/mobility phases; the pipeline
 * derives this from the MotionPlan and writes it as JSON (angles in degrees).
 */
export interface IsaacValidationHints {
  rootLink: string;
  fixedBase: boolean;
  drivenJoints: Array<{
    name: string;
    mode: "position" | "velocity";
    lower: number | null;
    upper: number | null;
    targetVelocity: number | null;
  }>;
  wheelJoints: string[];
  mimicJoints: Array<{
    follower: string;
    reference: string;
    gearing: number;
    offset: number;
  }>;
}

export interface IsaacValidationReport {
  ok: boolean;
  usdPath?: string;
  urdfPath?: string | null;
  phases: {
    schemaAudit?: IsaacSchemaAuditPhase;
    assetRules?: IsaacAssetRulesPhase;
    simulation?: IsaacSimulationPhase;
    actuation?: IsaacActuationPhase;
    contacts?: IsaacContactsPhase;
    mobility?: IsaacMobilityPhase;
    urdfRoundTrip?: IsaacUrdfRoundTripPhase;
  };
  /** Present only when the run was invoked with framesDir. */
  frames?: IsaacCapturedFrame[];
  /** MP4 clips of joint sweeps / mobility drive; present only with videosDir. */
  videos?: IsaacCapturedFrame[];
  errors: string[];
  warnings: string[];
  timings?: { startupSec?: number; totalSec?: number; phases?: Record<string, number> };
}

export interface RunIsaacValidationOpts {
  usdaPath: string;
  urdfPath?: string;
  reportPath: string;
  logPath?: string;
  steps?: number;
  timeoutMs?: number;
  isaacPath?: string;
  /** JSON file with IsaacValidationHints; enables actuation/contacts/mobility. */
  hintsPath?: string;
  /** Directory for RGB frame capture; enables the frames field. */
  framesDir?: string;
  /** Directory for MP4 sweep/mobility clips; enables the videos field (needs ffmpeg). */
  videosDir?: string;
  log?: (msg: string) => void;
}

export interface IsaacValidationRun {
  ok: boolean;
  report: IsaacValidationReport | null;
  reportPath: string;
  exitCode: number | null;
  timedOut: boolean;
  errors: string[];
  stderrTail?: string;
  durationMs: number;
}

const DEFAULT_ISAAC_PATH = join(process.env["HOME"] ?? "", "isaacsim");
const VALIDATE_SCRIPT = join(import.meta.dir, "isaac_validate.py");
const PROXY_VARS = [
  "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY",
];

/** Locate the Isaac Sim install: $PROCEDURA_ISAACSIM_PATH, else the default path. */
export function findIsaacSim(): string | null {
  const candidate = process.env.PROCEDURA_ISAACSIM_PATH ?? DEFAULT_ISAAC_PATH;
  if (existsSync(join(candidate, "python.sh"))) return candidate;
  return null;
}

export async function runIsaacValidation(opts: RunIsaacValidationOpts): Promise<IsaacValidationRun> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const reportPath = resolve(opts.reportPath);

  const isaacPath = opts.isaacPath ?? findIsaacSim();
  if (isaacPath === null || !existsSync(join(isaacPath, "python.sh"))) {
    return {
      ok: false,
      report: null,
      reportPath,
      exitCode: null,
      timedOut: false,
      errors: [
        "Isaac Sim not found (set PROCEDURA_ISAACSIM_PATH or install at " +
        `${DEFAULT_ISAAC_PATH}; python.sh must exist)`,
      ],
      durationMs: Date.now() - t0,
    };
  }

  if (!existsSync(VALIDATE_SCRIPT)) {
    return {
      ok: false,
      report: null,
      reportPath,
      exitCode: null,
      timedOut: false,
      errors: [`isaac_validate.py not found at ${VALIDATE_SCRIPT}`],
      durationMs: Date.now() - t0,
    };
  }

  mkdirSync(dirname(reportPath), { recursive: true });
  // A stale report from a previous round must never be parsed as this run's
  // result when the process dies before writing a fresh one.
  rmSync(reportPath, { force: true });
  const logPath = opts.logPath
    ? resolve(opts.logPath)
    : join(dirname(reportPath), "isaac_validation.log");

  const args: string[] = [
    // setsid gives the python.sh wrapper its own process group so a timeout
    // kill reaches the actual Kit python child, not just the bash wrapper.
    "setsid", "./python.sh", VALIDATE_SCRIPT,
    "--usd", resolve(opts.usdaPath),
    "--report", reportPath,
    "--steps", String(opts.steps ?? 120),
  ];
  if (opts.urdfPath) args.push("--urdf", resolve(opts.urdfPath));
  if (opts.hintsPath) args.push("--hints", resolve(opts.hintsPath));
  if (opts.framesDir) {
    mkdirSync(resolve(opts.framesDir), { recursive: true });
    args.push("--frames-dir", resolve(opts.framesDir));
  }
  if (opts.videosDir) {
    mkdirSync(resolve(opts.videosDir), { recursive: true });
    args.push("--videos-dir", resolve(opts.videosDir));
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !PROXY_VARS.includes(key)) env[key] = value;
  }
  env["LD_LIBRARY_PATH"] = join(
    isaacPath, "extsDeprecated/omni.isaac.ml_archive/pip_prebundle/nvidia/nvjitlink/lib",
  );
  env["OMNI_KIT_ACCEPT_EULA"] = "yes";
  env["PRIVACY_CONSENT"] = "N";

  const timeoutMs = opts.timeoutMs ?? Number(process.env.PROCEDURA_ISAAC_TIMEOUT_MS ?? 600_000);
  log(`  Isaac validation: ${args.join(" ")} (timeout ${Math.round(timeoutMs / 1000)}s)`);

  const proc = Bun.spawn(args, { cwd: isaacPath, env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    // Kill the whole setsid process group; python.sh does not exec its python
    // child, so killing only the wrapper would orphan the Kit process.
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill();
    }
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  const durationMs = Date.now() - t0;

  try {
    writeFileSync(logPath, `${stdout}\n---STDERR---\n${stderr}\n`, "utf8");
  } catch {
    // log file is best-effort
  }

  const errors: string[] = [];
  const stderrTail = stderr.slice(-2000);

  if (timedOut) {
    errors.push(`Isaac validation timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  let report: IsaacValidationReport | null = null;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8")) as IsaacValidationReport;
    } catch (err) {
      errors.push(`could not parse Isaac validation report: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    errors.push(`Isaac validation report was not written: ${reportPath}`);
  }

  if (exitCode !== 0 && !timedOut) {
    errors.push(`Isaac validation process exited ${exitCode}`);
  }

  const ok = report?.ok === true && exitCode === 0 && !timedOut;
  if (report !== null && report.ok !== true) {
    for (const err of report.errors ?? []) errors.push(err);
  }
  log(
    `  Isaac validation ${ok ? "passed" : "failed"} in ${Math.round(durationMs / 1000)}s` +
    ` (exit ${exitCode}, report ${report !== null ? "parsed" : "missing"}) — see ${logPath}`,
  );
  // The validator times its own phases and writes them into the report, where
  // they were being discarded. They are the only view into WHERE validation
  // time goes — on a 25s run, 10s of it was the mobility phase and 7s was
  // Isaac's own startup, which is not something the pipeline can speed up.
  const t = report?.timings;
  if (t) {
    const phases = Object.entries(t.phases ?? {})
      .filter(([, sec]) => typeof sec === "number" && sec >= 0.05)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .map(([name, sec]) => `${name} ${(sec as number).toFixed(1)}s`);
    log(
      `    isaac phases: startup ${(t.startupSec ?? 0).toFixed(1)}s` +
      (phases.length ? `, ${phases.join(", ")}` : "") +
      ` (total ${(t.totalSec ?? 0).toFixed(1)}s)`,
    );
  }

  return {
    ok,
    report,
    reportPath,
    exitCode,
    timedOut,
    errors,
    ...(report === null || exitCode !== 0 ? { stderrTail } : {}),
    durationMs,
  };
}
