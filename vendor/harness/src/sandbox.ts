/**
 * Sandbox bridge — same typed FS interface, swappable backend.
 *
 * Pattern source: openclaw src/agents/sandbox/fs-bridge.ts.
 *
 * Tools never know which backend they're inside. Local backend is a
 * pass-through to `node:fs`; Docker backend would shell out to `docker exec`.
 * Path safety is anchored at the bridge layer.
 */

import type { AsyncDisposable, WorkspaceContext } from "./types.ts";

export interface FileInfo {
  path: string;
  size: number;
  mtime: number;
  isDir: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface SandboxBridge extends AsyncDisposable {
  readonly backendId: string;
  readonly workspace: WorkspaceContext;

  // File ops
  read(path: string, opts?: { offset?: number; limit?: number }): Promise<string>;
  write(path: string, content: string): Promise<void>;
  edit(path: string, oldString: string, newString: string): Promise<void>;
  list(path: string): Promise<FileInfo[]>;
  stat(path: string): Promise<FileInfo | undefined>;
  move(from: string, to: string): Promise<void>;

  // Process
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
}

// ──────────────────────────────────────────────────────────────────────────
// LocalSandbox — pass-through, with anchored path safety.
// ──────────────────────────────────────────────────────────────────────────

export function createLocalSandbox(workspace: WorkspaceContext): SandboxBridge {
  const enforce = (p: string) => {
    const roots = [workspace.rootDir, ...(workspace.additionalRoots ?? [])];
    const ok = roots.some((r) => p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`));
    if (!ok) throw new Error(`Sandbox: path '${p}' outside workspace roots`);
  };

  // Lazy import node:fs so this module stays browser-safe at the type level.
  let fsLazy: typeof import("node:fs/promises") | undefined;
  const fs = async () => (fsLazy ??= await import("node:fs/promises"));

  return {
    backendId: "local",
    workspace,
    async read(path, opts) {
      enforce(path);
      const f = await fs();
      const buf = await f.readFile(path, "utf8");
      if (!opts) return buf;
      const lines = buf.split("\n");
      const start = opts.offset ?? 0;
      const limit = opts.limit ?? 2000;
      return lines.slice(start, start + limit).join("\n");
    },
    async write(path, content) {
      enforce(path);
      const f = await fs();
      await f.writeFile(path, content, "utf8");
    },
    async edit(path, oldString, newString) {
      enforce(path);
      const f = await fs();
      const buf = await f.readFile(path, "utf8");
      const idx = buf.indexOf(oldString);
      if (idx < 0) throw new Error(`edit: oldString not found in ${path}`);
      if (buf.indexOf(oldString, idx + oldString.length) >= 0) {
        throw new Error(`edit: oldString appears multiple times in ${path}`);
      }
      await f.writeFile(path, buf.replace(oldString, newString), "utf8");
    },
    async list(path) {
      enforce(path);
      const f = await fs();
      const ents = await f.readdir(path, { withFileTypes: true });
      const out: FileInfo[] = [];
      for (const e of ents) {
        const full = `${path}/${e.name}`;
        const s = await f.stat(full);
        out.push({ path: full, size: s.size, mtime: s.mtimeMs, isDir: e.isDirectory() });
      }
      return out;
    },
    async stat(path) {
      enforce(path);
      const f = await fs();
      try {
        const s = await f.stat(path);
        return { path, size: s.size, mtime: s.mtimeMs, isDir: s.isDirectory() };
      } catch { return undefined; }
    },
    async move(from, to) {
      enforce(from); enforce(to);
      const f = await fs();
      await f.rename(from, to);
    },
    async exec(command, opts) {
      const t0 = Date.now();
      const child = await import("node:child_process");
      return await new Promise<ExecResult>((resolve) => {
        const p = child.spawn(command, {
          shell: true,
          cwd: opts?.cwd ?? workspace.cwd ?? workspace.rootDir,
          env: { ...(globalThis as { process?: { env?: Record<string, string> } }).process?.env, ...(opts?.env ?? {}) },
          signal: opts?.signal,
        });
        let out = "", err = "";
        p.stdout?.on("data", (d: Buffer) => out += d.toString());
        p.stderr?.on("data", (d: Buffer) => err += d.toString());
        const timer = opts?.timeout ? setTimeout(() => p.kill("SIGTERM"), opts.timeout) : undefined;
        p.on("close", (code) => {
          if (timer) clearTimeout(timer);
          resolve({ stdout: out, stderr: err, exitCode: code ?? -1, durationMs: Date.now() - t0 });
        });
      });
    },
    async dispose() { /* nothing to release for local */ },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// DockerSandbox stub — shows the interface for a containerized backend.
// ──────────────────────────────────────────────────────────────────────────

export interface DockerSandboxOpts {
  image: string;
  containerName?: string;
  containerWorkdir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  workspace: WorkspaceContext;
}

export function createDockerSandbox(opts: DockerSandboxOpts): SandboxBridge {
  // Stub. Real impl wires `docker run -d` + `docker exec`, mounts the
  // workspace per workspaceAccess, and translates paths from host to
  // container by stripping the workspace root prefix.
  const _ = opts;
  return {
    backendId: "docker",
    workspace: opts.workspace,
    async read() { throw new Error("DockerSandbox not yet implemented"); },
    async write() { throw new Error("DockerSandbox not yet implemented"); },
    async edit() { throw new Error("DockerSandbox not yet implemented"); },
    async list() { throw new Error("DockerSandbox not yet implemented"); },
    async stat() { throw new Error("DockerSandbox not yet implemented"); },
    async move() { throw new Error("DockerSandbox not yet implemented"); },
    async exec() { throw new Error("DockerSandbox not yet implemented"); },
    async dispose() { /* container cleanup */ },
  };
}
