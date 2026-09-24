# Octree mapping shadow experiment

This removable experiment evaluates one question: can multiscale unbalanced
optimal transport recover useful full-surface correspondences between GT and
candidate occupied octree cells in their already-shared absolute frame?

The mapping CLI does not read raw meshes, compile OpenSCAD, call an LLM, change
a model, or participate in Procedura's draft/refine lifecycle. Its inputs are
private leaf-cell documents prepared by a trusted host. The optional Plan 4
preparation script below is that trusted host for one retained local run and is
not registered with Procedura. Outputs contain reconstructive cell data and
must remain private; they are not an Agent prompt or public run artifact.

## Layout

- `octree_mapping/`: solver, data contracts, mesh adapter, and installed CLI.
- `scripts/`: reusable host-side CLI scripts for private mapping-input preparation.
- `examples/`: deterministic fixture builder and catalog; see the
  [example and script commands](examples/README.md).
- `validation/`: controlled full-run fixture and review builders, black-box
  acceptance scenarios, and the frozen Plan 4 ablation.
- `archive/`: superseded experiment prototypes retained only for historical
  reproduction.

Generated artifacts stay under `outputs/` or an explicitly supplied output path.
The package name, installed CLI, and input/report schemas are unchanged. Direct
script invocations now use `scripts/` or `validation/`; the old root-level
`prepare_plan4_shadow.py` is now `scripts/prepare_mapping_input.py`.

## Setup and run

```bash
cd experiments/octree-mapping
python3.12 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/procedura-octree-map --input input.json --output mapping.json
```

The input schema is `procedura.octree-mapping-input/2`. All leaves are at the
frame's `maxDepth`; their Morton prefixes use the canonical XYZ child order
(`x` bit 2, `y` bit 1, `z` bit 0). Every leaf carries its area-weighted mean
oriented surface normal. Candidate part weights on a cell sum to one.
At the starting depth the solver maps every candidate occupied node against every GT occupied
node. Each finer depth materializes only occupied child pairs inherited from retained parent
support, same-grid halo neighbors, and bidirectional nearest fallbacks. Same-prefix occupancy is
a zero-distance candidate, not a fixed identity. Generalized Sinkhorn updates reduce directly
over that sparse edge set in the log domain, so no fine-level Cartesian matrix is allocated.

The default resolved depth is `min(6, inputMaxDepth)`. Depth 8 is supported for
bounded scenarios. The solver refuses a level when the materialized edge set exceeds
`--max-pairs`.

The output schema is `procedura.octree-mapping-report/3`. Every solved depth is
reported under `levels[]` as an exact compact `summary`, `candidateCells`, and
`gtCells` record. Candidate cells expose only `prefix`, `mass`, `displacementMm`,
`spreadCells`, and `sourceMarginalRatio`; GT cells expose only
`prefix`, `mass`, and `targetMarginalRatio`. The shared frame, level depth, prefix,
and displacement vector are sufficient to derive cell centers, parent prefixes,
direction, distance, and the transported GT barycenter. `displacementMm` starts at
the derivable grid cell center, not the private occupied-surface centroid. Full target
coupling, per-cell entropy, and all part-level summaries or fits are deliberately absent.
Semantic part provenance is not included. Cell-level evidence is the complete output contract
for this shadow experiment.

The dimensionless matching cost is the weighted sum of squared position in current-depth cell
units, mean-normal difference divided by four, and binary local-occupancy-stencil Hamming
distance. `--position-weight`, `--normal-weight`, and `--neighborhood-weight` independently
enable those terms; `--neighborhood-radius-cells` defines the stencil. A zero weight skips the
term. `--unmatched-penalty-cells` is the only unmatched control: it replaces the former reach
name and sets the UOT KL marginal penalty in finest-cell units. The default `1/0/0`, radius 1,
penalty 8 profile is mathematically the prior position-only solver. No semantic part provenance
is read by candidate generation, costs, support, or Sinkhorn or included in the output.

For the retained Plan 4 transformer validation, `scripts/prepare_mapping_input.py`
converts the private GT OBJ, final candidate OBJ, canonical whole STL, and the
renderer-retained per-part STL manifest into that same contract. It uses the
`[-1, 1]^3` root by default, or the root given by `--root-min x y z --root-side s`
in mesh units. Cell masses are surface areas in root half-side squared units, so the
unbalanced transport balance is the same whether the meshes are normalized or kept
in candidate SCAD millimetres. It verifies whole STL/OBJ frame identity, and applies the
single combined-part-bounds-to-final-OBJ uniform transform; it performs no ICP,
rotation, or semantic inference. Because the final Boolean union is retriangulated,
each final-surface triangle inherits the geometrically nearest retained part-surface
sample before voxelization; occupied cells always come from the final candidate mesh.
The
generated input remains private because its occupied cells and provenance are
reconstructive. The separate metadata file records paths, bounds, counts,
transform, time, and peak memory without containing node geometry.

