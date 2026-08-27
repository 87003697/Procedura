/**
 * Channel adapter interface.
 *
 * Pattern source: openclaw src/channels/ (~150 files of core + 22 channel extensions).
 *
 * A channel is a messaging surface (Slack, Discord, iMessage, Telegram,
 * email, etc.). The adapter contract is *capability-oriented*: each
 * adapter declares what it can/can't do so the runtime degrades
 * gracefully (e.g. strip images on a text-only channel).
 *
 * Per-adapter sub-interfaces (Messaging, Outbound, Threading, Pairing,
 * Security, Setup) borrowed from openclaw.
 */

import type { AsyncDisposable, JsonObject } from "../types.ts";
import type { Bus } from "../bus.ts";

export interface ChannelCapabilities {
  textOut: boolean;
  imagesOut: boolean;
  filesOut: boolean;
  threadsOut: boolean;
  ephemeralOut: boolean;            // Slack-style hidden replies
  interactiveOut: boolean;          // buttons / quick replies
  maxMessageBytes?: number;
}

export interface InboundMessage {
  channelId: string;
  conversationId: string;           // (channelId, conversationId) is a binding key
  threadId?: string;
  senderId: string;
  senderIsOwner: boolean;
  text: string;
  attachments?: { kind: "image" | "document" | "audio"; data: string; mimeType: string }[];
  timestamp: number;
}

export interface OutboundEnvelope {
  text?: string;
  attachments?: { kind: "image" | "file"; data: string; mimeType: string; filename?: string }[];
  threadId?: string;
  ephemeral?: boolean;
  interactive?: { kind: "buttons"; choices: { id: string; label: string }[] };
}

export interface ChannelMessagingAdapter {
  capabilities: ChannelCapabilities;
  send(env: OutboundEnvelope, target: { conversationId: string; threadId?: string }): Promise<void>;
  /** Edit a previously-sent message (if supported). */
  edit?(messageId: string, env: OutboundEnvelope): Promise<void>;
}

export interface ChannelPairingAdapter {
  /** Begin a setup-code pairing flow; returns a code to display to the user. */
  beginPairing?(): Promise<{ code: string; expiresAt: number }>;
  completePairing?(code: string, evidence: JsonObject): Promise<{ accountId: string }>;
}

export interface ChannelSecurityAdapter {
  /** Verify inbound webhook signature, decrypt envelope, etc. */
  verify?(raw: unknown): Promise<boolean>;
}

export interface ChannelAdapter extends AsyncDisposable {
  readonly id: string;
  readonly displayName: string;
  messaging: ChannelMessagingAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter;
  /** Start receiving inbound messages, fan to bus as `channel.<id>.inbound`. */
  start(bus: Bus): Promise<void>;
}
