"""Unbalanced transport scale calculations."""

from __future__ import annotations


def scales(depth: int, max_depth: int, blur_cells: float, unmatched_penalty_cells: float) -> tuple[float, float]:
    scale_to_finest = 1 << (max_depth - depth)
    return blur_cells ** 2, (unmatched_penalty_cells / scale_to_finest) ** 2
