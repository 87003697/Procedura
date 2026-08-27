/**
 * OpenAI Chat Completions protocol (sketch).
 *
 * Pattern source: opencode packages/llm/src/protocols/openai-chat.ts (420 LOC).
 *
 * Many providers reuse this verbatim — DeepSeek, TogetherAI, Cerebras, Groq,
 * Fireworks, DeepInfra. The trick is `openai-compatible-chat.ts` which wraps
 * this but removes the canonical baseURL — 28 lines, lets any compat
 * provider be 5 lines.
 */

import type { JsonObject } from "../../types.ts";
import type { CanonicalRequest, LLMEvent, Protocol } from "../protocol.ts";

type Raw = { event: string; data: string };

export const OpenAIChat: Protocol<Raw> = {
  id: "openai-chat",

  buildBody(req: CanonicalRequest): JsonObject {
    const wireMessages: JsonObject[] = [];
    for (const m of req.messages) {
      // Each canonical message normally becomes ONE wire message, but a
      // tool result that carries image attachments has to be split — OpenAI
      // role=tool messages are text-only, so the images ride on a synthetic
      // user message that immediately follows.
      // ANY message carrying tool-result parts must go through this path so
      // each result becomes a `role: tool` message WITH its `tool_call_id`.
      // (The generic mapping below drops tool_call_id — strict OpenAI models
      // then 400 with "No tool output found for function call"; lenient gateways
      // like the Gemini bridge tolerate it. The image-splitting only kicks in
      // when there are actually attachments.)
      const toolResults = m.content.filter((p) => p.kind === "tool-result");
      if (toolResults.length > 0) {
        // Tool messages first (one per tool-result canonical part, OpenAI
        // requires a separate `role: tool` message per tool_call_id).
        for (const p of m.content) {
          if (p.kind === "tool-result") {
            const outputText = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
            wireMessages.push({
              role: "tool",
              tool_call_id: p.toolCallId,
              // `name` is required by some OpenAI-compatible gateways that
              // translate to Gemini (function_response.name in the protobuf).
              // Pure OpenAI ignores it, so it's harmless to always include.
              ...(p.toolName !== undefined ? { name: p.toolName } : {}),
              content: outputText,
            });
          } else if (p.kind === "tool-call") {
            // Should appear on an assistant turn, not a tool turn — keep as-is.
            wireMessages.push({
              role: m.role,
              content: [toOpenAIPart(p)],
            });
          }
        }
        // Then a single follow-up user message carrying all attached images.
        const imageParts: JsonObject[] = [];
        for (const p of m.content) {
          if (p.kind !== "tool-result" || !p.attachments?.length) continue;
          imageParts.push({ type: "text", text: `Attachments from ${p.toolName ?? "tool"}:` });
          for (const a of p.attachments) {
            if (a.label) imageParts.push({ type: "text", text: a.label });
            imageParts.push({
              type: "image_url",
              image_url: { url: `data:${a.mimeType};base64,${a.data}` },
            });
          }
        }
        if (imageParts.length > 0) {
          wireMessages.push({ role: "user", content: imageParts });
        }
        continue;
      }
      // For assistant messages, hoist tool-call parts to the top-level
      // `tool_calls` field (OpenAI Chat's shape). Other parts become
      // `content`. For non-assistant messages, just map content directly.
      if (m.role === "assistant") {
        const toolCalls = m.content.filter((p) => p.kind === "tool-call");
        const textParts = m.content.filter((p) => p.kind !== "tool-call");
        const assistantMsg: JsonObject = { role: "assistant" };
        if (textParts.length === 1 && textParts[0]!.kind === "text") {
          assistantMsg["content"] = textParts[0]!.text;
        } else if (textParts.length > 0) {
          assistantMsg["content"] = textParts.map(toOpenAIPart);
        } else {
          assistantMsg["content"] = "";
        }
        if (toolCalls.length > 0) {
          assistantMsg["tool_calls"] = toolCalls.map((p) => {
            const tc = p as { toolCallId: string; toolName: string; input: JsonObject };
            return {
              id: tc.toolCallId, type: "function",
              function: { name: tc.toolName, arguments: JSON.stringify(tc.input) },
            };
          });
        }
        wireMessages.push(assistantMsg);
      } else {
        wireMessages.push({
          role: m.role === "tool" ? "tool" : m.role,
          content: m.content.length === 1 && m.content[0]!.kind === "text"
            ? m.content[0]!.text
            : m.content.map(toOpenAIPart),
        });
      }
    }
    const body: JsonObject = {
      model: req.model.modelId,
      stream: true,
      messages: wireMessages,
    };
    // Ask for the trailing usage chunk so token accounting works on streamed
    // responses (without it, OpenAI-compatible gateways report no usage at
    // all). Escape hatch for relays that reject the field.
    if (process.env["LLM_NO_STREAM_USAGE"] !== "1") {
      body["stream_options"] = { include_usage: true };
    }
    if (req.system && req.system.length) {
      const sys: JsonObject = { role: "system", content: req.system.map((s) => s.text).join("\n\n") };
      body["messages"] = [sys, ...wireMessages];
    }
    if (req.tools && req.tools.length) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      // Force serial tool calls — many OpenAI-compatible gateways (notably
      // gateways fronting Claude on Anthropic) split each parallel tool result
      // into its own role:tool message, then re-translate to Anthropic with
      // each tool_result in a separate user turn. That violates Anthropic's
      // "tool_result must follow tool_use in the previous message" rule.
      body["parallel_tool_calls"] = false;
    }
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    if (req.topP !== undefined) body["top_p"] = req.topP;
    if (req.maxOutputTokens !== undefined) body["max_completion_tokens"] = req.maxOutputTokens;
    if (req.providerOptions) Object.assign(body, req.providerOptions);
    return body;
  },

  parseEvent(raw: Raw): LLMEvent[] {
    if (!raw.data || raw.data === "[DONE]") return [];
    // Tolerate garbage SSE lines (gateways occasionally inject HTML error
    // fragments or truncated JSON mid-stream). One bad chunk must not kill an
    // expensive in-flight generation — skip it; real failures still surface
    // through finish/stream-end handling.
    let chunk: { choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: { id?: string; index: number; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      chunk = JSON.parse(raw.data) as typeof chunk;
    } catch {
      console.error(`  [openai-chat] skipping unparseable SSE chunk (${raw.data.length} chars): ${raw.data.slice(0, 120)}`);
      return [];
    }
    const out: LLMEvent[] = [];
    const choice = chunk.choices?.[0];
    if (!choice) {
      // stream_options.include_usage sends a trailing usage-only chunk with an
      // empty choices array. Surface it as a usage-bearing finish; the run
      // loop's tool-calls guard keeps it from downgrading the finish reason.
      if (chunk.usage && (chunk.usage.prompt_tokens || chunk.usage.completion_tokens)) {
        out.push({
          kind: "message-finish",
          reason: "stop",
          usage: { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 },
        });
      }
      return out;
    }

    const delta = choice.delta;
    // Reasoning/thinking channel. OpenAI-compatible "thinking" proxies stream it
    // as `reasoning_content` (DeepSeek convention, also used by the Gemini-via-
    // proxy gateways); OpenRouter uses `reasoning`. Surface it as a thinking-delta
    // so the agent records it as a reasoning part. Inert for models that send
    // neither field.
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) out.push({ kind: "thinking-delta", text: reasoning });
    if (delta?.content) out.push({ kind: "text-delta", text: delta.content });
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        // OpenAI sends `id` only on the first chunk for each tool call; subsequent
        // delta chunks reference the call by `index` alone. We keep a side map
        // so all the deltas resolve to the same canonical toolCallId (= openai id).
        // The map is cleared on message-finish below.
        let callId = tc.id ?? openaiToolCallIdByIndex.get(tc.index);
        if (tc.id) openaiToolCallIdByIndex.set(tc.index, tc.id);
        if (!callId) callId = `tc_${tc.index}`;
        if (tc.function?.name) out.push({ kind: "tool-call-start", toolCallId: callId, toolName: tc.function.name });
        if (tc.function?.arguments) out.push({ kind: "tool-call-delta", toolCallId: callId, argDelta: tc.function.arguments });
      }
    }

    if (choice.finish_reason) {
      const reason = choice.finish_reason === "tool_calls" ? "tool-calls" as const :
        choice.finish_reason === "length" ? "length" as const :
        choice.finish_reason === "content_filter" ? "content-filter" as const : "stop" as const;
      out.push({
        kind: "message-finish",
        reason,
        usage: { input: chunk.usage?.prompt_tokens ?? 0, output: chunk.usage?.completion_tokens ?? 0 },
      });
      openaiToolCallIdByIndex.clear();
    }
    return out;
  },
};

// Per-stream side map (index → openai tool_call id). Module-level because the
// harness's lane serializes one stream at a time per harness instance; cleared
// at every message-finish so a leak across runs is benign.
const openaiToolCallIdByIndex = new Map<number, string>();

function toOpenAIPart(p: CanonicalRequest["messages"][number]["content"][number]): JsonObject {
  switch (p.kind) {
    case "text": return { type: "text", text: p.text };
    case "image": return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } };
    case "tool-call": {
      // Assistant tool-call parts are rendered into `tool_calls` on the
      // assistant message, not as a content sub-part. Our buildBody handles
      // that case by splitting the message, so this path is exercised only
      // for fall-through. Synthesise an OpenAI tool_call entry.
      return { id: p.toolCallId, type: "function", function: { name: p.toolName, arguments: JSON.stringify(p.input) } };
    }
    case "tool-result": return { type: "text", text: typeof p.output === "string" ? p.output : JSON.stringify(p.output) };
    case "thinking": return { type: "text", text: p.text };
    case "document": return { type: "text", text: `[document: ${p.filename ?? p.mimeType}]` };
  }
}
