/**
 * Extract OpenSCAD code from an LLM response.
 *
 * Port of aetherion.llm.client.extract_openscad_code. Tries closed fenced
 * blocks first, scores each one, falls back to truncated-fence handling and
 * "whole text is SCAD" last-ditch detection.
 */

export function extractOpenscadCode(text: string): string {
  if (!text) return "";

  // Closed code blocks (with or without `openscad` language tag).
  let bestCode: string | null = null;
  let bestScore = 0;
  const closedPat = /```(?:openscad)?\s*\n?([\s\S]*?)\n?```/g;
  for (let m: RegExpExecArray | null; (m = closedPat.exec(text)); ) {
    const code = m[1]!.trim();
    const score = scoreOpenscad(code);
    if (score > bestScore) {
      bestScore = score;
      bestCode = code;
    }
  }
  if (bestCode && bestScore >= 3) return bestCode;

  // Unclosed code fence (truncated output).
  const truncated = /```(?:openscad)?\s*\n?([\s\S]+)$/.exec(text);
  if (truncated) {
    const code = truncated[1]!.trim();
    if (scoreOpenscad(code) >= 3) return code;
  }

  // Whole text might be SCAD with no fences.
  if (scoreOpenscad(text) >= 5) return text.trim();

  return bestCode ?? text.trim();
}

function scoreOpenscad(code: string): number {
  if (!code || code.length < 20) return 0;
  let score = 0;
  const markers = [
    /\bmodule\s+\w+\s*\(/,
    /\bcube\s*\(/,
    /\bsphere\s*\(/,
    /\bcylinder\s*\(/,
    /\btranslate\s*\(/,
    /\brotate\s*\(/,
    /\bunion\s*\(/,
    /\bdifference\s*\(/,
    /\bintersection\s*\(/,
    /\bhull\s*\(/,
    /\$fn\s*=/,
    /\bfunction\s+\w+\s*\(/,
  ];
  for (const re of markers) if (re.test(code)) score += 1;
  return score;
}
