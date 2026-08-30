---
status: accepted
---

# Isolate Mesh-to-CAD from upstream

Mesh-to-CAD is implemented through removable side-path modules with only thin registration seams in existing Procedura code. We accept limited local duplication instead of refactoring upstream Texture Mesh, Viewer, rendering, or generation pipelines, because preserving that working milestone is more valuable than maximizing reuse.
