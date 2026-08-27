/**
 * Bounded-concurrency map, and the shared limit for per-module OpenSCAD compiles.
 *
 * `mapPool` was private to `mesh/collisions.ts`, which has run its per-part
 * compiles this way for a while. `render/parts_split.ts` and
 * `mesh/floater-attribution.ts` do the same thing over the same module set, so
 * the helper and the limit live here rather than a renderer importing them out
 * of the collision analyser.
 */

/**
 * How many `compileModuleInAssembly` subprocesses run at once.
 *
 * Each compile reads the same immutable source and writes only into its own
 * directory, so the ceiling is a resource choice, not a correctness one. 4 is
 * inherited from `collisions.ts`, and the reason to keep it low is batch mode:
 * runs already fan out 8-12 CASES concurrently, so a per-case pool much wider
 * than this multiplies into hundreds of OpenSCAD processes and trades a
 * wall-clock win for memory pressure. Override with PROCEDURA_COMPILE_CONCURRENCY.
 */
export const COMPILE_CONCURRENCY = Math.max(
  1, Number(process.env["PROCEDURA_COMPILE_CONCURRENCY"]) || 4,
);

/** Run `fn` over `items` with a bounded number of concurrent workers. */
export async function mapPool<T, R>(
  items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
