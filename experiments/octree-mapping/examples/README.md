# Reproducible mapping examples

This side path builds local, host-private fixtures for the octree mapping
shadow experiment. It does not register with Procedura and does not change the
Plan 1–4 pipeline.

This directory contains only the deterministic recipes and their builder;
reusable input preparation lives in `../scripts/`, while controlled full-run
fixtures, review contexts, acceptance scenarios, and ablation runners live in
`../validation/`. Generated
meshes, `/2` inputs, `/3` reports, renders, and run metadata are written below
`outputs/examples/`, which is ignored by Git. `/2` and `/3` remain private
because they are reconstructive geometry evidence, not Agent prompts or public
run artifacts.

## Build the first example

The builder contains twelve deterministic fixtures ranging from a four-link
snake arm to a porous lattice and a breathing octopus. It creates a
reference/candidate pair in one shared frame, prepares the private mapping
input, runs the four named mapping profiles, renders the position profile, and
performs compact-report checks. Run from `experiments/octree-mapping/`:

```bash
uv run --with numpy==2.5.2 --with scipy==1.18.1 --with matplotlib \
  --python 3.12 python examples/build_examples.py --example snake-arm
```

The generated directory is `outputs/examples/01-snake-arm/`. Use
`--example all` to build every case in catalog order. A successful case
contains the source OBJ/STL, per-part STL files, `parts-meta.tsv`, `2-input.json`,
one report per profile, three PNG views, the analytic `oracle.json`, and
`validation.json`. The source OBJ/STL
files are retained only for local visualization and re-generation.

Every fixture uses a deterministic seed-free construction and a shared
`[-1, 1]^3` frame. Reference and candidate are never independently fitted;
the controlled parameter change is preserved in the same frame. For topology
or occlusion examples, the oracle will describe an invariant or region rather
than inventing a one-to-one cell displacement.

To prepare a compact MultiView direction context for the visual review cases,
run:

```bash
python3 validation/build_multiview_context.py \
  --example snake-arm,vault-city,mechanical-flower
```

This writes `multiview-direction.json` beside each case and a
`outputs/examples/multiview-review.md` overview. The context keeps the fixed
front/side/top view paths, mass-weighted displacement summaries, coarse spatial
regions, and the case oracle; its `agentContext` field is the path-free subset
that can be passed to the Mapping Agent. The script does not call an Agent or
change the mapping report contract.

The path-free context also includes mass-weighted summaries for each mapped
candidate part. These summaries keep the per-cell provenance aggregation out of
the Agent prompt and help separate a local part displacement from shared
assembly motion.

Each part summary also contains a `correctionProtocol`. Its `vectorMm` is the
candidate-to-GT displacement in mapping-frame millimetres; applying that vector
to the candidate placement is the only sign convention. It is not a SCAD-unit
value. A source-unit scale must be supplied separately before generating code.

The former correction-packet builder consumed this legacy summary contract.
It is archived under `../archive/` because the current Mapping Agent emits
schema v5 region feedback and automatic correction is not part of the active
workflow.

For a completed Mesh-to-CAD run, `validation/build_fullrun_pair.py` creates a
controlled mapping pair from the real per-part assembly and translates one selected part.
Run from the repository root:

```bash
uv run --project experiments/octree-mapping python \
  experiments/octree-mapping/validation/build_fullrun_pair.py \
  --source outputs/real-business-samples/snake-arm/full-run \
  --output outputs/real-business-samples/snake-arm/mapping \
  --part central_service_barrel
```

The output keeps the completed run as the baseline, records the controlled
change in `oracle.json`, and contains the same `/2`, `/3`, render, and
`multiview-direction.json` artifacts as the deterministic examples.

The catalog records the order for the complete sample set. Each case uses a
small, fixed polygon budget so the default depth-6 run stays within the
shadow mapper's resource guard. Complex cases such as the lattice and Möbius
band are deliberately coarse; they are visual and correspondence fixtures,
not production CAD models.
