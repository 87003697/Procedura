"""Closed input contract for the shadow mapping experiment."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Any


SCHEMA = "procedura.octree-mapping-input/2"


@dataclass(frozen=True)
class Frame:
    min_mm: tuple[float, float, float]
    side_mm: float
    max_depth: int


@dataclass(frozen=True)
class PartWeight:
    name: str
    weight: float


@dataclass(frozen=True)
class Cell:
    prefix: int
    mass: float
    normal: tuple[float, float, float]
    parts: tuple[PartWeight, ...] = ()


@dataclass(frozen=True)
class MappingInput:
    frame: Frame
    gt: tuple[Cell, ...]
    candidate: tuple[Cell, ...]


def _object(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{label} must contain exactly {sorted(keys)}")
    return value


def _finite(value: Any, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    number = float(value)
    if not math.isfinite(number) or (positive and number <= 0):
        raise ValueError(f"{label} must be {'positive and ' if positive else ''}finite")
    return number


def _frame(value: Any) -> Frame:
    item = _object(value, {"minMm", "sideMm", "maxDepth"}, "frame")
    minimum = item["minMm"]
    if not isinstance(minimum, list) or len(minimum) != 3:
        raise ValueError("frame.minMm must contain three numbers")
    max_depth = item["maxDepth"]
    if isinstance(max_depth, bool) or not isinstance(max_depth, int) or not 4 <= max_depth <= 8:
        raise ValueError("frame.maxDepth must be an integer in 4..8")
    return Frame(
        tuple(_finite(v, "frame.minMm") for v in minimum),
        _finite(item["sideMm"], "frame.sideMm", positive=True),
        max_depth,
    )


def _parse_cell_geometry(item: dict[str, Any], label: str) -> tuple[float, tuple[float, float, float]]:
    raw_normal = item["normal"]
    if not isinstance(raw_normal, list) or len(raw_normal) != 3:
        raise ValueError(f"{label}.normal must contain three numbers")
    normal = tuple(_finite(component, "cell normal") for component in raw_normal)
    if sum(component * component for component in normal) > 1.000001:
        raise ValueError(f"{label}.normal magnitude must not exceed one")
    return _finite(item["mass"], "cell mass", positive=True), normal


def _parse_parts(value: Any, label: str) -> tuple[PartWeight, ...]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{label}.parts must be non-empty")
    parsed: list[PartWeight] = []
    part_names: set[str] = set()
    for part_index, raw_part in enumerate(value):
        part = _object(raw_part, {"name", "weight"}, f"{label}.parts[{part_index}]")
        name = part["name"]
        if not isinstance(name, str) or not name or name in part_names:
            raise ValueError(f"{label} has invalid or duplicate part name")
        part_names.add(name)
        parsed.append(PartWeight(name, _finite(part["weight"], "part weight", positive=True)))
    total = sum(part.weight for part in parsed)
    if not math.isclose(total, 1.0, rel_tol=0.0, abs_tol=1e-9):
        raise ValueError(f"{label} part weights must sum to one")
    return tuple(parsed)


def _cells(value: Any, frame: Frame, *, candidate: bool) -> tuple[Cell, ...]:
    label = "candidate.cells" if candidate else "gt.cells"
    if not isinstance(value, list) or not value:
        raise ValueError(f"{label} must be a non-empty array")
    limit = 1 << (3 * frame.max_depth)
    cells: list[Cell] = []
    seen: set[int] = set()
    keys = {"prefix", "mass", "normal", "parts"} if candidate else {"prefix", "mass", "normal"}
    for index, raw in enumerate(value):
        item = _object(raw, keys, f"{label}[{index}]")
        item_label = f"{label}[{index}]"
        prefix = item["prefix"]
        if isinstance(prefix, bool) or not isinstance(prefix, int) or not 0 <= prefix < limit:
            raise ValueError(f"{label}[{index}].prefix is outside maxDepth")
        if prefix in seen:
            raise ValueError(f"{label} contains duplicate prefix {prefix}")
        seen.add(prefix)
        mass, normal = _parse_cell_geometry(item, item_label)
        parts = _parse_parts(item["parts"], item_label) if candidate else ()
        cells.append(Cell(prefix, mass, normal, parts))
    return tuple(sorted(cells, key=lambda cell: cell.prefix))


def parse_mapping_input(value: Any) -> MappingInput:
    root = _object(value, {"schema", "frame", "gt", "candidate"}, "input")
    if root["schema"] != SCHEMA:
        raise ValueError(f"input.schema must be {SCHEMA}")
    frame = _frame(root["frame"])
    gt = _object(root["gt"], {"cells"}, "gt")
    candidate = _object(root["candidate"], {"cells"}, "candidate")
    return MappingInput(
        frame,
        _cells(gt["cells"], frame, candidate=False),
        _cells(candidate["cells"], frame, candidate=True),
    )


def load_mapping_input(path: str | Path) -> MappingInput:
    return parse_mapping_input(json.loads(Path(path).read_text(encoding="utf-8")))
