"""Command line seam for the removable shadow experiment."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import resource
import time

from .contract import load_mapping_input
from .config import from_profile
from .mapping import map_octrees


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Map private occupied octrees with multiscale UOT")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--profile", choices=("position", "normal", "neighborhood", "unmatched"), default="position")
    parser.add_argument("--start-depth", type=int, default=3)
    parser.add_argument("--max-depth", type=int)
    parser.add_argument("--blur-cells", type=float, default=0.75)
    parser.add_argument("--position-weight", type=float)
    parser.add_argument("--normal-weight", type=float)
    parser.add_argument("--neighborhood-weight", type=float)
    parser.add_argument("--neighborhood-radius-cells", type=int)
    parser.add_argument("--unmatched-penalty-cells", type=float)
    parser.add_argument("--support-relative", type=float)
    parser.add_argument("--halo-cells", type=int)
    parser.add_argument("--max-pairs", type=int)
    parser.add_argument("--max-iterations", type=int)
    parser.add_argument("--tolerance", type=float)
    return parser


def main() -> None:
    args = _parser().parse_args()
    started = time.perf_counter()
    data = load_mapping_input(args.input)
    config = from_profile(
        args.profile,
        start_depth=args.start_depth,
        max_depth=args.max_depth if args.max_depth is not None else min(6, data.frame.max_depth),
        blur_cells=args.blur_cells,
        position_weight=args.position_weight,
        normal_weight=args.normal_weight,
        neighborhood_weight=args.neighborhood_weight,
        neighborhood_radius_cells=args.neighborhood_radius_cells,
        unmatched_penalty_cells=args.unmatched_penalty_cells,
        support_relative=args.support_relative,
        halo_cells=args.halo_cells,
        max_pairs=args.max_pairs,
        max_iterations=args.max_iterations,
        tolerance=args.tolerance,
    )
    report = map_octrees(data, config)
    report["runtime"] = {
        "elapsedSeconds": time.perf_counter() - started,
        "peakRssBytes": int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss),
    }
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
