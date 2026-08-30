import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  ReferenceAuthority,
  type ReferenceDescriptor,
  type ReferenceSummary,
} from "../reference/authority.ts";

const PROCEDURA_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

export interface ImportReferenceRunOpts {
  outputDir: string;
  meshPath?: string;
  referenceHandle?: string;
  referenceRoot?: string;
  runsRoot?: string;
}

export interface ImportReferenceRunResult {
  outputDir: string;
  reference: ReferenceDescriptor;
  summary: ReferenceSummary;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function importReferenceRun(opts: ImportReferenceRunOpts): Promise<ImportReferenceRunResult> {
  if (Boolean(opts.meshPath) === Boolean(opts.referenceHandle)) {
    throw new Error("importReferenceRun requires exactly one of meshPath or referenceHandle");
  }
  const outputDir = resolve(opts.outputDir);
  if (existsSync(outputDir) && !statSync(outputDir).isDirectory()) {
    throw new Error("outputDir must be a directory");
  }
  const runsRoot = resolve(opts.runsRoot ?? process.env["PROCEDURA_OUTPUTS_ROOT"] ?? join(PROCEDURA_ROOT, "outputs"));
  if (!isInside(outputDir, runsRoot)) throw new Error("outputDir must be inside runsRoot");
  const configuredRoot = opts.referenceRoot ?? process.env["PROCEDURA_REFERENCE_ROOT"];
  if (!configuredRoot) throw new Error("Mesh-to-CAD requires --reference-root or PROCEDURA_REFERENCE_ROOT");
  const authority = new ReferenceAuthority(resolve(configuredRoot), [runsRoot, PROCEDURA_ROOT]);
  let created = false;
  let createdHandle: string | null = null;
  const outputExisted = existsSync(outputDir);
  if (!outputExisted) mkdirSync(dirname(outputDir), { recursive: true });
  const stagingDir = outputExisted
    ? outputDir
    : mkdtempSync(join(dirname(outputDir), "." + randomUUID() + ".reference-import-"));
  const descriptorPath = outputExisted
    ? join(outputDir, ".reference-" + randomUUID() + ".json")
    : join(stagingDir, "reference.json");
  try {
    const reference = opts.meshPath
      ? await authority.importReference(opts.meshPath)
      : { handle: opts.referenceHandle! };
    created = Boolean(opts.meshPath);
    createdHandle = created ? reference.handle : null;
    const summary = authority.inspectReferenceSummary(reference.handle);
    if (!outputExisted) mkdirSync(stagingDir, { recursive: true });
    writeFileSync(descriptorPath, JSON.stringify({
      schemaVersion: 1,
      handle: reference.handle,
      format: "stl",
      summary,
    }, null, 2), "utf8");
    if (!outputExisted) renameSync(stagingDir, outputDir);
    else renameSync(descriptorPath, join(outputDir, "reference.json"));
    return { outputDir, reference, summary };
  } catch (error) {
    if (createdHandle) authority.discardReference(createdHandle);
    if (!outputExisted) rmSync(stagingDir, { recursive: true, force: true });
    else rmSync(descriptorPath, { force: true });
    throw error;
  }
}
