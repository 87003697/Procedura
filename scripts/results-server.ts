#!/usr/bin/env bun
/**
 * Results viewer for Procedura batch out-roots — compare multiple runs
 * side-by-side and scrub each case's render history.
 *
 *   bun run scripts/results-server.ts --port 10399 \
 *     --root baseline=outputs/bench_incremental \
 *     --root part-aware=outputs/bench_partaware
 *
 * Config (env, with the long-standing values as defaults; flags win over env):
 *   RESULTS_PORT   listen port                              (default 10399)
 *   RESULTS_ROOTS  comma list of label=path roots           (default outputs/bench_incremental)
 *   RESULTS_CASES  manifest for prompts     (default hard_surface_v2/objects.jsonl)
 *
 * Per case it shows the reference image plus one column per --root. Global
 * controls (header): render MODE (AO / parts-colour), VIEW (iso/front/right/
 * top), and a HISTORY slider that scrubs every column STEP BY STEP through its
 * build timeline (per-part context renders → refine steps → final preview).
 * Each step's caption lists WHICH VIEWS were selected/rendered at that step
 * (the refine steps show the model's multiselect choice), highlighting the one
 * currently displayed. Status reads "building…" → "refining…" → "finish" as
 * each case completes. Serves only files already on disk — no Blender calls.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename, relative, dirname, isAbsolute } from "node:path";
import { ALL_VIEW_NAMES } from "../src/render/views.ts";

// Lowercase → canonical view name. Render filenames are mixed-case
// (e.g. `color-iso-BL-top.png`) but we match case-insensitively.
const VIEW_BY_LC = new Map<string, string>(ALL_VIEW_NAMES.map((v) => [v.toLowerCase(), v]));

interface Root { label: string; path: string; }
interface Args { roots: Root[]; port: number; cases: string; ids: string[]; }

// "label=path" → Root (label sanitised for use in URLs)
function parseRoot(v: string): Root {
  const eq = v.indexOf("=");
  const label = (eq >= 0 ? v.slice(0, eq) : "result").replace(/[^A-Za-z0-9_-]/g, "_");
  const path = resolve(eq >= 0 ? v.slice(eq + 1) : v);
  return { label, path };
}

function parseArgs(argv: string[]): Args {
  const roots: Root[] = [];
  let port = Number(process.env.RESULTS_PORT ?? 10399);
  let cases = process.env.RESULTS_CASES
    ? resolve(process.env.RESULTS_CASES)
    : resolve("cases.jsonl");
  let ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === "--root") roots.push(parseRoot(argv[++i]!));
    else if (f === "--port") port = Number(argv[++i]!);
    else if (f === "--cases") cases = resolve(argv[++i]!);
    else if (f === "--ids") ids = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (roots.length === 0) {
    for (const v of (process.env.RESULTS_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      roots.push(parseRoot(v));
    }
  }
  if (roots.length === 0) roots.push({ label: "result", path: resolve("outputs/bench_incremental") });
  return { roots, port, cases, ids };
}
const args = parseArgs(process.argv.slice(2));
const ROOTS = args.roots;
const ID_FILTER = new Set(args.ids);
const rootByLabel = new Map(ROOTS.map((r) => [r.label, r.path]));

const prompts = new Map<string, string>();
const referenceImages = new Map<string, string>();
if (existsSync(args.cases)) {
  const casesDir = dirname(args.cases);
  for (const ln of readFileSync(args.cases, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try {
      const r = JSON.parse(ln) as { id: string; prompt?: string; condition_prompt_short?: string; image?: string };
      prompts.set(r.id, r.prompt ?? r.condition_prompt_short ?? "");
      if (r.image) referenceImages.set(r.id, isAbsolute(r.image) ? r.image : resolve(casesDir, r.image));
    } catch { /* skip */ }
  }
}

function safeMtime(p: string): number { try { return statSync(p).mtimeMs; } catch { return 0; } }
function sizeKb(p: string): number { try { return Math.round(statSync(p).size / 1024); } catch { return 0; } }
function readJson<T>(p: string): T | null { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } }

function caseIds(): string[] {
  const ids = new Set<string>();
  for (const r of ROOTS) {
    if (!existsSync(r.path)) continue;
    for (const e of readdirSync(r.path, { withFileTypes: true })) {
      if (e.isDirectory() && /^[A-Za-z0-9_-]+$/.test(e.name) && (ID_FILTER.size === 0 || ID_FILTER.has(e.name))) ids.add(e.name);
    }
  }
  return [...ids].sort();
}

function collectPngs(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 7 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectPngs(p, depth + 1, out);
    else if (e.name.toLowerCase().endsWith(".png") && e.name !== "image.png") out.push(p);
  }
  return out;
}

