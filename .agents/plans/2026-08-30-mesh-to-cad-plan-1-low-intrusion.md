# Mesh-to-CAD Plan 1 — low-intrusion reference seam

Baseline: `fac191ed49f55fcc2e0f23897e986042249f59fe`.

## Scope and design

Plan 1 adds an isolated Mesh-to-CAD reference path. Private authority and
normalization live under `src/reference/`; the pipeline and CLI are separate;
Blender normalization is an independent script; and the Studio route and
viewer are separate `reference` modules. Imported formats are normalized to
geometry-only canonical binary STL in Z-up millimetres. STL/OBJ/PLY are
explicitly interpreted as already Z-up millimetres (no inference or transform);
glTF/GLB use Y-up metres and convert to Z-up millimetres; 3MF uses its declared
unit and defined transform. Studio receives only
an opaque handle plus canonical format and measured summary. Private source
paths, sidecars, source bytes, and canonical bytes never enter its DTO.

The canonical route is reachable through the configured Studio server and
authorizes only by opaque handle; it has no loopback/IP gate. The reference
viewer is available only inside the existing Model page. The `ModelView` change
is deliberately thin: it selects the reference mode and
mounts `ReferenceViewer` with an opaque handle. It does not read private data
or parse formats. `RunView` is unchanged; Plan 1 does not make a reference-only
run eligible for a new Model tab.

## Planned patch boundary

The planned patch is the frozen approved contract. The standard `.final.patch`
is the review-clean implementation artifact.

New files:

- `scripts/mesh-to-cad.ts` — minimal import-only CLI registration.
- `scripts/_normalize_reference_blender.py` — supported-format normalization.
- `src/pipeline/mesh-to-cad-reference.ts` — reference import/reuse orchestration.
- `src/reference/authority.ts` — private handle authority and manifest storage.
- `src/reference/normalization.ts` — canonical normalization boundary.
- `web/server/reference.ts` — isolated canonical mesh route.
- `web/src/components/ReferenceViewer.tsx` — isolated canonical STL viewer.

Existing files with minimal required changes:

- `.env.example`, `README.md`, `package.json` — configuration, usage, and CLI
  registration only.
- `web/server.ts` — construct the private authority when configured and register
  the isolated reference route.
- `web/server/scan.ts` — recognize `reference.json` and project only the opaque
  handle, canonical format, and summary descriptor needed by Studio; it does
  not alter run-shape classification.
- `web/shared/types.ts` — add the safe reference descriptor contract (handle,
  canonical format, and summary only).
- `web/src/components/views/ModelView.tsx` — thin mode selection and viewer
  mount only.

`web/src/components/RunView.tsx` and `web/src/components/MeshViewer.tsx` are
intentionally absent from the planned patch. No generic viewer, availability
rule, private-path access, or format parsing is part of this plan.

## Completion criteria

- The standard git patch applies cleanly to the stated baseline.
- The patch contains no `RunView.tsx` or `MeshViewer.tsx` diff.
- Reference authority, normalization, CLI, route, and viewer remain isolated;
  existing server/type changes are limited to the safe descriptor contract.
- `git diff --check` passes for the two plan artifacts and no unit tests are
  added, modified, or run.

## Implementation evidence

The frozen planned patch was applied to the baseline-aligned working state.
The implementation retains the approved public descriptor contract:
`reference.json` contains `schemaVersion`, `handle`, `format: "stl"`, and the
fixed Z-up/mm `summary`; the scanner validates those fields and projects only
that shape. The private handle contains only `source.<ext>`, `canonical.stl`,
and `manifest.json`.

The final patch is generated from the same baseline and includes the seven
existing thin upstream files plus the seven isolated implementation files;
`RunView.tsx` and `MeshViewer.tsx` remain baseline-clean.

Validation completed without unit tests:

- Root and web TypeScript typechecks, CLI `--help`, Python AST syntax,
  `bun build scripts/mesh-to-cad.ts`, and `git diff --check` passed.
- A retained private validation root imported STL (1 triangle,
  10x20x5 mm), OBJ (2, 2x2x0 mm), polygon PLY (2, 10x20x5 mm), external GLB
  (3, 1010x3005x2020 mm), external glTF (3, 1010x3005x2020 mm), and 3MF
  (1, 190x120x30 mm). Every descriptor used the fixed public schema; each
  handle contained exactly source, canonical STL, and manifest, with no
  external buffers, MTL, image, or appearance sidecars.
