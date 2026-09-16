#!/usr/bin/env python3
"""Build a controlled validation pair from a completed Mesh-to-CAD assembly."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

import numpy as np

from octree_mapping.mesh_adapter import load_stl


ROOT = Path(__file__).resolve().parents[3]
EXPERIMENT = ROOT / "experiments" / "octree-mapping"
PREPARE = EXPERIMENT / "scripts" / "prepare_mapping_input.py"
RENDER = ROOT / "src" / "tools_mesh2code" / "render_mapping_report.py"
PROFILES = ("position", "normal", "neighborhood", "unmatched")
PALETTE = (
    (0.35, 0.65, 0.95),
    (0.95, 0.45, 0.30),
    (0.35, 0.85, 0.45),
    (0.80, 0.45, 0.90),
    (0.95, 0.80, 0.25),
    (0.30, 0.80, 0.85),
    (0.90, 0.35, 0.60),
    (0.55, 0.55, 0.95),
)


def write_obj(path: Path, triangles: np.ndarray) -> None:
    vertices = triangles.reshape(-1, 3)
    lines = ["# generated from a completed Mesh-to-CAD assembly"]
    lines.extend(f"v {x:.9f} {y:.9f} {z:.9f}" for x, y, z in vertices)
    lines.extend(
        f"f {index} {index + 1} {index + 2}"
        for index in range(1, len(vertices) + 1, 3)
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_binary_stl(path: Path, triangles: np.ndarray) -> None:
    import struct

    payload = bytearray(b"Procedura full-run mapping pair".ljust(80, b" "))
    payload.extend(struct.pack("<I", len(triangles)))
    for triangle in triangles:
        normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
        length = float(np.linalg.norm(normal))
        if length:
            normal = normal / length
        payload.extend(struct.pack("<3f", *normal))
        payload.extend(struct.pack("<9f", *triangle.reshape(-1)))
        payload.extend(struct.pack("<H", 0))
    path.write_bytes(payload)


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="completed full-run output directory")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--part", required=True, help="part name from parts_summary.json")
    parser.add_argument("--delta", nargs=3, type=float, default=(0.0, 0.08, 0.0), metavar=("DX", "DY", "DZ"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = args.source.resolve()
    destination = args.output.resolve()
    summary = json.loads((source / "parts_summary.json").read_text(encoding="utf-8"))
    names = [part["name"] for part in summary["parts"]]
    if args.part not in names:
        raise SystemExit(f"unknown part {args.part!r}; choose one of {', '.join(names)}")

    raw_parts = {
        name: load_stl(source / "_final_build" / "_snap" / "attr" / name / "output.stl").triangles
        for name in names
    }
    raw_min = np.min(np.stack([triangles.min(axis=(0, 1)) for triangles in raw_parts.values()]), axis=0)
    raw_max = np.max(np.stack([triangles.max(axis=(0, 1)) for triangles in raw_parts.values()]), axis=0)
    scale = 1.8 / float(np.max(raw_max - raw_min))
    center = (raw_min + raw_max) / 2.0
    reference_parts = {name: (triangles - center) * scale for name, triangles in raw_parts.items()}
    candidate_parts = {name: triangles.copy() for name, triangles in reference_parts.items()}
    delta = np.asarray(args.delta, dtype=np.float64)
    candidate_parts[args.part] += delta
    reference = np.concatenate(list(reference_parts.values()), axis=0)
    candidate = np.concatenate(list(candidate_parts.values()), axis=0)
    candidate_min = candidate.min(axis=(0, 1))
    candidate_max = candidate.max(axis=(0, 1))
    if np.any(candidate_min < -1.0) or np.any(candidate_max > 1.0):
        raise ValueError("delta moves the candidate outside the fixed mapping frame")

    destination.mkdir(parents=True, exist_ok=True)
    write_obj(destination / "reference.obj", reference)
    write_obj(destination / "candidate.obj", candidate)
    write_binary_stl(destination / "candidate.stl", candidate)
    manifest = ["name\tred\tgreen\tblue\tstl_path"]
    for index, name in enumerate(names):
        write_binary_stl(destination / f"{name}.stl", candidate_parts[name])
        red, green, blue = PALETTE[index % len(PALETTE)]
        manifest.append(f"{name}\t{red:.2f}\t{green:.2f}\t{blue:.2f}\t{name}.stl")
    (destination / "parts-meta.tsv").write_text("\n".join(manifest) + "\n", encoding="utf-8")
    write_json(destination / "spec.json", {
        "schema": "procedura.octree-mapping-example/1",
        "id": f"fullrun-{source.name}",
        "referenceRole": "completed_reconstruction_assembly_baseline",
        "description": f"Controlled {args.part} displacement from {source.name}",
        "frame": {"minMm": [-1.0, -1.0, -1.0], "sideMm": 2.0, "maxDepth": 6},
        "parameters": {"source": str(source), "part": args.part, "deltaMm": delta.tolist(), "normalizationScale": scale},
    })
    write_json(destination / "oracle.json", {
        "schema": "procedura.octree-mapping-example-oracle/1",
        "kind": "full_run_part_displacement",
        "source": str(source),
        "changedPart": args.part,
        "deltaNormalizedMm": delta.tolist(),
        "interpretation": "Only the selected completed-reconstruction part is translated; all other parts are unchanged.",
    })

    input_path = destination / "2-input.json"
    subprocess.run([
        sys.executable, str(PREPARE),
        "--gt-obj", str(destination / "reference.obj"),
        "--candidate-obj", str(destination / "candidate.obj"),
        "--candidate-stl", str(destination / "candidate.stl"),
        "--parts-meta", str(destination / "parts-meta.tsv"),
        "--output", str(input_path),
        "--metadata", str(destination / "preparation-metadata.json"),
    ], cwd=EXPERIMENT, check=True)
    for profile in PROFILES:
        report_path = destination / "reports" / profile / "3-report.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            sys.executable, "-m", "octree_mapping",
            "--input", str(input_path), "--output", str(report_path), "--profile", profile,
        ], cwd=EXPERIMENT, check=True)
    render_dir = destination / "renders" / "position"
    subprocess.run([
        sys.executable, str(RENDER),
        "--report", str(destination / "reports" / "position" / "3-report.json"),
        "--gt", str(destination / "reference.obj"),
        "--candidate", str(destination / "candidate.obj"),
        "--out-dir", str(render_dir),
    ], cwd=ROOT, check=True)

    from build_multiview_context import build_context

    context = build_context(destination, "position")
    (destination / "multiview-direction.json").write_text(
        json.dumps(context, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(destination)


if __name__ == "__main__":
    main()
