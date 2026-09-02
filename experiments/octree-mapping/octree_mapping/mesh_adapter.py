"""Trusted mesh-to-surface-cell adapter for private shadow experiments."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import struct
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree


@dataclass(frozen=True)
class TriangleMesh:
    triangles: np.ndarray

    @property
    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        return self.triangles.min(axis=(0, 1)), self.triangles.max(axis=(0, 1))


@dataclass(frozen=True)
class SurfaceCell:
    mass: float
    normal: np.ndarray


def load_obj(path: str | Path) -> TriangleMesh:
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("v "):
            values = line.split()
            vertices.append((float(values[1]), float(values[2]), float(values[3])))
        elif line.startswith("f "):
            indices = [int(value.split("/", 1)[0]) for value in line.split()[1:]]
            resolved = [index - 1 if index > 0 else len(vertices) + index for index in indices]
            triangles.extend((resolved[0], resolved[index], resolved[index + 1])
                             for index in range(1, len(resolved) - 1))
    points = np.asarray(vertices, dtype=np.float64)
    return TriangleMesh(points[np.asarray(triangles, dtype=np.int64)])


def load_stl(path: str | Path) -> TriangleMesh:
    data = Path(path).read_bytes()
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if 84 + count * 50 == len(data):
            values = np.ndarray(
                shape=(count, 12), dtype="<f4", buffer=data, offset=84,
                strides=(50, 4),
            )
            return TriangleMesh(values[:, 3:12].astype(np.float64).reshape(-1, 3, 3))
    vertices: list[tuple[float, float, float]] = []
    for line in data.decode("utf-8").splitlines():
        words = line.split()
        if words[:1] == ["vertex"]:
            vertices.append(tuple(map(float, words[1:4])))
    return TriangleMesh(np.asarray(vertices, dtype=np.float64).reshape(-1, 3, 3))


def uniform_bounds_transform_values(
    raw_min: np.ndarray,
    raw_max: np.ndarray,
    normalized_min: np.ndarray,
    normalized_max: np.ndarray,
) -> tuple[float, np.ndarray]:
    ratios = (normalized_max - normalized_min) / (raw_max - raw_min)
    scale = float(np.mean(ratios))
    if float(np.max(np.abs(ratios - scale))) > 5e-5:
        raise ValueError(f"whole-mesh bounds do not prove a uniform transform: {ratios.tolist()}")
    raw_center = (raw_min + raw_max) / 2.0
    normalized_center = (normalized_min + normalized_max) / 2.0
    offset = normalized_center - scale * raw_center
    return scale, offset


def uniform_bounds_transform(raw: TriangleMesh, normalized: TriangleMesh) -> tuple[float, np.ndarray]:
    return uniform_bounds_transform_values(*raw.bounds, *normalized.bounds)


def transform(mesh: TriangleMesh, scale: float, offset: np.ndarray) -> TriangleMesh:
    return TriangleMesh(mesh.triangles * scale + offset)


def load_mesh(path: str | Path) -> TriangleMesh:
    return load_obj(path) if Path(path).suffix.lower() == ".obj" else load_stl(path)


def normalize_mesh(raw: TriangleMesh, normalized: TriangleMesh) -> TriangleMesh:
    scale, offset = uniform_bounds_transform(raw, normalized)
    return transform(raw, scale, offset)


def label_triangles_by_nearest_part(
    mesh: TriangleMesh,
    parts: dict[str, TriangleMesh],
) -> np.ndarray:
    names = sorted(parts)
    samples: list[np.ndarray] = []
    labels: list[np.ndarray] = []
    for index, name in enumerate(names):
        triangles = parts[name].triangles
        points = np.concatenate((triangles.reshape(-1, 3), triangles.mean(axis=1)), axis=0)
        samples.append(points)
        labels.append(np.full(len(points), index, dtype=np.int32))
    sample_points = np.concatenate(samples, axis=0)
    sample_labels = np.concatenate(labels, axis=0)
    nearest = cKDTree(sample_points).query(mesh.triangles.mean(axis=1), workers=-1)[1]
    return np.asarray([names[index] for index in sample_labels[nearest]], dtype=object)


def _triangle_hits_box(triangle: np.ndarray, center: np.ndarray, half: float) -> bool:
    vertices = triangle - center
    if np.any(vertices.min(axis=0) > half) or np.any(vertices.max(axis=0) < -half):
        return False
    edges = (vertices[1] - vertices[0], vertices[2] - vertices[1], vertices[0] - vertices[2])
    normal = np.cross(edges[0], edges[1])
    projected = vertices @ normal
    radius = half * float(np.sum(np.abs(normal)))
    if float(projected.min()) > radius or float(projected.max()) < -radius:
        return False
    axes = np.eye(3)
    for edge in edges:
        for box_axis in axes:
            axis = np.cross(edge, box_axis)
            projected = vertices @ axis
            radius = half * float(np.sum(np.abs(axis)))
            if float(projected.min()) > radius or float(projected.max()) < -radius:
                return False
    return True


def morton_prefix(x: int, y: int, z: int, depth: int) -> int:
    prefix = 0
    for shift in range(depth - 1, -1, -1):
        prefix = (prefix << 3) | (((x >> shift) & 1) << 2) | (((y >> shift) & 1) << 1) | ((z >> shift) & 1)
    return prefix


def rasterize_surface_cells(
    mesh: TriangleMesh,
    root_min: np.ndarray,
    root_side: float,
    depth: int,
) -> tuple[dict[int, float], dict[int, np.ndarray]]:
    resolution = 1 << depth
    cell_side = root_side / resolution
    half = cell_side / 2.0
    masses: dict[int, float] = defaultdict(float)
    normal_sums: dict[int, np.ndarray] = defaultdict(lambda: np.zeros(3, dtype=np.float64))
    for triangle in mesh.triangles:
        tri_min = triangle.min(axis=0)
        tri_max = triangle.max(axis=0)
        low = np.floor((tri_min - root_min) / cell_side).astype(np.int64)
        high = np.floor((tri_max - root_min) / cell_side).astype(np.int64)
        low = np.clip(low, 0, resolution - 1)
        high = np.clip(high, 0, resolution - 1)
        hits: list[int] = []
        for x in range(int(low[0]), int(high[0]) + 1):
            for y in range(int(low[1]), int(high[1]) + 1):
                for z in range(int(low[2]), int(high[2]) + 1):
                    center = root_min + (np.asarray((x, y, z)) + 0.5) * cell_side
                    if _triangle_hits_box(triangle, center, half):
                        hits.append(morton_prefix(x, y, z, depth))
        area_vector = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
        area = float(np.linalg.norm(area_vector) / 2.0)
        if area == 0:
            continue
        unit_normal = area_vector / (2.0 * area)
        contribution = area / len(hits)
        for prefix in hits:
            masses[prefix] += contribution
            normal_sums[prefix] += contribution * unit_normal
    return masses, normal_sums


def aggregate_surface_cells(
    masses: dict[int, float], normal_sums: dict[int, np.ndarray]
) -> dict[int, SurfaceCell]:
    return {
        prefix: SurfaceCell(mass, normal_sums[prefix] / mass)
        for prefix, mass in masses.items()
        if mass > 0
    }


def surface_cells(
    mesh: TriangleMesh,
    root_min: np.ndarray,
    root_side: float,
    depth: int,
) -> dict[int, SurfaceCell]:
    return aggregate_surface_cells(*rasterize_surface_cells(mesh, root_min, root_side, depth))


def load_part_manifest(path: str | Path) -> dict[str, Path]:
    parts: dict[str, Path] = {}
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    for line in lines[1:]:
        name, _red, _green, _blue, stl_path = line.split("\t")
        parts[name] = Path(stl_path)
    return parts
