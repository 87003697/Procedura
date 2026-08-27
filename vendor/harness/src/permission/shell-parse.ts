/**
 * Shell command parsing for bash-tool preflight.
 *
 * Pattern source: opencode tool/shell.ts (tree-sitter-bash integration).
 *
 * This file is the *integration seam*. Real implementation wires up
 * web-tree-sitter + tree-sitter-bash.wasm (Bun supports either bundling
 * it or loading at runtime).
 *
 * The contract: given a command string, return a structured plan of
 * (verb, args, paths-touched, "always-allow"-pattern) so the permission
 * engine can ask once per command rather than per execution.
 */

import { arityPattern } from "./arity.ts";

export interface CommandPlan {
  /** Each connected command in a pipeline/and-chain. */
  commands: { words: string[]; raw: string }[];
  /** Distinct directories touched (for "external directory" prompts). */
  dirs: string[];
  /** Verbatim shapes the user can "always" approve. */
  patterns: string[];
  /** Arity-aware patterns (`git checkout *`, `npm run *`). */
  always: string[];
}

/**
 * Plan a shell command. **Reference implementation** uses naive splitting;
 * real implementation should use tree-sitter for correct handling of
 * quotes, expansions, redirections, etc.
 */
export function planCommand(command: string): CommandPlan {
  const segments = command.split(/&&|\|\||;|\|/g).map((s) => s.trim()).filter(Boolean);
  const commands: CommandPlan["commands"] = [];
  const patternsSet = new Set<string>();
  const alwaysSet = new Set<string>();
  const dirsSet = new Set<string>();

  for (const seg of segments) {
    const words = tokenize(seg);
    if (!words.length) continue;
    commands.push({ words, raw: seg });
    patternsSet.add(seg);
    alwaysSet.add(arityPattern(words));
    for (const w of words) {
      if (looksLikePath(w)) {
        const expanded = expandTilde(w);
        const parent = parentDir(expanded);
        if (parent) dirsSet.add(parent);
      }
    }
  }

  return {
    commands,
    dirs: [...dirsSet],
    patterns: [...patternsSet],
    always: [...alwaysSet],
  };
}

function tokenize(s: string): string[] {
  // Naive tokenizer; replace with tree-sitter for production.
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) { quote = undefined; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ""; }
    } else { cur += c; }
  }
  if (cur) out.push(cur);
  return out;
}

function looksLikePath(w: string): boolean {
  return w.startsWith("/") || w.startsWith("./") || w.startsWith("../") || w.startsWith("~/") || w.startsWith("$HOME");
}

function expandTilde(w: string): string {
  if (w === "~") return getHome();
  if (w.startsWith("~/")) return `${getHome()}${w.slice(1)}`;
  if (w.startsWith("$HOME")) return `${getHome()}${w.slice(5)}`;
  return w;
}

function getHome(): string {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.["HOME"] ?? "/";
}

function parentDir(p: string): string | undefined {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return undefined;
  return p.slice(0, idx);
}
