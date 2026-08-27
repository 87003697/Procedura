/**
 * Google Gemini route — the *native* GenAI path, not an OpenAI-compatible
 * translation of it:
 *
 *   POST {base}/models/{model}:streamGenerateContent?alt=sse
 *
 * Worth its own route because the native path exposes `thinkingConfig` and
 * streams thought text as first-class parts, which the refine loop's critic
 * benefits from. Use it when your Gemini access is the Google API (or a gateway
 * that mirrors its path shape); if you reach Gemini through an
 * OpenAI-compatible proxy instead, just use the `openai` provider.
 *
 *   GEMINI_BASE_URL   API root, default https://generativelanguage.googleapis.com/v1beta
 *   GEMINI_API_KEY    sent as `x-goog-api-key`; OMIT it for a gateway that
 *                     injects its own upstream credentials.
 */

import { Route, Endpoint, Auth, Framing } from "@harness/template";
import type { RouteDef } from "@harness/template";
import { GoogleGenAI } from "./google-genai.ts";

export const GEMINI_BASE_URL =
  process.env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta";

/** Key-if-present auth: the public API needs `x-goog-api-key`, while a
 *  self-authenticating gateway wants no client credential at all. Sending an
 *  empty header to the latter is an error, so an unset key means no header. */
const geminiAuth = {
  async apply(headers: Headers): Promise<void> {
    const key = process.env["GEMINI_API_KEY"];
    if (key) headers.set("x-goog-api-key", key);
  },
};

export const geminiRoute = Route.make({
  id: "gemini",
  protocol: GoogleGenAI,
  // The model id and the streaming action are part of the path, so the endpoint
  // is derived per request rather than fixed.
  endpoint: Endpoint.dynamic(
    (req) => `/models/${req.model.modelId}:streamGenerateContent?alt=sse`,
  ),
  auth: Auth.custom(geminiAuth),
  framing: Framing.sse,
  baseUrl: GEMINI_BASE_URL,
}) as RouteDef<unknown>;
