"""Black-box acceptance scenarios for the installed shadow CLI.

This deliberately uses subprocess execution and observable JSON reports rather
than the repository's unit-test framework.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Callable


SCHEMA = "procedura.octree-mapping-input/2"


def morton(x: int, y: int, z: int, depth: int) -> int:
    value = 0
    for shift in range(depth - 1, -1, -1):
        child = (((x >> shift) & 1) << 2) | (((y >> shift) & 1) << 1) | ((z >> shift) & 1)
        value = (value << 3) | child
    return value


def decode(prefix: int, depth: int) -> tuple[int, int, int]:
    xyz = [0, 0, 0]
    for shift in range(depth - 1, -1, -1):
        child = (prefix >> (3 * shift)) & 7
        xyz[0] = (xyz[0] << 1) | ((child >> 2) & 1)
        xyz[1] = (xyz[1] << 1) | ((child >> 1) & 1)
        xyz[2] = (xyz[2] << 1) | (child & 1)
    return xyz[0], xyz[1], xyz[2]


def document(
    depth: int,
    gt: list[tuple[int, int, int]],
    candidate: list[tuple[int, int, int, str]],
) -> dict:
    return {
        "schema": SCHEMA,
        "frame": {"minMm": [0, 0, 0], "sideMm": float(1 << depth), "maxDepth": depth},
        "gt": {"cells": [
            {"prefix": morton(*xyz, depth), "mass": 1.0, "normal": [0.0, 0.0, 1.0]}
            for xyz in gt
        ]},
        "candidate": {"cells": [
            {
                "prefix": morton(x, y, z, depth),
                "mass": 1.0,
                "normal": [0.0, 0.0, 1.0],
                "parts": [{"name": part, "weight": 1.0}],
            }
            for x, y, z, part in candidate
        ]},
    }


def run_case(
    name: str,
    value: dict,
    depth: int,
    check: Callable[[dict], None],
    arguments: tuple[str, ...] = (),
) -> None:
    with tempfile.TemporaryDirectory(prefix=f"octree-map-{name}-") as directory:
        root = Path(directory)
        input_path = root / "input.json"
        output_path = root / "report.json"
        input_path.write_text(json.dumps(value), encoding="utf-8")
        subprocess.run(
            [
                sys.executable,
                "-m",
                "octree_mapping",
                "--input",
                str(input_path),
                "--output",
                str(output_path),
                "--max-depth",
                str(depth),
                "--unmatched-penalty-cells",
                "8",
            "--blur-cells",
            "0.35",
                "--max-pairs",
                "1000000",
                *arguments,
            ],
            check=True,
        )
        report = json.loads(output_path.read_text(encoding="utf-8"))
        validate_compact_levels(report)
        check(report)
        print(f"PASS {name}")


def run_failure(name: str, value: dict, arguments: list[str], message: str) -> None:
    with tempfile.TemporaryDirectory(prefix=f"octree-map-{name}-") as directory:
        root = Path(directory)
        input_path = root / "input.json"
        output_path = root / "report.json"
        input_path.write_text(json.dumps(value), encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "octree_mapping",
                "--input",
                str(input_path),
                "--output",
                str(output_path),
                *arguments,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        require(result.returncode != 0 and message in result.stderr, f"{name} must fail with {message!r}")
        require(not output_path.exists(), f"{name} must not publish a report")
        print(f"PASS {name}")


def resolved_level(report: dict) -> dict:
    return report["levels"][-1]


def validate_compact_levels(report: dict) -> None:
    summary_keys = {
        "depth", "cellSizeMm", "candidateCellCount", "gtCellCount",
        "candidatePairCount", "supportPairCount", "iterations", "solverError",
    }
    candidate_keys = {
                "prefix", "mass", "displacementMm", "spreadCells",
        "sourceMarginalRatio",
    }
    gt_keys = {"prefix", "mass", "targetMarginalRatio"}
    levels = report["levels"]
    require(
        report["schema"] == "procedura.octree-mapping-report/3",
        "report must publish schema /3",
    )
    require(
        "candidateNodes" not in report and "gtNodes" not in report,
        "schema /3 must not retain final-only verbose node arrays",
    )
    require(
        [level["summary"]["depth"] for level in levels]
        == list(range(report["solver"]["startDepth"], report["solver"]["resolvedDepth"] + 1)),
        "levels must cover every solved depth",
    )
    previous_candidate: set[int] | None = None
    previous_gt: set[int] | None = None
    for level in levels:
        require(
            set(level) == {"summary", "candidateCells", "gtCells"},
            "level wrapper fields must match the compact contract",
        )
        summary = level["summary"]
        candidate = level["candidateCells"]
        gt = level["gtCells"]
        require(set(summary) == summary_keys, "level summary fields must match the compact contract")
        require(
            all(set(cell) == candidate_keys for cell in candidate),
            "candidate cell fields must match the compact contract",
        )
        require(
            all(set(cell) == gt_keys for cell in gt),
            "GT cell fields must match the compact contract",
        )
        require(
            len(candidate) == summary["candidateCellCount"]
            and len(gt) == summary["gtCellCount"],
            "compact cell arrays must match their summary counts",
        )
        require(
            all(
                cell["displacementMm"] is None or len(cell["displacementMm"]) == 3
                for cell in candidate
            ),
            "displacementMm must remain a three-component millimetre vector",
        )
        candidate_prefixes = {cell["prefix"] for cell in candidate}
        gt_prefixes = {cell["prefix"] for cell in gt}
        if previous_candidate is not None:
            require(
                all(prefix >> 3 in previous_candidate for prefix in candidate_prefixes)
                and all(prefix >> 3 in previous_gt for prefix in gt_prefixes),
                "fine prefixes must have derivable parents at the previous depth",
            )
        previous_candidate = candidate_prefixes
        previous_gt = gt_prefixes


def axis_values(level: dict, axis: int) -> list[float]:
    nodes = [node for node in level["candidateCells"] if node["displacementMm"] is not None]
    return [node["displacementMm"][axis] for node in nodes]


def grid_center(report: dict, level: dict, prefix: int) -> list[float]:
    depth = level["summary"]["depth"]
    cell_size = level["summary"]["cellSizeMm"]
    xyz = decode(prefix, depth)
    return [
        report["frame"]["minMm"][axis] + (xyz[axis] + 0.5) * cell_size
        for axis in range(3)
    ]


def displacement(report: dict, prefix: int) -> list[float]:
    return next(
        node["displacementMm"]
        for node in resolved_level(report)["candidateCells"]
        if node["prefix"] == prefix
    )


def max_displacement(report: dict) -> float:
    return max(
        sum(component * component for component in node["displacementMm"]) ** 0.5
        for node in resolved_level(report)["candidateCells"]
        if node["displacementMm"] is not None
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    identical = [(x, y, 4) for x in range(5, 8) for y in range(5, 8)]
    run_case(
        "identity",
        document(4, identical, [(x, y, z, "block") for x, y, z in identical]),
        4,
        lambda report: require(
            max_displacement(report) < 0.1,
            "identity must resolve every node to zero displacement",
        ),
    )

    translated_gt = [(x, 8 + (x % 3), 8) for x in (6, 9, 12, 15)]
    translated_candidate = [(x + 1, y, z, "panel") for x, y, z in translated_gt]
    run_case(
        "translated-pattern",
        document(5, translated_gt, translated_candidate),
        5,
        lambda report: require(
            all(abs(value + 1.0) < 0.35 for value in axis_values(resolved_level(report), 0)),
            "translated pattern must map one cell back",
        ),
    )

    translated_cube = [(8, 16, 16)]
    run_case(
        "multidepth-mm-displacement",
        document(
            6,
            translated_cube,
            [(x + 8, y, z, "translated_cube") for x, y, z in translated_cube],
        ),
        6,
        lambda report: require(
            all(
                all(
                    abs(value + 8.0) <= level["summary"]["cellSizeMm"] / 2.0 + 1e-9
                    for value in axis_values(level, 0)
                )
                for level in report["levels"]
            ),
            "the same translation must remain comparable in millimetres at every depth",
        ),
    )

    def grid_center_reconstruction(report: dict) -> None:
        expected_barycenter = [5.5, 1.5, 1.5]
        for level in report["levels"]:
            cell = level["candidateCells"][0]
            center = grid_center(report, level, cell["prefix"])
            reconstructed = [
                center[axis] + cell["displacementMm"][axis]
                for axis in range(3)
            ]
            require(
                all(
                    abs(reconstructed[axis] - expected_barycenter[axis]) < 1e-9
                    for axis in range(3)
                ),
                "grid center plus displacement must reconstruct the GT barycenter",
            )

    run_case(
        "grid-center-reconstruction",
        document(4, [(5, 1, 1)], [(1, 1, 1, "partial_cell")]),
        4,
        grid_center_reconstruction,
    )

    leg_shape = [(0, y, z) for y in range(10, 13) for z in range(3, 12)]
    gt_legs = [(9 + x, y, z) for x, y, z in leg_shape] + [(22 + x, y, z) for x, y, z in leg_shape]
    candidate_legs = (
        [(8 + x, y, z, "left_leg") for x, y, z in leg_shape]
        + [(23 + x, y, z, "right_leg") for x, y, z in leg_shape]
    )
    run_case(
        "wide-legs",
        document(5, gt_legs, candidate_legs),
        5,
        lambda report: require(
            all(
                cell["displacementMm"][0] > 0.5
                for cell in resolved_level(report)["candidateCells"]
                if decode(cell["prefix"], 5)[0] < 16
            )
            and all(
                cell["displacementMm"][0] < -0.5
                for cell in resolved_level(report)["candidateCells"]
                if decode(cell["prefix"], 5)[0] >= 16
            ),
            "wide legs must receive opposed inward motion",
        ),
    )

    body = [(x, y, 8) for x in range(12, 16) for y in range(12, 16)]
    armour = [(x, 24, z) for x in range(12, 16) for z in range(12, 16)]

    def missing_armour(report: dict) -> None:
        ratios = {
            node["prefix"]: node["targetMarginalRatio"]
            for node in resolved_level(report)["gtCells"]
        }
        body_ratio = sum(ratios[morton(*xyz, 5)] for xyz in body) / len(body)
        armour_ratio = sum(ratios[morton(*xyz, 5)] for xyz in armour) / len(armour)
        require(armour_ratio < body_ratio * 0.5, "missing armour must retain lower GT support than the body")

    run_case(
        "missing-armour",
        document(5, body + armour, [(x, y, z, "torso") for x, y, z in body]),
        5,
        missing_armour,
    )

    island = [(27, y, z, "island") for y in range(24, 27) for z in range(24, 27)]

    def extra_island(report: dict) -> None:
        cells = resolved_level(report)["candidateCells"]
        torso_cells = [cell for cell in cells if decode(cell["prefix"], 5)[0] < 20]
        island_cells = [cell for cell in cells if decode(cell["prefix"], 5)[0] >= 20]
        require(
            island_cells and torso_cells
            and max(cell["sourceMarginalRatio"] for cell in island_cells)
            < 0.5 * min(cell["sourceMarginalRatio"] for cell in torso_cells),
            "each extra-island cell must retain lower support than each torso cell",
        )

    run_case(
        "extra-island",
        document(5, body, [(x, y, z, "torso") for x, y, z in body] + island),
        5,
        extra_island,
    )

    boundary_gt = (
        [(15, y, 6) for y in range(8, 12)]
        + [(19, y, 6) for y in range(8, 12)]
    )
    boundary_candidate = (
        [(16, y, 6, "bar") for y in range(8, 12)]
        + [(19, y, 6, "bar") for y in range(8, 12)]
    )

    def coarse_recovery(report: dict) -> None:
        crossed = displacement(report, morton(16, 8, 6, 5))[0]
        stationary = displacement(report, morton(19, 8, 6, 5))[0]
        require(
            crossed < -0.5 and abs(stationary) < 0.35,
            "fine level must split an ambiguous coarse aggregate across the boundary",
        )

    run_case(
        "coarse-recovery",
        document(5, boundary_gt, boundary_candidate),
        5,
        coarse_recovery,
    )

    mixed_gt = [(x - 1, y, z) for x, y, z in [(16, 8, 8), (17, 8, 8), (16, 10, 8)]]
    mixed = document(
        5,
        mixed_gt,
        [(16, 8, 8, "left_panel"), (17, 8, 8, "right_panel"), (16, 10, 8, "left_panel")],
    )
    mixed["candidate"]["cells"][0]["parts"] = [
        {"name": "left_panel", "weight": 0.5},
        {"name": "right_panel", "weight": 0.5},
    ]

    def mixed_provenance(report: dict) -> None:
        cells = resolved_level(report)["candidateCells"]
        require(
            all(cell["displacementMm"][0] < -0.5 for cell in cells),
            "cell-level displacement must remain available without part-level fitting",
        )

    run_case("mixed-provenance", mixed, 4, mixed_provenance)

    depth8_gt = [(120, 120, 120), (121, 120, 120), (120, 121, 120)]
    run_case(
        "bounded-depth-8",
        document(8, depth8_gt, [(x + 1, y, z, "fine") for x, y, z in depth8_gt]),
        8,
        lambda report: require(
            report["solver"]["resolvedDepth"] == 8
            and all(value < -0.5 for value in axis_values(resolved_level(report), 0)),
            "bounded case must resolve at depth 8",
        ),
    )

    normal_case = document(
        4,
        [(6, 8, 8), (10, 8, 8)],
        [(8, 7, 8, "normal_probe"), (8, 9, 8, "normal_probe")],
    )
    normal_case["gt"]["cells"][0]["normal"] = [-1.0, 0.0, 0.0]
    normal_case["gt"]["cells"][1]["normal"] = [1.0, 0.0, 0.0]
    normal_case["candidate"]["cells"][0]["normal"] = [1.0, 0.0, 0.0]
    normal_case["candidate"]["cells"][1]["normal"] = [-1.0, 0.0, 0.0]
    run_case(
        "normal-disambiguation",
        normal_case,
        4,
        lambda report: (
            require(
                displacement(report, morton(8, 7, 8, 4))[0] > 0.5,
                "matching +X normal must resolve an equal-position choice",
            ),
            require(
                displacement(report, morton(8, 9, 8, 4))[0] < -0.5,
                "matching -X normal must resolve the reciprocal equal-position choice",
            ),
        ),
        ("--normal-weight", "1"),
    )

    neighborhood_case = document(
        4,
        [(8, 6, 8), (9, 6, 8), (8, 10, 8), (7, 10, 8)],
        [
            (6, 8, 8, "neighborhood_probe"),
            (7, 8, 8, "neighborhood_probe"),
            (10, 8, 8, "neighborhood_probe"),
            (9, 8, 8, "neighborhood_probe"),
        ],
    )
    run_case(
        "neighborhood-disambiguation",
        neighborhood_case,
        4,
        lambda report: require(
            displacement(report, morton(6, 8, 8, 4))[1] > 0.5
            and displacement(report, morton(10, 8, 8, 4))[1] < -0.5,
            "reciprocal occupancy stencils must retain mirrored cell displacement",
        ),
        ("--neighborhood-weight", "8"),
    )

    invalid = document(4, identical, [(x, y, z, "block") for x, y, z in identical])
    invalid["candidate"]["cells"][0]["parts"][0]["weight"] = 0.5
    run_failure("invalid-contract", invalid, ["--max-depth", "4"], "part weights must sum to one")
    run_failure(
        "candidate-pair-limit",
        document(4, identical, [(x, y, z, "block") for x, y, z in identical]),
        ["--max-depth", "4", "--max-pairs", "2"],
        "exceeding maxPairs=2",
    )


if __name__ == "__main__":
    main()
