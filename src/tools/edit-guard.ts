/**
 * Safety guard shared by every tool that can rewrite more than one module in
 * one call (edit_modules, edit_full).
 *
 * Why this exists: a whole-buffer rewrite of a 2.5k–15k line model is not
 * something an LLM reproduces — it re-authors a compact equivalent from
 * memory. Measured on the hard_surface_v2 batch, 26% of the runs that called
 * edit_full lost >20% of their geometry, the worst dropping a 171kB / 68-module
 * projector to 7kB / 37 modules (1.9% of the original facets). The rewrite
 * compiles cleanly, so nothing downstream noticed.
 *
 * The old guard was an ABSOLUTE floor (reject under 100 chars), which a 7kB
 * stand-in for a 171kB model sails past. These checks are relative instead:
 * a part that was in the model must still be in the model, and the buffer may
 * not silently collapse. A caller that genuinely means to delete something
 * says so by name via `allowRemovals`.
 */

import { findModuleSpans, listTopLevelModules } from "../scad/parts.ts";

export interface EditSafetyOpts {
  /** Tool name, quoted back in the error text. */
  tool: string;
  /** Modules the caller EXPLICITLY declared it is deleting. */
  allowRemovals?: readonly string[];
  /** Reject when new/old length falls below this. Default 0.6. */
  minSizeRatio?: number;
}

export type EditSafetyResult = { ok: true } | { ok: false; error: string };

/** Cap the name list in an error message so it stays readable. */
function names(list: readonly string[], max = 8): string {
  const head = list.slice(0, max).join(", ");
  return list.length > max ? `${head}, … (+${list.length - max} more)` : head;
}

export function checkEditSafety(
  oldScad: string,
  newScad: string,
  opts: EditSafetyOpts,
): EditSafetyResult {
  const declared = new Set(opts.allowRemovals ?? []);
  const minRatio = opts.minSizeRatio ?? 0.6;

  // 1. Placed parts — a module the assembly actually instantiates. Losing one
  //    of these means a part vanished from the object, which is never an
  //    accident worth shipping.
  const oldPlaced = listTopLevelModules(oldScad);
  const newPlaced = new Set(listTopLevelModules(newScad));
  const droppedParts = oldPlaced.filter((n) => !newPlaced.has(n) && !declared.has(n));
  if (droppedParts.length > 0) {
    return {
      ok: false,
      error:
        `${opts.tool} would remove ${droppedParts.length} part(s) that the assembly ` +
        `currently places: ${names(droppedParts)}. Parts may not disappear as a ` +
        `side effect of an edit. Either keep them, or re-call declaring them in ` +
        `removed_modules if deleting them IS the fix.`,
    };
  }

  // 2. Defined modules — includes shared helpers (rr2d, xdisc, …). Dropping
  //    one that something still calls is a compile error waiting to happen.
  const oldDefs = findModuleSpans(oldScad).map((s) => s.name);
  const newDefs = new Set(findModuleSpans(newScad).map((s) => s.name));
  const droppedDefs = oldDefs.filter((n) => !newDefs.has(n) && !declared.has(n));
  if (droppedDefs.length > 0) {
    return {
      ok: false,
      error:
        `${opts.tool} would drop ${droppedDefs.length} module definition(s): ` +
        `${names(droppedDefs)}. Reproduce every module you are not deliberately ` +
        `deleting, or declare the deletions in removed_modules.`,
    };
  }

  // 3. Size collapse — catches "same module names, all bodies gutted", the
  //    shape the re-authored rewrites actually take.
  const ratio = newScad.length / Math.max(1, oldScad.length);
  if (ratio < minRatio) {
    return {
      ok: false,
      error:
        `${opts.tool} would shrink the model from ${oldScad.length} to ` +
        `${newScad.length} chars (${(ratio * 100).toFixed(0)}% of the original, ` +
        `floor is ${(minRatio * 100).toFixed(0)}%). That is the signature of a ` +
        `rewrite-from-memory rather than an edit: the module names survive but the ` +
        `geometry inside them is gone. Use edit_modules to change only the modules ` +
        `the reviewer flagged, or move_parts if the fix is a rigid reposition.`,
    };
  }

  return { ok: true };
}
