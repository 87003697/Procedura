import type { JsonObject } from "@harness/template/types";
import type { MappingEvidence } from "./mapping-evidence.ts";

type Arrow = { cell: JsonObject; displacement: number[]; weight: number };

function asVector(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? value as number[]
    : undefined;
}

function length(values: number[]): number { return Math.hypot(...values); }

export function emptyMappingArrowSummary(partId: string, evidenceIds: string[] = []): JsonObject {
  return { partId, evidenceIds, cellCount: 0, meanDisplacementMm: [0, 0, 0], meanMagnitudeMm: 0, directionCoherence: 0 };
}

export function summarizeMappingArrows(partId: string, cells: JsonObject[], evidence: MappingEvidence, evidenceIds?: string[]): JsonObject | undefined {
  const arrows: Arrow[] = cells.flatMap((cell) => {
    const displacement = asVector(cell.displacementMm);
    const part = (cell.parts as JsonObject[]).find((item) => item.name === partId);
    if (!displacement || !part) return [];
    const mass = typeof cell.mass === "number" ? Math.max(0, cell.mass) : 1;
    const ratio = typeof cell.sourceMarginalRatio === "number" ? Math.max(0, cell.sourceMarginalRatio) : 1;
    const partWeight = typeof part.weight === "number" ? Math.max(0, part.weight) : 1;
    return [{ cell, displacement, weight: Math.max(1e-9, mass * ratio * partWeight) }];
  });
  if (arrows.length === 0) return undefined;
  const totalWeight = arrows.reduce((sum, arrow) => sum + arrow.weight, 0);
  const meanDisplacementMm = [0, 1, 2].map((axis) => arrows.reduce((sum, arrow) => sum + arrow.weight * arrow.displacement[axis]!, 0) / totalWeight);
  const meanMagnitudeMm = arrows.reduce((sum, arrow) => sum + arrow.weight * length(arrow.displacement), 0) / totalWeight;
  const unit = [0, 1, 2].map((axis) => arrows.reduce((sum, arrow) => {
    const magnitude = length(arrow.displacement);
    return sum + (magnitude === 0 ? 0 : arrow.weight * arrow.displacement[axis]! / magnitude);
  }, 0));
  const defaultEvidenceIds = (evidence.parts.find((part) => part.partId === partId)?.evidence as JsonObject[] ?? []).map((item) => String(item.id));
  return {
    partId,
    evidenceIds: evidenceIds ?? defaultEvidenceIds,
    cellCount: arrows.length,
    meanDisplacementMm,
    meanMagnitudeMm,
    directionCoherence: length(unit) / totalWeight,
  };
}
