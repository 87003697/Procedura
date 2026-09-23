"""Register a reference mesh onto a candidate mesh with one similarity transform."""

from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from octree_mapping.mesh_adapter import TriangleMesh, load_mesh


def sample_surface(mesh: TriangleMesh, count: int, rng: np.random.Generator) -> np.ndarray:
    triangles = mesh.triangles
    edges_a = triangles[:, 1] - triangles[:, 0]
    edges_b = triangles[:, 2] - triangles[:, 0]
    areas = np.linalg.norm(np.cross(edges_a, edges_b), axis=1)
    chosen = rng.choice(len(triangles), size=count, p=areas / areas.sum())
    u, v = rng.random((2, count))
    outside = u + v > 1.0
    u[outside], v[outside] = 1.0 - u[outside], 1.0 - v[outside]
    return triangles[chosen, 0] + u[:, None] * edges_a[chosen] + v[:, None] * edges_b[chosen]


def similarity_from_pairs(source: np.ndarray, target: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Least-squares scale, proper rotation, and translation mapping source pairs onto target pairs."""
    source_mean = source.mean(axis=0)
    target_mean = target.mean(axis=0)
    source_centered = source - source_mean
    target_centered = target - target_mean
    left, singular, right_t = np.linalg.svd(target_centered.T @ source_centered / len(source))
    reflection = np.diag([1.0, 1.0, np.sign(np.linalg.det(left @ right_t))])
    rotation = left @ reflection @ right_t
    scale = float(np.trace(np.diag(singular) @ reflection) / source_centered.var(axis=0).sum())
    return scale, rotation, target_mean - scale * rotation @ source_mean


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Similarity-register a reference mesh onto a candidate mesh")
    result.add_argument("--reference", required=True)
    result.add_argument("--candidate", required=True)
    result.add_argument("--output", required=True, help="binary STL of the reference in candidate coordinates")
    result.add_argument("--metadata", required=True)
    result.add_argument("--samples", type=int, default=4000)
    result.add_argument("--iterations", type=int, default=100)
    result.add_argument("--seed", type=int, default=0)
    return result


def main() -> None:
    argument_parser = parser()
    args = argument_parser.parse_args()
    if args.samples < 1 or args.iterations < 1:
        argument_parser.error("--samples and --iterations must be positive")
    reference = load_mesh(args.reference)
    candidate = load_mesh(args.candidate)

    # Area-weighted surface samples make the fit independent of triangulation density.
    rng = np.random.default_rng(args.seed)
    reference_points = sample_surface(reference, args.samples, rng)
    candidate_points = sample_surface(candidate, args.samples, rng)
    candidate_tree = cKDTree(candidate_points)

    # Symmetric nearest-neighbour RMS and pairings between moved reference samples and the candidate.
    def _symmetric_fit(moved: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
        forward_distance, forward_index = candidate_tree.query(moved)
        backward_distance, backward_index = cKDTree(moved).query(candidate_points)
        squared = forward_distance @ forward_distance + backward_distance @ backward_distance
        return float(np.sqrt(squared / (len(moved) + len(candidate_points)))), forward_index, backward_index

    # Seed ICP from every proper sign assignment of the matched principal axes.
    reference_mean = reference_points.mean(axis=0)
    candidate_mean = candidate_points.mean(axis=0)
    reference_axes = np.linalg.eigh(np.cov(reference_points.T))[1][:, ::-1]
    candidate_axes = np.linalg.eigh(np.cov(candidate_points.T))[1][:, ::-1]
    initial_scale = float(np.sqrt(candidate_points.var(axis=0).sum() / reference_points.var(axis=0).sum()))
    seeds = []
    for signs in itertools.product((1.0, -1.0), repeat=3):
        rotation = candidate_axes @ np.diag(signs) @ reference_axes.T
        if np.linalg.det(rotation) > 0:
            seeds.append((initial_scale, rotation, candidate_mean - initial_scale * rotation @ reference_mean))

    # Symmetric pairs keep the scale estimate from collapsing onto a dense candidate patch.
    trials = []
    for scale, rotation, translation in seeds:
        best_rms = np.inf
        for _ in range(args.iterations):
            rms, forward_index, backward_index = _symmetric_fit(scale * reference_points @ rotation.T + translation)
            if rms >= best_rms * (1.0 - 1e-7):
                break
            else:
                best_rms, fitted = rms, (scale, rotation, translation)
                scale, rotation, translation = similarity_from_pairs(
                    np.concatenate((reference_points, reference_points[backward_index])),
                    np.concatenate((candidate_points[forward_index], candidate_points)),
                )
        trials.append((best_rms, *fitted))
    rms, scale, rotation, translation = min(trials, key=lambda trial: trial[0])

    # Write the registered reference as binary STL in candidate coordinates.
    triangles = scale * reference.triangles @ rotation.T + translation
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    records = np.zeros(len(triangles), dtype=[("normal", "<f4", 3), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
    records["normal"] = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    records["vertices"] = triangles
    with open(args.output, "wb") as stream:
        stream.write(b"registered reference".ljust(80, b"\0"))
        stream.write(np.asarray(len(records), dtype="<u4").tobytes())
        stream.write(records.tobytes())

    # Record the fitted transform with symmetric RMS before and after registration.
    metadata = {
        "method": "PCA-seeded symmetric nearest-neighbour similarity ICP; distances in candidate units",
        "reference": str(Path(args.reference).resolve()),
        "candidate": str(Path(args.candidate).resolve()),
        "samples": args.samples,
        "iterations": args.iterations,
        "seed": args.seed,
        "scale": scale,
        "rotation": rotation.tolist(),
        "rotationDegrees": float(np.degrees(np.arccos(np.clip((np.trace(rotation) - 1.0) / 2.0, -1.0, 1.0)))),
        "translation": translation.tolist(),
        "unregisteredRms": _symmetric_fit(reference_points)[0],
        "registeredRms": rms,
        "seedRms": [trial[0] for trial in trials],
    }
    Path(args.metadata).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
