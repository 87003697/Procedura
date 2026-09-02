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

For the retained Plan 4 transformer validation, `prepare_plan4_shadow.py`
converts the private GT OBJ, final candidate OBJ, canonical whole STL, and the
renderer-retained per-part STL manifest into that same contract. It uses the
fixed `[-1, 1]^3` root, verifies whole STL/OBJ frame identity, and applies the
single combined-part-bounds-to-final-OBJ uniform transform; it performs no ICP,
rotation, or semantic inference. Because the final Boolean union is retriangulated,
each final-surface triangle inherits the geometrically nearest retained part-surface
sample before voxelization; occupied cells always come from the final candidate mesh.
The
generated input remains private because its occupied cells and provenance are
reconstructive. The separate metadata file records paths, bounds, counts,
transform, time, and peak memory without containing node geometry.

The real-data ablation writes four private reports plus one aggregate summary:

```bash
.venv/bin/python run_plan4_ablation.py \
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
.venv/bin/python validate_scenarios.py
```

This command runs the installed CLI on generated end-to-end scenarios. It is
not part of the repository unit-test suite. It covers identity, translation,
opposed leg motion, missing armour, extra geometry, coarse-to-fine recovery,
mixed provenance below input max depth, and a bounded depth-8 case.
It also covers normal and occupancy-neighborhood geometric disambiguation.
Each successful case also checks the exact compact field sets, complete solved-depth
coverage, array counts, derivable parent prefixes, and millimetre displacement vectors.
