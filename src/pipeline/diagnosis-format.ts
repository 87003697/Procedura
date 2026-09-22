export type DiagnosisSeverity = "HIGH" | "MED" | "LOW";

export interface DiagnosisIssueHeader {
  number: number;
  name: string;
  severity: DiagnosisSeverity;
}

const NAMED_ISSUE_RE = /^\s*(\d+)[.)]\s+([A-Za-z][A-Za-z0-9_-]*)\s+\[(HIGH|MED|LOW)\](?:\s+\[modules:[^\n\]]*\])?/gim;
const LEGACY_ISSUE_RE = /^\s*(\d+)[.)]\s+\[(HIGH|MED|LOW)\](?:\s+\[modules:[^\n\]]*\])?/gim;

export function parseDiagnosisIssueHeaders(text: string): DiagnosisIssueHeader[] {
  const named: DiagnosisIssueHeader[] = [];
  NAMED_ISSUE_RE.lastIndex = 0;
  for (let match = NAMED_ISSUE_RE.exec(text); match; match = NAMED_ISSUE_RE.exec(text)) {
    named.push({ number: Number(match[1]), name: match[2]!, severity: match[3] as DiagnosisSeverity });
  }
  if (named.length) return named;

  const legacy: DiagnosisIssueHeader[] = [];
  LEGACY_ISSUE_RE.lastIndex = 0;
  for (let match = LEGACY_ISSUE_RE.exec(text); match; match = LEGACY_ISSUE_RE.exec(text)) {
    legacy.push({ number: Number(match[1]), name: `issue_${match[1]}`, severity: match[2] as DiagnosisSeverity });
  }
  return legacy;
}

export function hasDiagnosisIssues(text: string): boolean {
  return parseDiagnosisIssueHeaders(text).length > 0;
}
