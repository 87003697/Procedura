/**
 * Plugin host.
 *
 * Pattern source: opencode packages/plugin/src/index.ts (Hooks object).
 *
 * Plugin authors export a default function:
 *   export default async (input: PluginInput, options?: any): Promise<Hooks>
 *
 * The host calls each hook at the relevant point in the run lifecycle.
 * No inheritance, no method overriding — just an object of handlers.
 */

import type { AsyncDisposable, JsonObject, SessionId } from "./types.ts";
import type { Bus, StandardEvents } from "./bus.ts";
import type { ToolDescriptor, ToolExecutor } from "./tool.ts";
import type { CanonicalMessage, CanonicalRequest } from "./llm/protocol.ts";

export interface PluginInput {
  bus: Bus<StandardEvents & Record<string, unknown>>;
  workspaceDir: string;
  config: JsonObject;
}

export interface Hooks {
  // Lifecycle
  config?(c: JsonObject): JsonObject | Promise<JsonObject>;
  event?(event: string, payload: unknown): void | Promise<void>;
  shutdown?(): void | Promise<void>;

  // Tools
  tool?: Record<string, ToolExecutor>;
  "tool.definition"?(name: string, desc: ToolDescriptor): ToolDescriptor;
  "tool.execute.before"?(name: string, args: JsonObject, ctx: { sessionId: SessionId }): JsonObject | Promise<JsonObject>;
  "tool.execute.after"?(name: string, result: unknown, ctx: { sessionId: SessionId }): unknown | Promise<unknown>;

  // Auth / providers
  auth?: Record<string, { kind: "oauth" | "api"; handler: () => Promise<string> }>;
  provider?: Record<string, { models: { id: string }[] }>;

  // Chat / messages
  "chat.message"?(msg: CanonicalMessage, ctx: { sessionId: SessionId }): CanonicalMessage | Promise<CanonicalMessage>;
  "chat.params"?(params: { temperature?: number; topP?: number; maxOutputTokens?: number }, ctx: { sessionId: SessionId }): typeof params | Promise<typeof params>;
  "chat.headers"?(headers: Record<string, string>): Record<string, string> | Promise<Record<string, string>>;

  // Permission
  "permission.ask"?(opts: { permission: string; pattern: string }): "allow" | "deny" | undefined | Promise<"allow" | "deny" | undefined>;

  // Commands
  "command.execute.before"?(parts: unknown[]): unknown[] | Promise<unknown[]>;

  // Shell
  "shell.env"?(env: Record<string, string>): Record<string, string> | Promise<Record<string, string>>;

  // Experimental
  "experimental.chat.messages.transform"?(messages: CanonicalMessage[]): CanonicalMessage[] | Promise<CanonicalMessage[]>;
  "experimental.chat.system.transform"?(system: { text: string }[]): { text: string }[] | Promise<{ text: string }[]>;
  "experimental.session.compacting"?(opts: { sessionId: SessionId }): void | Promise<void>;
  "experimental.compaction.autocontinue"?(): boolean | Promise<boolean>;
  "experimental.text.complete"?(text: string, ctx: { sessionId: SessionId }): string | Promise<string>;
}

export type PluginFactory = (input: PluginInput, options?: unknown) => Promise<Hooks>;

export interface PluginHost extends AsyncDisposable {
  load(spec: string | PluginFactory): Promise<void>;
  hooks: Hooks[];
  /** Run a specific hook across all plugins, collecting non-undefined results. */
  fanout<K extends keyof Hooks>(hook: K, ...args: Parameters<NonNullable<Hooks[K]> extends (...a: infer A) => infer _R ? (...a: A) => unknown : never>): Promise<unknown[]>;
}

export function createPluginHost(input: PluginInput): PluginHost {
  const hooks: Hooks[] = [];

  return {
    hooks,
    async load(spec) {
      const factory: PluginFactory = typeof spec === "function"
        ? spec
        : (await import(spec)).default as PluginFactory;
      const h = await factory(input);
      hooks.push(h);
    },
    async fanout(hook, ...args) {
      const results: unknown[] = [];
      for (const h of hooks) {
        const fn = h[hook] as ((...a: unknown[]) => unknown) | undefined;
        if (typeof fn === "function") {
          try {
            const r = await Promise.resolve(fn.apply(h, args as unknown[]));
            results.push(r);
          } catch (e) { input.bus.emit("error" as never, { plugin: true, error: e } as never); }
        }
      }
      return results;
    },
    async dispose() {
      for (const h of hooks) await h.shutdown?.();
      hooks.length = 0;
    },
  };
}
