#!/usr/bin/env python3
"""Build deterministic, host-private octree mapping example fixtures."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass


ROOT = Path(__file__).resolve().parents[3]
EXPERIMENT = ROOT / "experiments" / "octree-mapping"
PREPARE = EXPERIMENT / "scripts" / "prepare_mapping_input.py"
RENDER = ROOT / "src" / "tools_mesh2code" / "render_mapping_report.py"
DEFAULT_OUTPUT_ROOT = ROOT / "outputs" / "examples"


Vec = tuple[float, float, float]


def add(a: Vec, b: Vec) -> Vec:
    return tuple(a[index] + b[index] for index in range(3))  # type: ignore[return-value]


def sub(a: Vec, b: Vec) -> Vec:
    return tuple(a[index] - b[index] for index in range(3))  # type: ignore[return-value]


def scale(value: Vec, factor: float) -> Vec:
    return tuple(component * factor for component in value)  # type: ignore[return-value]


def dot(a: Vec, b: Vec) -> float:
    return sum(a[index] * b[index] for index in range(3))


def cross(a: Vec, b: Vec) -> Vec:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def unit(value: Vec) -> Vec:
    length = math.sqrt(dot(value, value))
    if length == 0:
        raise ValueError("zero vector")
    return scale(value, 1.0 / length)


@dataclass
class MeshBuilder:
    vertices: list[Vec]
    triangles: list[tuple[int, int, int]]

    @classmethod
    def create(cls) -> "MeshBuilder":
        return cls([], [])

    def vertex(self, value: Vec) -> int:
        self.vertices.append(value)
        return len(self.vertices) - 1

    def triangle(self, a: int, b: int, c: int) -> None:
        self.triangles.append((a, b, c))

    def extend(self, other: "MeshBuilder") -> None:
        offset = len(self.vertices)
        self.vertices.extend(other.vertices)
        self.triangles.extend(
            (a + offset, b + offset, c + offset) for a, b, c in other.triangles
        )


def add_cylinder(mesh: MeshBuilder, start: Vec, end: Vec, radius: float, segments: int = 12) -> None:
    axis = unit(sub(end, start))
    reference = (0.0, 0.0, 1.0) if abs(axis[2]) < 0.9 else (0.0, 1.0, 0.0)
    first = unit(cross(axis, reference))
    second = cross(axis, first)
    lower = [mesh.vertex(add(start, scale(add(scale(first, math.cos(2 * math.pi * i / segments)), scale(second, math.sin(2 * math.pi * i / segments))), radius))) for i in range(segments)]
    upper = [mesh.vertex(add(end, scale(add(scale(first, math.cos(2 * math.pi * i / segments)), scale(second, math.sin(2 * math.pi * i / segments))), radius))) for i in range(segments)]
    lower_center = mesh.vertex(start)
    upper_center = mesh.vertex(end)
    for index in range(segments):
        next_index = (index + 1) % segments
        mesh.triangle(lower[index], lower[next_index], upper[next_index])
        mesh.triangle(lower[index], upper[next_index], upper[index])
        mesh.triangle(lower_center, lower[next_index], lower[index])
        mesh.triangle(upper_center, upper[index], upper[next_index])


def add_sphere(mesh: MeshBuilder, center: Vec, radius: float, rings: int = 6, segments: int = 12) -> None:
    top = mesh.vertex(add(center, (0.0, 0.0, radius)))
    ring_vertices: list[list[int]] = []
    for ring in range(1, rings):
        polar = math.pi * ring / rings
        z = radius * math.cos(polar)
        ring_radius = radius * math.sin(polar)
        ring_vertices.append([
            mesh.vertex(add(center, (ring_radius * math.cos(2 * math.pi * index / segments), ring_radius * math.sin(2 * math.pi * index / segments), z)))
            for index in range(segments)
        ])
    bottom = mesh.vertex(add(center, (0.0, 0.0, -radius)))
    for index in range(segments):
        next_index = (index + 1) % segments
        mesh.triangle(top, ring_vertices[0][index], ring_vertices[0][next_index])
        for ring in range(len(ring_vertices) - 1):
            current = ring_vertices[ring]
            following = ring_vertices[ring + 1]
            mesh.triangle(current[index], following[index], following[next_index])
            mesh.triangle(current[index], following[next_index], current[next_index])
        mesh.triangle(bottom, ring_vertices[-1][next_index], ring_vertices[-1][index])


def add_prism(
    mesh: MeshBuilder,
    center: Vec,
    u: Vec,
    v: Vec,
    n: Vec,
    half_u: float,
    half_v: float,
    half_n: float,
) -> None:
    """Add a box in the orthonormal basis (u, v, n)."""
    basis = (unit(u), unit(v), unit(n))
    extents = (half_u, half_v, half_n)
    vertices: list[int] = []
    for su, sv, sn in ((-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
                       (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)):
        point = center
        for sign, axis, extent in zip((su, sv, sn), basis, extents):
            point = add(point, scale(axis, sign * extent))
        vertices.append(mesh.vertex(point))
    for a, b, c in ((0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
                    (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
                    (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)):
        mesh.triangle(vertices[a], vertices[b], vertices[c])


def add_polyline_tube(mesh: MeshBuilder, points: list[Vec], radius: float, segments: int = 10) -> None:
    for start, end in zip(points, points[1:]):
        add_cylinder(mesh, start, end, radius, segments)
    for point in points:
        add_sphere(mesh, point, radius * 1.12, rings=4, segments=segments)


def add_torus(mesh: MeshBuilder, center: Vec, major: float, minor: float, rings: int = 32, sides: int = 8) -> None:
    vertices: list[list[int]] = []
    for ring in range(rings):
        theta = 2.0 * math.pi * ring / rings
        row: list[int] = []
        for side in range(sides):
            phi = 2.0 * math.pi * side / sides
            radius = major + minor * math.cos(phi)
            row.append(mesh.vertex(add(center, (radius * math.cos(theta), radius * math.sin(theta), minor * math.sin(phi)))))
        vertices.append(row)
    for ring in range(rings):
        next_ring = (ring + 1) % rings
        for side in range(sides):
            next_side = (side + 1) % sides
            mesh.triangle(vertices[ring][side], vertices[next_ring][side], vertices[next_ring][next_side])
            mesh.triangle(vertices[ring][side], vertices[next_ring][next_side], vertices[ring][next_side])


def add_gear(mesh: MeshBuilder, center: Vec, root_radius: float, tooth_radius: float, thickness: float, teeth: int, phase: float = 0.0) -> None:
    add_cylinder(mesh, add(center, (0.0, 0.0, -thickness)), add(center, (0.0, 0.0, thickness)), root_radius, segments=max(16, teeth * 2))
    for tooth in range(teeth):
        angle = phase + 2.0 * math.pi * tooth / teeth
        radial = (math.cos(angle), math.sin(angle), 0.0)
        tangent = (-math.sin(angle), math.cos(angle), 0.0)
        tooth_center = add(center, scale(radial, (root_radius + tooth_radius) / 2.0))
        add_prism(mesh, tooth_center, radial, tangent, (0.0, 0.0, 1.0), (tooth_radius - root_radius) / 2.0, math.pi * root_radius / teeth * 0.42, thickness)


def add_ribbon(mesh: MeshBuilder, point, width: float, length_steps: int = 36, width_steps: int = 5) -> None:
    vertices: list[list[int]] = []
    for i in range(length_steps + 1):
        u = i / length_steps
        row: list[int] = []
        for j in range(width_steps + 1):
            v = -1.0 + 2.0 * j / width_steps
            row.append(mesh.vertex(point(u, v * width)))
        vertices.append(row)
    for i in range(length_steps):
        for j in range(width_steps):
            mesh.triangle(vertices[i][j], vertices[i + 1][j], vertices[i + 1][j + 1])
            mesh.triangle(vertices[i][j], vertices[i + 1][j + 1], vertices[i][j + 1])


def add_arch(mesh: MeshBuilder, center_x: float, radius: float, rise: float, thickness: float, segments: int = 18) -> None:
    points: list[Vec] = []
    for index in range(segments + 1):
        angle = math.pi * index / segments
        points.append((center_x + radius * math.cos(angle), -0.05, rise * math.sin(angle)))
    add_polyline_tube(mesh, points, thickness, segments=10)


def add_lattice(mesh: MeshBuilder, phase: float, strut: float) -> None:
    spacing = 0.34
    for x in (-spacing, 0.0, spacing):
        for y in (-spacing, 0.0, spacing):
            for z in (-spacing, 0.0, spacing):
                start = (x, y, z)
                for axis in range(3):
                    direction = [0.0, 0.0, 0.0]
                    direction[axis] = spacing
                    end = add(start, tuple(direction))
                    if all(-0.7 <= value <= 0.7 for value in end):
                        add_cylinder(mesh, start, end, strut, segments=7)
                diagonal = (spacing * math.cos(phase), spacing * math.sin(phase), spacing)
                end = add(start, diagonal)
                if all(-0.7 <= value <= 0.7 for value in end):
                    add_cylinder(mesh, start, end, strut, segments=7)


def snake_arm(angle_degrees: list[float]) -> tuple[MeshBuilder, list[Vec], dict[str, MeshBuilder]]:
    mesh = MeshBuilder.create()
    parts: dict[str, MeshBuilder] = {}
    joints: list[Vec] = []
    current = (-0.72, -0.26, 0.0)
    heading = math.radians(12.0)
    lengths = (0.30, 0.27, 0.25, 0.22)
    for index, (angle, length) in enumerate(zip(angle_degrees, lengths)):
        heading += math.radians(angle)
        next_joint = add(current, (length * math.cos(heading), length * math.sin(heading), 0.0))
        part = MeshBuilder.create()
        add_cylinder(part, current, next_joint, 0.055 if index < 3 else 0.05)
        add_sphere(part, current, 0.072, rings=6, segments=12)
        mesh.extend(part)
        parts[f"link_{index + 1}"] = part
        joints.append(current)
        current = next_joint
    tip = MeshBuilder.create()
    add_sphere(tip, current, 0.072, rings=6, segments=12)
    mesh.extend(tip)
    parts["tip"] = tip
    joints.append(current)
    return mesh, joints, parts


@dataclass(frozen=True)
class ExampleCase:
    id: str
    directory: str
    description: str
    reference: MeshBuilder
    candidate: MeshBuilder
    parameters: dict[str, object]
    oracle: dict[str, object]
    candidate_parts: dict[str, MeshBuilder] | None = None


def make_snake_case() -> ExampleCase:
    reference, reference_joints, _ = snake_arm([25.0, -35.0, 50.0, -20.0])
    candidate, candidate_joints, candidate_parts = snake_arm([38.0, -20.0, 66.0, -5.0])
    return ExampleCase(
        "snake-arm", "01-snake-arm", "Four-link snake arm with controlled multi-joint angle change",
        reference, candidate,
        {"referenceAnglesDeg": [25.0, -35.0, 50.0, -20.0], "candidateAnglesDeg": [38.0, -20.0, 66.0, -5.0], "linkLengths": [0.30, 0.27, 0.25, 0.22], "jointRadius": 0.072},
        {"kind": "parametric_joint_endpoints", "referenceJoints": [list(point) for point in reference_joints], "candidateJoints": [list(point) for point in candidate_joints], "interpretation": "Compare cell displacement direction to nearby link endpoint motion; voxel quantization is expected."},
        candidate_parts,
    )


def make_miura_case() -> ExampleCase:
    def panels(fold: float) -> tuple[MeshBuilder, dict[str, MeshBuilder]]:
        mesh = MeshBuilder.create()
        parts: dict[str, MeshBuilder] = {}
        for row in range(3):
            for column in range(4):
                x = -0.56 + column * 0.37
                y = -0.40 + row * 0.27
                sign = -1.0 if (row + column) % 2 else 1.0
                angle = sign * fold
                u = (math.cos(angle), 0.0, math.sin(angle))
                v = (0.0, 1.0, 0.0)
                n = cross(u, v)
                center = (x, y, 0.05 * sign * math.sin(angle))
                panel = MeshBuilder.create()
                add_prism(panel, center, u, v, n, 0.17, 0.115, 0.018)
                mesh.extend(panel)
                parts[f"panel_{row + 1}_{column + 1}"] = panel
        return mesh, parts

    reference, _ = panels(math.radians(35.0))
    candidate, candidate_parts = panels(math.radians(49.0))
    return ExampleCase(
        "miura-solar-sail", "02-miura-solar-sail", "Miura-ori solar sail with a controlled crease-angle change",
        reference, candidate,
        {"grid": [3, 4], "referenceFoldDeg": 35.0, "candidateFoldDeg": 49.0, "panelThickness": 0.018},
        {"kind": "panel_fold_angle", "referenceFoldDeg": 35.0, "candidateFoldDeg": 49.0, "interpretation": "Panel normals should flip across alternating creases; crease neighborhoods are intentionally ambiguous."},
        candidate_parts,
    )


def make_vault_case() -> ExampleCase:
    def vault(sag: float, lean: float) -> tuple[MeshBuilder, dict[str, MeshBuilder]]:
        mesh = MeshBuilder.create()
        roof = MeshBuilder.create()
        add_arch(roof, 0.0, 0.68, sag, 0.075)
        left_support = MeshBuilder.create()
        add_prism(left_support, (-0.68, -0.05, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), 0.10, 0.12, 0.48)
        pillar_center = (0.68 + lean * 0.25, -0.05, 0.0)
        right_support = MeshBuilder.create()
        add_prism(right_support, pillar_center, unit((1.0, 0.0, lean)), (0.0, 1.0, 0.0), unit((-lean, 0.0, 1.0)), 0.10, 0.12, 0.48)
        for part in (roof, left_support, right_support):
            mesh.extend(part)
        return mesh, {"roof": roof, "left_support": left_support, "right_support": right_support}

    reference, _ = vault(0.54, 0.0)
    candidate, candidate_parts = vault(0.64, 0.12)
    return ExampleCase(
        "vault-city", "03-vault-city", "Suspended arch roof with one leaning support",
        reference, candidate,
        {"referenceRise": 0.54, "candidateRise": 0.64, "referenceLean": 0.0, "candidateLean": 0.12},
        {"kind": "surface_region_invariant", "interpretation": "Roof displacement is predominantly vertical; one pillar has a local lean. Compare roof and pillar regions separately."},
        candidate_parts,
    )


def make_bat_wing_case() -> ExampleCase:
    def wing(fold: float, ridge: float) -> tuple[MeshBuilder, dict[str, MeshBuilder]]:
        mesh = MeshBuilder.create()
        parts: dict[str, MeshBuilder] = {}
        # A faceted membrane keeps the thin features at several depth-6 cells.
        root = (-0.62, -0.08, 0.0)
        tips = [(-0.25, -0.42, 0.06), (0.12, -0.50, 0.10), (0.48, -0.38, 0.05), (0.70, -0.12, 0.0)]
        for index, tip in enumerate(tips):
            previous = root if index == 0 else tips[index - 1]
            mid = ((previous[0] + tip[0]) / 2.0, (previous[1] + tip[1]) / 2.0, ridge * math.sin(index * 0.8) + fold * (index - 1.5) * 0.04)
            finger = MeshBuilder.create()
            add_prism(finger, mid, unit(sub(tip, previous)), (0.0, 0.0, 1.0), unit(cross(sub(tip, previous), (0.0, 0.0, 1.0))), math.dist(previous, tip) / 2.0, 0.12, 0.018)
            add_polyline_tube(finger, [previous, tip], 0.018, segments=7)
            mesh.extend(finger)
            parts[f"finger_{index + 1}"] = finger
        midrib = MeshBuilder.create()
        add_polyline_tube(midrib, [root, (-0.10, 0.10, fold * 0.12), (0.42, 0.16, ridge * 0.20)], 0.035, segments=8)
        mesh.extend(midrib)
        parts["midrib"] = midrib
        return mesh, parts

    reference, _ = wing(0.0, 0.05)
    candidate, candidate_parts = wing(1.0, 0.10)
    return ExampleCase(
        "bat-wing", "04-bat-wing", "Wing membrane with a folded midrib and raised finger ridges",
        reference, candidate,
        {"referenceFold": 0.0, "candidateFold": 1.0, "referenceRidge": 0.05, "candidateRidge": 0.10, "fingerCount": 4},
        {"kind": "smooth_plus_ridge_field", "interpretation": "Membrane motion should vary smoothly while ridges remain locally coherent; thin ridge cells may have larger spread."},
        candidate_parts,
    )


def make_blind_labyrinth_case() -> ExampleCase:
    def helmet(cavity_depth: float, baffle_offset: float) -> MeshBuilder:
        mesh = MeshBuilder.create()
        add_prism(mesh, (0.0, 0.0, 0.05), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), 0.58, 0.38, 0.08)
        add_prism(mesh, (0.0, 0.0, 0.43), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), 0.58, 0.38, 0.08)
        # Side rails make the outer silhouette shared between the two meshes.
        for x in (-0.50, 0.50):
            add_prism(mesh, (x, 0.0, 0.24), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), 0.08, 0.38, 0.24)
        for y in (-0.30, 0.30):
            add_prism(mesh, (0.0, y, 0.24), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), 0.50, 0.08, 0.24)
        # Internal blind plates are deliberately invisible in front view.
        add_prism(mesh, (0.0, 0.0, 0.12 + cavity_depth), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), 0.42, 0.24, 0.025)
        add_prism(mesh, (baffle_offset, 0.0, 0.27), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), 0.035, 0.24, 0.14)
        return mesh

    return ExampleCase(
        "blind-labyrinth", "05-blind-labyrinth", "Shared outer helmet with a shifted internal blind baffle",
        helmet(0.16, -0.18), helmet(0.30, 0.16),
        {"referenceCavityDepth": 0.16, "candidateCavityDepth": 0.30, "referenceBaffleOffset": -0.18, "candidateBaffleOffset": 0.16},
        {"kind": "occluded_internal_region", "interpretation": "Outer shell should remain nearly stationary; only internal cavity and baffle regions are expected to move."},
    )


def make_branching_case() -> ExampleCase:
    def vessel(angle: float, radius: float) -> MeshBuilder:
        mesh = MeshBuilder.create()
        trunk = [(-0.72, 0.0, 0.0), (-0.35, 0.0, 0.0), (0.0, 0.0, 0.02)]
        add_polyline_tube(mesh, trunk, 0.09, segments=9)
        left = [(0.0, 0.0, 0.02), (0.25 * math.cos(angle), 0.25 * math.sin(angle), 0.08), (0.54 * math.cos(angle), 0.54 * math.sin(angle), 0.12)]
        right = [(0.0, 0.0, 0.02), (0.25 * math.cos(-angle), 0.25 * math.sin(-angle), -0.06), (0.52 * math.cos(-angle), 0.52 * math.sin(-angle), -0.10)]
        add_polyline_tube(mesh, left, radius, segments=9)
        add_polyline_tube(mesh, right, radius * 0.78, segments=9)
        return mesh

    return ExampleCase(
        "branching-vessel", "06-branching-vessel", "Y-shaped vessel with a controlled bifurcation angle",
        vessel(math.radians(30.0), 0.065), vessel(math.radians(48.0), 0.075),
        {"referenceBranchAngleDeg": 30.0, "candidateBranchAngleDeg": 48.0, "trunkRadius": 0.09},
        {"kind": "branch_junction_invariant", "interpretation": "Branch segments should have coherent direction; the junction is expected to carry higher spread than straight segments."},
    )


def make_wormgear_case() -> ExampleCase:
    def gear(phase: float, pitch: float) -> MeshBuilder:
        mesh = MeshBuilder.create()
        add_gear(mesh, (-0.28, 0.0, 0.0), 0.28, 0.48, 0.06, 9, phase)
        points = []
        for index in range(34):
            theta = 1.5 * math.pi * index / 33.0
            points.append((0.28 * math.cos(theta) + 0.20, 0.28 * math.sin(theta), -0.18 + pitch * theta / (1.5 * math.pi)))
        add_polyline_tube(mesh, points, 0.045, segments=8)
        return mesh

    return ExampleCase(
        "wormgear-planet", "07-wormgear-planet", "Phase-shifted helical cam beside a nine-tooth gear",
        gear(0.0, 0.42), gear(math.radians(14.0), 0.56),
        {"teeth": 9, "referencePhaseDeg": 0.0, "candidatePhaseDeg": 14.0, "referencePitch": 0.42, "candidatePitch": 0.56},
        {"kind": "periodic_helical_field", "interpretation": "Helical displacement mixes tangential and axial motion; repeated teeth create deliberate coarse-level aliases."},
    )


def make_nautilus_case() -> ExampleCase:
    def shell(growth: float, phase: float) -> MeshBuilder:
        mesh = MeshBuilder.create()
        points: list[Vec] = []
        for index in range(46):
            theta = phase + 1.25 * math.pi * index / 45.0
            radius = 0.07 + growth * theta
            points.append((radius * math.cos(theta) - 0.25, radius * math.sin(theta), 0.12 * math.sin(theta * 1.4)))
        add_polyline_tube(mesh, points, 0.055, segments=9)
        add_sphere(mesh, points[0], 0.08, rings=5, segments=9)
        return mesh

    return ExampleCase(
        "nautilus-shell", "08-nautilus-shell", "Logarithmic spiral shell with a changed growth rate",
        shell(0.17, 0.0), shell(0.22, math.radians(6.0)),
        {"referenceGrowth": 0.17, "candidateGrowth": 0.22, "candidatePhaseDeg": 6.0, "turns": 0.625},
        {"kind": "parametric_spiral_growth", "interpretation": "Radial displacement should grow with spiral angle; compare coarse-to-fine direction continuity along the shell."},
    )


def make_flower_case() -> ExampleCase:
    def flower(rotation: float, curl: float) -> tuple[MeshBuilder, dict[str, MeshBuilder]]:
        mesh = MeshBuilder.create()
        parts: dict[str, MeshBuilder] = {}
        center = (0.0, 0.0, 0.0)
        hub = MeshBuilder.create()
        add_sphere(hub, center, 0.13, rings=6, segments=10)
        mesh.extend(hub)
        parts["hub"] = hub
        for index in range(6):
            angle = rotation + index * math.pi / 3.0
            start = (0.10 * math.cos(angle), 0.10 * math.sin(angle), 0.0)
            bend = (0.36 * math.cos(angle), 0.36 * math.sin(angle), curl * math.sin(angle * 2.0))
            end = (0.64 * math.cos(angle), 0.64 * math.sin(angle), curl * math.sin(angle * 2.0) + 0.06)
            petal = MeshBuilder.create()
            add_polyline_tube(petal, [start, bend, end], 0.055, segments=8)
            mesh.extend(petal)
            parts[f"petal_{index + 1}"] = petal
        return mesh, parts

    reference, _ = flower(0.0, 0.05)
    candidate, candidate_parts = flower(math.radians(15.0), 0.12)
    return ExampleCase(
        "mechanical-flower", "09-mechanical-flower", "Six articulated petals opening with a phase offset",
        reference, candidate,
        {"petalCount": 6, "referenceRotationDeg": 0.0, "candidateRotationDeg": 15.0, "referenceCurl": 0.05, "candidateCurl": 0.12},
        {"kind": "radial_multi_part_motion", "interpretation": "Petals should show mixed radial/tangential displacement around a stable center."},
        candidate_parts,
    )


def make_mobius_case() -> ExampleCase:
    def band(twist: float) -> MeshBuilder:
        mesh = MeshBuilder.create()
        def point(u: float, offset: float) -> Vec:
            theta = 2.0 * math.pi * u
            return ((0.45 + offset * math.cos(twist * theta / 2.0)) * math.cos(theta), (0.45 + offset * math.cos(twist * theta / 2.0)) * math.sin(theta), offset * math.sin(twist * theta / 2.0))
        add_ribbon(mesh, point, 0.17, length_steps=40, width_steps=6)
        edge_a = [point(index / 40.0, -0.17) for index in range(41)]
        edge_b = [point(index / 40.0, 0.17) for index in range(41)]
        add_polyline_tube(mesh, edge_a, 0.015, segments=7)
        add_polyline_tube(mesh, edge_b, 0.015, segments=7)
        return mesh

    return ExampleCase(
        "mobius-repair-band", "10-mobius-repair-band", "Möbius repair band with reversed half-twist",
        band(1.0), band(-1.0),
        {"referenceHalfTwist": "+pi", "candidateHalfTwist": "-pi", "width": 0.34, "radius": 0.45},
        {"kind": "topology_invariant", "interpretation": "Do not require one-to-one arrows near the seam; high spread there is the expected honest result."},
    )


def make_gyroid_case() -> ExampleCase:
    def material(phase: float, strut: float) -> MeshBuilder:
        mesh = MeshBuilder.create()
        add_lattice(mesh, phase, strut)
        for z in (-0.34, 0.34):
            add_torus(mesh, (0.0, 0.0, z), 0.35, strut * 0.8, rings=24, sides=6)
        return mesh

    return ExampleCase(
        "gyroid-material", "11-gyroid-material", "Low-poly porous metamaterial with a phase-shifted lattice",
        material(0.0, 0.035), material(math.radians(22.0), 0.052),
        {"latticeSize": [2, 2, 2], "referencePhaseDeg": 0.0, "candidatePhaseDeg": 22.0, "referenceStrut": 0.035, "candidateStrut": 0.052},
        {"kind": "porous_occupancy_invariant", "interpretation": "Fine levels should reveal phase and thickness changes; coarse levels intentionally merge neighboring struts."},
    )


def make_octopus_case() -> ExampleCase:
    def octopus(amplitude: float, phase: float) -> MeshBuilder:
        mesh = MeshBuilder.create()
        add_sphere(mesh, (0.0, 0.0, 0.05), 0.19, rings=7, segments=12)
        for index in range(6):
            angle = 2.0 * math.pi * index / 6.0
            points: list[Vec] = []
            for step in range(6):
                u = step / 5.0
                radius = 0.18 + 0.55 * u
                bend = amplitude * math.sin(phase + u * math.pi * 1.5 + index)
                points.append((radius * math.cos(angle) + bend * math.cos(angle + math.pi / 2.0), radius * math.sin(angle) + bend * math.sin(angle + math.pi / 2.0), 0.05 - 0.18 * u + amplitude * 0.5 * math.cos(phase + index + u)))
            add_polyline_tube(mesh, points, 0.055 - 0.018 * (len(points) / 6.0), segments=8)
        return mesh

    return ExampleCase(
        "breathing-octopus", "12-breathing-octopus", "Soft-body tentacles with a controlled breathing phase",
        octopus(0.05, 0.0), octopus(0.14, math.pi / 3.0),
        {"tentacleCount": 6, "referenceAmplitude": 0.05, "candidateAmplitude": 0.14, "referencePhase": 0.0, "candidatePhase": math.pi / 3.0},
        {"kind": "time_slice_deformation", "interpretation": "This pair is one snapshot of a time series; displacement should vary smoothly along each tentacle."},
    )


BUILDERS = {
    "snake-arm": make_snake_case,
    "miura-solar-sail": make_miura_case,
    "vault-city": make_vault_case,
    "bat-wing": make_bat_wing_case,
    "blind-labyrinth": make_blind_labyrinth_case,
    "branching-vessel": make_branching_case,
    "wormgear-planet": make_wormgear_case,
    "nautilus-shell": make_nautilus_case,
    "mechanical-flower": make_flower_case,
    "mobius-repair-band": make_mobius_case,
    "gyroid-material": make_gyroid_case,
    "breathing-octopus": make_octopus_case,
}


def write_obj(path: Path, mesh: MeshBuilder) -> None:
    lines = ["# generated by procedura mapping example builder"]
    lines.extend(f"v {x:.9f} {y:.9f} {z:.9f}" for x, y, z in mesh.vertices)
    lines.extend(f"f {a + 1} {b + 1} {c + 1}" for a, b, c in mesh.triangles)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_binary_stl(path: Path, mesh: MeshBuilder) -> None:
    import struct

    header = b"Procedura mapping example".ljust(80, b" ")
    payload = bytearray(header)
    payload.extend(struct.pack("<I", len(mesh.triangles)))
    for a, b, c in mesh.triangles:
        first, second, third = mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]
        normal = unit(cross(sub(second, first), sub(third, first))) if sub(second, first) != (0.0, 0.0, 0.0) else (0.0, 0.0, 0.0)
        payload.extend(struct.pack("<3f", *normal))
        payload.extend(struct.pack("<9f", *(first + second + third)))
        payload.extend(struct.pack("<H", 0))
    path.write_bytes(payload)


def write_parts_manifest(path: Path, candidate_stl: Path, case: ExampleCase) -> None:
    parts = case.candidate_parts
    lines = ["name\tred\tgreen\tblue\tstl_path"]
    if not parts:
        lines.append(f"{case.id}_whole\t0.35\t0.65\t0.95\t{candidate_stl.name}")
    else:
        palette = ((0.35, 0.65, 0.95), (0.95, 0.45, 0.30), (0.35, 0.85, 0.45), (0.80, 0.45, 0.90), (0.95, 0.80, 0.25), (0.30, 0.80, 0.85), (0.90, 0.35, 0.60), (0.55, 0.55, 0.95))
        for index, (name, mesh) in enumerate(parts.items()):
            part_stl = path.parent / f"{name}.stl"
            write_binary_stl(part_stl, mesh)
            red, green, blue = palette[index % len(palette)]
            lines.append(f"{name}\t{red:.2f}\t{green:.2f}\t{blue:.2f}\t{part_stl.name}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_case(case: ExampleCase, destination: Path, python: str, profiles: list[str], depth: int, render: bool) -> None:
    write_obj(destination / "reference.obj", case.reference)
    write_obj(destination / "candidate.obj", case.candidate)
    write_binary_stl(destination / "candidate.stl", case.candidate)
    write_parts_manifest(destination / "parts-meta.tsv", destination / "candidate.stl", case)
    write_json(destination / "spec.json", {
        "schema": "procedura.octree-mapping-example/1",
        "id": case.id,
        "referenceRole": "generated_reference_not_external_truth",
        "description": case.description,
        "frame": {"minMm": [-1.0, -1.0, -1.0], "sideMm": 2.0, "maxDepth": depth},
        "parameters": case.parameters,
    })
    write_json(destination / "oracle.json", {
        "schema": "procedura.octree-mapping-example-oracle/1",
        "id": case.id,
        **case.oracle,
    })
    input_path = destination / "2-input.json"
    metadata_path = destination / "preparation-metadata.json"
    subprocess.run([
        python, str(PREPARE), "--gt-obj", str(destination / "reference.obj"),
        "--candidate-obj", str(destination / "candidate.obj"),
        "--candidate-stl", str(destination / "candidate.stl"),
        "--parts-meta", str(destination / "parts-meta.tsv"),
        "--output", str(input_path), "--metadata", str(metadata_path), "--depth", str(depth),
    ], cwd=EXPERIMENT, check=True)

    reports = destination / "reports"
    for profile in profiles:
        report_path = reports / profile / "3-report.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            python, "-m", "octree_mapping", "--input", str(input_path),
            "--output", str(report_path), "--profile", profile,
        ], cwd=EXPERIMENT, check=True)

    if render:
        render_dir = destination / "renders" / "position"
        subprocess.run([
            python, str(RENDER), "--report", str(reports / "position" / "3-report.json"),
            "--gt", str(destination / "reference.obj"),
            "--candidate", str(destination / "candidate.obj"),
            "--out-dir", str(render_dir),
        ], cwd=ROOT, check=True)

    validate_case(destination, case.id, profiles, depth, render)


def validate_case(destination: Path, case_id: str, profiles: list[str], depth: int, render: bool) -> None:
    checks: dict[str, object] = {"example": case_id, "profiles": {}, "renders": []}
    for profile in profiles:
        report = json.loads((destination / "reports" / profile / "3-report.json").read_text(encoding="utf-8"))
        if report.get("schema") != "procedura.octree-mapping-report/3":
            raise ValueError(f"{profile}: unexpected report schema")
        levels = report.get("levels")
        expected_depths = list(range(3, depth + 1))
        if [level["summary"]["depth"] for level in levels] != expected_depths:
            raise ValueError(f"{profile}: incomplete depth coverage")
        for level in levels:
            candidate_keys = {"prefix", "mass", "displacementMm", "spreadCells", "sourceMarginalRatio"}
            gt_keys = {"prefix", "mass", "targetMarginalRatio"}
            if any(set(cell) != candidate_keys for cell in level["candidateCells"]):
                raise ValueError(f"{profile}: candidate contract mismatch")
            if any(set(cell) != gt_keys for cell in level["gtCells"]):
                raise ValueError(f"{profile}: GT contract mismatch")
        checks["profiles"][profile] = {"depths": expected_depths, "status": "ok"}  # type: ignore[index]
    if render:
        for name in ("front", "top", "side"):
            path = destination / "renders" / "position" / f"mapping-report-{name}.png"
            if not path.is_file() or path.stat().st_size == 0:
                raise ValueError(f"missing render: {path}")
            checks["renders"].append(name)  # type: ignore[union-attr]
    checks["status"] = "ok"
    write_json(destination / "validation.json", checks)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--example", default="snake-arm")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--depth", type=int, default=6)
    parser.add_argument("--profiles", default="position,normal,neighborhood,unmatched")
    parser.add_argument("--skip-render", action="store_true")
    parser.add_argument("--list", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.list:
        catalog = json.loads((Path(__file__).parent / "catalog.json").read_text(encoding="utf-8"))
        for item in catalog["examples"]:
            print(f"{item['id']}\t{item['status']}")
        return
    if not 1 <= args.depth <= 10:
        raise SystemExit("--depth must be between 1 and 10")
    profiles = [profile for profile in args.profiles.split(",") if profile]
    allowed = {"position", "normal", "neighborhood", "unmatched"}
    if not profiles or any(profile not in allowed for profile in profiles):
        raise SystemExit(f"--profiles must use {', '.join(sorted(allowed))}")
    args.output_root.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((Path(__file__).parent / "catalog.json").read_text(encoding="utf-8"))
    if args.example == "all":
        selected = [item["id"] for item in catalog["examples"]]
    else:
        selected = [args.example]
    for example_id in selected:
        try:
            builder = BUILDERS[example_id]
        except KeyError as error:
            raise SystemExit(f"example {example_id!r} is not implemented") from error
        case = builder()
        destination = args.output_root / next(item["directory"] for item in catalog["examples"] if item["id"] == example_id)
        if destination.exists():
            print(f"skip existing {destination}")
            continue
        temporary = Path(tempfile.mkdtemp(prefix=f".building-{case.directory}-", dir=args.output_root))
        try:
            build_case(case, temporary, sys.executable, profiles, args.depth, not args.skip_render)
            temporary.rename(destination)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        print(destination)


if __name__ == "__main__":
    main()
