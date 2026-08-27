/**
 * Bash CLI arity table — granular "always-allow" approvals.
 *
 * Pattern source: opencode permission/arity.ts (~100 CLIs).
 *
 * Number = how many words to keep as a prefix when materializing the
 * "always allow" rule. Example:
 *   git -> 2 → `git checkout *` not `git: *`
 *   npm run -> 3 → `npm run test *` not `npm: *`
 *
 * When the user picks "always", the harness uses this table to choose the
 * granularity. Missing entries fall back to arity = 1 (just the binary).
 */

export const ARITY: Record<string, number> = {
  // VCS
  "git": 2,
  "hg": 2,
  "svn": 2,
  "gh": 2,
  "gh pr": 3,
  "gh issue": 3,
  "gh repo": 3,
  "gh release": 3,
  "gh api": 3,
  "glab": 2,
  // Package managers
  "npm": 2,
  "npm run": 3,
  "pnpm": 2,
  "pnpm run": 3,
  "yarn": 2,
  "yarn run": 3,
  "bun": 2,
  "bun run": 3,
  "bunx": 2,
  "npx": 2,
  "pip": 2,
  "uv": 2,
  "uv pip": 3,
  "uv run": 3,
  "poetry": 2,
  "pipx": 2,
  "cargo": 2,
  "rustup": 2,
  "go": 2,
  "go mod": 3,
  "mvn": 2,
  "gradle": 2,
  "bazel": 2,
  "brew": 2,
  "apt": 2,
  "apt-get": 2,
  "dnf": 2,
  "yum": 2,
  "pacman": 2,
  // Container / orchestration
  "docker": 2,
  "docker compose": 3,
  "docker buildx": 3,
  "podman": 2,
  "kubectl": 2,
  "kubectl get": 3,
  "helm": 2,
  // Cloud CLIs
  "aws": 2,
  "aws s3": 3,
  "aws ec2": 3,
  "gcloud": 3,
  "az": 2,
  "fly": 2,
  "flyctl": 2,
  "vercel": 2,
  "netlify": 2,
  "wrangler": 2,
  // Testing / dev
  "pytest": 1,
  "jest": 1,
  "mocha": 1,
  "vitest": 1,
  "playwright": 2,
  "cypress": 2,
  // Linters / formatters
  "eslint": 1,
  "prettier": 1,
  "tsc": 1,
  "ruff": 2,
  "ruff check": 3,
  "ruff format": 3,
  "black": 1,
  "biome": 2,
  "oxlint": 1,
  "oxfmt": 1,
  // Build systems
  "make": 1,
  "cmake": 2,
  "ninja": 1,
  "turbo": 2,
  // Network / shell tools
  "curl": 1,
  "wget": 1,
  "ssh": 1,
  "scp": 1,
  "rsync": 1,
  "ping": 1,
  "nc": 1,
  // FS / misc
  "ls": 1,
  "cat": 1,
  "head": 1,
  "tail": 1,
  "grep": 1,
  "rg": 1,
  "find": 1,
  "fd": 1,
  "sed": 1,
  "awk": 1,
  "echo": 1,
  "mkdir": 1,
  "touch": 1,
  "mv": 1,
  "cp": 1,
  "rm": 1,
  "chmod": 1,
  "chown": 1,
  "ln": 1,
  // Python
  "python": 1,
  "python3": 1,
  // Node
  "node": 1,
  "deno": 2,
  // DB
  "psql": 1,
  "mysql": 1,
  "sqlite3": 1,
  // Misc
  "tmux": 2,
  "screen": 1,
  "systemctl": 2,
  "launchctl": 2,
};

/** Given a parsed command (array of words), produce the "always-allow" pattern. */
export function arityPattern(words: string[]): string {
  if (words.length === 0) return "*";
  // try longest prefix matches first (e.g. "npm run" before "npm")
  for (let take = Math.min(words.length, 3); take >= 1; take--) {
    const prefix = words.slice(0, take).join(" ");
    const n = ARITY[prefix];
    if (n !== undefined) {
      const kept = words.slice(0, n).join(" ");
      return `${kept}${words.length > n ? " *" : ""}`;
    }
  }
  return `${words[0]}${words.length > 1 ? " *" : ""}`;
}
