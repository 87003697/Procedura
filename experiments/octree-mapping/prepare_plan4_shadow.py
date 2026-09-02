"""Prepare the retained Plan 4 transformer robot for the private shadow mapper."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import resource
import time

import numpy as np

from octree_mapping.mesh_adapter import (
    SurfaceCell,
    TriangleMesh,
    load_obj,
    load_part_manifest,
    load_stl,
    label_triangles_by_nearest_part,
    surface_cells,
    transform,
    uniform_bounds_transform,
    uniform_bounds_transform_values,
)


def bounds(mesh) -> dict[str, list[float]]:
    minimum, maximum = mesh.bounds
    return {"min": minimum.tolist(), "max": maximum.tolist(), "size": (maximum - minimum).tolist()}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Prepare private Plan 4 depth-6 surface cells")
    result.add_argument("--gt-obj", required=True)
    result.add_argument("--candidate-obj", required=True)
    result.add_argument("--candidate-stl", required=True)
    result.add_argument("--parts-meta", required=True)
    result.add_argument("--output", required=True)
    result.add_argument("--metadata", required=True)
    result.add_argument("--depth", type=int, default=6)
    return result


def main() -> None:
    args = parser().parse_args()
    started = time.perf_counter()
    root_min = np.asarray((-1.0, -1.0, -1.0))
    root_side = 2.0

    gt = load_obj(args.gt_obj)
    candidate = load_obj(args.candidate_obj)
    candidate_stl = load_stl(args.candidate_stl)
    canonical_scale, canonical_offset = uniform_bounds_transform(candidate_stl, candidate)
    if abs(canonical_scale - 1.0) > 5e-5 or float(np.max(np.abs(canonical_offset))) > 5e-5:
        raise ValueError("final candidate STL and OBJ do not share the same canonical frame")
    gt_cells = surface_cells(gt, root_min, root_side, args.depth)
    candidate_cells = surface_cells(candidate, root_min, root_side, args.depth)
    part_paths = load_part_manifest(args.parts_meta)
    part_meshes = {name: load_stl(path) for name, path in sorted(part_paths.items())}
    raw_min = np.min(np.stack([mesh.bounds[0] for mesh in part_meshes.values()]), axis=0)
    raw_max = np.max(np.stack([mesh.bounds[1] for mesh in part_meshes.values()]), axis=0)
    scale, offset = uniform_bounds_transform_values(raw_min, raw_max, *candidate.bounds)
    normalized_parts = {name: transform(mesh, scale, offset) for name, mesh in part_meshes.items()}
    triangle_labels = label_triangles_by_nearest_part(candidate, normalized_parts)
    part_cells: dict[str, dict[int, SurfaceCell]] = {}
    part_triangles: dict[str, int] = {}
    for name, path in sorted(part_paths.items()):
        part_triangles[name] = int(np.count_nonzero(triangle_labels == name))
        part_cells[name] = surface_cells(
            TriangleMesh(candidate.triangles[triangle_labels == name]),
            root_min,
            root_side,
            args.depth,
        )

    provenance: dict[int, list[dict[str, float | str]]] = {}
    for prefix in sorted(candidate_cells):
        contributions = [(name, cells[prefix].mass) for name, cells in part_cells.items() if prefix in cells]
        total = sum(value for _, value in contributions)
        provenance[prefix] = [{"name": name, "weight": value / total} for name, value in contributions]

    document = {
        "schema": "procedura.octree-mapping-input/2",
        "frame": {"minMm": root_min.tolist(), "sideMm": root_side, "maxDepth": args.depth},
        "gt": {"cells": [
            {"prefix": prefix, "mass": cell.mass, "normal": cell.normal.tolist()}
            for prefix, cell in sorted(gt_cells.items())
        ]},
        "candidate": {"cells": [
            {
                "prefix": prefix,
                "mass": cell.mass,
                "normal": cell.normal.tolist(),
                "parts": provenance[prefix],
            }
            for prefix, cell in sorted(candidate_cells.items())
        ]},
    }
    Path(args.output).write_text(json.dumps(document, separators=(",", ":")) + "\n", encoding="utf-8")
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    metadata = {
        "frame": {"minMm": root_min.tolist(), "sideMm": root_side, "depth": args.depth},
        "inputs": {
            "gtObj": str(Path(args.gt_obj).resolve()),
            "candidateObj": str(Path(args.candidate_obj).resolve()),
            "candidateStl": str(Path(args.candidate_stl).resolve()),
            "partsMeta": str(Path(args.parts_meta).resolve()),
        },
        "triangles": {
            "gt": len(gt.triangles),
            "candidate": len(candidate.triangles),
            "parts": part_triangles,
        },
        "bounds": {
            "gt": bounds(gt),
            "candidate": bounds(candidate),
            "candidateStl": bounds(candidate_stl),
            "partsRawUnion": {"min": raw_min.tolist(), "max": raw_max.tolist(), "size": (raw_max - raw_min).tolist()},
        },
        "canonicalStlToObj": {"scale": canonical_scale, "offset": canonical_offset.tolist()},
        "partStlToCanonical": {"scale": scale, "offset": offset.tolist()},
        "provenanceMethod": "nearest retained part surface sample per final candidate triangle",
        "normalMethod": "oriented triangle unit normals averaged by per-cell surface-area contribution",
        "cells": {"gt": len(gt_cells), "candidate": len(candidate_cells)},
        "parts": {name: {"path": str(path), "cells": len(part_cells[name])} for name, path in sorted(part_paths.items())},
        "elapsedSeconds": time.perf_counter() - started,
        "peakRssBytes": int(peak_rss),
    }
    Path(args.metadata).write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
