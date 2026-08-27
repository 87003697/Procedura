/**
 * OpenSCAD CLI wrapper — compile .scad to binary STL + OBJ.
 *
 * Port of aetherion.openscad.compile_openscad. Spawns the openscad binary,
 * uses the Manifold backend when available, generates a summary JSON,
 * then post-processes the STL into an OBJ via our zero-dep mesh tools.
 *
 * Binary discovery: $OPENSCAD_PATH, else the first OPENSCAD_CANDIDATES entry
 * that exists, else `openscad` on $PATH.
 *
 * WHY THIS IS NOT JUST `openscad`: the binary many distros package is 2021.01,
 * which predates the Manifold backend and falls back to CGAL. That is not a
 * small difference — a single hull() measured 1774s under CGAL against 1.77s
 * under Manifold. Falling back to it silently turns a working run into one that
 * looks hung, so the resolver probes for Manifold support and a non-Manifold
 * binary warns loudly rather than quietly costing hours.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import { loadSTL } from "../mesh/stl.ts";
import { writeOBJ } from "../mesh/obj.ts";
import { addStage } from "../pipeline/stage-timer.ts";

/**
 * Searched in order when OPENSCAD_PATH is unset, after a bare `openscad` on
 * $PATH. These are the conventional places a hand-installed AppImage lands;
 * point OPENSCAD_PATH at yours if it lives somewhere else.
 */
const OPENSCAD_CANDIDATES = [
  join(process.env["HOME"] ?? "", "opt", "openscad"),
  "/usr/local/bin/openscad",
  "/opt/openscad/openscad",
];

