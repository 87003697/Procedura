/**
 * Built-in tools (sketched).
 *
 * These mirror the opencode set: read, write, edit, bash, glob, grep,
 * todo, fetch. Each is a small ToolExecutor; the host registers them
 * into the registry.
 */

import type { JsonObject } from "../types.ts";
import type { ToolExecutor } from "../tool.ts";

export const ReadTool: ToolExecutor = {
  descriptor: {
    name: "read",
    description: "Read a file from the workspace.",
    owner: { kind: "core" },
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path inside workspace" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  async execute(input, ctx) {
    const path = input["path"] as string;
    const offset = (input["offset"] as number | undefined) ?? 0;
    const limit = (input["limit"] as number | undefined) ?? 2000;
    // The actual filesystem read should go through SandboxBridge, not
    // node:fs directly — the harness wires that up at registration time.
    return { ok: false, error: `ReadTool stub: would read ${path}[${offset}, ${offset + limit}] for session ${ctx.sessionId}` };
  },
};

export const WriteTool: ToolExecutor = {
  descriptor: {
    name: "write",
    description: "Write a whole file (must have been read first).",
    owner: { kind: "core" },
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
  },
  async execute(input) {
    const path = input["path"] as string;
    return { ok: false, error: `WriteTool stub: would write ${path}` };
  },
};

export const EditTool: ToolExecutor = {
  descriptor: {
    name: "edit",
    description: "Edit a file by exact string replacement.",
    owner: { kind: "core" },
    inputSchema: {
      type: "object",
      required: ["path", "oldString", "newString"],
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
    },
  },
  async execute(input) {
    const path = input["path"] as string;
    return { ok: false, error: `EditTool stub: would edit ${path}` };
  },
};

export const BashTool: ToolExecutor = {
  descriptor: {
    name: "bash",
    description: "Run a shell command. Path arguments are parsed via tree-sitter.",
    owner: { kind: "core" },
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "ms" },
      },
    },
  },
  async execute(input, ctx) {
    const cmd = input["command"] as string;
    const allowed = await ctx.ask(`Run: \`${cmd}\``, "bash");
    if (!allowed) return { ok: false, error: "Permission denied" };
    return { ok: false, error: `BashTool stub: would exec ${cmd}` };
  },
};

export const GlobTool: ToolExecutor = {
  descriptor: {
    name: "glob",
    description: "Find files matching a glob pattern.",
    owner: { kind: "core" },
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: { pattern: { type: "string" } },
    },
  },
  async execute(input) {
    return { ok: true, output: `GlobTool stub for ${input["pattern"]}` };
  },
};

export const GrepTool: ToolExecutor = {
  descriptor: {
    name: "grep",
    description: "Search file contents (ripgrep-backed).",
    owner: { kind: "core" },
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  async execute(input) {
    return { ok: true, output: `GrepTool stub for ${input["pattern"]}` };
  },
};

export const TodoTool: ToolExecutor = {
  descriptor: {
    name: "todo",
    description: "Replace the session todo list.",
    owner: { kind: "core" },
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: { items: { type: "array", items: { type: "object" } } },
    },
  },
  async execute(input, ctx) {
    ctx.state.set("todos", input["items"]);
    return { ok: true, output: "Todos updated" };
  },
};

export const BUILTINS: ToolExecutor[] = [
  ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, TodoTool,
];
