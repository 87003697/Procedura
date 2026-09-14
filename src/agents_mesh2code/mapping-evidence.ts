import type { JsonObject } from "@harness/template/types";
import { emptyMappingArrowSummary, summarizeMappingArrows } from "./mapping-arrow-summary.ts";

const MAX_EVIDENCE_PER_PART = 8;
const MAX_LOCAL_CELLS = 256;
const MAX_NEIGHBOR_PARTS = 8;
const DEFAULT_INSPECT_DEPTH_DELTA = 2;

interface CandidateEvidence {
  direction: string;
  magnitude: number;
  value: JsonObject;
}

export interface MappingEvidence {
  partIds: Set<string>;
  evidenceOwners: Map<string, string>;
  initialEvidenceIds: Set<string>;
  exposedEvidenceIds: Set<string>;
  parts: JsonObject[];
  cellsByPart: Map<string, JsonObject[]>;
}

function direction(values: number[]): string {
  return values.map((value) => value > 0 ? "+" : value < 0 ? "-" : "0").join(",");
}

function magnitude(values: number[]): number {
  return Math.hypot(...values);
}

function uniqueCells(evidence: MappingEvidence): JsonObject[] {
  return [...new Set([...evidence.cellsByPart.values()].flat())];
}

function parentPrefix(prefix: number, fromDepth: number, targetDepth: number): number {
  return prefix >> (3 * Math.max(0, fromDepth - targetDepth));
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function cellEvidence(partId: string, cell: JsonObject): JsonObject | undefined {
  if (!validVector(cell.displacementMm)) return undefined;
  return {
    id: `${partId}:${cell.depth}:${cell.prefix}`,
    locationMm: cell.locationMm ?? null,
    displacementMm: cell.displacementMm,
  };
}

function selectEvidence(partId: string, cells: JsonObject[]): CandidateEvidence[] {
  const byDirection = new Map<string, CandidateEvidence>();
  for (const cell of cells) {
    const displacement = cell.displacementMm;
    if (!validVector(displacement)) continue;
    const candidate: CandidateEvidence = {
      direction: direction(displacement),
      magnitude: magnitude(displacement),
      value: {
        id: `${partId}:${cell.depth}:${cell.prefix}`,
        locationMm: cell.locationMm ?? null,
        displacementMm: displacement,
      },
    };
    const previous = byDirection.get(candidate.direction);
    if (!previous || candidate.magnitude > previous.magnitude) {
      byDirection.set(candidate.direction, candidate);
    }
  }
  return [...byDirection.values()]
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, MAX_EVIDENCE_PER_PART);
}

export function buildMappingEvidence(cells: JsonObject[]): MappingEvidence {
  const cellsByPart = new Map<string, JsonObject[]>();
  for (const cell of cells) {
    for (const part of cell.parts as JsonObject[]) {
      const partId = part.name as string;
      cellsByPart.set(partId, [...(cellsByPart.get(partId) ?? []), cell]);
    }
  }

  const evidenceOwners = new Map<string, string>();
  const initialEvidenceIds = new Set<string>();
  const parts = [...cellsByPart].map(([partId, partCells]) => {
    const evidence = selectEvidence(partId, partCells).map((candidate) => candidate.value);
    for (const item of evidence) initialEvidenceIds.add(String(item.id));
    return { partId, evidence } as JsonObject;
  });
  for (const [partId, partCells] of cellsByPart) {
    for (const cell of partCells) evidenceOwners.set(`${partId}:${cell.depth}:${cell.prefix}`, partId);
  }
  return {
    partIds: new Set(cellsByPart.keys()),
    evidenceOwners,
    initialEvidenceIds,
    exposedEvidenceIds: new Set(initialEvidenceIds),
    parts,
    cellsByPart,
  };
}

export function resetMappingEvidenceExposure(evidence: MappingEvidence): void {
  evidence.exposedEvidenceIds.clear();
  for (const evidenceId of evidence.initialEvidenceIds) evidence.exposedEvidenceIds.add(evidenceId);
}

