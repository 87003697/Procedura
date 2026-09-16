#!/usr/bin/env python3
"""Build compact, fixed-frame MultiView direction contexts for validation cases."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from statistics import median
from collections import defaultdict


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ROOT = ROOT / "outputs" / "examples"
VIEWS = {
    "front": (0, 2),
    "side": (1, 2),
    "top": (0, 1),
}
AXES = ("X", "Y", "Z")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def decode_center(prefix: int, depth: int, minimum: list[float], side: float) -> list[float]:
    xyz = [0, 0, 0]
    for shift in range(depth - 1, -1, -1):
        child = (prefix >> (3 * shift)) & 7
        for axis in range(3):
            xyz[axis] = (xyz[axis] << 1) | ((child >> (2 - axis)) & 1)
    cell_size = side / 2**depth
    return [minimum[axis] + (xyz[axis] + 0.5) * cell_size for axis in range(3)]


def weighted_mean(values: list[list[float]], weights: list[float]) -> list[float]:
    total = sum(weights)
    return [sum(value[axis] * weight for value, weight in zip(values, weights)) / total for axis in range(3)]


def weighted_median(values: list[list[float]], weights: list[float]) -> list[float]:
    result: list[float] = []
    for axis in range(3):
        ordered = sorted((value[axis], weight) for value, weight in zip(values, weights))
        halfway = sum(weights) / 2.0
        running = 0.0
        for value, weight in ordered:
            running += weight
            if running >= halfway:
                result.append(value)
                break
    return result


def length(vector: list[float]) -> float:
    return math.sqrt(sum(component * component for component in vector))


def axis_direction(vector: list[float]) -> str:
    active = [
        (abs(value), ("+" if value >= 0 else "-") + AXES[axis])
        for axis, value in enumerate(vector)
        if abs(value) >= 1e-4
    ]
    active.sort(reverse=True)
    return ", ".join(label for _, label in active) if active else "near-zero"


def summarize(rows: list[dict]) -> dict:
    positions = [row["positionMm"] for row in rows]
    displacements = [row["displacementMm"] for row in rows]
    weights = [row["mass"] for row in rows]
    mean_position = weighted_mean(positions, weights)
    mean_displacement = weighted_mean(displacements, weights)
    spatial_spread = math.sqrt(
        sum(weight * length([
            position[axis] - mean_position[axis] for axis in range(3)
        ]) ** 2 for position, weight in zip(positions, weights)) / sum(weights)
    )
    displacement_spread = math.sqrt(
        sum(weight * length([
            displacement[axis] - mean_displacement[axis] for axis in range(3)
        ]) ** 2 for displacement, weight in zip(displacements, weights)) / sum(weights)
    )
    projected = {
        name: [mean_displacement[axes[0]], mean_displacement[axes[1]]]
        for name, axes in VIEWS.items()
    }
    return {
        "cellCount": len(rows),
        "mass": sum(weights),
        "centerMm": mean_position,
        "meanDisplacementMm": mean_displacement,
        "medianDisplacementMm": weighted_median(displacements, weights),
        "direction": axis_direction(mean_displacement),
        "magnitudeMm": length(mean_displacement),
        "spatialSpreadMm": spatial_spread,
        "displacementSpreadMm": displacement_spread,
        "projectedMeanByView": projected,
        "prefixes": [row["prefix"] for row in sorted(rows, key=lambda row: row["prefix"])[:12]],
    }


def region_rows(rows: list[dict]) -> list[tuple[str, list[dict]]]:
    cuts = [median(row["positionMm"][axis] for row in rows) for axis in range(3)]
    regions: dict[str, list[dict]] = {}
    for row in rows:
        key = "".join("1" if row["positionMm"][axis] >= cuts[axis] else "0" for axis in range(3))
        regions.setdefault(key, []).append(row)
    return sorted(regions.items(), key=lambda item: sum(row["mass"] for row in item[1]), reverse=True)


def part_summaries(rows: list[dict]) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        for part in row.get("partWeights", []):
            grouped[part["name"]].append({
                "prefix": row["prefix"],
                "positionMm": row["positionMm"],
                "displacementMm": row["displacementMm"],
                "mass": row["mass"] * float(part["weight"]),
            })
    result = []
    for name, part_rows in grouped.items():
        summary = summarize(part_rows)
        summary["partId"] = name
        summary["correctionProtocol"] = {
            "coordinateFrame": "candidate-to-gt",
            "units": "mapping-frame-mm",
            "vectorMm": summary["meanDisplacementMm"],
            "apply": "add-to-candidate-placement",
        }
        result.append(summary)
    return sorted(result, key=lambda item: item["mass"], reverse=True)


def build_context(case_dir: Path, profile: str) -> dict:
    spec = read_json(case_dir / "spec.json")
    source = read_json(case_dir / "2-input.json")
    report = read_json(case_dir / "reports" / profile / "3-report.json")
    oracle = read_json(case_dir / "oracle.json")
    frame = source["frame"]
    level = next(level for level in report["levels"] if level["summary"]["depth"] == frame["maxDepth"])
    part_by_prefix = {
        int(cell["prefix"]): [
            {"name": part["name"], "weight": float(part["weight"])}
            for part in cell.get("parts", [])
        ]
        for cell in source["candidate"]["cells"]
    }
    rows = []
    for cell in level["candidateCells"]:
        if cell["displacementMm"] is None or cell["mass"] <= 0:
            continue
        part_weights = part_by_prefix.get(int(cell["prefix"]), [])
        if spec["id"] != "snake-arm" and [part["name"] for part in part_weights] == ["snake_arm"]:
            part_weights = []
        rows.append({
            "prefix": int(cell["prefix"]),
            "positionMm": decode_center(cell["prefix"], frame["maxDepth"], frame["minMm"], frame["sideMm"]),
            "displacementMm": [float(value) for value in cell["displacementMm"]],
            "mass": float(cell["mass"]),
            "partWeights": part_weights,
            "partIds": [part["name"] for part in part_weights],
        })
    if not rows:
        raise ValueError(f"{case_dir.name}: report has no mapped cells")

    global_summary = summarize(rows)
    parts = part_summaries(rows)
    regions = []
    for key, grouped in region_rows(rows):
        summary = summarize(grouped)
        summary["regionId"] = f"octant-{key}"
        summary["partIds"] = sorted({part for row in grouped for part in row["partIds"]})
        if spec["id"] != "snake-arm" and summary["partIds"] == ["snake_arm"]:
            summary["partIds"] = []
        regions.append(summary)
    global_magnitude = global_summary["magnitudeMm"]
    region_deviation = max(
        length([region["meanDisplacementMm"][axis] - global_summary["meanDisplacementMm"][axis] for axis in range(3)])
        for region in regions
    )
    if len(regions) == 1 or region_deviation <= max(0.01, global_magnitude * 0.5):
        pattern = "coherent"
    elif any(region["displacementSpreadMm"] > max(0.02, global_magnitude * 1.2) for region in regions):
        pattern = "non-rigid"
    else:
        pattern = "piecewise"
    part_ids = sorted({part for row in rows for part in row["partIds"]})
    if spec["id"] != "snake-arm" and part_ids == ["snake_arm"]:
        part_ids = []
    agent_context = {
        "schemaVersion": 1,
        "example": spec["id"],
        "partIds": part_ids,
        "pattern": pattern,
        "global": global_summary,
        "regions": regions,
        "parts": parts,
    }
    return {
        "schemaVersion": 1,
        "example": spec["id"],
        "description": spec["description"],
        "source": {
            "input": "2-input.json",
            "report": f"reports/{profile}/3-report.json",
            "profile": profile,
        },
        "frame": frame,
        "views": [
            {
                "name": name,
                "planeAxes": [AXES[axes[0]], AXES[axes[1]]],
                "image": f"renders/{profile}/mapping-report-{name}.png",
            }
            for name, axes in VIEWS.items()
        ],
        "partIds": part_ids,
        "cellCount": len(rows),
        "pattern": pattern,
        "global": global_summary,
        "regions": regions,
        "parts": parts,
        "agentContext": agent_context,
        "oracle": oracle,
    }


def write_review(output_root: Path, case_dirs: list[Path]) -> None:
    lines = [
        "# MultiView defect review",
        "",
        "Each row uses the same fixed-frame mapping report. Blue is GT, gray is candidate, and arrows are candidate → GT displacement proxies.",
        "The JSON context beside each case contains the compact direction summary; `oracle.json` records the controlled change used to build the case.",
        "",
    ]
    for case_dir in case_dirs:
        context = read_json(case_dir / "multiview-direction.json")
        lines.extend([
            f"## {context['example']}",
            "",
            f"{context['description']}",
            "",
            f"Pattern: **{context['pattern']}**; mapped cells: **{context['cellCount']}**; dominant direction: **{context['global']['direction']}**.",
            "",
            f"[direction context](./{case_dir.name}/multiview-direction.json) · [oracle](./{case_dir.name}/oracle.json)",
            "",
            " | ".join(f"![{view['name']}]({case_dir.name}/{view['image']})" for view in context["views"]),
            "",
        ])
    (output_root / "multiview-review.md").write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--example", default="snake-arm,vault-city,mechanical-flower")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--profile", default="position")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    case_ids = [item.strip() for item in args.example.split(",") if item.strip()]
    case_dirs = []
    catalog = read_json(Path(__file__).resolve().parents[1] / "examples" / "catalog.json")
    for case_id in case_ids:
        directory = next(item["directory"] for item in catalog["examples"] if item["id"] == case_id)
        case_dir = args.output_root / directory
        if not (case_dir / "reports" / args.profile / "3-report.json").is_file():
            raise SystemExit(f"missing generated case: {case_dir}; build it with examples/build_examples.py first")
        context = build_context(case_dir, args.profile)
        (case_dir / "multiview-direction.json").write_text(json.dumps(context, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        case_dirs.append(case_dir)
        print(case_dir / "multiview-direction.json")
    write_review(args.output_root, case_dirs)
    print(args.output_root / "multiview-review.md")


if __name__ == "__main__":
    main()
