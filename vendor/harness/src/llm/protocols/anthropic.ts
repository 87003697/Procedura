/**
 * Anthropic Messages protocol (sketch).
 *
 * Pattern source: opencode packages/llm/src/protocols/anthropic-messages.ts (691 LOC).
 * Real implementation handles cache_control blocks, server tools, thinking
 * blocks, etc. This file shows the protocol shape.
 */

import type { JsonObject } from "../../types.ts";
import type { CanonicalRequest, LLMEvent, Protocol } from "../protocol.ts";

type Raw = { event: string; data: string };

export const AnthropicMessages: Protocol<Raw> = {
  id: "anthropic-messages",

  buildBody(req: CanonicalRequest): JsonObject {
    const body: JsonObject = {
      model: req.model.modelId,
      max_tokens: req.maxOutputTokens ?? 4096,
      stream: true,
      messages: req.messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content.map(toAnthropicPart),
        ...(m.cacheHint ? { cache_control: toCacheControl(m.cacheHint) } : {}),
      })),
    };
    if (req.system && req.system.length) {
      body["system"] = req.system.map((s) => ({
        type: "text",
        text: s.text,
        ...(s.cacheHint ? { cache_control: toCacheControl(s.cacheHint) } : {}),
      }));
    }
    if (req.tools && req.tools.length) {
      body["tools"] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        ...(t.cacheHint ? { cache_control: toCacheControl(t.cacheHint) } : {}),
      }));
    }
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    if (req.topP !== undefined) body["top_p"] = req.topP;
    if (req.providerOptions) Object.assign(body, req.providerOptions);
    return body;
  },

  parseEvent(raw: Raw): LLMEvent[] {
    if (!raw.data || raw.data === "[DONE]") return [];
    const parsed = JSON.parse(raw.data) as { type?: string; [k: string]: unknown };
    switch (parsed["type"]) {
      case "message_start":
        return [{ kind: "message-start" }];
      case "content_block_delta": {
        const d = parsed["delta"] as { type: string; text?: string; partial_json?: string } | undefined;
        if (!d) return [];
        if (d.type === "text_delta" && d.text) return [{ kind: "text-delta", text: d.text }];
        if (d.type === "input_json_delta" && d.partial_json) {
          return [{ kind: "tool-call-delta", toolCallId: String(parsed["index"] ?? "0"), argDelta: d.partial_json }];
        }
        return [];
      }
      case "content_block_start": {
        const cb = parsed["content_block"] as { type: string; id?: string; name?: string } | undefined;
        if (cb?.type === "tool_use" && cb.id && cb.name) {
          return [{ kind: "tool-call-start", toolCallId: cb.id, toolName: cb.name }];
        }
        return [];
      }
      case "message_delta": {
        const stop = (parsed["delta"] as { stop_reason?: string } | undefined)?.stop_reason;
        const usage = (parsed["usage"] as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined) ?? {};
        if (stop) {
          return [{
            kind: "message-finish",
            reason: stop === "tool_use" ? "tool-calls" : stop === "end_turn" ? "stop" : "stop",
            usage: {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cacheRead: usage.cache_read_input_tokens,
              cacheWrite: usage.cache_creation_input_tokens,
            },
          }];
        }
        return [];
      }
      default:
        return [];
    }
  },

  isTerminal(raw) { return raw.event === "message_stop"; },
};

function toAnthropicPart(p: CanonicalRequest["messages"][number]["content"][number]): JsonObject {
  switch (p.kind) {
    case "text": return { type: "text", text: p.text };
    case "image": return { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } };
    case "tool-call": return { type: "tool_use", id: p.toolCallId, name: p.toolName, input: p.input };
    case "tool-result": {
      const outputText = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
      // If the tool returned images, emit a multipart tool_result.content
      // array so Anthropic sees both the text summary and each image.
      if (p.attachments && p.attachments.length > 0) {
        const content: JsonObject[] = [{ type: "text", text: outputText }];
        for (const a of p.attachments) {
          if (a.label) content.push({ type: "text", text: a.label });
          content.push({ type: "image", source: { type: "base64", media_type: a.mimeType, data: a.data } });
        }
        return { type: "tool_result", tool_use_id: p.toolCallId, content, ...(p.isError ? { is_error: true } : {}) };
      }
      return { type: "tool_result", tool_use_id: p.toolCallId, content: outputText, ...(p.isError ? { is_error: true } : {}) };
    }
    case "thinking": return { type: "thinking", thinking: p.text, signature: p.signature ?? "" };
    case "document": return { type: "document", source: { type: "base64", media_type: p.mimeType, data: p.data } };
  }
}

function toCacheControl(hint: NonNullable<CanonicalRequest["messages"][number]["cacheHint"]>): JsonObject {
  if (hint === "ephemeral") return { type: "ephemeral" };
  if (hint.ttlSeconds >= 3600) return { type: "ephemeral", ttl: "1h" };
  return { type: "ephemeral", ttl: "5m" };
}
