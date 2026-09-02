"""Sparse hierarchical unbalanced OT and compact cell-level evidence."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from .contract import Cell, Frame, MappingInput
from .config import MappingConfig
from .costs import neighborhood_cost, normal_cost, position_cost
from .unmatched import scales


OUTPUT_SCHEMA = "procedura.octree-mapping-report/3"


SolverConfig = MappingConfig


@dataclass(frozen=True)
class Node:
    prefix: int
    mass: float
    center: np.ndarray
    normal: np.ndarray


@dataclass(frozen=True)
class SparsePlan:
    rows: np.ndarray
    columns: np.ndarray
    weights: np.ndarray
    row_starts: np.ndarray


@dataclass(frozen=True)
class NodeEvidence:
    source_marginal_ratio: float
    displacement_mm: np.ndarray | None
    spread_mm: float | None


@dataclass(frozen=True)
class LevelEvidence:
    depth: int
    source: list[Node]
    target: list[Node]
    candidate_pair_count: int
    support_pair_count: int
    iterations: int
    solver_error: float
    candidate: list[NodeEvidence]
    target_marginal_ratios: np.ndarray


def _decode(prefix: int, depth: int) -> tuple[int, int, int]:
    xyz = [0, 0, 0]
    for shift in range(depth - 1, -1, -1):
        child = (prefix >> (3 * shift)) & 7
        xyz[0] = (xyz[0] << 1) | ((child >> 2) & 1)
        xyz[1] = (xyz[1] << 1) | ((child >> 1) & 1)
        xyz[2] = (xyz[2] << 1) | (child & 1)
    return xyz[0], xyz[1], xyz[2]


def _cell_center(frame: Frame, prefix: int, depth: int) -> np.ndarray:
    xyz = np.asarray(_decode(prefix, depth), dtype=np.float64)
    side = frame.side_mm / (1 << depth)
    return np.asarray(frame.min_mm, dtype=np.float64) + (xyz + 0.5) * side


def _leaf_center(frame: Frame, prefix: int) -> np.ndarray:
    return _cell_center(frame, prefix, frame.max_depth)


def _aggregate(frame: Frame, cells: tuple[Cell, ...], depth: int) -> list[Node]:
    shift = 3 * (frame.max_depth - depth)
    groups: dict[int, dict[str, Any]] = {}
    for cell in cells:
        prefix = cell.prefix >> shift
        group = groups.setdefault(
            prefix,
            {"mass": 0.0, "center": np.zeros(3), "normal": np.zeros(3)},
        )
        group["mass"] += cell.mass
        group["center"] += cell.mass * _leaf_center(frame, cell.prefix)
        group["normal"] += cell.mass * np.asarray(cell.normal)
    nodes: list[Node] = []
    for prefix, group in sorted(groups.items()):
        mass = float(group["mass"])
        nodes.append(Node(prefix, mass, group["center"] / mass, group["normal"] / mass))
    return nodes


def _validate_config(frame: Frame, config: SolverConfig) -> None:
    if not 1 <= config.start_depth <= config.max_depth <= frame.max_depth:
        raise ValueError("solver depths must satisfy 1 <= start <= max <= frame.maxDepth")
    if config.max_depth < 4 or config.max_depth > 8:
        raise ValueError("solver maxDepth must be in 4..8")
    if config.blur_cells <= 0 or config.unmatched_penalty_cells <= 0:
        raise ValueError("blurCells and unmatchedPenaltyCells must be positive")
    weights = (config.position_weight, config.normal_weight, config.neighborhood_weight)
    if any(weight < 0 for weight in weights) or not any(weight > 0 for weight in weights):
        raise ValueError("matching weights must be non-negative with at least one positive")
    if config.neighborhood_radius_cells <= 0:
        raise ValueError("neighborhoodRadiusCells must be positive")
    if not 0 < config.support_relative < 1:
        raise ValueError("supportRelative must be in (0, 1)")
    if config.halo_cells < 0 or config.max_pairs <= 0:
        raise ValueError("haloCells must be non-negative and maxPairs positive")
    if config.max_iterations <= 0 or config.tolerance <= 0:
        raise ValueError("maxIterations and tolerance must be positive")


def _candidate_pairs(
    source: list[Node],
    target: list[Node],
    depth: int,
    previous_support: set[tuple[int, int]] | None,
    halo_cells: int,
    limit: int,
) -> tuple[np.ndarray, np.ndarray]:
    if previous_support is None:
        count = len(source) * len(target)
        if count > limit:
            raise RuntimeError(
                f"depth {depth} requires {count} candidate pairs, exceeding maxPairs={limit}"
            )
        return (
            np.repeat(np.arange(len(source), dtype=np.int64), len(target)),
            np.tile(np.arange(len(target), dtype=np.int64), len(source)),
        )

    target_by_parent: dict[int, list[int]] = {}
    target_by_xyz: dict[tuple[int, int, int], int] = {}
    for j, node in enumerate(target):
        target_by_parent.setdefault(node.prefix >> 3, []).append(j)
        target_by_xyz[_decode(node.prefix, depth)] = j
    inherited_by_source_parent: dict[int, set[int]] = {}
    for source_parent, target_parent in previous_support:
        inherited_by_source_parent.setdefault(source_parent, set()).add(target_parent)

    pairs: set[tuple[int, int]] = set()

    def add(pair: tuple[int, int]) -> None:
        if pair in pairs:
            return
        if len(pairs) == limit:
            raise RuntimeError(
                f"depth {depth} requires more than {limit} candidate pairs, "
                f"exceeding maxPairs={limit}"
            )
        pairs.add(pair)

    for i, node in enumerate(source):
        source_parent = node.prefix >> 3
        for target_parent in inherited_by_source_parent.get(source_parent, ()):
            for j in target_by_parent.get(target_parent, ()):
                add((i, j))
        x, y, z = _decode(node.prefix, depth)
        for dx in range(-halo_cells, halo_cells + 1):
            for dy in range(-halo_cells, halo_cells + 1):
                for dz in range(-halo_cells, halo_cells + 1):
                    j = target_by_xyz.get((x + dx, y + dy, z + dz))
                    if j is not None:
                        add((i, j))

    source_centers = np.stack([node.center for node in source])
    target_centers = np.stack([node.center for node in target])
    nearest_target = cKDTree(target_centers).query(source_centers)[1]
    nearest_source = cKDTree(source_centers).query(target_centers)[1]
    for i, j in enumerate(nearest_target):
        add((i, int(j)))
    for j, i in enumerate(nearest_source):
        add((int(i), j))
    ordered = np.asarray(sorted(pairs), dtype=np.int64)
    return ordered[:, 0], ordered[:, 1]


def _starts(indices: np.ndarray) -> np.ndarray:
    return np.flatnonzero(np.r_[True, indices[1:] != indices[:-1]])


def _segment_logsumexp(values: np.ndarray, starts: np.ndarray) -> np.ndarray:
    maxima = np.maximum.reduceat(values, starts)
    totals = np.add.reduceat(np.exp(values - np.repeat(maxima, np.diff(np.r_[starts, len(values)]))), starts)
    return maxima + np.log(totals)


def _occupancy_descriptors(nodes: list[Node], depth: int, radius: int) -> np.ndarray:
    occupied = {_decode(node.prefix, depth) for node in nodes}
    offsets = [
        (dx, dy, dz)
        for dx in range(-radius, radius + 1)
        for dy in range(-radius, radius + 1)
        for dz in range(-radius, radius + 1)
        if (dx, dy, dz) != (0, 0, 0)
    ]
    descriptors = np.empty((len(nodes), len(offsets)), dtype=bool)
    for i, node in enumerate(nodes):
        x, y, z = _decode(node.prefix, depth)
        descriptors[i] = [
            (x + dx, y + dy, z + dz) in occupied for dx, dy, dz in offsets
        ]
    return descriptors


def _log_sinkhorn(
    source_mass: np.ndarray,
    target_mass: np.ndarray,
    rows: np.ndarray,
    columns: np.ndarray,
    cost: np.ndarray,
    epsilon: float,
    rho: float,
    max_iterations: int,
    tolerance: float,
) -> tuple[SparsePlan, int, float]:
    log_source = np.log(source_mass)
    log_target = np.log(target_mass)
    log_kernel = log_source[rows] + log_target[columns] - cost / epsilon
    row_starts = _starts(rows)
    column_order = np.lexsort((rows, columns))
    ordered_columns = columns[column_order]
    column_starts = _starts(ordered_columns)
    exponent = rho / (rho + epsilon)
    log_u = np.zeros_like(source_mass)
    log_v = np.zeros_like(target_mass)
    final_error = math.inf
    for iteration in range(1, max_iterations + 1):
        previous_u = log_u.copy()
        previous_v = log_v.copy()
        row_sum = _segment_logsumexp(log_kernel + log_v[columns], row_starts)
        log_u = exponent * (log_source - row_sum)
        column_sum = _segment_logsumexp(
            log_kernel[column_order] + log_u[rows[column_order]],
            column_starts,
        )
        log_v = exponent * (log_target - column_sum)
        final_error = float(max(
            np.max(np.abs(log_u - previous_u)),
            np.max(np.abs(log_v - previous_v)),
        ))
        if not np.isfinite(final_error):
            raise RuntimeError("UOT log-domain iteration produced non-finite potentials")
        if final_error <= tolerance:
            break
    else:
        raise RuntimeError(
            f"UOT log-domain solver did not converge within {max_iterations} iterations; "
            f"finalError={final_error}"
        )
    weights = np.exp(log_kernel + log_u[rows] + log_v[columns])
    return SparsePlan(rows, columns, weights, row_starts), iteration, final_error


def _matching_cost(
    frame: Frame,
    source: list[Node],
    target: list[Node],
    depth: int,
    rows: np.ndarray,
    columns: np.ndarray,
    config: SolverConfig,
) -> np.ndarray:
    """Build the normalized cell-pair cost; disabled signals stay unevaluated."""
    x = np.stack([node.center for node in source])
    y = np.stack([node.center for node in target])
    cell_side = frame.side_mm / (1 << depth)
    cost = np.zeros(len(rows), dtype=np.float64)
    if config.position_weight > 0:
        cost += config.position_weight * position_cost(x, y, rows, columns, cell_side)
    if config.normal_weight > 0:
        source_normals = np.stack([node.normal for node in source])
        target_normals = np.stack([node.normal for node in target])
        cost += config.normal_weight * normal_cost(source_normals, target_normals, rows, columns)
    if config.neighborhood_weight > 0:
        source_neighborhood = _occupancy_descriptors(
            source, depth, config.neighborhood_radius_cells
        )
        target_neighborhood = _occupancy_descriptors(
            target, depth, config.neighborhood_radius_cells
        )
        cost += config.neighborhood_weight * neighborhood_cost(
            source_neighborhood, target_neighborhood, rows, columns
        )
    return cost


def _require_finite_plan(plan: SparsePlan, depth: int) -> None:
    if not np.all(np.isfinite(plan.weights)) or float(plan.weights.sum()) <= 0:
        raise RuntimeError(f"depth {depth} UOT solver returned no finite transported mass")


def _solve_level(
    frame: Frame,
    source: list[Node],
    target: list[Node],
    depth: int,
    rows: np.ndarray,
    columns: np.ndarray,
    config: SolverConfig,
) -> tuple[SparsePlan, int, float]:
    epsilon, rho = scales(
        depth, config.max_depth, config.blur_cells, config.unmatched_penalty_cells
    )
    cost = _matching_cost(frame, source, target, depth, rows, columns, config)
    source_mass = np.asarray([node.mass for node in source], dtype=np.float64)
    target_mass = np.asarray([node.mass for node in target], dtype=np.float64)
    plan, iterations, final_error = _log_sinkhorn(
        source_mass,
        target_mass,
        rows,
        columns,
        cost,
        epsilon,
        rho,
        config.max_iterations,
        config.tolerance,
    )
    _require_finite_plan(plan, depth)
    return plan, iterations, final_error


def _support(plan: SparsePlan, source: list[Node], target: list[Node], relative: float) -> set[tuple[int, int]]:
    support: set[tuple[int, int]] = set()
    ends = np.r_[plan.row_starts[1:], len(plan.rows)]
    for i, (start, end) in enumerate(zip(plan.row_starts, ends, strict=True)):
        row = plan.weights[start:end]
        maximum = float(row.max(initial=0.0))
        if maximum <= 0:
            continue
        for offset in np.flatnonzero(row >= maximum * relative):
            j = int(plan.columns[start + int(offset)])
            support.add((source[i].prefix, target[j].prefix))
    return support


def _node_evidence(
    source: list[Node],
    target: list[Node],
    plan: SparsePlan,
) -> list[NodeEvidence]:
    evidence: list[NodeEvidence] = []
    target_centers = np.stack([node.center for node in target])
    ends = np.r_[plan.row_starts[1:], len(plan.rows)]
    for node, start, end in zip(source, plan.row_starts, ends, strict=True):
        row = plan.weights[start:end]
        target_indices = plan.columns[start:end]
        mass = float(row.sum())
        if mass <= 0:
            evidence.append(NodeEvidence(0.0, None, None))
            continue
        probabilities = row / mass
        row_centers = target_centers[target_indices]
        barycenter = probabilities @ row_centers
        variance = float(np.sum(probabilities * np.sum((row_centers - barycenter) ** 2, axis=1)))
        evidence.append(NodeEvidence(
            mass / node.mass,
            barycenter - node.center,
            math.sqrt(max(variance, 0.0)),
        ))
    return evidence


def _target_marginal_ratios(target: list[Node], plan: SparsePlan) -> np.ndarray:
    received = np.bincount(plan.columns, weights=plan.weights, minlength=len(target))
    return received / np.asarray([node.mass for node in target])


def _level_report(
    frame: Frame,
    level: LevelEvidence,
) -> dict[str, Any]:
    cell_size = frame.side_mm / (1 << level.depth)
    candidate_cells = []
    for node, evidence in zip(level.source, level.candidate, strict=True):
        candidate_cells.append({
            "prefix": node.prefix,
            "mass": node.mass,
            "displacementMm": (
                (
                    evidence.displacement_mm
                    + node.center
                    - _cell_center(frame, node.prefix, level.depth)
                ).tolist()
                if evidence.displacement_mm is not None
                else None
            ),
            "spreadCells": (
                evidence.spread_mm / cell_size if evidence.spread_mm is not None else None
            ),
            "sourceMarginalRatio": evidence.source_marginal_ratio,
        })
    return {
        "summary": {
            "depth": level.depth,
            "cellSizeMm": cell_size,
            "candidateCellCount": len(level.source),
            "gtCellCount": len(level.target),
            "candidatePairCount": level.candidate_pair_count,
            "supportPairCount": level.support_pair_count,
            "iterations": level.iterations,
            "solverError": level.solver_error,
        },
        "candidateCells": candidate_cells,
        "gtCells": [
            {
                "prefix": node.prefix,
                "mass": node.mass,
                "targetMarginalRatio": float(ratio),
            }
            for node, ratio in zip(level.target, level.target_marginal_ratios, strict=True)
        ],
    }


def map_octrees(data: MappingInput, config: SolverConfig) -> dict[str, Any]:
    _validate_config(data.frame, config)
    previous_support: set[tuple[int, int]] | None = None
    level_evidence: list[LevelEvidence] = []
    for depth in range(config.start_depth, config.max_depth + 1):
        source = _aggregate(data.frame, data.candidate, depth)
        target = _aggregate(data.frame, data.gt, depth)
        rows, columns = _candidate_pairs(
            source,
            target,
            depth,
            previous_support,
            config.halo_cells,
            config.max_pairs,
        )
        plan, iterations, solver_error = _solve_level(
            data.frame, source, target, depth, rows, columns, config
        )
        previous_support = _support(plan, source, target, config.support_relative)
        level_evidence.append(LevelEvidence(
            depth,
            source,
            target,
            len(rows),
            len(previous_support),
            iterations,
            solver_error,
            _node_evidence(source, target, plan),
            _target_marginal_ratios(target, plan),
        ))
    levels = [
        _level_report(
            data.frame,
            level,
        )
        for level in level_evidence
    ]
    return {
        "schema": OUTPUT_SCHEMA,
        "frame": {
            "minMm": list(data.frame.min_mm),
            "sideMm": data.frame.side_mm,
            "inputMaxDepth": data.frame.max_depth,
        },
        "solver": {
            "kind": "multiscale-uot-sparse-hierarchical-log",
            "startDepth": config.start_depth,
            "resolvedDepth": config.max_depth,
            "blurCells": config.blur_cells,
            "positionWeight": config.position_weight,
            "normalWeight": config.normal_weight,
            "neighborhoodWeight": config.neighborhood_weight,
            "neighborhoodRadiusCells": config.neighborhood_radius_cells,
            "unmatchedPenaltyCells": config.unmatched_penalty_cells,
            "supportRelative": config.support_relative,
            "haloCells": config.halo_cells,
            "maxPairs": config.max_pairs,
        },
        "levels": levels,
    }