/**
 * Classify one render PNG into a frame: render {mode, view} plus the *step* it
 * belongs to. A "step" is one render event in the build timeline:
 *   - a per-part context render (`_parts/NN_name/context_render/…`)
 *   - a per-part focused-refine step (`_parts/NN_name/_agent_renders/step_M/…`)
 *   - a whole-model refine step  (`_agent_renders/step_M/…`)  ← multiselect choice
 *   - the final preview          (`preview_final/…`)
 * The set of views in a step IS what was selected/rendered at that step, so the
 * viewer can show "which views were selected" by listing a step's frames.
 * Returns null if the filename isn't a known catalog view.
 */
function classify(
  caseDir: string,
  p: string,
): { mode: string; view: string; stepKey: string; stepLabel: string; phase: string } | null {
  const rel = relative(caseDir, p);
  const base = basename(p).toLowerCase().replace(/\.png$/, "");
  const isParts = rel.includes("parts_color") || base.startsWith("color-") || base.startsWith("color_");
  const mode = isParts ? "parts-color" : "ao";
  const viewRaw = base.replace(/^(color|ao)[-_]/, "");
  const view = VIEW_BY_LC.get(viewRaw); // canonical name, or undefined
  if (!view) return null;

  let stepKey: string, stepLabel: string, phase: string;
  let m: RegExpExecArray | null;
  if ((m = /^_parts\/(\d+)_([^/]+)\/_agent_renders\/step_(\d+)\//.exec(rel))) {
    phase = "partfix"; stepKey = `part:${m[1]}_${m[2]}:${m[3]}`; stepLabel = `P${m[1]} fix s${Number(m[3])} · ${m[2]}`;
  } else if ((m = /^_parts\/(\d+)_([^/]+)\/context_render\//.exec(rel))) {
    phase = "ctx"; stepKey = `ctx:${m[1]}_${m[2]}`; stepLabel = `P${m[1]} ${m[2]}`;
  } else if ((m = /^_parts\/(\d+)_([^/]+)\/plan_revise_render\//.exec(rel))) {
    // The build-so-far render taken after part NN (and reused as the next
    // part's context when geometry is unchanged). Group all its views into ONE
    // step — without this it falls into the catch-all below, where each PNG's
    // unique path makes it its own single-view step and the VIEW selector breaks.
    phase = "ctx"; stepKey = `revise:${m[1]}_${m[2]}`; stepLabel = `P${m[1]} revise · ${m[2]}`;
  } else if ((m = /^_agent_renders\/step_(\d+)\//.exec(rel))) {
    phase = "refine"; stepKey = `refine:${m[1]}`; stepLabel = `refine s${Number(m[1])}`;
  } else if (rel.includes("preview_final")) {
    phase = "final"; stepKey = "final"; stepLabel = "final preview";
  } else {
    phase = "other"; stepKey = `other:${rel}`; stepLabel = "render";
  }
  return { mode, view, stepKey, stepLabel, phase };
}

/**
 * Map a ctx step → the set of views the LLM SELECTED (ctx-select mode). Reads
 * each `_parts/NN_name/context_render/selection.json`; its stepKey is
 * `ctx:NN_name`. Views not in a selection.json (fixed-12 runs) have no entry.
 */
function ctxSelections(caseDir: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const partsDir = join(caseDir, "_parts");
  if (!existsSync(partsDir)) return out;
  for (const e of readdirSync(partsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const selPath = join(partsDir, e.name, "context_render", "selection.json");
    const sel = readJson<{ selected?: string[] }>(selPath);
    if (!sel || !Array.isArray(sel.selected)) continue;
    const set = new Set<string>();
    for (const v of sel.selected) {
      const canon = VIEW_BY_LC.get(String(v).toLowerCase());
      if (canon) set.add(canon);
    }
    out.set(`ctx:${e.name}`, set);
  }
  return out;
}

interface Frame { rel: string; mode: string; view: string; stepKey: string; stepLabel: string; phase: string; t: number; selected: boolean; }
// Cache frames for COMPLETED cases (final.obj present + stable mtime). A done
// case's render set never changes, so we avoid re-scanning its (often 300+) PNGs
// on every 5s poll. In-progress cases (no final.obj) always re-scan.
const frameCache = new Map<string, { sig: number; frames: Frame[] }>();
function framesFor(caseDir: string): Frame[] {
  const sig = safeMtime(join(caseDir, "final.obj")); // 0 while still running
  if (sig > 0) { const c = frameCache.get(caseDir); if (c && c.sig === sig) return c.frames; }
  const ctxSel = ctxSelections(caseDir);
  const out: Frame[] = [];
  for (const p of collectPngs(caseDir)) {
    const c = classify(caseDir, p);
    if (!c) continue;
    // "selected" = the LLM actively chose this view at this step.
    //   refine/partfix: render_views renders ONLY the chosen views → all selected.
    //   ctx (ctx-select mode): the subset in selection.json.
    //   ctx (fixed mode) / final / other: not an active choice → false.
    const selected =
      c.phase === "refine" || c.phase === "partfix" ? true
      : c.phase === "ctx" ? (ctxSel.get(c.stepKey)?.has(c.view) ?? false)
      : false;
    out.push({
      rel: relative(caseDir, p),
      mode: c.mode, view: c.view, stepKey: c.stepKey, stepLabel: c.stepLabel, phase: c.phase,
      t: Math.round(safeMtime(p)), selected,
    });
  }
  out.sort((a, b) => (a.t - b.t) || a.rel.localeCompare(b.rel));
  if (sig > 0) frameCache.set(caseDir, { sig, frames: out });
  return out;
}

interface RootInfo {
  label: string; planCount: number; partsGenerated: number | null; draftDone: boolean;
  edits: number; refineVerdict: string | null; done: boolean;
  draftKb: number; finalKb: number; frames: Frame[];
  /** Hardened-pipeline telemetry (parts_summary.json / eval_case_result.json);
   *  null/0 on runs that predate the fields. */
  reverts: number; nudges: number; tokens: number | null; seconds: number | null;
  /** Plan-review critic iterations (count of plan_review_NN.txt); 0 if the
   *  feature was off or the run predates it. */
  planReviews: number;
}
function collectSummaries(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectSummaries(p, depth + 1, out);
    else if (e.name === "summary.json") out.push(p);
  }
  return out;
}
interface PartsSummary {
  partsGenerated?: number;
  parts?: { edits?: number; nudges?: number; reverted?: boolean }[];
  usage?: { inputTokens?: number; outputTokens?: number };
}
function rootInfo(label: string, rootPath: string, id: string): RootInfo {
  const dir = join(rootPath, id);
  const plan = readJson<unknown[]>(join(dir, "plan.json"));
  const summary = readJson<PartsSummary>(join(dir, "parts_summary.json"));
  // parts_summary.json is written only when the draft COMPLETES; during a live
  // build the running count lives in _resume.json (partsGenerated / nextIndex).
  const resume = readJson<{ partsGenerated?: number; nextIndex?: number }>(join(dir, "_resume.json"));
  let refineVerdict: string | null = null;
  // Prefer the eval's recorded verdict (accurate: ok/max-steps/error); fall back
  // to parsing final_summary.txt for non-eval benchmark roots.
  const ecr = readJson<{ verdict?: string; seconds?: number }>(join(dir, "eval_case_result.json"));
  const fsum = join(dir, "final_summary.txt");
  if (ecr?.verdict) {
    refineVerdict = ecr.verdict;
  } else if (existsSync(fsum)) {
    const first = readFileSync(fsum, "utf8").split("\n").find((l) => l.toLowerCase().startsWith("verdict:"));
    refineVerdict = first ? first.replace(/verdict:\s*/i, "").trim() : "done";
  }
  // Edits: the hardened pipeline records per-part edits in parts_summary.json
  // (authoritative); older runs only have the step-saver summary.json files.
  let edits = 0;
  let nudges = 0;
  let reverts = 0;
  const parts = summary?.parts;
  if (Array.isArray(parts) && parts.some((p) => typeof p.edits === "number")) {
    for (const p of parts) {
      edits += p.edits ?? 0;
      nudges += p.nudges ?? 0;
      if (p.reverted) reverts += 1;
    }
  } else {
    for (const f of collectSummaries(join(dir, "_parts"))) {
      const s = readJson<{ edits?: unknown[] }>(f);
      if (s && Array.isArray(s.edits)) edits += s.edits.length;
    }
  }
  const tokens = summary?.usage
    ? (summary.usage.inputTokens ?? 0) + (summary.usage.outputTokens ?? 0)
    : null;
  // Plan-review critic iterations = count of plan_review_NN.txt sidecars.
  let planReviews = 0;
  try {
    for (const f of readdirSync(dir)) if (/^plan_review_\d+\.txt$/.test(f)) planReviews++;
  } catch { /* dir missing → 0 */ }
  // Live-progress fallback for pipelines without _resume.json (the 43213d0
  // baseline has no checkpointing): each built part leaves a _parts/NN_* dir.
  let partsDirCount: number | null = null;
  try {
    const n = readdirSync(join(dir, "_parts")).filter((f) => /^\d+_/.test(f)).length;
    if (n > 0) partsDirCount = n;
  } catch { /* no _parts yet */ }
  const finalKb = sizeKb(join(dir, "final.obj"));
  return {
    label,
    planCount: Array.isArray(plan) ? plan.length : 0,
    partsGenerated: summary?.partsGenerated ?? resume?.partsGenerated ?? resume?.nextIndex ?? partsDirCount,
    draftDone: summary != null,
    edits,
    refineVerdict,
    done: finalKb > 0 || refineVerdict !== null,
    draftKb: sizeKb(join(dir, "draft.obj")),
    finalKb,
    frames: framesFor(dir),
    reverts, nudges, planReviews,
    tokens: tokens && tokens > 0 ? tokens : null,
    seconds: typeof ecr?.seconds === "number" ? ecr.seconds : null,
  };
}

function fileResponse(p: string | null, type: string): Response {
  if (!p || !existsSync(p)) return new Response("not found", { status: 404 });
  return new Response(readFileSync(p), { headers: { "content-type": type, "cache-control": "no-cache" } });
}
function ctype(p: string): string {
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8"; // .txt .scad .obj .jsonl .md etc. — viewable inline in the browser
}
function walkFiles(base: string, dir = base, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(base, p, depth + 1, out);
    else out.push(relative(base, p));
  }
  return out;
}

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8">
<title>Procedura results compare</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0e0f12; color:#e6e6e6; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { position:sticky; top:0; background:#15171c; border-bottom:1px solid #262a31; padding:10px 18px; display:flex; gap:18px; align-items:center; flex-wrap:wrap; z-index:10; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .meta { color:#9aa3af; font-size:12px; }
  .ctl { display:flex; gap:6px; align-items:center; }
  .ctl label { color:#9aa3af; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .seg button { background:#1b1e25; color:#cbd2da; border:1px solid #2c313a; padding:3px 9px; font-size:12px; cursor:pointer; }
  .seg button:first-child { border-radius:6px 0 0 6px; } .seg button:last-child { border-radius:0 6px 6px 0; }
  .seg button.on { background:#27406b; color:#dbe7ff; border-color:#3b5fa0; }
  input[type=range] { width:260px; accent-color:#7aa2f7; }
  .grid { display:grid; grid-template-columns:1fr; gap:14px; padding:16px; }  /* one case per full-width row */
  .card { background:#15171c; border:1px solid #262a31; border-radius:10px; overflow:hidden; }
  .card h2 { font-size:13px; margin:0; padding:8px 12px; background:#1b1e25; border-bottom:1px solid #262a31; }
  .imgs { display:grid; gap:1px; background:#262a31; }
  .imgs figure { margin:0; background:#0a0b0d; display:flex; flex-direction:column; }
  .imgs figcaption { font-size:10px; color:#7a828e; padding:3px 6px; text-transform:uppercase; letter-spacing:.03em; display:flex; gap:6px; justify-content:space-between; align-items:flex-start; }
  .imgs figcaption a.scad { color:#7aa2f7; text-decoration:none; white-space:nowrap; flex:none; }
  .cap { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; }
  .capmain { color:#aab2bd; }
  .vchips { display:flex; flex-wrap:wrap; gap:3px; text-transform:none; letter-spacing:0; }
  .vchip { font-size:9px; padding:0 4px; border-radius:3px; border:1px solid #2c313a; color:#6b7280; background:#14161b; line-height:1.5; }
  .vchip.sel { border-color:#1f6f3f; color:#86efac; background:#0f2418; font-weight:600; }
  .vchip.cur { outline:1.5px solid #dbe7ff; outline-offset:0; }
  .legend { display:flex; gap:10px; align-items:center; color:#7a828e; font-size:10px; text-transform:none; letter-spacing:0; }
  .legend .vchip { cursor:default; }
  .imgs img { width:100%; aspect-ratio:1/1; object-fit:contain; background:#0a0b0d; display:block; }
  .imgs .ph { width:100%; aspect-ratio:1/1; display:flex; align-items:center; justify-content:center; color:#555; font-size:12px; }
  .body { padding:8px 12px; }
  .prompt { color:#aab2bd; font-size:12px; max-height:3.4em; overflow:hidden; }
  .rows { margin-top:8px; display:flex; flex-direction:column; gap:4px; }
  .row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:11px; }
  .row .lab { color:#9aa3af; min-width:84px; font-weight:600; }
  .b { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid #2c313a; color:#cbd2da; background:#1b1e25; }
  .b.ok { border-color:#1f6f3f; color:#86efac; background:#0f2418; }
  .b.warn { border-color:#7a5b16; color:#fcd34d; background:#241c0f; }
  .b.fail { border-color:#7a2331; color:#fca5a5; background:#2a0f14; }
  .b.big { border-color:#9a6a16; color:#fbbf24; background:#2a200c; font-weight:600; }
  .b.verd { border-color:#3a3f4b; color:#aab2bd; background:#171a20; }
  .b.edits { border-color:#3b4d7a; color:#9db8f7; background:#121a2e; }
  kbd { font:11px ui-monospace,monospace; background:#1b1e25; border:1px solid #2c313a; border-radius:4px; padding:0 4px; color:#cbd2da; }
  .det { border-top:1px solid #262a31; margin-top:8px; padding-top:8px; }
  .detbtn { appearance:none; background:#1b1e25; border:1px solid #2c313a; color:#9db8f7; font:inherit; font-size:11px; padding:4px 11px; border-radius:7px; cursor:pointer; }
  .detbtn:hover { color:#dbe7ff; border-color:#3b5fa0; }
  .detbody { margin-top:10px; }
  .detroot > h4 { margin:10px 0 6px; font:11px ui-monospace,monospace; color:#7aa2f7; font-weight:600; }
  .planlist { list-style:none; padding:0; margin:0 0 8px; }
  .planlist li { font-size:11px; padding:4px 0; border-bottom:1px solid #14161b; color:#9aa3af; }
  .planlist li b { color:#cbd2da; } .planlist li .lv { color:#6b7280; font:10px ui-monospace,monospace; margin:0 6px; }
  .filegrp { margin:7px 0; }
  .filegrp > span.gl { font-size:10px; color:#6b7280; text-transform:uppercase; letter-spacing:.04em; }
  .filegrp a { display:inline-block; margin:3px 8px 3px 0; font:11px ui-monospace,monospace; color:#9aa3af; text-decoration:none; border-bottom:1px dotted #3a3f4b; }
  .filegrp a:hover { color:#7aa2f7; }
  .filegrp .more { color:#6b7280; font-size:10px; }
</style></head><body>
<header>
  <h1>Procedura results</h1>
  <span class="ctl"><label>mode</label><span class="seg" id="mode"></span></span>
  <span class="ctl"><label>view</label><span class="seg" id="view"></span></span>
  <span class="ctl"><label>history</label><input type="range" id="hist" min="0" max="100" value="100"><span class="meta" id="histlab">latest</span><span class="meta"><kbd>←</kbd><kbd>→</kbd> step</span></span>
  <span class="legend"><span class="vchip sel">view</span>LLM-selected<span class="vchip">view</span>rendered<span class="vchip cur">view</span>showing</span>
  <span class="meta" id="meta" style="margin-left:auto"></span>
</header>
<div class="grid" id="grid"></div>
<script>
const MODES = ["parts-color","ao"], VIEWS = ["isometric","front","right","top"];
const VIEW_ORDER = ${JSON.stringify([...ALL_VIEW_NAMES])};   // catalog order for chip sorting
let state = { mode:"parts-color", view:"isometric", pos:100 };
let DATA = null, lastKey = "";
function seg(id, opts, cur, on){ const e=document.getElementById(id); e.innerHTML=opts.map(o=>'<button class="'+(o===cur?'on':'')+'" data-v="'+o+'">'+o+'</button>').join(''); e.querySelectorAll('button').forEach(b=>b.onclick=()=>on(b.dataset.v)); }
function setSeg(id,cur){ document.querySelectorAll('#'+id+' button').forEach(b=>b.classList.toggle('on', b.dataset.v===cur)); }
function controls(){
  seg("mode", MODES, state.mode, v=>{state.mode=v; setSeg("mode",v); applyFrames();});
  seg("view", VIEWS, state.view, v=>{state.view=v; setSeg("view",v); applyFrames();});
  const h=document.getElementById("hist"); h.value=state.pos;
  const setPos=p=>{ state.pos=Math.max(0,Math.min(100,Math.round(p))); h.value=state.pos; document.getElementById("histlab").textContent = state.pos>=100?"latest":state.pos+"%"; applyFrames(); };
  h.oninput=()=>setPos(+h.value);
  // Keyboard scrubbing: ←/→ advance by one step of the densest timeline; Home/End to ends.
  document.addEventListener("keydown", e=>{
    if(e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
    let maxSteps=2;
    if(DATA) for(const c of DATA.cases) for(const l of DATA.roots) maxSteps=Math.max(maxSteps, stepsOf(l,c.id).length);
    const stepPct=100/(maxSteps-1);
    if(e.key==="ArrowRight") setPos(state.pos+stepPct);
    else if(e.key==="ArrowLeft") setPos(state.pos-stepPct);
    else if(e.key==="Home") setPos(0);
    else if(e.key==="End") setPos(100);
    else return;
    e.preventDefault();
  });
}
function framesOf(label,id){ const c=(DATA?DATA.cases:[]).find(x=>x.id===id); return (c && c.roots[label] && c.roots[label].frames) || []; }
// Group a column's frames into ordered STEPS (one render event each), earliest
// first. Each step carries the full set of views that were rendered at it.
function stepsOf(label,id){
  const map = new Map();
  for(const f of framesOf(label,id)){
    let s = map.get(f.stepKey);
    if(!s){ s={key:f.stepKey,label:f.stepLabel,phase:f.phase,minT:f.t,frames:[]}; map.set(f.stepKey,s); }
    s.frames.push(f); if(f.t<s.minT) s.minT=f.t;
  }
  return [...map.values()].sort((a,b)=>(a.minT-b.minT)||a.key.localeCompare(b.key));
}
// Pick the step at the current slider position and choose which frame to DISPLAY.
// The slider scrubs each column through its OWN steps. Within the chosen step we
// prefer the global VIEW (and MODE as a soft preference); the views array is the
// full set of views selected/rendered at that step so the caption can show them.
function pickStep(label,id){
  const steps = stepsOf(label,id);
  if(!steps.length) return null;
  const idx = Math.round(state.pos/100*(steps.length-1));
  const step = steps[idx];
  let cands = step.frames.filter(f=>f.view===state.view);
  if(!cands.length) cands = step.frames.slice();        // view not rendered here → show whatever was
  const pref = cands.filter(f=>f.mode===state.mode);
  const show = (pref.length?pref:cands)[0];
  // one chip per view at this step; selected = the LLM actively chose it.
  const byView = new Map();
  for(const f of step.frames){ const e=byView.get(f.view); if(e){ e.selected = e.selected||f.selected; } else byView.set(f.view,{name:f.view, selected:!!f.selected}); }
  const views = [...byView.values()].sort((a,b)=>VIEW_ORDER.indexOf(a.name)-VIEW_ORDER.indexOf(b.name));
  const nSel = views.filter(v=>v.selected).length;
  return { show, step, idx, n:steps.length, views, nSel };
}
function statusBadge(r){
  if(r.finalKb>0) return '<span class="b ok">finish</span>';
  if(r.refineVerdict) return '<span class="b fail">✗ no final</span>';   // terminal but produced no mesh
  if(r.draftDone) return '<span class="b warn">refining…</span>';        // all parts built, whole-model refine running
  if(r.partsGenerated!=null || r.planCount>0) return '<span class="b warn">building…</span>';
  return '<span class="b warn">running…</span>';
}
const fmtKb = k => k>=1024 ? (k/1024).toFixed(1)+" MB" : k+" KB";
const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
// Build the card STRUCTURE once per data change; images are filled by applyFrames.
function rebuild(){
  if(!DATA) return;
  const ROOTS = DATA.roots, cs = DATA.cases, ncol = ROOTS.length+1;
  document.getElementById("meta").textContent = cs.length+" cases · "+ROOTS.join(" vs ");
  document.getElementById("grid").innerHTML = cs.map(c=>{
    const cols = ['<figure><figcaption>reference</figcaption><img loading="lazy" src="/ref/'+c.id+'"></figure>']
      .concat(ROOTS.map(label=>
        '<figure><figcaption><span class="cap" data-label="'+esc(label)+'" data-id="'+c.id+'">'+esc(label)+'</span>'
        +'<a class="scad" href="/scad/'+label+'/'+c.id+'" target="_blank">scad ↗</a></figcaption>'
        +'<img class="rimg" loading="lazy" data-label="'+esc(label)+'" data-id="'+c.id+'" data-rel="">'
        +'<div class="ph" data-label="'+esc(label)+'" data-id="'+c.id+'" style="display:none"></div></figure>'
      )).join("");
    const big = kb => kb>=100*1024 ? ' big' : '';   // flag pathologically large meshes (>100 MB)
    const rows = ROOTS.map(label=>{
      const r=c.roots[label]||{};
      const gen = r.planCount>0 ? (r.partsGenerated ?? 0)+"/"+r.planCount+" parts"
                : "monolithic";
      const fin = r.finalKb ? '<span class="b'+big(r.finalKb)+'">final '+fmtKb(r.finalKb)+'</span>'
                : (r.draftKb?'<span class="b'+big(r.draftKb)+'">draft '+fmtKb(r.draftKb)+'</span>':'');
      const verd = r.refineVerdict ? '<span class="b verd" title="refine verdict">'+esc(r.refineVerdict)+'</span>' : '';
      // Hardened-pipeline telemetry — rendered only when the run recorded it.
      const nud = r.nudges ? '<span class="b" title="continue-nudges across per-part passes">'+r.nudges+' nudge'+(r.nudges>1?'s':'')+'</span>' : '';
      const rev = r.reverts ? '<span class="b fail" title="per-part safety-net reverts">'+r.reverts+' revert'+(r.reverts>1?'s':'')+'</span>' : '';
      const tok = r.tokens ? '<span class="b" title="LLM tokens, in+out, whole build">'+(r.tokens>=1e6?(r.tokens/1e6).toFixed(1)+'M':Math.round(r.tokens/1e3)+'k')+' tok</span>' : '';
      const dur = r.seconds ? '<span class="b" title="wall-clock (excl. outage waits)">'+(r.seconds>=3600?(r.seconds/3600).toFixed(1)+'h':Math.round(r.seconds/60)+'m')+'</span>' : '';
      const plr = r.planReviews ? '<span class="b" title="plan-review critic iterations">'+r.planReviews+' plan-rev</span>' : '';
      return '<div class="row"><span class="lab">'+esc(label)+'</span><span class="b">'+gen+'</span>'+plr+'<span class="b edits">'+(r.edits||0)+' edits</span>'+statusBadge(r)+verd+nud+rev+tok+dur+fin+'</div>';
    }).join("");
    return '<div class="card"><h2>'+c.id+'</h2>'
      +'<div class="imgs" style="grid-template-columns:repeat('+ncol+',1fr)">'+cols+'</div>'
      +'<div class="body"><div class="prompt" title="'+esc(c.prompt||"")+'">'+esc(c.prompt||"")+'</div>'
      +'<div class="rows">'+rows+'</div>'
      +'<div class="det"><button class="detbtn" data-id="'+c.id+'">▾ all artifacts (plan, responses, scad, renders, trajectory)</button>'
      +'<div class="detbody" data-id="'+c.id+'" style="display:none"></div></div>'
      +'</div></div>';
  }).join("");
  applyFrames();
}
// Update each result image's src + caption in place for the current mode/view/pos.
// No innerHTML rebuild → scrubbing the slider is smooth and only refetches a frame
// when it actually changes.
function applyFrames(){
  document.querySelectorAll('img.rimg').forEach(img=>{
    const label=img.dataset.label, id=img.dataset.id;
    const pick=pickStep(label,id);
    const cap=document.querySelector('.cap[data-label="'+label+'"][data-id="'+id+'"]');
    const ph=document.querySelector('.ph[data-label="'+label+'"][data-id="'+id+'"]');
    if(pick){
      const f=pick.show;
      if(img.dataset.rel!==f.rel){
        img.dataset.rel=f.rel;
        img.src='/framefile/'+label+'/'+id+'?rel='+encodeURIComponent(f.rel)+'&t='+f.t;
      }
      img.style.display=''; if(ph) ph.style.display='none';
      if(cap){
        // main line: column · step · k/n · (#selected/#rendered when the LLM chose).
        // chips: every view rendered at this step — GREEN = LLM-selected, dim =
        // rendered but not chosen, outlined = the one currently displayed.
        const sel=pick.nSel, tot=pick.views.length;
        const selTag=(sel>0&&sel<tot)?' · <b style="color:#86efac">'+sel+'/'+tot+' picked</b>':'';
        const main=esc(label)+' · '+esc(pick.step.label)+' · '+(pick.idx+1)+'/'+pick.n+selTag;
        const chips=pick.views.map(v=>'<span class="vchip'+(v.selected?' sel':'')+(v.name===f.view?' cur':'')+'">'+esc(v.name)+'</span>').join('');
        cap.innerHTML='<span class="capmain">'+main+'</span><span class="vchips" title="views rendered at this step (green = LLM-selected)">'+chips+'</span>';
      }
    } else {
      img.style.display='none'; img.dataset.rel='';
      if(ph){ ph.style.display=''; ph.textContent='no renders'; }
      if(cap) cap.textContent=label;
    }
  });
}
// The VIEW selector is DYNAMIC: it offers exactly the views actually rendered in
// the data (e.g. the 6 ortho faces for a 6-view run), not a hardcoded set — so
// every rendered view is selectable. Rebuilt whenever the available set changes.
let lastViews = "";
function availableViews(){
  const set = new Set();
  if(DATA) for(const c of DATA.cases) for(const l of DATA.roots){
    const r = c.roots[l]; if(r && r.frames) for(const f of r.frames){ if(f.view) set.add(f.view); }
  }
  return VIEW_ORDER.filter(v=>set.has(v)).concat([...set].filter(v=>!VIEW_ORDER.includes(v)));
}
function syncViewControl(){
  const vs = availableViews();
  if(!vs.length) return;
  const k = vs.join(",");
  if(k===lastViews) return;
  lastViews = k;
  if(!vs.includes(state.view)) state.view = vs.includes("isometric") ? "isometric" : vs[0];
  seg("view", vs, state.view, v=>{ state.view=v; setSeg("view",v); applyFrames(); });
}
async function refresh(){
  let nd; try{ nd=await (await fetch("/api/cases")).json(); }catch{ return; }
  DATA=nd;
  syncViewControl();   // keep the view selector in sync with what's actually rendered
  // Only rebuild the DOM when the structure / progress actually changes; otherwise
  // just re-apply frames (a no-op for unchanged images → no flicker while idle).
  const key=JSON.stringify([DATA.roots, DATA.cases.map(c=>[c.id, DATA.roots.map(l=>{const r=c.roots[l]||{}; return [r.partsGenerated,r.done,r.finalKb,(r.frames||[]).length];})])]);
  if(key!==lastKey){ lastKey=key; rebuild(); } else { applyFrames(); }
}
// --- artifacts panel: lazy-load EVERY saved file + the plan, per case ---
function fileGroup(title,label,id,files){
  if(!files.length) return "";
  var cap=40, shown=files.slice(0,cap);
  var links=shown.map(function(f){
    return '<a href="/raw/'+label+'/'+id+'/'+f.rel.split("/").map(encodeURIComponent).join("/")+'" target="_blank" title="'+esc(f.rel)+' · '+fmtKb(f.kb)+'">'+esc(f.rel)+'</a>';
  }).join("");
  var more=files.length>cap?'<span class="more">+'+(files.length-cap)+' more</span>':"";
  return '<div class="filegrp"><span class="gl">'+title+' ('+files.length+')</span><br>'+links+more+'</div>';
}
function renderDetails(label,id,fd){
  var files=fd.files||[];
  function grp(re){return files.filter(function(f){return re.test(f.rel);});}
  var plan=fd.plan||[];
  var planHtml=plan.length?'<ul class="planlist">'+plan.map(function(p,i){
    return '<li><b>'+(i+1)+'. '+esc(p.name||"?")+'</b><span class="lv">'+esc(p.level||"")+'</span>'+esc(p.description||"")+'</li>';
  }).join("")+'</ul>':"";
  return '<div class="detroot"><h4>'+esc(label)+(plan.length?' · plan: '+plan.length+' parts':"")+'</h4>'
    +planHtml
    +fileGroup("plan",label,id,grp(/plan/))
    +fileGroup("scad",label,id,grp(/\\.scad$/))
    +fileGroup("mesh",label,id,grp(/\\.obj$/))
    +fileGroup("part responses",label,id,grp(/gen_response|ctx_select_response|selection\\.json/))
    +fileGroup("renders",label,id,grp(/\\.png$/))
    +fileGroup("summaries",label,id,grp(/summary|parts_summary|final_summary|eval_case_result/))
    +fileGroup("trajectory",label,id,grp(/_trajectory|\\.jsonl$/))
    +fileGroup("text",label,id,grp(/prompt\\.txt|effective_text|response\\.txt/))
    +'</div>';
}
document.getElementById("grid").addEventListener("click",async function(e){
  var btn=e.target.closest&&e.target.closest(".detbtn"); if(!btn) return;
  var id=btn.dataset.id, body=document.querySelector('.detbody[data-id="'+id+'"]');
  if(body.style.display!=="none"){ body.style.display="none"; btn.textContent="▾ all artifacts (plan, responses, scad, renders, trajectory)"; return; }
  body.style.display=""; btn.textContent="▴ hide artifacts"; body.innerHTML='<span class="meta">loading…</span>';
  var out=[];
  for(var k=0;k<DATA.roots.length;k++){ var label=DATA.roots[k];
    try{ var fd=await (await fetch("/api/files/"+label+"/"+id)).json(); out.push(renderDetails(label,id,fd)); }catch(_){}
  }
  body.innerHTML=out.join("")||'<span class="meta">no artifacts</span>';
});
controls(); refresh(); setInterval(refresh, 5000);
</script></body></html>`;

const server = Bun.serve({
  port: args.port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/" || path === "/index.html") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (path === "/api/cases") {
      const cases = caseIds().map((id) => {
        const roots: Record<string, RootInfo> = {};
        for (const r of ROOTS) roots[r.label] = rootInfo(r.label, r.path, id);
        return { id, prompt: prompts.get(id) ?? "", roots };
      });
      return Response.json({ roots: ROOTS.map((r) => r.label), cases });
    }
    let m = /^\/ref\/([A-Za-z0-9_-]+)$/.exec(path);
    if (m) {
      const id = m[1]!;
      const cands = [
        ...ROOTS.map((r) => join(r.path, id, "image.png")),
        referenceImages.get(id) ?? "",
      ];
      return fileResponse(cands.find(existsSync) ?? null, "image/png");
    }
    // /framefile/<label>/<id>?rel=<relpath>  — a specific render frame.
    m = /^\/framefile\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path);
    if (m) {
      const root = rootByLabel.get(m[1]!);
      if (!root) return new Response("unknown root", { status: 404 });
      const dir = join(root, m[2]!);
      const rel = url.searchParams.get("rel") ?? "";
      const abs = resolve(dir, rel);
      if (!abs.startsWith(resolve(dir) + "/") || !abs.endsWith(".png")) {
        return new Response("bad path", { status: 400 });
      }
      return fileResponse(abs, "image/png");
    }
    m = /^\/scad\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path);
    if (m) {
      const root = rootByLabel.get(m[1]!);
      if (!root) return new Response("unknown root", { status: 404 });
      const dir = join(root, m[2]!);
      const scad = [join(dir, "final.scad"), join(dir, "draft.scad")].find(existsSync);
      return scad
        ? new Response(readFileSync(scad, "utf8"), { headers: { "content-type": "text/plain; charset=utf-8" } })
        : new Response("no scad", { status: 404 });
    }
    // /api/files/<label>/<id> — EVERY saved artifact for a case, plus the parsed plan.
    m = /^\/api\/files\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path);
    if (m) {
      const root = rootByLabel.get(m[1]!);
      if (!root) return new Response("unknown root", { status: 404 });
      const dir = join(root, m[2]!);
      if (!existsSync(dir)) return Response.json({ plan: null, files: [] });
      const files = walkFiles(dir).sort().map((rel) => ({ rel, kb: sizeKb(join(dir, rel)) }));
      const plan = readJson<unknown[]>(join(dir, "plan.json"));
      return Response.json({ plan: Array.isArray(plan) ? plan : null, files });
    }
    // /raw/<label>/<id>/<relpath> — serve ANY saved file (text or image), path-guarded.
    m = /^\/raw\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/(.+)$/.exec(path);
    if (m) {
      const root = rootByLabel.get(m[1]!);
      if (!root) return new Response("unknown root", { status: 404 });
      const dir = resolve(join(root, m[2]!));
      const abs = resolve(dir, decodeURIComponent(m[3]!));
      if (abs !== dir && !abs.startsWith(dir + "/")) return new Response("bad path", { status: 400 });
      return fileResponse(existsSync(abs) ? abs : null, ctype(abs));
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`results viewer on http://localhost:${server.port}`);
for (const r of ROOTS) console.log(`  [${r.label}] ${r.path}`);
