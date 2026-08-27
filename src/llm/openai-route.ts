/**
 * OpenAI-compatible chat route — the default transport.
 *
 * Anything that speaks `POST {base}/chat/completions` with SSE framing works
 * here: the OpenAI API itself, OpenRouter, an Azure/Vertex-style gateway, a
 * self-hosted vLLM / Ollama / LM Studio server, or a company proxy. Everything
 * provider-specific comes from the environment, so swapping backends is a
 * `.env` edit and never a code change:
 *
 *   OPENAI_BASE_URL   API root, default https://api.openai.com/v1
 *   OPENAI_API_KEY    bearer token (required)
 *
 * Reasoning effort. OpenAI's reasoning models accept a `reasoning_effort` body
 * param, but endpoints serving other model families usually reject it with a
 * 400. It is therefore sent ONLY when PROCEDURA_REASONING_EFFORT is set, and it
 * never overrides a value the caller already supplied via providerOptions.
 */

import { Route, Endpoint, Auth, Framing } from "@harness/template";
import type { RouteDef } from "@harness/template";
import type { CanonicalRequest } from "@harness/template/llm/protocol";
import type { JsonObject } from "@harness/template/types";
import { OpenAIChat } from "@harness/template/llm/protocols/openai-chat";

export const OPENAI_BASE_URL =
  process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";

/** Read per call so it stays tunable without a restart of a long batch. */
function reasoningEffort(): string | undefined {
  return process.env["PROCEDURA_REASONING_EFFORT"] || undefined;
}

const OpenAIChatWithEffort = {
  ...OpenAIChat,
  id: "openai-chat",
  buildBody(req: CanonicalRequest): JsonObject {
    const body = OpenAIChat.buildBody(req);
    const effort = reasoningEffort();
    if (effort && body["reasoning_effort"] === undefined) {
      body["reasoning_effort"] = effort;
    }
    return body;
  },
};

export const openaiRoute = Route.make({
  id: "openai-chat",
  protocol: OpenAIChatWithEffort as typeof OpenAIChat,
  endpoint: Endpoint.path("/chat/completions"),
  auth: Auth.bearer("OPENAI_API_KEY"),
  framing: Framing.sse,
  baseUrl: OPENAI_BASE_URL,
}) as RouteDef<unknown>;
