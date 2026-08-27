/**
 * Noop SandboxBridge — Procedura's tools don't go through the sandbox at all.
 * They use Bun.spawn and node:fs directly, with absolute paths anchored at
 * the workspace root by convention. The harness's runLoop still needs a
 * SandboxBridge to expose `workspace` on ToolContext, so we hand it this
 * stub. Every fs/exec method throws — and that's fine: none of the six
 * Procedura tools calls them.
 */

import type { SandboxBridge, FileInfo, ExecResult } from "@harness/template/sandbox";
import type { WorkspaceContext } from "@harness/template/types";

export function createNoopSandbox(workspace: WorkspaceContext): SandboxBridge {
  const nope = (name: string) =>
    new Error(`noop sandbox: ${name} not implemented — Procedura tools use Bun.spawn / node:fs directly`);

  return {
    backendId: "noop",
    workspace,
    async read() { throw nope("read"); },
    async write() { throw nope("write"); },
    async edit() { throw nope("edit"); },
    async list() { throw nope("list"); },
    async stat(): Promise<FileInfo | undefined> { throw nope("stat"); },
    async move() { throw nope("move"); },
    async exec(): Promise<ExecResult> { throw nope("exec"); },
    async dispose() { /* nothing to release */ },
  };
}