export function inspectMappingPart(evidence: MappingEvidence, partId: string, focusEvidenceId: string | undefined, limit: number, radiusMm?: number, depth?: number): JsonObject {
  if (!evidence.partIds.has(partId)) throw Error(`unknown mapping part: ${partId}`);
  const cells = evidence.cellsByPart.get(partId) ?? [];
  if (focusEvidenceId !== undefined && !evidence.exposedEvidenceIds.has(focusEvidenceId)) throw Error(`unknown mapping evidence: ${focusEvidenceId}`);
  const focus = focusEvidenceId === undefined
    ? cells.find((cell) => validVector(cell.displacementMm))
    : cells.find((cell) => `${partId}:${cell.depth}:${cell.prefix}` === focusEvidenceId);
  if (focusEvidenceId !== undefined && !focus) throw Error(`unknown mapping evidence: ${focusEvidenceId}`);
  const focusLocation = Array.isArray(focus?.locationMm) ? focus.locationMm as number[] : undefined;
  const maxDepth = cells.reduce((depth, cell) => Math.max(depth, Number(cell.depth)), 0);
  const inspectDepth = focus && depth !== undefined ? Math.min(depth, maxDepth) : focus && radiusMm === undefined && maxDepth > DEFAULT_INSPECT_DEPTH_DELTA ? maxDepth - DEFAULT_INSPECT_DEPTH_DELTA : maxDepth;
  if (focus && inspectDepth < maxDepth) {
    const key = parentPrefix(Number(focus.prefix), maxDepth, inspectDepth);
    const nodeCells = uniqueCells(evidence).filter((cell) => Number(cell.depth) === maxDepth && parentPrefix(Number(cell.prefix), maxDepth, inspectDepth) === key);
    const partCells = nodeCells.filter((cell) => (cell.parts as JsonObject[]).some((part) => part.name === partId));
    const boundedPartCells = partCells.slice(0, MAX_LOCAL_CELLS);
    const nodeIds = boundedPartCells.map((cell) => `${partId}:${cell.depth}:${cell.prefix}`);
    for (const id of nodeIds) evidence.exposedEvidenceIds.add(id);
    const parentSummary = summarizeMappingArrows(partId, boundedPartCells, evidence, nodeIds) ?? emptyMappingArrowSummary(partId, nodeIds);
    const childGroups = new Map<number, JsonObject[]>();
    for (const cell of boundedPartCells) {
      const child = Number(cell.prefix) >> (3 * Math.max(0, maxDepth - (inspectDepth + 1)));
      childGroups.set(child, [...(childGroups.get(child) ?? []), cell]);
    }
    const children = [...childGroups.entries()].slice(0, MAX_LOCAL_CELLS).map(([childPrefix, childCells]) => {
      const ids = childCells.map((cell) => `${partId}:${cell.depth}:${cell.prefix}`);
      return summarizeMappingArrows(partId, childCells, evidence, ids) ?? emptyMappingArrowSummary(partId, ids);
    });
    return { partId, depth: inspectDepth, focus: { evidenceId: focusEvidenceId ?? null, locationMm: focusLocation ?? null, radiusMm: null }, parentSummary, localSummary: parentSummary, children, neighborParts: [], evidence: partCells.slice(0, limit).map((cell) => cellEvidence(partId, cell)).filter((item): item is JsonObject => item !== undefined) } as JsonObject;
  }
  const ranked = cells.map((cell) => {
    const item = cellEvidence(partId, cell);
    if (!item) return undefined;
    const location = Array.isArray(item.locationMm) ? item.locationMm as number[] : undefined;
    const distance = focusLocation && location ? Math.hypot(location[0]! - focusLocation[0]!, location[1]! - focusLocation[1]!, location[2]! - focusLocation[2]!) : 0;
    return { cell, item, distance, magnitude: magnitude(item.displacementMm as number[]) };
  }).filter((item): item is { cell: JsonObject; item: JsonObject; distance: number; magnitude: number } => item !== undefined)
    .filter((item) => radiusMm === undefined || !focusLocation || item.distance <= radiusMm)
    .sort((a, b) => focusLocation ? a.distance - b.distance : b.magnitude - a.magnitude);
  const localCells = ranked.slice(0, MAX_LOCAL_CELLS).map(({ cell }) => cell);
  const selected = ranked.slice(0, limit);
  const selectedEvidence = selected.map(({ item }) => item);
  const localIds = localCells.map((cell) => `${partId}:${cell.depth}:${cell.prefix}`);
  for (const id of localIds) evidence.exposedEvidenceIds.add(id);
  const localSummary = summarizeMappingArrows(partId, localCells, evidence, localIds) ?? emptyMappingArrowSummary(partId, localIds);
  const neighborParts = [...new Set(localCells.flatMap((cell) => (cell.parts as JsonObject[]).map((part) => String(part.name)).filter((name) => name !== partId)))].slice(0, MAX_NEIGHBOR_PARTS).map((neighbor) => {
    const neighborCells = localCells.filter((cell) => (cell.parts as JsonObject[]).some((part) => part.name === neighbor));
    const neighborIds = neighborCells.map((cell) => `${neighbor}:${cell.depth}:${cell.prefix}`);
    for (const id of neighborIds) evidence.exposedEvidenceIds.add(id);
    return summarizeMappingArrows(neighbor, neighborCells, evidence, neighborIds);
  }).filter((summary): summary is JsonObject => summary !== undefined);
  return { partId, depth: selected[0]?.cell.depth ?? null, focus: { evidenceId: focusEvidenceId ?? null, locationMm: focusLocation ?? null, radiusMm: radiusMm ?? null }, localSummary, neighborParts, evidence: selectedEvidence } as JsonObject;
}
