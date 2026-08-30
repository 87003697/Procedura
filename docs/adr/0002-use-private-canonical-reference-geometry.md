---
status: accepted
---

# Use private canonical reference geometry

Every supported reference Mesh is normalized by the trusted host into private, geometry-only, Z-up millimetre canonical STL, while Agents and public run artifacts receive only an opaque handle and bounded geometry summary. This single trust boundary prevents raw source, paths, materials, textures, and format-specific semantics from leaking into observation or later CAD generation, at the cost of deliberately discarding appearance data.
