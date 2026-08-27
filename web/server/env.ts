/**
 * Minimal .env parser. We spawn the Procedura CLI as a subprocess with cwd set to
 * the main repo (so Bun would auto-load its .env), but we also parse and pass
 * the keys explicitly so generation works regardless of the child's cwd/.env
 * loading behavior.
 */

import { readFileSync } from "node:fs";

export function parseEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const lineRaw of raw.split("\n")) {
    let line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = val;
  }
  return out;
}
