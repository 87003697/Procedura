/**
 * Permission engine.
 *
 * Patterns synthesized:
 *   - opencode permission/evaluate.ts (last-wins wildcard rules)
 *   - opencode permission ask/reply service with Deferred + bus events
 *   - openclaw multi-source merge (11-layer priority order)
 *
 * Rule shape:
 *   { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
 *
 * Wildcard matching uses simple "*" glob — replace with `micromatch` etc.
 * if you need full glob semantics.
 */

import type { AsyncDisposable } from "../types.ts";
import type { Bus, StandardEvents } from "../bus.ts";

export type Action = "allow" | "deny" | "ask";

export interface Rule {
  permission: string;       // tool/permission name pattern (e.g. "bash", "edit:*", "*")
  pattern: string;          // argument pattern (e.g. "git checkout *", "*")
  action: Action;
}

export type Ruleset = Rule[];

export type PolicySource =
  | "profile" | "provider-profile"
  | "global" | "global-provider"
  | "agent" | "agent-provider"
  | "group" | "sender" | "sandbox"
  | "subagent" | "inherited"
  | "runtime-allowlist";

export interface PolicyLayer {
  source: PolicySource;
  rules: Ruleset;
}

// ──────────────────────────────────────────────────────────────────────────
// Last-wins evaluator (opencode pattern, 3 lines)
// ──────────────────────────────────────────────────────────────────────────

export function evaluate(
  permission: string,
  pattern: string,
  ...rulesets: Ruleset[]
): { action: Action; rule?: Rule } {
  const flat = rulesets.flat();
  for (let i = flat.length - 1; i >= 0; i--) {
    const r = flat[i]!;
    if (wildcardMatch(permission, r.permission) && wildcardMatch(pattern, r.pattern)) {
      return { action: r.action, rule: r };
    }
  }
  return { action: "ask" };
}

/** Simple "*" wildcard. Replace with micromatch for full glob support. */
export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(value);
}

// ──────────────────────────────────────────────────────────────────────────
// Multi-source merge (openclaw pattern; explicit ordering)
// ──────────────────────────────────────────────────────────────────────────

export const POLICY_ORDER: PolicySource[] = [
  "profile", "provider-profile",
  "global", "global-provider",
  "agent", "agent-provider",
  "group", "sender",
  "sandbox",
  "subagent", "inherited",
  "runtime-allowlist",   // last → wins
];

export function mergeLayers(layers: PolicyLayer[]): Ruleset {
  const sorted = [...layers].sort((a, b) =>
    POLICY_ORDER.indexOf(a.source) - POLICY_ORDER.indexOf(b.source));
  return sorted.flatMap((l) => l.rules);
}

// ──────────────────────────────────────────────────────────────────────────
// PermissionEngine — observable ask/reply
// ──────────────────────────────────────────────────────────────────────────

export type ReplyKind = "once" | "always" | "reject";

export interface AskOpts {
  permission: string;
  pattern: string;
  question: string;
  /** If set: caller is owner; gates owner-only tools (openclaw two-factor). */
  ownerOnly?: { senderIsOwner: boolean; allowlist: string[] };
}

export interface PermissionEngine extends AsyncDisposable {
  /** Returns true if allowed (allow rule or 'once'/'always' reply). */
  ask(opts: AskOpts): Promise<boolean>;
  /** UI replies; resolves any pending ask matching permissionId. */
  reply(permissionId: string, reply: ReplyKind): void;
  /** Register a new policy layer (e.g. when the user `always`-allows). */
  addLayer(layer: PolicyLayer): void;
  /** Snapshot of all current layers. */
  snapshot(): PolicyLayer[];
}

export interface PermissionEngineOpts {
  bus: Bus<StandardEvents & Record<string, unknown>>;
  initialLayers: PolicyLayer[];
  /** Where to persist "always allow" decisions. */
  onPersistAlways?(rule: Rule): Promise<void>;
}

interface Pending {
  resolve(value: boolean): void;
  opts: AskOpts;
}

export function createPermissionEngine(opts: PermissionEngineOpts): PermissionEngine {
  const layers: PolicyLayer[] = [...opts.initialLayers];
  const pending = new Map<string, Pending>();
  let counter = 0;

  return {
    async ask(askOpts) {
      // Owner-only gating (openclaw two-factor)
      if (askOpts.ownerOnly) {
        if (!askOpts.ownerOnly.senderIsOwner) return false;
        if (!askOpts.ownerOnly.allowlist.includes(askOpts.permission)) return false;
      }

      const merged = mergeLayers(layers);
      const { action } = evaluate(askOpts.permission, askOpts.pattern, merged);
      if (action === "allow") return true;
      if (action === "deny") return false;

      // action === "ask" → publish and wait
      const id = `perm_${++counter}`;
      opts.bus.emit("permission.asked", {
        sessionId: "" /* set by caller via decorate */,
        permissionId: id,
        question: askOpts.question,
      });
      return new Promise<boolean>((resolve) => {
        pending.set(id, { resolve, opts: askOpts });
      });
    },
    reply(id, reply) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      opts.bus.emit("permission.replied", { sessionId: "", permissionId: id, reply });
      if (reply === "reject") return p.resolve(false);
      p.resolve(true);
      if (reply === "always") {
        const rule: Rule = {
          permission: p.opts.permission,
          pattern: p.opts.pattern,
          action: "allow",
        };
        layers.push({ source: "runtime-allowlist", rules: [rule] });
        void opts.onPersistAlways?.(rule);
      }
    },
    addLayer(layer) { layers.push(layer); },
    snapshot() { return [...layers]; },
    async dispose() { pending.clear(); layers.length = 0; },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Standard agent rulesets (opencode `agent/agent.ts` patterns)
// ──────────────────────────────────────────────────────────────────────────

export const STANDARD_RULESETS = {
  build: [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "ask" },
    { permission: "plan_enter", pattern: "*", action: "ask" },
  ] as Ruleset,

  plan: [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "edit:*", pattern: "*", action: "deny" },
    { permission: "edit:*", pattern: ".opencode/plans/*.md", action: "allow" },
    { permission: "write", pattern: "*", action: "deny" },
    { permission: "write", pattern: ".opencode/plans/*.md", action: "allow" },
  ] as Ruleset,

  explore: [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "allow" },
    { permission: "websearch", pattern: "*", action: "allow" },
  ] as Ruleset,

  compactionOrTitle: [
    { permission: "*", pattern: "*", action: "deny" },
  ] as Ruleset,
};
