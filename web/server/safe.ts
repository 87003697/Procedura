/**
 * Path-safety helpers. The server only ever serves files that resolve to a
 * location INSIDE the runs root; anything that escapes (via `..`, symlink, or
 * absolute injection) is rejected.
 *
 * Symlinks. A runs root very often holds symlinks to run dirs on other disks
 * or mounts, which the strict realpath check would refuse. `trustSymlinks`
 * (--follow-symlinks / PROCEDURA_STUDIO_FOLLOW_SYMLINKS=1) keeps the lexical
 * `..` guard but lets a symlink under the root resolve wherever it points —
 * opt-in, because it means trusting every link anyone can drop into the root.
 */

import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

let trustSymlinks = false;

export function setTrustSymlinks(on: boolean): void {
  trustSymlinks = on;
}

export function symlinksTrusted(): boolean {
  return trustSymlinks;
}

/** True if `child` is the same as or nested under `parent` (both absolute). */
export function isInside(parent: string, child: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
}

/** realpath containment check, honouring the trust flag. `abs` may not exist. */
export function realInside(baseDir: string, abs: string): boolean {
  if (trustSymlinks) return true;
  try {
    return isInside(realpathSync(baseDir), realpathSync(abs));
  } catch {
    // Target may not exist yet / realpath failed — the lexical check decides.
    return true;
  }
}

/**
 * Resolve `relPath` against `baseDir` and guarantee the result stays inside
 * `baseDir`. Returns the absolute path, or null if it would escape.
 */
export function safeJoin(baseDir: string, relPath: string): string | null {
  const cleaned = relPath.replace(/^[/\\]+/, "");
  const abs = resolve(baseDir, cleaned);
  if (!isInside(baseDir, abs)) return null;
  if (!realInside(baseDir, abs)) return null;
  return abs;
}
