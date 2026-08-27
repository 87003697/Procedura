/**
 * Runtime helpers — scoped per-key state, lazy imports, and a
 * "globalThis singleton" pattern that survives bundle splitting.
 *
 * Pattern sources:
 *   - opencode src/effect/instance-state.ts (per-directory ScopedCache)
 *   - openclaw src/hooks/internal-hooks.ts (Symbol.for global singleton)
 *   - openclaw src/shared/lazy-promise.ts (lazy boundary loader)
 */

import type { AsyncDisposable } from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────
// InstanceState — per-key scoped resource with finalizer.
//
// Opening a new "project" / "tenant" gets a fresh independent state.
// Closing it triggers the dispose chain (Bus shutdown, file unlocks, etc.).
// ──────────────────────────────────────────────────────────────────────────

export interface InstanceState<T extends AsyncDisposable> {
  /** Get-or-create the per-key instance. Idempotent for the same key. */
  get(key: string): Promise<T>;
  /** Dispose one key; runs finalizers and removes the entry. */
  release(key: string): Promise<void>;
  /** Dispose all keys. */
  releaseAll(): Promise<void>;
}

export function makeInstanceState<T extends AsyncDisposable>(
  factory: (key: string) => Promise<T>,
): InstanceState<T> {
  const cache = new Map<string, Promise<T>>();

  return {
    async get(key) {
      const existing = cache.get(key);
      if (existing) return existing;
      const pending = factory(key);
      cache.set(key, pending);
      return pending;
    },
    async release(key) {
      const pending = cache.get(key);
      if (!pending) return;
      cache.delete(key);
      const instance = await pending;
      await instance.dispose();
    },
    async releaseAll() {
      const entries = [...cache.entries()];
      cache.clear();
      await Promise.all(entries.map(async ([, p]) => {
        const inst = await p;
        await inst.dispose();
      }));
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// resolveGlobalSingleton — survives ESM bundle splitting where the same
// module ends up duplicated and module-level Maps would otherwise be
// per-copy.
//
// Use sparingly. Right for: hook registries, plugin registries, dev caches.
// Wrong for: per-tenant state (use InstanceState instead).
// ──────────────────────────────────────────────────────────────────────────

export function resolveGlobalSingleton<T>(
  symbolName: string,
  init: () => T,
): T {
  const key = Symbol.for(symbolName);
  const g = globalThis as unknown as Record<symbol, T>;
  if (g[key] === undefined) g[key] = init();
  return g[key] as T;
}

// ──────────────────────────────────────────────────────────────────────────
// LazyPromise — defer a heavy module import until first call.
//
// Useful for keeping CLI cold-start under 100ms while still exposing
// e.g. a Bun-native SQLite driver lazily.
// ──────────────────────────────────────────────────────────────────────────

export function lazy<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= factory());
}

// ──────────────────────────────────────────────────────────────────────────
// Composable AsyncDisposables
// ──────────────────────────────────────────────────────────────────────────

export function chainDispose(...items: AsyncDisposable[]): AsyncDisposable {
  return {
    async dispose() {
      // Reverse order — opposite of acquisition.
      for (let i = items.length - 1; i >= 0; i--) {
        try { await items[i]!.dispose(); } catch { /* swallow */ }
      }
    },
  };
}
