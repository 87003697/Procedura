"""Normalized geometric matching cost components."""

from __future__ import annotations

import numpy as np


def position_cost(source: np.ndarray, target: np.ndarray, rows: np.ndarray, columns: np.ndarray, cell_side: float) -> np.ndarray:
    return np.sum(((source[rows] - target[columns]) / cell_side) ** 2, axis=1)


def normal_cost(source: np.ndarray, target: np.ndarray, rows: np.ndarray, columns: np.ndarray) -> np.ndarray:
    return np.sum((source[rows] - target[columns]) ** 2, axis=1) / 4.0


def neighborhood_cost(source: np.ndarray, target: np.ndarray, rows: np.ndarray, columns: np.ndarray) -> np.ndarray:
    difference = np.zeros(len(rows), dtype=np.float64)
    for index in range(source.shape[1]):
        difference += source[rows, index] != target[columns, index]
    return difference / source.shape[1]
