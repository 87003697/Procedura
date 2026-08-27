/**
 * Shared vocabulary across the harness.
 *
 * Keep this file tight — it's imported by everything. No runtime deps.
 */

// ──────────────────────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject { [k: string]: JsonValue }
export type JsonArray = JsonValue[];

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// Discriminated nominal id types; prevents passing a sessionId where a runId is expected.
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type MessageId = Brand<string, "MessageId">;
export type PartId = Brand<string, "PartId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type EntryId = Brand<string, "EntryId">;
export type TraceId = Brand<string, "TraceId">;

// ──────────────────────────────────────────────────────────────────────────
// Tool ownership refs (see openclaw src/tools/types.ts)
// ──────────────────────────────────────────────────────────────────────────

export type ToolOwnerRef =
  | { kind: "core" }
  | { kind: "plugin"; pluginId: string }
  | { kind: "mcp"; serverId: string }
  | { kind: "skill"; skillId: string }
  | { kind: "channel"; channelId: string };

// ──────────────────────────────────────────────────────────────────────────
// Model identity
// ──────────────────────────────────────────────────────────────────────────

export interface ModelRef {
  providerId: string;        // e.g. "anthropic"
  modelId: string;           // e.g. "claude-opus-4-7"
  variant?: string;          // optional channel/variant (1m context, etc.)
}

export interface ModelCapability {
  input: ("text" | "image" | "document" | "audio")[];
  reasoning: boolean;
  contextWindow: number;     // tokens
  maxOutputTokens: number;
  costInput?: number;        // USD per 1M tokens
  costOutput?: number;
  status?: "available" | "preview" | "deprecated" | "disabled";
  replaces?: string[];
  replacedBy?: string;
  tags?: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Token usage — opencode-style, with cache breakdown
// ──────────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Finish reasons (canonical superset)
// ──────────────────────────────────────────────────────────────────────────

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "aborted";

// ──────────────────────────────────────────────────────────────────────────
// Workspace
// ──────────────────────────────────────────────────────────────────────────

export interface WorkspaceContext {
  /** Canonical root for filesystem operations. All paths anchored here. */
  rootDir: string;
  /** Additional read-only roots (e.g. skill bundles). */
  additionalRoots?: string[];
  /** Override cwd for shell commands. */
  cwd?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Generic Disposable (for resources that must clean up)
// ──────────────────────────────────────────────────────────────────────────

export interface AsyncDisposable {
  dispose(): Promise<void>;
}
