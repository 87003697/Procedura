/** Closed parser for Mapping Agent feedback. */
export type FeedbackStatus = "ok" | "insufficient-evidence";
export interface MappingFeedbackRegion { candidatePartIds: string[]; evidenceIds: string[]; diagnosis: string; repairHint: string; }
export interface MappingFeedbackArtifact { schemaVersion: 5; status: FeedbackStatus; regions: MappingFeedbackRegion[]; }
const statuses: FeedbackStatus[] = ["ok", "insufficient-evidence"];
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}
function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { throw Error("invalid artifact JSON"); } }
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  assert(Object.keys(value).every((key) => allowed.includes(key)), label);
}
function nonEmptyString(value: unknown, label: string): asserts value is string {
  assert(typeof value === "string" && value.trim().length > 0, label);
}
function evidenceIds(value: unknown): string[] {
  assert(Array.isArray(value) && value.length > 0, "invalid evidence references");
  const ids = value.map((id) => {
    nonEmptyString(id, "invalid evidence reference");
    return id;
  });
  assert(new Set(ids).size === ids.length, "duplicate evidence reference");
  return ids;
}
export function parseMappingFeedbackArtifact(text: string): MappingFeedbackArtifact {
  const root = object(parseJson(text), "invalid artifact");
  keys(root, ["schemaVersion", "status", "regions"], "unknown artifact field");
  assert(root.schemaVersion === 5 && statuses.includes(root.status as FeedbackStatus), "invalid artifact header");
  assert(Array.isArray(root.regions), "regions must be an array");
  const status = root.status as FeedbackStatus;
  assert(root.regions.length <= 2, "too many regions");
  const regions = root.regions.map((value): MappingFeedbackRegion => {
    const item = object(value, "invalid region");
    keys(item, ["candidatePartIds", "evidenceIds", "diagnosis", "repairHint"], "invalid region");
    const candidatePartIds = item.candidatePartIds;
    assert(Array.isArray(candidatePartIds) && candidatePartIds.length > 0, "invalid region candidates");
    const partIds = candidatePartIds.map((partId) => {
      nonEmptyString(partId, "invalid region candidate");
      return partId;
    });
    assert(new Set(partIds).size === partIds.length, "duplicate region candidate");
    const diagnosis = item.diagnosis;
    nonEmptyString(diagnosis, "invalid diagnosis");
    const repairHint = item.repairHint;
    nonEmptyString(repairHint, "invalid repair hint");
    const references = evidenceIds(item.evidenceIds);
    return { candidatePartIds: partIds, evidenceIds: references, diagnosis, repairHint };
  });
  assert((status === "insufficient-evidence") === (regions.length === 0), "status does not match regions");
  return { schemaVersion: 5, status, regions };
}
