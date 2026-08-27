/**
 * Context engine — pluggable contract.
 *
 * Pattern source: openclaw src/context-engine/types.ts.
 *
 * Default ("legacy") is a deliberate no-op shim: pass-through assemble,
 * delegate compact to a summary call. Replace with your own engine
 * (e.g. RAG, semantic memory, custom history rewriting).
 */

import type { AsyncDisposable, ModelRef, SessionId, TokenUsage } from "./types.ts";
import type { CanonicalMessage } from "./llm/protocol.ts";
import type { ToolDescriptor } from "./tool.ts";
import type { MessageInfo } from "./storage.ts";

export interface ContextEngineInfo {
  id: string;
  name: string;
  version: string;
  ownsCompaction: boolean;
  turnMaintenanceMode: "foreground" | "background";
}

export interface AssembleInput {
  sessionId: SessionId;
  messages: MessageInfo[];
  prompt?: { text: string };       // freshly-arrived user prompt for this turn
  tokenBudget: number;             // = model contextWindow - reserve
  availableTools: ToolDescriptor[];
  model: ModelRef;
  citationsMode?: "off" | "on";
}

export interface AssembleResult {
  /** Canonical message list to send to the model. */
  messages: CanonicalMessage[];
  /** Optional system blocks (separate from chat messages). */
  system?: { text: string }[];
  /** Tools to expose this turn (subset of availableTools). */
  tools: ToolDescriptor[];
  /** Approximate token count of the assembled context. */
  approximateTokens?: number;
}

export interface CompactInput {
  sessionId: SessionId;
  tokenBudget: number;
  currentTokenCount: number;
  compactionTarget: "tool-results-only" | "soft-summary" | "hard-summary";
  customInstructions?: string;
  force?: boolean;
  signal?: AbortSignal;
}

export interface CompactResult {
  /** Whether compaction actually ran. */
  performed: boolean;
  /** Token count after compaction. */
  newTokenCount?: number;
  /** Free-form summary that was written into history. */
  summary?: string;
}

export interface ContextEngine extends AsyncDisposable {
  info: ContextEngineInfo;
  bootstrap?(sessionId: SessionId): Promise<void>;
  maintain?(sessionId: SessionId): Promise<void>;
  ingest?(sessionId: SessionId, message: MessageInfo): Promise<void>;
  ingestBatch?(sessionId: SessionId, messages: MessageInfo[]): Promise<void>;
  afterTurn?(sessionId: SessionId, prePromptCount: number, autoCompactionSummary?: string): Promise<void>;
  assemble(input: AssembleInput): Promise<AssembleResult>;
  compact(input: CompactInput): Promise<CompactResult>;
  prepareSubagentSpawn?(parent: SessionId, child: SessionId): Promise<void>;
  onSubagentEnded?(parent: SessionId, child: SessionId): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────
// LegacyContextEngine — deliberate no-op shim
// ──────────────────────────────────────────────────────────────────────────

export interface LegacyOpts {
  /** Convert stored MessageInfo into CanonicalMessage. */
  materialize(messages: MessageInfo[]): CanonicalMessage[];
  /** Used by `compact` to summarize tool-results / older turns. */
  summarize?(input: CompactInput): Promise<CompactResult>;
}

export function createLegacyEngine(opts: LegacyOpts): ContextEngine {
  return {
    info: {
      id: "legacy",
      name: "Legacy pass-through engine",
      version: "0.1.0",
      ownsCompaction: false,
      turnMaintenanceMode: "foreground",
    },
    async assemble(input) {
      return {
        messages: opts.materialize(input.messages),
        tools: input.availableTools,
      };
    },
    async compact(input) {
      if (!opts.summarize) return { performed: false };
      return opts.summarize(input);
    },
    async dispose() { /* nothing */ },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Compaction triggers — when the loop should compact mid-run
// ──────────────────────────────────────────────────────────────────────────

export interface CompactionTrigger {
  shouldCompact(opts: { currentTokens: number; budget: number; usage?: TokenUsage }): boolean;
  target(opts: { currentTokens: number; budget: number }): CompactInput["compactionTarget"];
}

export const defaultTrigger: CompactionTrigger = {
  shouldCompact({ currentTokens, budget }) {
    return currentTokens >= Math.floor(budget * 0.85);
  },
  target({ currentTokens, budget }) {
    const ratio = currentTokens / budget;
    if (ratio < 0.9) return "tool-results-only";
    if (ratio < 0.95) return "soft-summary";
    return "hard-summary";
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Registry — plugin slot for swapping engines
// ──────────────────────────────────────────────────────────────────────────

const registry = new Map<string, () => Promise<ContextEngine>>();

export const ContextEngineRegistry = {
  register(id: string, factory: () => Promise<ContextEngine>): void {
    registry.set(id, factory);
  },
  async resolve(id: string): Promise<ContextEngine | undefined> {
    const f = registry.get(id);
    if (!f) return undefined;
    return f();
  },
  list(): string[] { return [...registry.keys()]; },
};
