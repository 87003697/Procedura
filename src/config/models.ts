/**
 * Model catalog.
 *
 * Procedura does not ship a hosted backend. You point it at whatever endpoint
 * you have — the OpenAI API, the Google GenAI API, OpenRouter, a corporate
 * gateway, or a local server — through two environment variables per provider
 * (see `.env.example`). This file only decides, for a given model key, WHICH of
 * those two transports to use and WHAT model id to send.
 *
 * Resolution order for a model key:
 *
 *   1. An explicit `provider:model` prefix wins — `gemini:gemini-3-pro-preview`
 *      or `openai:gpt-5.2`. Use it to reach a model the catalog has never heard
 *      of without touching this file.
 *   2. A `MODEL_CATALOG` entry below, if the key matches one.
 *   3. Otherwise the key is passed through verbatim as the model id, on the
 *      provider named by PROCEDURA_PROVIDER (default `openai`).
 *
 * Rule 3 is deliberate: an unknown key is far more often a model your endpoint
 * serves and this catalog has not caught up with than it is a typo, and a hard
 * error there would make every new model release a code change.
 */

import type { ModelRef } from "@harness/template/types";

export type ProviderId = "openai" | "gemini";

export interface ModelCatalogEntry {
  ref: ModelRef;
  /** Approximate context window in tokens. */
  contextWindow: number;
  /** Approximate per-turn cost ceiling (USD); used only as a sanity log. */
  estimatedTurnCostUsd?: number;
  /** Notes for the human reader; not consumed by the runtime. */
  notes?: string;
}

/**
 * Known-good presets. These are the models the pipeline was developed and
 * evaluated against; the exact ids your endpoint exposes may differ, in which
 * case pass the id straight through (rule 3 above) or add an entry here.
 */
export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = {
  // ── Reasoning models, OpenAI-compatible transport ────────────────────────
  "gpt-5.2": {
    ref: { providerId: "openai", modelId: "gpt-5.2" },
    contextWindow: 400_000,
    estimatedTurnCostUsd: 0.12,
    notes:
      "Strong all-rounder for both stages. Set PROCEDURA_REASONING_EFFORT=high " +
      "(or max) to buy accuracy on the part-generation calls.",
  },
  "gpt-5.2-mini": {
    ref: { providerId: "openai", modelId: "gpt-5.2-mini" },
    contextWindow: 400_000,
    estimatedTurnCostUsd: 0.02,
    notes: "Cheap tier — fine for smoke tests, weak on multi-part assemblies.",
  },
  "claude-opus-4-5": {
    ref: { providerId: "openai", modelId: "claude-opus-4-5" },
    contextWindow: 200_000,
    estimatedTurnCostUsd: 0.25,
    notes:
      "Vision-capable with robust tool use — a good fit for the refine agent " +
      "loop and the diagnose critic. Assumes an OpenAI-compatible gateway.",
  },

  // ── Gemini, native GenAI transport ───────────────────────────────────────
  // Thinking is native here (thinkingConfig / includeThoughts), so the model id
  // carries no effort suffix; see src/llm/gemini-route.ts.
  "gemini-3-pro-preview": {
    ref: { providerId: "gemini", modelId: "gemini-3-pro-preview" },
    contextWindow: 1_000_000,
    estimatedTurnCostUsd: 0.08,
    notes: "Multimodal with a long context — comfortable with large SCAD buffers.",
  },
  "gemini-3-flash": {
    ref: { providerId: "gemini", modelId: "gemini-3-flash" },
    contextWindow: 1_000_000,
    estimatedTurnCostUsd: 0.01,
    notes: "Fast/cheap tier for smoke tests and light calls.",
  },
};

/** Provider used for a model key that carries no prefix and no catalog entry. */
function fallbackProviderId(): ProviderId {
  return process.env["PROCEDURA_PROVIDER"] === "gemini" ? "gemini" : "openai";
}

/** The model every stage uses unless a CLI flag overrides it. */
export const DEFAULT_MODEL = process.env["PROCEDURA_MODEL"] ?? "gpt-5.2";

/** Split an explicit `provider:model` key; undefined if there is no prefix. */
function splitProviderPrefix(key: string): ModelRef | undefined {
  const i = key.indexOf(":");
  if (i <= 0) return undefined;
  const provider = key.slice(0, i);
  const modelId = key.slice(i + 1);
  if (!modelId) return undefined;
  if (provider !== "openai" && provider !== "gemini") return undefined;
  return { providerId: provider, modelId };
}

export function resolveModel(idOrShort: string | undefined): ModelRef {
  const key = idOrShort ?? DEFAULT_MODEL;
  const explicit = splitProviderPrefix(key);
  if (explicit) return explicit;
  const entry = MODEL_CATALOG[key];
  if (entry) return entry.ref;
  return { providerId: fallbackProviderId(), modelId: key };
}

/** Returns the route provider corresponding to a model key. */
export function providerIdOf(model: string): ProviderId {
  return resolveModel(model).providerId as ProviderId;
}
