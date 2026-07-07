import { randomBytes, randomUUID } from "node:crypto";

import type {
  ClawChatCapabilities,
  ClawChatEnvelope,
  ClawChatFragment,
  ClawChatMessagePayload,
} from "./types";

const PROTOCOL_VERSION = "2";
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const DEFAULT_BASE_URL = "https://app.clawling.com";
/** Hermes ClawChat plugin default WebSocket endpoint. Env can override it in the factory. */
export const CLAWCHAT_WEBSOCKET_URL = "wss://app.clawling.com/ws";
export const DEFAULT_WEBSOCKET_URL = CLAWCHAT_WEBSOCKET_URL;

export const DEFAULT_CAPABILITIES: ClawChatCapabilities = {
  multi_device: false,
  device_replay: true,
  chat_meta_events: true,
  delivery_receipt: false,
  notify_signals: true,
  permission_events: true,
  history_sync: false,
  reliable_delivery: false,
  reliable_delivery_v2: false,
  e2ee: false,
};

export function currentTimeMs(): number {
  return Date.now();
}

export function newFrameId(prefix = "trace"): string {
  return `${prefix}-${randomUUID()}`;
}

function encodeBase32(value: bigint, length: number): string {
  const chars = Array.from({ length }, () => "0");
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    chars[index] = ULID_ALPHABET[Number(remaining & 31n)];
    remaining >>= 5n;
  }
  return chars.join("");
}

export function newUlid(): string {
  const timestamp = BigInt(Date.now()) & ((1n << 48n) - 1n);
  const randomness = BigInt(`0x${randomBytes(10).toString("hex")}`);
  return encodeBase32(timestamp, 10) + encodeBase32(randomness, 16);
}

export function newMessageId(): string {
  return `msg-${newUlid()}`;
}

export function encodeFrame(frame: ClawChatEnvelope): string {
  return JSON.stringify(frame);
}

export function decodeFrame(text: string): ClawChatEnvelope {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) {
    throw new Error("ClawChat frame must be a JSON object");
  }
  return value as unknown as ClawChatEnvelope;
}

export function buildConnectFrame(input: {
  capabilities: Partial<ClawChatCapabilities>;
  deviceId?: string;
  nonce: string;
  token: string;
  traceId?: string;
}): ClawChatEnvelope {
  const payload: Record<string, unknown> = {
    token: input.token,
    nonce: input.nonce,
    capabilities: { ...DEFAULT_CAPABILITIES, ...input.capabilities },
  };
  if (input.deviceId) {
    payload.device_id = input.deviceId;
  }

  return {
    version: PROTOCOL_VERSION,
    event: "connect",
    trace_id: input.traceId ?? newFrameId("connect"),
    emitted_at: currentTimeMs(),
    payload,
  };
}

export function buildMessageSendFrame(input: {
  chatId: string;
  chatType?: "direct" | "group";
  fragments: ClawChatFragment[];
  mentions?: Array<Record<string, string>>;
  messageId?: string;
  traceId?: string;
}): ClawChatEnvelope<ClawChatMessagePayload & Record<string, unknown>> {
  return buildMaterializedMessageFrame("message.send", input);
}

export function buildMessageReplyFrame(input: {
  chatId: string;
  chatType?: "direct" | "group";
  fragments: ClawChatFragment[];
  mentions?: Array<Record<string, string>>;
  messageId?: string;
  replyPreview?: Record<string, unknown> | null;
  replyToMessageId?: string;
  traceId?: string;
}): ClawChatEnvelope<ClawChatMessagePayload & Record<string, unknown>> {
  return buildMaterializedMessageFrame("message.reply", input);
}

