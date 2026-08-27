/**
 * Auto cache-breakpoint placement.
 *
 * Pattern source: opencode packages/llm/src/cache-policy.ts.
 *
 * Default policy ("auto") places three breakpoints:
 *   1. last tool definition
 *   2. last system part
 *   3. latest user message
 *
 * Math (per opencode comment): Anthropic 5m cache write = 1.25x base,
 * read = 0.1x base. A single reuse within 5 minutes wins.
 *
 * Provider-aware short-circuit: OpenAI and Gemini use server-side implicit
 * caching, so the policy is a noop for them.
 */

import type { CanonicalRequest } from "./protocol.ts";

const RESPECTS_INLINE_HINTS = new Set([
  "anthropic-messages",
  "bedrock-converse",
]);

export type CacheMode =
  | "auto"
  | "none"
  | {
      tools?: boolean;
      system?: boolean;
      messages?: "latest-user-message" | "latest-assistant" | { tail: number };
      ttlSeconds?: number;          // >= 3600 → 1h Anthropic cache; else 5m
    };

export interface CacheApplyOpts {
  protocolId: string;               // route.protocol.id
  mode?: CacheMode;
}

/**
 * Mutates the request in place, adding cacheHints where appropriate.
 * Returns the same request for chaining.
 *
 * Manual hints already present are preserved; auto only fills gaps.
 */
export function applyAutoCache(
  req: CanonicalRequest,
  opts: CacheApplyOpts,
): CanonicalRequest {
  const mode = opts.mode ?? "auto";
  if (mode === "none") return req;
  if (!RESPECTS_INLINE_HINTS.has(opts.protocolId)) return req;

  const ttlSeconds = typeof mode === "object" ? mode.ttlSeconds : undefined;
  const hint: CanonicalRequest["messages"][number]["cacheHint"] =
    ttlSeconds && ttlSeconds >= 3600 ? { ttlSeconds } : "ephemeral";

  // 1. last tool definition
  const wantTools = mode === "auto" || (typeof mode === "object" && mode.tools !== false);
  if (wantTools && req.tools && req.tools.length > 0) {
    const lastIdx = req.tools.length - 1;
    const last = req.tools[lastIdx]!;
    if (last.cacheHint === undefined) {
      req.tools[lastIdx] = { ...last, cacheHint: hint };
    }
  }

  // 2. last system part
  const wantSystem = mode === "auto" || (typeof mode === "object" && mode.system !== false);
  if (wantSystem && req.system && req.system.length > 0) {
    const lastIdx = req.system.length - 1;
    const last = req.system[lastIdx]!;
    if (last.cacheHint === undefined) {
      req.system[lastIdx] = { ...last, cacheHint: hint };
    }
  }

  // 3. last user message (or per `messages` override)
  const wantMessages =
    mode === "auto" || (typeof mode === "object" && mode.messages !== undefined);
  if (wantMessages) {
    const target = mode === "auto" ? "latest-user-message" : (mode as { messages?: unknown }).messages ?? "latest-user-message";
    const idx = pickMessageIdx(req, target);
    if (idx >= 0) {
      const m = req.messages[idx]!;
      if (m.cacheHint === undefined) {
        req.messages[idx] = { ...m, cacheHint: hint };
      }
    }
  }

  return req;
}

function pickMessageIdx(
  req: CanonicalRequest,
  target: "latest-user-message" | "latest-assistant" | { tail: number } | unknown,
): number {
  if (target === "latest-user-message") {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i]!.role === "user") return i;
    }
    return -1;
  }
  if (target === "latest-assistant") {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i]!.role === "assistant") return i;
    }
    return -1;
  }
  if (typeof target === "object" && target !== null && "tail" in target) {
    const n = (target as { tail: number }).tail;
    return Math.max(0, req.messages.length - n);
  }
  return -1;
}

// ──────────────────────────────────────────────────────────────────────────
// Observation — tell the caller why a cache miss happened
// ──────────────────────────────────────────────────────────────────────────

export type CacheBreakCode =
  | "cacheRetention" | "model" | "streamStrategy"
  | "systemPrompt" | "tools" | "transport";

export interface CacheObservation {
  hit: boolean;
  changeCodes: CacheBreakCode[];
  lastCallUsage?: { cacheRead: number; cacheWrite: number };
}
