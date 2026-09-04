/** Closed parser for Mapping Agent feedback. */
export type FeedbackStatus = "ok" | "insufficient-evidence";
export interface MappingFeedbackEvidence { id: string; kind: "part" | "region" | "overlay"; payload: Record<string, unknown>; }
export interface MappingFeedbackIssue { partId: string; problem: string; direction: string; magnitudeRangeMm: { min: number; max: number } | null; confidence: number; evidenceIds: string[]; }
export interface MappingFeedbackArtifact { schemaVersion: 1; status: FeedbackStatus; issues: MappingFeedbackIssue[]; evidence: MappingFeedbackEvidence[]; }
const forbidden = new Set(["path", "mesh", "vertices", "faces", "source", "raw", "handle", "bytes", "material", "texture", "report", "target"]);
function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(label); return value as Record<string, unknown>; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw Error(label); return value; }
function payloadValue(value: unknown): void { if (Array.isArray(value)) { value.forEach(payloadValue); return; } if (value && typeof value === "object") { for (const [key, child] of Object.entries(value)) { if (forbidden.has(key.toLowerCase())) throw Error("forbidden payload field"); payloadValue(child); } return; } if (typeof value === "number") finite(value, "invalid payload number"); }
function payload(value: unknown): Record<string, unknown> { const item = object(value, "invalid payload"); payloadValue(item); return item; }
export function parseMappingFeedbackArtifact(text: string): MappingFeedbackArtifact {
  let raw: unknown; try { raw = JSON.parse(text); } catch { throw Error("invalid artifact JSON"); }
  const root = object(raw, "invalid artifact"); const rootFields = ["schemaVersion", "status", "issues", "evidence"];
  if (Object.keys(root).some((key) => !rootFields.includes(key))) throw Error("unknown artifact field");
  if (root.schemaVersion !== 1 || (root.status !== "ok" && root.status !== "insufficient-evidence")) throw Error("invalid artifact header");
  if (!Array.isArray(root.issues) || !Array.isArray(root.evidence)) throw Error("issues and evidence must be arrays");
  const evidenceIds = new Set<string>();
  const evidence = root.evidence.map((value) => { const item = object(value, "invalid evidence");
    if (Object.keys(item).some((key) => !["id", "kind", "payload"].includes(key)) || typeof item.id !== "string" || !item.id || evidenceIds.has(item.id)) throw Error("invalid evidence");
    if (!["part", "region", "overlay"].includes(String(item.kind))) throw Error("invalid evidence kind");
    const result = { id: item.id, kind: item.kind as MappingFeedbackEvidence["kind"], payload: payload(item.payload) }; evidenceIds.add(item.id); return result;
  });
  const issueParts = new Set<string>();
  const issues = root.issues.map((value): MappingFeedbackIssue => { const item = object(value, "invalid issue");
    const fields = ["partId", "problem", "direction", "magnitudeRangeMm", "confidence", "evidenceIds"];
    if (Object.keys(item).some((key) => !fields.includes(key)) || typeof item.partId !== "string" || !item.partId || issueParts.has(item.partId)) throw Error("invalid issue");
    if (typeof item.problem !== "string" || !item.problem || typeof item.direction !== "string" || !item.direction) throw Error("invalid issue text");
    const confidence = finite(item.confidence, "confidence"); if (confidence < 0 || confidence > 1) throw Error("confidence out of range");
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0 || item.evidenceIds.some((id) => typeof id !== "string" || !evidenceIds.has(id))) throw Error("invalid evidence reference");
    let range: { min: number; max: number } | null = null; if (item.magnitudeRangeMm !== null) { const value = object(item.magnitudeRangeMm, "invalid range"); if (Object.keys(value).some((key) => !["min", "max"].includes(key))) throw Error("unknown range field"); const min = finite(value.min, "range.min"); const max = finite(value.max, "range.max"); if (min < 0 || max < min || max > 1000) throw Error("invalid magnitude range"); range = { min, max }; }
    issueParts.add(item.partId); return { partId: item.partId, problem: item.problem, direction: item.direction, magnitudeRangeMm: range, confidence, evidenceIds: [...item.evidenceIds] };
  });
  if ((root.status === "insufficient-evidence") !== (issues.length === 0)) throw Error("status does not match issues");
  return { schemaVersion: 1, status: root.status, issues, evidence };
}