function buildMaterializedMessageFrame(
  event: "message.send" | "message.reply",
  input: {
    chatId: string;
    chatType?: "direct" | "group";
    fragments: ClawChatFragment[];
    mentions?: Array<Record<string, string>>;
    messageId?: string;
    replyPreview?: Record<string, unknown> | null;
    replyToMessageId?: string;
    traceId?: string;
  },
): ClawChatEnvelope<ClawChatMessagePayload & Record<string, unknown>> {
  const context: NonNullable<NonNullable<ClawChatMessagePayload["message"]>["context"]> = {
    mentions: input.mentions ?? [],
    reply: null,
  };

  if (input.replyToMessageId) {
    context.reply = {
      reply_to_msg_id: input.replyToMessageId,
      reply_preview: input.replyPreview ?? null,
    };
  }

  return {
    version: PROTOCOL_VERSION,
    event,
    trace_id: input.traceId ?? newFrameId("trace"),
    emitted_at: currentTimeMs(),
    chat_id: input.chatId,
    to: { id: input.chatId, type: input.chatType ?? "direct" },
    payload: {
      message_id: input.messageId ?? newMessageId(),
      message_mode: "normal",
      message: {
        body: { fragments: input.fragments },
        context,
      },
    },
  };
}

export function buildTypingUpdateFrame(input: {
  active: boolean;
  chatId: string;
  chatType?: "direct" | "group";
  traceId?: string;
}): ClawChatEnvelope {
  return {
    version: PROTOCOL_VERSION,
    event: "typing.update",
    trace_id: input.traceId ?? newFrameId("trace"),
    emitted_at: currentTimeMs(),
    chat_id: input.chatId,
    to: { id: input.chatId, type: input.chatType ?? "direct" },
    payload: { is_typing: input.active },
  };
}

export function buildPongFrame(frame: ClawChatEnvelope): ClawChatEnvelope {
  return {
    version: PROTOCOL_VERSION,
    event: "pong",
    trace_id: frame.trace_id ?? newFrameId("pong"),
    emitted_at: frame.emitted_at ?? currentTimeMs(),
    payload: {},
  };
}

export function buildStreamCreatedFrame(input: {
  chatId: string;
  messageId: string;
  messageMode?: string;
  traceId?: string;
}): ClawChatEnvelope {
  return {
    version: PROTOCOL_VERSION,
    event: "message.created",
    trace_id: input.traceId ?? newFrameId("stream"),
    emitted_at: currentTimeMs(),
    chat_id: input.chatId,
    payload: {
      message_id: input.messageId,
      message_mode: input.messageMode ?? "normal",
    },
  };
}

export function buildStreamAddFrame(input: {
  chatId: string;
  delta: string;
  messageId: string;
  sequence: number;
  text: string;
  traceId?: string;
}): ClawChatEnvelope {
  const now = currentTimeMs();
  return {
    version: PROTOCOL_VERSION,
    event: "message.add",
    trace_id: input.traceId ?? newFrameId("stream-add"),
    emitted_at: now,
    chat_id: input.chatId,
    payload: {
      message_id: input.messageId,
      sequence: input.sequence,
      mutation: { type: "append", target_fragment_index: 0 },
      fragments: [{ kind: "text", text: input.text, delta: input.delta }],
      streaming: {
        status: "streaming",
        sequence: input.sequence,
        mutation_policy: "append_text_only",
        started_at: null,
        completed_at: null,
      },
      added_at: now,
    },
  };
}

export function buildStreamDoneFrame(input: {
  chatId: string;
  failed?: boolean;
  messageId: string;
  sequence: number;
  text: string;
  traceId?: string;
}): ClawChatEnvelope {
  const now = currentTimeMs();
  const status = input.failed ? "failed" : "done";
  return {
    version: PROTOCOL_VERSION,
    event: input.failed ? "message.failed" : "message.done",
    trace_id: input.traceId ?? newFrameId("stream-done"),
    emitted_at: now,
    chat_id: input.chatId,
    payload: {
      message_id: input.messageId,
      fragments: input.text ? [{ kind: "text", text: input.text }] : [],
      streaming: {
        status,
        sequence: input.sequence,
        mutation_policy: "append_text_only",
        started_at: null,
        completed_at: now,
      },
      completed_at: now,
    },
  };
}

export function extractNonce(frame: ClawChatEnvelope): string | null {
  const payload = isRecord(frame.payload) ? frame.payload : undefined;
  if (typeof payload?.nonce === "string") {
    return payload.nonce;
  }
  const data = isRecord(payload?.data) ? payload.data : undefined;
  return typeof data?.nonce === "string" ? data.nonce : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
