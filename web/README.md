# Procedura Studio

A web front-end for Procedura: **generate** a model from a prompt and an
optional reference image, watch it build part by part, and **inspect** every
intermediate artifact of any run in the outputs directory.

```bash
cd web && bun install
bun run start                     # http://localhost:8080
```

That is the whole setup when `web/` lives inside the repo: the CLI, its
`node_modules`, `.env`, OpenSCAD and Blender all resolve from the repo root,
exactly as they do from a terminal. The Studio adds no second configuration
surface — it reads `<repo>/.env` and passes it to the runs it spawns.

## Generate

**New generation** (or press `n`) opens the composer. Two decisions dominate a
run's cost and quality, so the form is built around them:

- **Reference image.** Upload one (drop, paste, or choose), have the run
  render its own (when `PROCEDURA_IMAGE_MODEL` is set), or build from the
  prompt alone. Supplying one is the single largest fidelity gain.
- **Pipeline preset.** *Default* is the cheap run — part-by-part, text-only,
  six refine cycles. *Best quality* is everything on: 3D feedback, assembly
  mates, materials, articulation with URDF, twelve cycles. Any toggle lands on
  *Custom*. Options the host cannot back (no Blender, no Isaac) are greyed out
  with the reason, so a run never fails on its first render.

The footer says in one line what will actually run. `⌘ ↵` starts it.

A running generation shows a phase rail (Reference → Plan → Build *n/m* →
Refine → Final → Materials → Articulation, only the phases that are on), the
plan being ticked off part by part, the most advanced artifact on disk as a
live preview, and the pipeline console. Cancel any time; a run that ends with
a non-`ok` verdict still produced a model and flows into the inspector.

## Inspect

Per run: **Prompt** · **Reference** · **Build** (the plan, each part's
generation, its build-context renders, the source after it landed) · **Refine**
(a scrubber over every cycle: the renders the critic saw, the diagnosis, the
patch, the compile) · **Final** (the OBJ in 3D — plain or painted — with AO and
PBR renders and the verdict) · **Materials** (the painted model with its
per-part materials, the palette, part assignments) · **Articulation** (links,
joints with limits and drives, the planner's views, the Isaac validation
verdict, USDA/URDF downloads) · **Customize** (edit the program's parameters and
recompile live) · **Trajectory** (the event log) · **Files** (everything in
the run dir, previewable and downloadable).

## Configuration

| var / flag | default | meaning |
| --- | --- | --- |
| `PORT` | `8080` | server port |
| `HOST` | `0.0.0.0` | bind address |
| `--repo` / `PROCEDURA_REPO` | parent of `web/` | checkout to spawn the CLI from; needs `scripts/procedura.ts` + `node_modules` |
| `--root` / `PROCEDURA_OUTPUTS_ROOT` | `<repo>/outputs` | runs root — generated and browsed runs live here |
| `--follow-symlinks` / `PROCEDURA_STUDIO_FOLLOW_SYMLINKS=1` | off | trust symlinks under the root (a root full of links to runs on other disks) |
| `PROCEDURA_MAX_CONCURRENT` | `2` | simultaneous generations |
| `bun run dev` | — | development mode with HMR |
| `bun run typecheck` | — | type-check server + client |
| `bun run shot` | — | headless screenshots of every view into `.shots/` |

Generation needs, in the repo's `.env`: an LLM key (`OPENAI_API_KEY` or
`GEMINI_API_KEY`), OpenSCAD on `PATH` (or `OPENSCAD_PATH`), and Blender
(`PROCEDURA_BLENDER_PATH`) for anything that renders. The server prints what it
detected at startup.

> The runs root must be a dedicated outputs directory: `/api/file` serves any
> allowlisted artifact under it to unauthenticated clients. Bind to localhost
> or put it behind auth before exposing it.

## Layout

```
server.ts            Bun.serve — API + artifact streaming + generation + SPA host
server/
  scan.ts            run discovery + per-run artifact inventory (plan, parts, refine,
                     final, paint, motion) + dir listing
  jobs.ts            generation job queue (spawn / stream / persist / recover)
  customize.ts       parameter extraction + recompile with -D overrides
  csg.ts  deps.ts    CSG export for the SDF preview; parameter → part analysis
  trajectory.ts      JSONL parse + phase segmentation
  env.ts  safe.ts    .env parser; path-traversal guard
shared/types.ts      API + job contract (shared by server + client)
src/
  App.tsx            shell: sidebar, composer, view routing, shortcuts
  components/        Composer, GenerationView, RunView, Sidebar, MeshViewer
                     (OBJ / MTL / STL), ScadPanel, stages/*
```

## API

| route | purpose |
| --- | --- |
| `POST /api/upload` | multipart `file` (png/jpeg/webp) → `{path}` for a reference image |
| `POST /api/generate` | start a run: `{prompt, imagePath?, noImage?, oneShot?, contextRenders?, assembly?, paint?, motion?, motionUrdf?, maxSteps?, agentModel?, scadModel?, imageModel?}` |
| `GET /api/jobs` · `/api/job?id=` · `POST /api/jobs/cancel?id=` · `GET /api/jobs/stream?id=` | job list, detail, cancel, SSE (`log` / `status` / `progress`) |
| `GET /api/info` · `/api/runs` · `/api/run?id=` · `/api/trajectory?id=` · `/api/ls?id=&sub=` · `/api/file?path=[&download=1]` | inspector + artifact serving |
| `GET /api/params` · `/api/parts` · `POST /api/customize` · `/api/csg` | parametric customizer |
