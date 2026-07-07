import type { Logger } from "chat";

export type ClawChatChatType = "direct" | "group";

export interface ClawChatThreadId {
  /** ClawChat conversation/chat id, for example `cnv_...`. */
  chatId: string;
  /** Optional message id to send a protocol `message.reply` instead of `message.send`. */
  messageId?: string;
}

export interface ClawChatCapabilities {
  multi_device: boolean;
  device_replay: boolean;
  chat_meta_events: boolean;
  delivery_receipt: boolean;
  notify_signals: boolean;
  permission_events: boolean;
  history_sync: boolean;
  reliable_delivery: boolean;
  reliable_delivery_v2: boolean;
  e2ee: boolean;
}

export interface ClawChatAdapterConfig {
  /** ClawChat REST API base URL. Used for media uploads. */
  baseUrl?: string;
  /** Optional per-connection capability override. */
  capabilities?: Partial<ClawChatCapabilities>;
  /** Stable device id for ClawChat replay cursors. Strongly recommended in production. */
  deviceId?: string;
  /** Automatically open the WebSocket during `Chat.initialize()`. Defaults to true. */
  autoConnect?: boolean;
  /** Automatically reconnect after an unexpected socket close. Defaults to true. */
  reconnect?: boolean;
  /** Initial reconnect delay in milliseconds. Defaults to 500. */
  reconnectInitialDelayMs?: number;
  /** Maximum reconnect delay in milliseconds. Defaults to 15000. */
  reconnectMaxDelayMs?: number;
  /** Handshake timeout in milliseconds. Defaults to 10000. */
  handshakeTimeoutMs?: number;
  /** `message.ack` timeout in milliseconds. Defaults to 15000. */
  ackTimeoutMs?: number;
  /** Chat SDK logger override. */
  logger?: Logger;
  /** Media upload endpoint. Defaults to `${baseUrl}/media/upload`. */
  mediaUploadUrl?: string;
  /** Opaque ClawChat bearer token. */
  token: string;
  /** Bot/runtime ClawChat user id. Used for self-echo filtering. */
  userId: string;
  /** Bot mention/display name used by Chat SDK mention detection. */
  userName?: string;
  /** ClawChat Protocol v2 WebSocket URL, usually `wss://.../ws`. */
  websocketUrl: string;
}

export interface ClawChatEndpointConfig {
  baseUrl: string;
  mediaUploadUrl: string;
  websocketUrl: string;
}

export interface ClawChatActorRef {
  id?: string;
  nick_name?: string;
  type?: string;
}

export interface ClawChatToRef {
  id?: string;
  type?: ClawChatChatType | string;
}

export interface ClawChatEnvelope<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  version?: string;
  event: string;
  trace_id?: string;
  emitted_at?: number;
  chat_id?: string;
  chat_type?: ClawChatChatType | string;
  to?: ClawChatToRef;
  sender?: ClawChatActorRef;
  origin_device_id?: string;
  payload?: TPayload;
  seq?: number;
  dseq?: number;
}

export type ClawChatFragment =
  | { kind: "text"; text: string; delta?: string }
  | { kind: "mention"; user_id?: string; display?: string }
  | {
      kind: "image";
      url: string;
      name?: string;
      mime?: string;
      size?: number;
      width?: number;
      height?: number;
    }
  | { kind: "file"; url: string; name?: string; mime?: string; size?: number }
  | { kind: "audio"; url: string; name?: string; mime?: string; size?: number; duration?: number }
  | {
      kind: "video";
      url: string;
      name?: string;
      mime?: string;
      size?: number;
      width?: number;
      height?: number;
      duration?: number;
    };

export interface ClawChatMessagePayload {
  message_id?: string;
  message_mode?: string;
  message?: {
    body?: {
      fragments?: ClawChatFragment[];
    };
    context?: {
      mentions?: Array<
        string | { user_id?: string; userId?: string; id?: string; display?: string }
      >;
      reply?: {
        reply_to_msg_id?: string;
        reply_preview?: Record<string, unknown> | null;
      } | null;
    };
    streaming?: Record<string, unknown>;
  };
}

export interface ClawChatAckPayload {
  accepted_at?: number;
  message_id?: string;
}

export interface ClawChatMediaUploadResult {
  kind?: ClawChatFragment["kind"];
  url?: string;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}
