#!/usr/bin/env python3
"""Archived prototype for turning a legacy MultiView summary into a correction packet."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--part", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--mapping-mm-per-source-unit",
        type=float,
        help="explicit conversion from source placement units to mapping-frame mm",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    context = json.loads(args.context.read_text(encoding="utf-8"))
    parts = context.get("parts")
    if not isinstance(parts, list):
        raise SystemExit("context has no per-part summaries")
    part = next((item for item in parts if item.get("partId") == args.part), None)
    if not isinstance(part, dict):
        raise SystemExit(f"part not found: {args.part}")
    protocol = part.get("correctionProtocol")
    if not isinstance(protocol, dict) or protocol.get("coordinateFrame") != "candidate-to-gt":
        raise SystemExit("part has no candidate-to-GT correction protocol")
    vector = protocol.get("vectorMm")
    if not isinstance(vector, list) or len(vector) != 3 or any(not isinstance(value, (int, float)) for value in vector):
        raise SystemExit("correction vector must contain three numbers")
    packet: dict[str, object] = {
        "schemaVersion": 1,
        "partId": args.part,
        "coordinateFrame": "candidate-to-gt",
        "mappingUnits": "mm",
        "correctionVectorMm": [float(value) for value in vector],
        "apply": "add-to-candidate-placement",
        "sourceDelta": None,
    }
    if args.mapping_mm_per_source_unit is not None:
        if args.mapping_mm_per_source_unit <= 0:
            raise SystemExit("mapping-mm-per-source-unit must be positive")
        packet["sourceUnits"] = "placement-units"
        packet["mappingMmPerSourceUnit"] = args.mapping_mm_per_source_unit
        packet["sourceDelta"] = [float(value) / args.mapping_mm_per_source_unit for value in vector]
    args.output.write_text(json.dumps(packet, indent=2) + "\n", encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()