When the reference mesh keeps its own arbitrary pose and scale, such as a fixture
OBJ scaled for a paid retest, run `scripts/register_reference.py` first. It fits
one similarity transform (uniform scale, proper rotation, translation) of the
reference onto the candidate with PCA-seeded symmetric nearest-neighbour ICP and
writes the registered reference STL in candidate coordinates plus a metadata file
with the transform and before/after symmetric RMS. Reflections are never fitted,
so a mirrored candidate still appears as residual. Without this step, the mapper
reports the pose and scale gap between the two frames as surface displacement.

```bash
.venv/bin/python scripts/register_reference.py \
  --reference reference.stl --candidate candidate.stl \
  --output reference-registered.stl --metadata registration.json
```

The real-data ablation writes four private reports plus one aggregate summary:

```bash
.venv/bin/python validation/run_plan4_ablation.py \
  --input /tmp/plan4-depth6-mapping-input-v2.json \
  --output-dir /tmp/plan4-geometric-ablation \
  --summary /tmp/plan4-geometric-ablation-summary.json
```

The profiles are position `1/0/0, unmatched=8`, normal `1/1/0, 8`, neighborhood `1/1/1, 8`,
and explicit-unmatched `1/1/1, 2`. They are fixed before examining the real outputs.
Because schema `/3` intentionally omits full target coupling and all part-level
aggregation, the compact ablation summary reports only solver levels, marginal ranges,
and runtime. Target-dependent and part-level diagnostics remain only in frozen prior
validation artifacts.

## Black-box acceptance

```bash
.venv/bin/python validation/validate_scenarios.py
```

This command runs the installed CLI on generated end-to-end scenarios. It is
not part of the repository unit-test suite. It covers identity, translation,
opposed leg motion, missing armour, extra geometry, coarse-to-fine recovery,
mixed provenance below input max depth, and a bounded depth-8 case.
It also covers normal and occupancy-neighborhood geometric disambiguation.
Each successful case also checks the exact compact field sets, complete solved-depth
coverage, array counts, derivable parent prefixes, and millimetre displacement vectors.

## Mapping critic in direct refine

The direct refine loop can accept an optional `MappingCritic` with the same outer
shape as the visual critic: it receives the current cycle's SCAD, compiled STL,
parts-colour views, legend, and step directory, then returns one Mapping text
feedback string. The host adapter is responsible for preparing the current
candidate/target octree `input` and `report`, the existing `plan.json` semantic
plan, and the front/top/right candidate/comparison images required by
`runMappingAgent`. The adapter must keep both meshes in candidate SCAD millimetres
and pass an octree root in those units: the Mapping Agent treats every `*Mm`
length, `locationMm`, and the `inspect_mapping_part` radius as SCAD millimetres,
and the radius cap is eight finest cells of that root. For Mesh-to-CAD runs,
convert the target to STL with `normalizeReference` from
`src/reference/normalization.ts`, then normalize that copy with
`normalizeReferenceStl` from `src/pipeline_mesh2code/mesh-to-cad-reference-frame.ts`;
it reproduces the transform in `reference-normalization.json`, so the target
shares the frame the draft was built in and needs no registration.

```ts
import { makeMappingCritic } from "../../src/pipeline/mapping-critic.ts";

const mappingCritic = makeMappingCritic(async (context) => {
  const current = await prepareCurrentMappingInput(context);
  return {
    source: current.source,
    semanticPlan: current.semanticPlan,
    vision: current.vision,
  };
});
```

Pass that callback through the Mesh-to-CAD host or `runProcedura`. Each cycle must
prepare the Mapping source from the `context.stlPath` for that cycle. The Mapping
Agent returns the same plain-text diagnosis shape as the visual critic:
`SUMMARY`, `ISSUES`, a severity tag, `[modules: ...]`, and a `FIX:` direction.
The Mapping issue keeps its evidence-grounded candidate→GT axis correction inside
the problem and fix text. Its input schema, bounded facts, plan coverage, and
optional inspection-tool argument checks remain inside the Mapping path. The
refine path does not parse a Mapping JSON artifact. Without a Mapping critic,
ordinary visual direct refine is unchanged.
