/**
 * Persistence — SessionStore + MessageV2 schema.
 *
 * Pattern source: opencode session/session.sql.ts + session/message-v2.ts.
 * Big idea: minimal indexed columns + a single typed `data` JSON column.
 * Schema evolution happens at the application layer (TypeScript types),
 * not at the DB layer. Migrations only add indexes/columns, never reshape
 * `data`.
 */

import type {
  AsyncDisposable, FinishReason, JsonObject, MessageId, ModelRef,
  PartId, SessionId, TokenUsage, ToolCallId,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────
// MessageV2 — canonical schema for messages and parts
// ──────────────────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: SessionId;
  parentId?: SessionId;        // subagent sessions hang off a parent
  workspaceDir: string;
  title?: string;
  agentKind: string;           // "build" | "plan" | "explore" | ...
  model: ModelRef;
  permission?: JsonObject;     // serialized per-session approvals
  cost?: number;
  tokens?: TokenUsage;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  compactedAt?: number;
}

export type MessageRole = "user" | "assistant";

export interface MessageInfo {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  data: JsonObject;            // role-specific extras (snapshot, cost, agent, ...)
  createdAt: number;
}

export type PartKind =
  | "text"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "file"
  | "step-start"
  | "step-finish"
  | "compaction"
  | "subtask"
  | "agent";

export interface PartInfo {
  id: PartId;
  messageId: MessageId;
  sessionId: SessionId;
  kind: PartKind;
  data: JsonObject;            // shape varies per kind (typed at the app layer)
  createdAt: number;
}

// Typed shapes for the JSON `data` column by kind — application-layer
// schema evolution lives here.

export interface TextPartData { text: string }
export interface ReasoningPartData { text: string; signature?: string }
export interface ToolCallPartData {
  toolCallId: ToolCallId;
  toolName: string;
  input: JsonObject;
}
export interface ToolResultPartData {
  toolCallId: ToolCallId;
  toolName: string;
  output: string | JsonObject;
  isError?: boolean;
  durationMs?: number;
  truncatedToFile?: string;    // if output was truncated → sidecar path
  /** Image attachments produced by this tool call (inline base64).
   *
   * The in-memory store keeps them as-is. A persistent backend may want
   * to spill them to disk and replace this with file paths; that's an
   * implementation choice for the SessionStore, not a schema break.
   */
  attachments?: {
    kind: "image";
    data: string;
    mimeType: string;
    label?: string;
  }[];
}
export interface StepFinishPartData {
  finishReason: FinishReason;
  usage: TokenUsage;
}

// ──────────────────────────────────────────────────────────────────────────
// SessionStore — the persistence interface
// ──────────────────────────────────────────────────────────────────────────

export interface SessionStore extends AsyncDisposable {
  // Sessions
  createSession(info: Omit<SessionInfo, "createdAt" | "updatedAt">): Promise<SessionInfo>;
  getSession(id: SessionId): Promise<SessionInfo | undefined>;
  updateSession(id: SessionId, patch: Partial<SessionInfo>): Promise<void>;
  listSessions(opts?: { parentId?: SessionId; limit?: number }): Promise<SessionInfo[]>;

  // Messages
  appendMessage(m: Omit<MessageInfo, "createdAt">): Promise<MessageInfo>;
  getMessage(id: MessageId): Promise<MessageInfo | undefined>;
  listMessages(sessionId: SessionId): Promise<MessageInfo[]>;

  // Parts
  appendPart(p: Omit<PartInfo, "createdAt">): Promise<PartInfo>;
  updatePart(id: PartId, patch: { data?: JsonObject }): Promise<void>;
  listParts(messageId: MessageId): Promise<PartInfo[]>;

  // Filter helpers
  /** Returns messages excluding any whose data has `compacted: true`. */
  liveMessages(sessionId: SessionId): Promise<MessageInfo[]>;
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory reference implementation — production should be SQLite/Postgres
// ──────────────────────────────────────────────────────────────────────────

export function createInMemoryStore(): SessionStore {
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, PartInfo>();
  // index: sessionId -> message ids in append order
  const sessionMessages = new Map<string, string[]>();
  const messageParts = new Map<string, string[]>();

  const now = () => Date.now();

  return {
    async createSession(info) {
      const created: SessionInfo = { ...info, createdAt: now(), updatedAt: now() };
      sessions.set(created.id, created);
      sessionMessages.set(created.id, []);
      return created;
    },
    async getSession(id) { return sessions.get(id); },
    async updateSession(id, patch) {
      const existing = sessions.get(id);
      if (!existing) return;
      sessions.set(id, { ...existing, ...patch, updatedAt: now() });
    },
    async listSessions(opts = {}) {
      let list = [...sessions.values()];
      if (opts.parentId) list = list.filter((s) => s.parentId === opts.parentId);
      list.sort((a, b) => b.createdAt - a.createdAt);
      if (opts.limit) list = list.slice(0, opts.limit);
      return list;
    },

    async appendMessage(m) {
      const created: MessageInfo = { ...m, createdAt: now() };
      messages.set(created.id, created);
      const list = sessionMessages.get(created.sessionId) ?? [];
      list.push(created.id);
      sessionMessages.set(created.sessionId, list);
      messageParts.set(created.id, []);
      return created;
    },
    async getMessage(id) { return messages.get(id); },
    async listMessages(sessionId) {
      const ids = sessionMessages.get(sessionId) ?? [];
      return ids.map((i) => messages.get(i)!).filter(Boolean);
    },

    async appendPart(p) {
      const created: PartInfo = { ...p, createdAt: now() };
      parts.set(created.id, created);
      const list = messageParts.get(created.messageId) ?? [];
      list.push(created.id);
      messageParts.set(created.messageId, list);
      return created;
    },
    async updatePart(id, patch) {
      const existing = parts.get(id);
      if (!existing) return;
      parts.set(id, { ...existing, ...(patch.data ? { data: patch.data } : {}) });
    },
    async listParts(messageId) {
      const ids = messageParts.get(messageId) ?? [];
      return ids.map((i) => parts.get(i)!).filter(Boolean);
    },

    async liveMessages(sessionId) {
      const ids = sessionMessages.get(sessionId) ?? [];
      return ids
        .map((i) => messages.get(i)!)
        .filter((m) => m && m.data["compacted"] !== true);
    },

    async dispose() {
      sessions.clear(); messages.clear(); parts.clear();
      sessionMessages.clear(); messageParts.clear();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// SQLite blueprint — the actual production target.
// Use Bun's built-in sqlite or `better-sqlite3` on Node.
// Schema sketch (Drizzle-style):
//
//   session (id pk, parent_id, workspace_dir, title, agent_kind, model JSON,
//            permission JSON, cost real, tokens JSON, created_at, updated_at,
//            archived_at, compacted_at)
//   message (id pk, session_id fk, role, data JSON, created_at)
//            INDEX(session_id, created_at)
//   part    (id pk, message_id fk, session_id fk, kind, data JSON, created_at)
//            INDEX(message_id, created_at)
//            INDEX(session_id, kind)
//
// Migrations stay shallow — only add indexes/columns. `data` is application-
// owned, schema evolution at the TypeScript layer.
// ──────────────────────────────────────────────────────────────────────────
