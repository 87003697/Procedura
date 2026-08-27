/**
 * Route selection — maps a model key to its provider route.
 *
 * Every pipeline stage picks its transport the same way, so adding a provider
 * is one case here plus one route file, not an edit in every stage.
 */

import type { RouteDef } from "@harness/template";
import { providerIdOf } from "../config/models.ts";
import { openaiRoute } from "./openai-route.ts";
import { geminiRoute } from "./gemini-route.ts";

export function routeForModel(modelKey: string): RouteDef<unknown> {
  switch (providerIdOf(modelKey)) {
    case "gemini": return geminiRoute;
    default: return openaiRoute;
  }
}
