/**
 * ImageAwareEngine — context engine for the refine stage.
 *
 * Responsibilities:
 *
 * 1. Inject the reference image + text spec into the system block on every
 *    turn (it's the agent's ground truth and never changes).
 * 2. Materialize stored MessageInfo / PartInfo rows into CanonicalMessages.
 * 3. Bound token usage: each render_views call produces N base64 PNGs (the
 *    model-selected views, 1–20 per mode). Keeping every historical render in
 *    context bloats the prompt fast.
 *    Strategy: keep the LATEST render_views attachments inline; for every
 *    earlier render_views result, drop the attachments and replace the
 *    text with a short marker ("[step N renders dropped; latest above]").
 * 4. Compact: nothing fancy yet — `tool-results-only` swaps every tool
 *    result older than the last 4 turns for a one-line stub.
 */

import { readFileSync } from "node:fs";
import type {
  ContextEngine, AssembleInput, AssembleResult,
  CompactInput, CompactResult,
} from "@harness/template/context";
import type {
  CanonicalMessage, CanonicalPart, ImageAttachment,
} from "@harness/template/llm/protocol";
import type {
  MessageInfo, PartInfo, ToolCallPartData, ToolResultPartData, TextPartData,
} from "@harness/template/storage";
import type { SessionStore } from "@harness/template/storage";
import type { ProceduraWorkspace } from "../config/workspace.ts";

const RENDER_TOOL_NAME = "render_views";

export interface ImageAwareEngineOpts {
  workspace: ProceduraWorkspace;
  store: SessionStore;
  /** Cached parts-colour legend, updated as render_views observes new ones. */
  getPartsColorLegend?(): string | null;
}

