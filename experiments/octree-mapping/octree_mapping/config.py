"""Immutable mapping configuration and named experiment profiles."""

from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class MappingConfig:
    start_depth: int = 3
    max_depth: int = 6
    blur_cells: float = 0.75
    position_weight: float = 1.0
    normal_weight: float = 0.0
    neighborhood_weight: float = 0.0
    neighborhood_radius_cells: int = 1
    unmatched_penalty_cells: float = 8.0
    support_relative: float = 1e-5
    halo_cells: int = 1
    max_pairs: int = 4_000_000
    max_iterations: int = 5_000
    tolerance: float = 1e-7


PROFILE_DEFAULTS = {
    "position": {"position_weight": 1.0, "normal_weight": 0.0, "neighborhood_weight": 0.0, "unmatched_penalty_cells": 8.0},
    "normal": {"position_weight": 1.0, "normal_weight": 1.0, "neighborhood_weight": 0.0, "unmatched_penalty_cells": 8.0},
    "neighborhood": {"position_weight": 1.0, "normal_weight": 1.0, "neighborhood_weight": 1.0, "unmatched_penalty_cells": 8.0},
    "unmatched": {"position_weight": 1.0, "normal_weight": 1.0, "neighborhood_weight": 1.0, "unmatched_penalty_cells": 2.0},
}


def from_profile(name: str, **overrides: object) -> MappingConfig:
    try:
        values = PROFILE_DEFAULTS[name].copy()
    except KeyError as error:
        raise ValueError(f"unknown mapping profile: {name}") from error
    values.update({key: value for key, value in overrides.items() if value is not None})
    return replace(MappingConfig(), **values)