- Handle reuse returned the same handle without adding a private reference.
  Unsupported extension, point-only PLY, glTF non-TRIANGLES, glTF animation,
  and 3MF cycle/required-extension/beam-lattice fixtures failed without a
  `ref_*` handle or run descriptor.
- Current-code production loopback API verification is recorded below after
  running the server against the retained validation roots. The route contract
  has no IP gate; the implementation does not claim a non-loopback restriction.
- Current-code browser and ordinary Viewer regression verification is recorded
  below. A reference-only run remains Model-eligible only through its existing
  detail mode and does not add a new Model tab. No formal historical
  `final_painted.obj/.mtl` artifact exists; the painted regression is explicitly
  temporary input-driven evidence.

The evidence above supports the final implementation:
`.agents/plans/2026-08-30-mesh-to-cad-plan-1-low-intrusion.final.patch`.

### Current-code follow-up evidence

The current code was rechecked against `/private/tmp/procedura-contract-check`
on loopback. On a confirmed available port, `info`, `runs`, `detail`, and a
valid canonical route returned 200; missing handle returned 400, an invalid
handle returned 404, and `/api/file` traversal toward the private root
returned 403. A second server without `PROCEDURA_REFERENCE_ROOT` returned 503
for the reference route. Both temporary servers were stopped. The route has no
IP gate, so no non-loopback restriction is part of this evidence.

For browser evidence, the current server was run against the same roots. The
reference-only six-format runs were visible in the run list but correctly had
no new Model tab. A temporary eligible run containing ordinary painted OBJ/MTL
artifacts exposed the existing Model view; selecting Reference showed the
active Reference mode and its single canvas with zero warning/error logs. The
current screenshot is
`/Users/zhiyuanma/.codex/visualizations/2026/08/30/01a051c2-1f9e-7ce1-8c19-0b1fb204e8e5/procedura-current-reference-mode-final.png`.
The repository-wide search command
`find /Users/zhiyuanma/Desktop/Codes/Procedura -path '*/node_modules' -prune -o -path '*/.git' -prune -o -type f \( -name 'final_painted.obj' -o -name 'final_painted.mtl' \) -print`
returned zero formal historical artifacts. The painted conclusion is therefore
temporary input-driven regression evidence, not a historical-run claim.

### Planned state versus final implementation

Both states use baseline `fac191ed49f55fcc2e0f23897e986042249f59fe` and the
same fourteen target paths. The seven new implementation paths match the
approved implementation state. Among the seven existing paths, `.env.example`,
`README.md`, `package.json`, `web/server.ts`, and
`web/src/components/views/ModelView.tsx` match the planned state; the
`web/server/scan.ts` and `web/shared/types.ts` implement the approved strict
descriptor projection. The only planned-to-final state difference is the
behavior-equivalent scanner simplification recorded below; no other design or
scope difference was introduced.

## Implementation Review

Mode B final status: `No findings` from all three independent reviewers.
Final is frozen as the review-clean implementation. Baseline is
`fac191ed49f55fcc2e0f23897e986042249f59fe`; the approved planned patch remains
frozen and unchanged.

The complete planned-to-final tree has one accepted difference. In
`web/server/scan.ts`, the final descriptor projection reads
`summaryRecord?.["triangleCount"]` directly, whereas the planned state used
`summaryRecord?.["triangleCount"] ?? null`; the same `typeof number`, finite,
and nonnegative guard rejects both `undefined` and `null`, so DTO behavior is
unchanged. This is an equivalent simplification. The corresponding final
patch hunk is [web/server/scan.ts readRunDetail](.agents/plans/2026-08-30-mesh-to-cad-plan-1-low-intrusion.final.patch:115).
The remaining thirteen target paths are state-identical between planned and
final; all fourteen final paths match the current implementation. Prohibited
paths including `RunView.tsx` and `MeshViewer.tsx` have no diff.

Review relied on root/web TypeScript typechecks, CLI help, Python AST syntax,
Bun transpilation, and diff checks; six-format dimensions/triangle counts and
sidecar isolation; handle reuse; failure atomicity; current production API
status; current browser Reference Viewer screenshot; temporary painted OBJ/MTL
regression; and the formal painted-artifact search returning zero. No unit
tests, LLM, or OpenSCAD were run or added.

Residual risks remain: broader real-world Blender/importer compatibility beyond
the retained fixtures was not exhaustively tested, and no formal historical
painted artifact exists, so that regression evidence is limited to the
temporary fixture.