/** `--help` output of a binary, or "" if it could not be run. */
function probeHelp(bin: string): string {
  try {
    const p = Bun.spawnSync([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    return p.stdout.toString() + p.stderr.toString();
  } catch {
    return "";
  }
}

/**
 * Resolve to a MANIFOLD-CAPABLE OpenSCAD, or to nothing.
 *
 * $OPENSCAD_PATH is tried first and wins whenever it can actually do the job.
 * It is overridden ONLY when it names a pre-Manifold build while a Manifold one
 * is sitting right there — the case that silently costs hours and that a stale
 * .env makes easy to hit. Probing costs one `--help` per candidate, once per
 * process, and stops at the first hit.
 */
function resolveOpenscadPath(): {
  path: string; manifold: boolean; tried: string[]; help: string;
} {
  const fromEnv = process.env["OPENSCAD_PATH"];
  const ordered = [...(fromEnv ? [fromEnv] : []), "openscad", ...OPENSCAD_CANDIDATES];
  const tried: string[] = [];
  let lastHelp = "";
  for (const c of ordered) {
    if (!c || tried.includes(c)) continue;
    // A bare name has no path to stat — let the probe resolve it through $PATH.
    if (c.includes("/") && !existsSync(c)) continue;
    tried.push(c);
    const help = probeHelp(c);
    if (help.includes("--backend")) return { path: c, manifold: true, tried, help };
    if (c === (fromEnv ?? "")) lastHelp = help; // keep the caller's own probe
  }
  // Nothing Manifold-capable. Keep the caller's choice (or the bare name) so the
  // error at compile time names something recognisable.
  return { path: fromEnv ?? "openscad", manifold: false, tried, help: lastHelp };
}

const RESOLVED = resolveOpenscadPath();
export const OPENSCAD_PATH = RESOLVED.path;

/**
 * Set PROCEDURA_ALLOW_CGAL_OPENSCAD=1 to run anyway on a pre-Manifold build.
 * Off by default: a CGAL fallback does not fail, it just takes orders of
 * magnitude longer (a single hull() measured 1774s vs 1.77s), so the useful
 * default is to stop and say so rather than let a run look hung for hours.
 */
const ALLOW_CGAL = process.env["PROCEDURA_ALLOW_CGAL_OPENSCAD"] === "1";

if (!RESOLVED.manifold && !ALLOW_CGAL) {
  console.error(
    `[openscad] No Manifold-capable OpenSCAD found. Tried:\n` +
    RESOLVED.tried.map((t) => `    ${t}`).join("\n") +
    `\n  Procedura needs a Manifold-capable build (OpenSCAD 2023.03+ / a recent\n` +
    `  development snapshot). Install one and either put it on $PATH or set\n` +
    `  OPENSCAD_PATH to it. To run anyway on the slow CGAL build, set` +
    ` PROCEDURA_ALLOW_CGAL_OPENSCAD=1.`,
  );
}

export interface CompileResult {
  stlPath: string;
  objPath: string;
  summary: Record<string, unknown>;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** OpenSCAD process exit code (null if killed by the timeout). */
  exitCode: number | null;
  /** True when the compile succeeded (exit 0) but produced NO geometry — a
   *  genuinely empty result (e.g. an empty intersection), distinct from a
   *  compile error. Only set in softFail mode; otherwise no-STL throws. */
  empty: boolean;
}

export interface CompileOpts {
  /** Output directory. Created if missing. */
  outputDir: string;
  /** Timeout in ms. Default 600 000 (10 min — generous for heavy CSG). */
  timeoutMs?: number;
  /** When true, a missing output STL returns `{ empty: true }` instead of
   *  throwing — so the caller can distinguish an empty-but-valid result
   *  (exit 0) from a real compile error (exit != 0). Default false. */
  softFail?: boolean;
  /**
   * Also emit `output.obj` beside the STL. Default FALSE.
   *
   * The OBJ costs a full STL read-back plus an ASCII write of the same mesh —
   * measured on refine_v5/assault_buggy: 176 compiles wrote 4.14 GB of STL and
   * 3.12 GB of OBJ (43% of all bytes) into an sshfs output dir, and the read-
   * back+write pass alone took 3350 s = 31% of that case's 180-min budget
   * (399 s for a single 375 MB pass under contention, vs 48 s uncontended).
   * Nothing on the hot paths reads this file: the gates read the STL or the
   * summary JSON, and `publishMesh` writes the shipped OBJ itself from the
   * normalized mesh. Set true only where the `output.obj` FILE is read.
   */
  writeObj?: boolean;
}

interface VersionInfo {
  version: string;
  hasManifold: boolean;
  hasSummary: boolean;
  hasEnableAll: boolean;
}

let _versionInfo: VersionInfo | null = null;

async function getVersionInfo(): Promise<VersionInfo> {
  if (_versionInfo) return _versionInfo;
  const info: VersionInfo = {
    version: "", hasManifold: false, hasSummary: false, hasEnableAll: false,
  };
  try {
    // Reuse the `--help` output the path resolution already paid for.
    const helpText = RESOLVED.help || probeHelp(OPENSCAD_PATH);
    info.hasManifold  = helpText.includes("--backend");
    info.hasSummary   = helpText.includes("--summary-file");
    info.hasEnableAll = helpText.includes("--enable");

    const ver = Bun.spawn([OPENSCAD_PATH, "--version"], { stdout: "pipe", stderr: "pipe" });
    const vOut = await new Response(ver.stdout).text();
    const vErr = await new Response(ver.stderr).text();
    await ver.exited;
    info.version = (vOut + vErr).trim();
  } catch (e) {
    console.error(`[openscad] version detection failed: ${(e as Error).message}`);
  }
  // A CGAL-only binary compiles everything correctly, just orders of magnitude
  // slower on hull/minkowski, so the failure mode is a run that LOOKS HUNG
  // rather than one that errors. Refuse it here — at the first compile, where
  // the message is attributable — instead of letting a batch burn hours.
  if (!info.hasManifold && !ALLOW_CGAL) {
    throw new Error(
      `OpenSCAD at "${OPENSCAD_PATH}" has no Manifold backend ` +
      `(${info.version || "version unknown"}). Procedura requires ` +
      `OpenSCAD-2026.04.04.AppImage or newer; the 2021.01 distro build falls ` +
      `back to CGAL and is orders of magnitude slower on heavy CSG. ` +
      `Set OPENSCAD_PATH, or set PROCEDURA_ALLOW_CGAL_OPENSCAD=1 to proceed anyway.`,
    );
  }
  _versionInfo = info;
  return info;
}

/**
 * Compile a SCAD source string into `<outputDir>/output.stl` + `output.obj`.
 *
 * Writes the source to `<outputDir>/input.scad` first (so the caller can
 * inspect/diff later). Throws if openscad produces no STL.
 */
export async function compileScad(
  code: string, opts: CompileOpts,
): Promise<CompileResult> {
  if (!opts.outputDir) throw new Error("compileScad: outputDir is required");
  mkdirSync(opts.outputDir, { recursive: true });

  const scadPath = join(opts.outputDir, "input.scad");
  const stlPath  = join(opts.outputDir, "output.stl");
  const objPath  = join(opts.outputDir, "output.obj");
  const summaryPath = join(opts.outputDir, "output.summary.json");
  writeFileSync(scadPath, code, "utf8");
  // Clear any prior outputs so a FAILED or truncated compile can never leave a
  // stale STL/summary that the existence checks below mistake for this run's
  // result. Draft build dirs are reused across parts/retries; without this, a
  // compile that writes no STL (e.g. a syntax error in a truncated part)
  // leaves the prior part's STL on disk and false-passes as success — the
  // stale-STL bug that let malformed parts commit.
  for (const p of [stlPath, objPath, summaryPath]) rmSync(p, { force: true });

  const info = await getVersionInfo();
  const args: string[] = [scadPath, "-o", stlPath, "--export-format", "binstl"];
  if (info.hasManifold)  args.push("--backend", "Manifold");
  if (info.hasEnableAll) args.push("--enable", "all");
  if (info.hasSummary)   args.push("--summary", "all", "--summary-file", summaryPath);
  args.push("--quiet");

  const t0 = Date.now();
  const proc = Bun.spawn([OPENSCAD_PATH, ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  const timer = opts.timeoutMs
    ? setTimeout(() => proc.kill(), opts.timeoutMs)
    : setTimeout(() => proc.kill(), 600_000);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  clearTimeout(timer);
  const durationMs = Date.now() - t0;
  addStage("openscad.total", durationMs);
  const exitCode = proc.exitCode;

  if (!existsSync(stlPath)) {
    // No STL. In softFail mode this is a valid outcome the caller classifies
    // (an empty top-level object also exits non-zero, so the caller keys on
    // stderr + exitCode — see classifyIntersectionEmpty); otherwise hard error.
    if (opts.softFail) {
      return { stlPath, objPath, summary: {}, stdout, stderr, durationMs, exitCode, empty: true };
    }
    throw new Error(`OpenSCAD produced no output STL (exit ${exitCode}).\nstderr: ${stderr.slice(-2000)}`);
  }
  // A parse/syntax error is a hard failure even if a build left an STL behind
  // (the stale-clear above covers the common case; this covers partials that
  // let malformed/truncated parts commit). softFail callers classify instead.
  if (!opts.softFail && /Parser error|syntax error/i.test(stderr)) {
    throw new Error(`OpenSCAD parse error.\nstderr: ${stderr.slice(-2000)}`);
  }
  let summary: Record<string, unknown> = {};
  if (existsSync(summaryPath)) {
    try { summary = JSON.parse(readFileSync(summaryPath, "utf8")); }
    catch { /* tolerate malformed summary */ }
  }

  // STL → OBJ via in-process parser/writer — opt-in only (see writeObj). The
  // path is still returned so callers' truthiness checks are unchanged; the
  // unconditional rmSync above guarantees a stale OBJ from a previous compile
  // in this reused build dir can never be mistaken for this run's output.
  if (opts.writeObj) {
    const mesh = loadSTL(stlPath);
    writeOBJ(objPath, mesh);
  }

  return { stlPath, objPath, summary, stdout, stderr, durationMs, exitCode, empty: false };
}

export async function checkOpenscad(): Promise<string> {
  const info = await getVersionInfo();
  if (!info.version || !info.version.includes("OpenSCAD")) {
    throw new Error(
      `OpenSCAD not found at "${OPENSCAD_PATH}". Install it or set OPENSCAD_PATH.`,
    );
  }
  return info.version;
}
