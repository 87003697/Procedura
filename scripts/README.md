# Scripts

Run script commands from the repository root.

- **Public CLIs:** `procedura.ts`, `mesh-to-cad.ts`, `paint.ts`, `motion.ts`,
  `batch.ts`, and `results-server.ts` are the supported command-line entry
  points.
- **Setup:** `install-deps.sh` installs project dependencies and external tools.
- **Upstream maintenance:** `gen_parts_color_full.ts` and `refine_one.ts` are
  maintenance utilities rather than public CLIs.
- **Private runtime assets:** root-level Blender and OpenSCAD helpers such as
  `_blender_gpu.py`, `_render_*.py`, and `_openscad_manifold_env.ts` are invoked
  by the runtime. An underscore marks an internal asset; it does not mean the
  file is disposable.
- **Local tools:** developer-only machine or workspace helpers live under
  `scripts/local/`; see `scripts/local/README.md`.

Capability-specific scripts and runtime assets should live with their owning
module or experiment when they do not need to remain shared at this root.
