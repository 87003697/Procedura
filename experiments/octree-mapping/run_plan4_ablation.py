"""Run the frozen Plan 4 geometric-signal ablation and summarize private reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

PROFILES = (
    ("position", 1.0, 0.0, 0.0, 8.0),
    ("normal", 1.0, 1.0, 0.0, 8.0),
    ("neighborhood", 1.0, 1.0, 1.0, 8.0),
    ("unmatched", 1.0, 1.0, 1.0, 2.0),
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Run frozen Plan 4 mapping ablation")
    result.add_argument("--input", required=True)
    result.add_argument("--output-dir", required=True)
    result.add_argument("--summary", required=True)
    return result


def resolved_level(report: dict) -> dict:
    return report["levels"][-1]


def summarize(report: dict) -> dict:
    level = resolved_level(report)
    candidate_ratios = [node["sourceMarginalRatio"] for node in level["candidateCells"]]
    gt_ratios = [node["targetMarginalRatio"] for node in level["gtCells"]]
    return {
        "solver": report["solver"],
        "levels": report["levels"],
        "runtime": report["runtime"],
        "marginalRanges": {
            "candidate": [min(candidate_ratios), max(candidate_ratios)],
            "gt": [min(gt_ratios), max(gt_ratios)],
        },
    }


def main() -> None:
    args = parser().parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    profiles = {}
    for name, position, normal, neighborhood, unmatched in PROFILES:
        report_path = output_dir / f"{name}.json"
        subprocess.run(
            [
                sys.executable, "-m", "octree_mapping",
                "--input", args.input,
                "--output", str(report_path),
                "--position-weight", str(position),
                "--normal-weight", str(normal),
                "--neighborhood-weight", str(neighborhood),
                "--neighborhood-radius-cells", "1",
                "--unmatched-penalty-cells", str(unmatched),
            ],
            check=True,
        )
        report = json.loads(report_path.read_text(encoding="utf-8"))
        profiles[name] = {"privateReport": str(report_path.resolve()), **summarize(report)}
    result = {
        "schema": "procedura.octree-mapping-plan4-ablation/2",
        "privateInput": str(Path(args.input).resolve()),
        "profiles": profiles,
        "classification": "not_recomputed_without_target_coupling",
    }
    Path(args.summary).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