export function createImageAwareEngine(opts: ImageAwareEngineOpts): ContextEngine {
  // Text-only runs have no image.png. The engine still needs SOMETHING that
  // names the target, so the text spec takes the image's place in both slots
  // below rather than the engine attaching nothing and the prompt still saying
  // "the target you're trying to match".
  const hasImage = opts.workspace.hasImage;
  const refImageB64 = hasImage
    ? readFileSync(opts.workspace.imagePath).toString("base64")
    : "";

  return {
    info: {
      id: "procedura-image-aware",
      name: "Image-aware context engine for refine",
      version: "0.1.0",
      ownsCompaction: false,
      turnMaintenanceMode: "foreground",
    },

    async assemble(input: AssembleInput): Promise<AssembleResult> {
      const messages = await materialize(opts.store, input.messages);

      // System block — ref image + text spec + legend, with a cache hint.
      const legend = opts.getPartsColorLegend?.();
      const systemTextParts: CanonicalPart[] = [
        {
          kind: "text",
          text:
            "You are reviewing an OpenSCAD model against a reference image and text " +
            "spec. Your job is to make the SCAD's geometry match the reference. Use " +
            "render_views to see what you've built, inspect_module and " +
            "module_context to navigate, edit_module (one module) / edit_modules (a " +
            "group) / move_parts (rigid reposition) to change it, compile to verify, " +
            "and finish when you're done.",
        },
        ...(hasImage
          ? [
              { kind: "text", text: "REFERENCE IMAGE (the target):" } as CanonicalPart,
              { kind: "image", data: refImageB64, mimeType: "image/png" } as CanonicalPart,
            ]
          : [{ kind: "text", text: "There is NO reference image — the text spec below is the whole target." } as CanonicalPart]),
        { kind: "text", text: `TEXT SPEC:\n\n${opts.workspace.text}` },
      ];
      if (legend) {
        systemTextParts.push({
          kind: "text",
          text: `PARTS-COLOUR LEGEND (module → RGB):\n${legend.trim()}`,
        });
      }
      // The engine builds a single system block here; the OpenAI mapper
      // concatenates them by `\n\n`, the Anthropic mapper sends them as
      // separate `system: [{type:text}]` entries.
      const system = systemTextParts
        .filter((p) => p.kind === "text")
        .map((p) => ({ text: (p as { text: string }).text }));

      // Embed the reference image in the FIRST user message instead of system,
      // because OpenAI Chat doesn't support image content blocks in the system
      // role. We hoist it into a synthetic first user message.
      const refImageMessage: CanonicalMessage = {
        role: "user",
        content: hasImage
          ? [
              { kind: "text", text: "REFERENCE IMAGE (the target you're trying to match):" },
              { kind: "image", data: refImageB64, mimeType: "image/png" },
            ]
          : [{
              kind: "text",
              text: "TARGET (no reference image exists for this object; the text " +
                    `specification is the whole target):\n\n${opts.workspace.text}`,
            }],
        cacheHint: "ephemeral",
      };

      return {
        messages: [refImageMessage, ...messages],
        system,
        tools: input.availableTools,
        approximateTokens: estimateTokens([refImageMessage, ...messages]),
      };
    },

    async compact(input: CompactInput): Promise<CompactResult> {
      // No real compaction yet — we keep latest-renders-only at assemble time,
      // which is already the main token-saver. Return performed=false so the
      // run loop just keeps going.
      const _ = input;
      return { performed: false };
    },

    async dispose() { /* nothing to release */ },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Materialization: stored messages + parts → CanonicalMessage list,
// with latest-render-only image attachment policy.
// ──────────────────────────────────────────────────────────────────────────

async function materialize(
  store: SessionStore, messages: MessageInfo[],
): Promise<CanonicalMessage[]> {
  // First pass: gather all (messageIndex, partIndex, partInfo) tuples in order.
  type Indexed = { msgIdx: number; partIdx: number; part: PartInfo };
  const allParts: Indexed[] = [];
  const partsPerMessage: PartInfo[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const ps = await store.listParts(m.id);
    partsPerMessage.push(ps);
    ps.forEach((p, j) => allParts.push({ msgIdx: i, partIdx: j, part: p }));
  }

  // Find the LAST render_views tool-result; only that one keeps its attachments.
  let latestRenderIdx = -1;
  for (let i = allParts.length - 1; i >= 0; i--) {
    const p = allParts[i]!.part;
    if (p.kind !== "tool-result") continue;
    const data = p.data as unknown as ToolResultPartData;
    if (data.toolName === RENDER_TOOL_NAME) { latestRenderIdx = i; break; }
  }

  // Build CanonicalMessages — note that for assistant messages we may need
  // to emit TWO wire messages (one assistant for text+tool-call, one user
  // for tool-result), because Anthropic requires tool_result blocks in a
  // user role following the assistant's tool_use blocks.
  const out: CanonicalMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const ps = partsPerMessage[i]!;
    const assistantContent: CanonicalPart[] = [];
    const toolResultContent: CanonicalPart[] = [];

    // User messages store their text in MessageInfo.data.text (no part), so
    // hoist that into a text content part before scanning the parts list.
    if (m.role === "user") {
      const directText = (m.data as { text?: string }).text;
      if (typeof directText === "string" && directText.length > 0) {
        assistantContent.push({ kind: "text", text: directText });
      }
    }

    for (let j = 0; j < ps.length; j++) {
      const p = ps[j]!;
      const globalIdx = allParts.findIndex(
        (a) => a.msgIdx === i && a.partIdx === j,
      );
      const isLatestRender = globalIdx === latestRenderIdx;

      switch (p.kind) {
        case "text": {
          const td = p.data as unknown as TextPartData;
          if (td.text) assistantContent.push({ kind: "text", text: td.text });
          break;
        }
        case "reasoning": {
          // Drop reasoning blocks from re-sent context — providers reject them
          // if the signature doesn't match the original. Keep only the latest.
          break;
        }
        case "tool-call": {
          const tc = p.data as unknown as ToolCallPartData;
          assistantContent.push({
            kind: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          });
          break;
        }
        case "tool-result": {
          const tr = p.data as unknown as ToolResultPartData;
          const outputText = typeof tr.output === "string"
            ? tr.output
            : (tr.output as { text?: string }).text ?? JSON.stringify(tr.output);
          const isRender = tr.toolName === RENDER_TOOL_NAME;
          const keepAttachments =
            isLatestRender && tr.attachments && tr.attachments.length > 0;
          const finalAttachments: ImageAttachment[] | undefined = keepAttachments
            ? (tr.attachments!.map((a) => ({
                kind: "image" as const,
                data: a.data,
                mimeType: a.mimeType,
                ...(a.label !== undefined ? { label: a.label } : {}),
              })))
            : undefined;
          const finalOutput = isRender && !keepAttachments
            ? `[render_views step output dropped — see latest render below]`
            : outputText;
          const part: CanonicalPart = {
            kind: "tool-result",
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            output: finalOutput,
            ...(tr.isError ? { isError: true } : {}),
            ...(finalAttachments ? { attachments: finalAttachments } : {}),
          };
          // Tool-results go in a separate user message (Anthropic requires
          // tool_result blocks in role=user, following the assistant's
          // tool_use). OpenAI Chat also accepts this — the protocol mapper
          // handles both.
          toolResultContent.push(part);
          break;
        }
        // step-start / step-finish / etc. are bookkeeping; not sent to the model.
        default: break;
      }
    }

    if (assistantContent.length > 0) {
      out.push({
        role: m.role === "user" ? "user" : "assistant",
        content: assistantContent,
      });
    }
    if (toolResultContent.length > 0) {
      out.push({ role: "user", content: toolResultContent });
    }
  }

  return out;
}

function estimateTokens(messages: CanonicalMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.content) {
      if (p.kind === "text") chars += p.text.length;
      else if (p.kind === "image") chars += 1300; // ~1300 chars / image, OpenAI vision baseline
      else if (p.kind === "tool-call") chars += JSON.stringify(p.input).length;
      else if (p.kind === "tool-result") {
        chars += typeof p.output === "string" ? p.output.length : JSON.stringify(p.output).length;
        if (p.attachments) chars += p.attachments.length * 1300;
      }
    }
  }
  return Math.ceil(chars / 4);
}
