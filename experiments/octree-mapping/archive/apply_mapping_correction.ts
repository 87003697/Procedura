/** Apply a validated mapping correction around an existing assembly placement. */

import { readFile, writeFile } from "node:fs/promises";
import { nudgeAssemblyPlacements } from "../../../src/scad/parts.ts";

interface CorrectionPacket {
  schemaVersion: 1;
  partId: string;
  coordinateFrame: "candidate-to-gt";
  mappingUnits: "mm";
  apply: "add-to-candidate-placement";
  sourceUnits: "placement-units";
  mappingMmPerSourceUnit: number;
  sourceDelta: number[] | null;
}

const [packetPath, scadPath, outputPath] = process.argv.slice(2);
if (!packetPath || !scadPath || !outputPath) {
  throw new Error("usage: bun experiments/octree-mapping/archive/apply_mapping_correction.ts <packet.json> <input.scad> <output.scad>");
}

const packet = JSON.parse(await readFile(packetPath, "utf8")) as Partial<CorrectionPacket>;
if (
  packet.schemaVersion !== 1 ||
  typeof packet.partId !== "string" ||
  !packet.partId ||
  packet.coordinateFrame !== "candidate-to-gt" ||
  packet.mappingUnits !== "mm" ||
  packet.apply !== "add-to-candidate-placement" ||
  packet.sourceUnits !== "placement-units" ||
  typeof packet.mappingMmPerSourceUnit !== "number" ||
  !Number.isFinite(packet.mappingMmPerSourceUnit) ||
  packet.mappingMmPerSourceUnit <= 0 ||
  !Array.isArray(packet.sourceDelta) ||
  packet.sourceDelta.length !== 3
) {
  throw new Error("correction packet needs schemaVersion 1, partId, candidate-to-gt/mm units, source-unit scale, apply directive, and sourceDelta");
}
if (packet.sourceDelta.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
  throw new Error("correction packet sourceDelta must contain three finite numbers");
}

const scad = await readFile(scadPath, "utf8");
const result = nudgeAssemblyPlacements(
  scad,
  new Set([packet.partId]),
  packet.sourceDelta as [number, number, number],
);
if (result.wrappedStatements === 0) {
  throw new Error(`no assembly placement found for ${packet.partId}`);
}
await writeFile(outputPath, result.scad, "utf8");
console.log(JSON.stringify({
  outputPath,
  partId: packet.partId,
  wrappedStatements: result.wrappedStatements,
  delta: packet.sourceDelta,
}));
