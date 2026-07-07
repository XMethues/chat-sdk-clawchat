import {
  extractFiles,
  extractPostableAttachments,
  NetworkError,
  toBuffer,
  ValidationError,
} from "@chat-adapter/shared";
import {
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type ChannelInfo,
  type ChatInstance,
  ConsoleLogger,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  Message,
  NotImplementedError,
  type RawMessage,
  type StreamChunk,
  type StreamOptions,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import WebSocket from "ws";

import { ClawChatFormatConverter } from "./format-converter";
import {
  buildConnectFrame,
  buildMessageReplyFrame,
  buildMessageSendFrame,
  buildPongFrame,
  buildStreamAddFrame,
  buildStreamCreatedFrame,
  buildStreamDoneFrame,
  buildTypingUpdateFrame,
  decodeFrame,
  encodeFrame,
  isRecord,
  newMessageId,
} from "./protocol";
import type {
  ClawChatAckPayload,
  ClawChatAdapterConfig,
  ClawChatChatType,
  ClawChatEnvelope,
  ClawChatFragment,
  ClawChatMediaUploadResult,
  ClawChatMessagePayload,
  ClawChatThreadId,
} from "./types";

type ReadyState = "closed" | "connecting" | "ready";

interface PendingAck {
  reject: (error: Error) => void;
  resolve: (frame: ClawChatEnvelope) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 15_000;

/** Chat SDK adapter for ClawChat Protocol v2. */
export class ClawChatAdapter implements Adapter<ClawChatThreadId, ClawChatEnvelope> {
  readonly name = "clawchat";
  readonly persistThreadHistory = true;
  readonly lockScope = "channel" as const;

  readonly userName: string;
  readonly botUserId: string;

  private readonly config: ClawChatAdapterConfig;
  private readonly converter = new ClawChatFormatConverter();
  private readonly knownChatTypes = new Map<string, ClawChatChatType>();
  private readonly pendingAcks = new Map<string, PendingAck>();

  private chat: ChatInstance | null = null;
  private connectDeferred: Deferred<void> | null = null;
  private logger: Logger;
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socket: WebSocket | null = null;
  private state: ReadyState = "closed";
  private stopped = false;

  constructor(config: ClawChatAdapterConfig) {
    this.config = {
      autoConnect: true,
      reconnect: true,
      reconnectInitialDelayMs: DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      reconnectMaxDelayMs: DEFAULT_RECONNECT_MAX_DELAY_MS,
      handshakeTimeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS,
      ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
      ...config,
    };
    this.userName = this.config.userName ?? "clawchat-bot";
    this.botUserId = this.config.userId;
    this.logger = this.config.logger ?? new ConsoleLogger("info", "clawchat");
    this.reconnectDelayMs =
      this.config.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("clawchat");
    if (this.config.autoConnect !== false) {
      await this.connect();
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    this.rejectAllAcks(new NetworkError("clawchat", "ClawChat adapter disconnected"));
    const socket = this.socket;
    this.socket = null;
    this.state = "closed";
    if (this.connectDeferred) {
      this.connectDeferred.reject(new NetworkError("clawchat", "ClawChat adapter disconnected"));
      this.connectDeferred = null;
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
  }

  async connect(): Promise<void> {
    if (this.state === "ready") {
      return;
    }
    if (this.connectDeferred) {
      return this.connectDeferred.promise;
    }

    this.stopped = false;
    this.state = "connecting";
    const deferred = createDeferred<void>();
    this.connectDeferred = deferred;

    const socket = new WebSocket(this.config.websocketUrl);
    this.socket = socket;

    const handshakeTimer = setTimeout(() => {
      const error = new NetworkError("clawchat", "ClawChat WebSocket handshake timed out");
      deferred.reject(error);
      socket.close();
    }, this.config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);

    socket.on("message", (data) => {
      void this.handleSocketData(data).catch((error: unknown) => {
        this.logger.error("ClawChat inbound frame handling failed", error);
      });
    });

    socket.once("error", (error) => {
      this.logger.error("ClawChat WebSocket error", error);
      if (this.state !== "ready") {
        clearTimeout(handshakeTimer);
        deferred.reject(new NetworkError("clawchat", error.message, error));
      }
    });

    socket.once("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      const reasonText = reason.toString() || `code ${code}`;
      this.logger.warn("ClawChat WebSocket closed", { code, reason: reasonText });
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.state !== "ready") {
        deferred.reject(
          new NetworkError("clawchat", `ClawChat WebSocket closed before ready: ${reasonText}`),
        );
      }
      this.state = "closed";
      this.connectDeferred = null;
      this.rejectAllAcks(new NetworkError("clawchat", `ClawChat WebSocket closed: ${reasonText}`));
      if (!this.stopped && this.config.reconnect !== false) {
        this.scheduleReconnect();
      }
    });

    deferred.promise
      .then(() => {
        clearTimeout(handshakeTimer);
        this.reconnectDelayMs =
          this.config.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
      })
      .catch(() => {
        clearTimeout(handshakeTimer);
      });

    return deferred.promise;
  }

  encodeThreadId(data: ClawChatThreadId): string {
    const chatSegment = encodeSegment(data.chatId);
    if (data.messageId) {
      return `clawchat:${chatSegment}:${encodeSegment(data.messageId)}`;
    }
    return `clawchat:${chatSegment}`;
  }

  decodeThreadId(threadId: string): ClawChatThreadId {
    const parts = threadId.split(":");
    if (parts.length < 2 || parts.length > 3 || parts[0] !== "clawchat") {
      throw new ValidationError("clawchat", `Invalid ClawChat thread ID: ${threadId}`);
    }
    return {
      chatId: decodeSegment(parts[1]),
      messageId: parts[2] ? decodeSegment(parts[2]) : undefined,
    };
  }

  channelIdFromThreadId(threadId: string): string {
    const { chatId } = this.decodeThreadId(threadId);
    return this.encodeThreadId({ chatId });
  }

  isDM(threadId: string): boolean {
    const { chatId } = this.decodeThreadId(threadId);
    return this.knownChatTypes.get(chatId) !== "group";
  }

  parseMessage(raw: ClawChatEnvelope): Message<ClawChatEnvelope> {
    const chatId = raw.chat_id;
    if (!chatId) {
      throw new ValidationError("clawchat", "Inbound ClawChat message is missing chat_id");
    }

    const chatType = normalizeChatType(raw.chat_type);
    if (chatType) {
      this.knownChatTypes.set(chatId, chatType);
    }

    const payload = isRecord(raw.payload) ? raw.payload : {};
    const messagePayload = payload as ClawChatMessagePayload & Record<string, unknown>;
    const fragments = extractFragments(messagePayload);
    const text = fragmentsToText(fragments);
    const sender = isRecord(raw.sender) ? raw.sender : {};
    const userId = stringValue(sender.id) ?? "unknown";
    const userName = stringValue(sender.nick_name) ?? userId;
    const messageId = stringValue(messagePayload.message_id) ?? raw.trace_id ?? newMessageId();
    const threadId = this.encodeThreadId({ chatId });

    const message = new Message<ClawChatEnvelope>({
      id: messageId,
      threadId,
      text,
      formatted: this.converter.toAst(text),
      raw,
      author: {
        userId,
        userName,
        fullName: userName,
        isBot: userId === this.config.userId ? true : "unknown",
        isMe: userId === this.config.userId,
      },
      metadata: {
        dateSent: new Date(raw.emitted_at ?? Date.now()),
        edited: false,
      },
      attachments: fragmentsToAttachments(fragments),
    });

    if (mentionsUser(messagePayload, this.config.userId)) {
      message.isMention = true;
    }

    return message;
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  async handleWebhook(_request: Request, _options?: WebhookOptions): Promise<Response> {
    return new Response("ClawChat uses WebSocket transport; call Chat.initialize().", {
      status: 501,
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ClawChatEnvelope>> {
    const { chatId, messageId: replyToMessageId } = this.decodeThreadId(threadId);
    const messageId = newMessageId();
    const fragments = await this.buildFragments(message);
    const chatType = this.knownChatTypes.get(chatId);
    const frame = replyToMessageId
      ? buildMessageReplyFrame({ chatId, chatType, messageId, replyToMessageId, fragments })
      : buildMessageSendFrame({ chatId, chatType, messageId, fragments });
    const ack = await this.sendFrame(frame, { waitForAck: true });
    const ackPayload = isRecord(ack?.payload) ? (ack.payload as ClawChatAckPayload) : undefined;
    return {
      id: ackPayload?.message_id ?? messageId,
      raw: ack ?? frame,
      threadId,
    };
  }

  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ClawChatEnvelope>> {
    return this.postMessage(channelId, message);
  }

  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<ClawChatEnvelope>> {
    throw new NotImplementedError(
      "ClawChat Protocol v2 does not expose message edits",
      "editMessage",
    );
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError(
      "ClawChat Protocol v2 does not expose message deletion",
      "deleteMessage",
    );
  }

  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError("ClawChat Protocol v2 does not expose reactions", "addReaction");
  }

  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError(
      "ClawChat Protocol v2 does not expose reactions",
      "removeReaction",
    );
  }

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions,
  ): Promise<FetchResult<ClawChatEnvelope>> {
    return { messages: [], nextCursor: undefined };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId);
    const chatType = this.knownChatTypes.get(chatId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: chatType !== "group",
      metadata: { chatId, chatType: chatType ?? "unknown" },
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const { chatId } = this.decodeThreadId(channelId);
    const chatType = this.knownChatTypes.get(chatId);
    return {
      id: channelId,
      name: chatId,
      isDM: chatType !== "group",
      metadata: { chatId, chatType: chatType ?? "unknown" },
    };
  }

  async startTyping(threadId: string, status?: string): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);
    const active =
      status == null || !["false", "idle", "stop", "stopped"].includes(status.toLowerCase());
    await this.sendFrame(
      buildTypingUpdateFrame({ chatId, chatType: this.knownChatTypes.get(chatId), active }),
      {
        waitForAck: false,
      },
    );
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<RawMessage<ClawChatEnvelope> | null> {
    const { chatId } = this.decodeThreadId(threadId);
    const messageId = newMessageId();
    await this.sendFrame(buildStreamCreatedFrame({ chatId, messageId }), { waitForAck: false });

    let sequence = 0;
    let text = "";
    try {
      for await (const chunk of textStream) {
        const delta = streamChunkToText(chunk);
        if (!delta) {
          continue;
        }
        text += delta;
        await this.sendFrame(buildStreamAddFrame({ chatId, messageId, sequence, text, delta }), {
          waitForAck: false,
        });
        sequence += 1;
      }
      const done = buildStreamDoneFrame({
        chatId,
        messageId,
        sequence: Math.max(sequence - 1, 0),
        text,
      });
      await this.sendFrame(done, { waitForAck: false });
      return { id: messageId, raw: done, threadId };
    } catch (error) {
      const failed = buildStreamDoneFrame({
        chatId,
        messageId,
        sequence: Math.max(sequence - 1, 0),
        text,
        failed: true,
      });
      await this.sendFrame(failed, { waitForAck: false }).catch(() => undefined);
      throw error;
    }
  }

  private async handleSocketData(data: WebSocket.RawData): Promise<void> {
    const text = data.toString("utf8");
    const frame = decodeFrame(text);
    await this.handleFrame(frame);
  }

  private async handleFrame(frame: ClawChatEnvelope): Promise<void> {
    if (frame.event === "connect.challenge") {
      const nonce = extractFrameNonce(frame);
      if (!nonce) {
        throw new ValidationError("clawchat", "ClawChat connect.challenge is missing nonce");
      }
      await this.sendRawFrame(
        buildConnectFrame({
          token: this.config.token,
          nonce,
          deviceId: this.config.deviceId,
          capabilities: this.config.capabilities ?? {},
        }),
      );
      return;
    }

    if (frame.event === "hello-ok") {
      this.state = "ready";
      this.connectDeferred?.resolve(undefined);
      this.connectDeferred = null;
      this.logger.info("ClawChat WebSocket ready");
      return;
    }

    if (frame.event === "hello-fail") {
      const reason = isRecord(frame.payload) ? stringValue(frame.payload.reason) : undefined;
      const error = new NetworkError(
        "clawchat",
        `ClawChat handshake failed: ${reason ?? "unknown"}`,
      );
      this.connectDeferred?.reject(error);
      this.connectDeferred = null;
      this.socket?.close();
      return;
    }

    if (frame.event === "ping") {
      await this.sendRawFrame(buildPongFrame(frame));
      return;
    }

    if (frame.event === "message.ack" || frame.event === "message.error") {
      this.resolveAck(frame);
      return;
    }

    if (
      frame.event === "message.send" ||
      frame.event === "message.reply" ||
      frame.event === "message.done"
    ) {
      this.processInboundMessage(frame);
      return;
    }

    if (frame.event === "message.created" || frame.event === "message.add") {
      return;
    }

    this.logger.debug("Ignoring unsupported ClawChat frame", { event: frame.event });
  }

  private processInboundMessage(frame: ClawChatEnvelope): void {
    const sender = isRecord(frame.sender) ? frame.sender : undefined;
    if (sender?.id === this.config.userId) {
      this.logger.debug("Dropped ClawChat self-echo", {
        chatId: frame.chat_id,
        traceId: frame.trace_id,
      });
      return;
    }
    if (!this.chat || !frame.chat_id) {
      return;
    }
    const chatType = normalizeChatType(frame.chat_type);
    if (chatType) {
      this.knownChatTypes.set(frame.chat_id, chatType);
    }
    const threadId = this.encodeThreadId({ chatId: frame.chat_id });
    void this.chat
      .processMessage(this, threadId, async () => this.parseMessage(frame))
      .catch((error) => {
        this.logger.error("ClawChat message dispatch failed", error);
      });
  }

  private async sendFrame(
    frame: ClawChatEnvelope,
    options: { waitForAck: boolean },
  ): Promise<ClawChatEnvelope | undefined> {
    if (this.state !== "ready") {
      await this.connect();
    }

    const traceId = frame.trace_id;
    const ackPromise = options.waitForAck && traceId ? this.waitForAck(traceId) : undefined;
    try {
      await this.sendRawFrame(frame);
    } catch (error) {
      if (traceId) {
        this.clearPendingAck(traceId);
      }
      throw error;
    }
    return ackPromise;
  }

  private async sendRawFrame(frame: ClawChatEnvelope): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new NetworkError("clawchat", "ClawChat WebSocket is not open");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(encodeFrame(frame), (error) => {
        if (error) {
          reject(new NetworkError("clawchat", "Failed to send ClawChat frame", error));
          return;
        }
        resolve();
      });
    });
  }

  private waitForAck(traceId: string): Promise<ClawChatEnvelope> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(traceId);
        reject(
          new NetworkError("clawchat", `Timed out waiting for ClawChat message.ack: ${traceId}`),
        );
      }, this.config.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
      this.pendingAcks.set(traceId, { resolve, reject, timeout });
    });
  }

  private resolveAck(frame: ClawChatEnvelope): void {
    const traceId = frame.trace_id;
    if (!traceId) {
      return;
    }
    const pending = this.clearPendingAck(traceId);
    if (!pending) {
      return;
    }
    if (frame.event === "message.error") {
      const message = isRecord(frame.payload) ? stringValue(frame.payload.message) : undefined;
      pending.reject(new NetworkError("clawchat", message ?? "ClawChat rejected message"));
      return;
    }
    pending.resolve(frame);
  }

  private clearPendingAck(traceId: string): PendingAck | undefined {
    const pending = this.pendingAcks.get(traceId);
    if (!pending) {
      return undefined;
    }
    clearTimeout(pending.timeout);
    this.pendingAcks.delete(traceId);
    return pending;
  }

  private rejectAllAcks(error: Error): void {
    for (const [traceId, pending] of this.pendingAcks) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingAcks.delete(traceId);
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      delay * 2,
      this.config.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        this.logger.warn("ClawChat reconnect failed", error);
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async buildFragments(message: AdapterPostableMessage): Promise<ClawChatFragment[]> {
    const fragments: ClawChatFragment[] = [];
    const text = this.converter.renderPostable(message).trim();
    if (text) {
      fragments.push({ kind: "text", text });
    }

    for (const attachment of extractPostableAttachments(message)) {
      const fragment = attachmentToFragment(attachment);
      if (fragment) {
        fragments.push(fragment);
      }
    }

    for (const file of extractFiles(message)) {
      fragments.push(await this.uploadFile(file));
    }

    if (fragments.length === 0) {
      fragments.push({ kind: "text", text: "" });
    }
    return fragments;
  }

  private async uploadFile(file: {
    data: unknown;
    filename: string;
    mimeType?: string;
  }): Promise<ClawChatFragment> {
    const buffer = await toBuffer(file.data, { platform: "clawchat" as never });
    if (!buffer) {
      throw new ValidationError("clawchat", `Unsupported file data for ${file.filename}`);
    }
    const mimeType = file.mimeType ?? "application/octet-stream";
    const body = new FormData();
    body.append(
      "file",
      new Blob([buffer as unknown as BlobPart], { type: mimeType }),
      file.filename,
    );

    const response = await fetch(this.mediaUploadUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.token}` },
      body,
    });
    if (!response.ok) {
      throw new NetworkError(
        "clawchat",
        `ClawChat media upload failed with HTTP ${response.status}`,
      );
    }

    const json = (await response.json()) as unknown;
    const result = unwrapMediaUploadResult(json);
    if (!result.url) {
      throw new NetworkError("clawchat", "ClawChat media upload response did not include a URL");
    }

    return {
      kind: mediaKind(result.kind, result.mime ?? mimeType),
      url: result.url,
      name: result.name ?? file.filename,
      mime: result.mime ?? mimeType,
      size: result.size,
      width: result.width,
      height: result.height,
      duration: result.duration,
    } as ClawChatFragment;
  }

  private mediaUploadUrl(): string {
    if (this.config.mediaUploadUrl) {
      return this.config.mediaUploadUrl;
    }
    const baseUrl = this.config.baseUrl?.replace(/\/+$/, "") ?? "https://app.clawling.com";
    return `${baseUrl}/media/upload`;
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeSegment(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch (error) {
    throw new ValidationError("clawchat", `Invalid ClawChat thread segment: ${String(error)}`);
  }
}

function normalizeChatType(value: unknown): ClawChatChatType | undefined {
  return value === "direct" || value === "group" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function extractFrameNonce(frame: ClawChatEnvelope): string | null {
  const payload = isRecord(frame.payload) ? frame.payload : undefined;
  if (typeof payload?.nonce === "string") {
    return payload.nonce;
  }
  const data = isRecord(payload?.data) ? payload.data : undefined;
  return typeof data?.nonce === "string" ? data.nonce : null;
}

function extractFragments(
  payload: ClawChatMessagePayload & Record<string, unknown>,
): ClawChatFragment[] {
  if (Array.isArray(payload.fragments)) {
    return payload.fragments.filter(isFragmentLike) as ClawChatFragment[];
  }
  const body = payload.message?.body;
  if (Array.isArray(body?.fragments)) {
    return body.fragments.filter(isFragmentLike);
  }
  return [];
}

function isFragmentLike(value: unknown): value is ClawChatFragment {
  return isRecord(value) && typeof value.kind === "string";
}

function fragmentsToText(fragments: ClawChatFragment[]): string {
  const parts: string[] = [];
  let inline = "";
  const flushInline = () => {
    if (inline) {
      parts.push(inline);
      inline = "";
    }
  };

  for (const fragment of fragments) {
    if (fragment.kind === "text") {
      inline += fragment.text;
      continue;
    }
    if (fragment.kind === "mention") {
      inline += `@${fragment.display ?? fragment.user_id ?? "unknown"}`;
      continue;
    }
    flushInline();
    parts.push(
      fragment.kind === "image"
        ? `![${fragment.name ?? fragment.url}](${fragment.url})`
        : `[${fragment.name ?? fragment.url}](${fragment.url})`,
    );
  }

  flushInline();
  return parts.join("\n");
}

function fragmentsToAttachments(fragments: ClawChatFragment[]): Attachment[] {
  return fragments.flatMap((fragment) => {
    if (!isMediaFragment(fragment)) {
      return [];
    }
    return [
      {
        type: fragment.kind,
        url: fragment.url,
        name: fragment.name,
        mimeType: fragment.mime,
        size: fragment.size,
        width: "width" in fragment ? fragment.width : undefined,
        height: "height" in fragment ? fragment.height : undefined,
      } satisfies Attachment,
    ];
  });
}

function isMediaFragment(
  fragment: ClawChatFragment,
): fragment is Extract<ClawChatFragment, { kind: "image" | "file" | "audio" | "video" }> {
  return (
    fragment.kind === "image" ||
    fragment.kind === "file" ||
    fragment.kind === "audio" ||
    fragment.kind === "video"
  );
}

function mentionsUser(payload: ClawChatMessagePayload, userId: string): boolean {
  const context = payload.message?.context;
  const mentions = context?.mentions ?? [];
  for (const mention of mentions) {
    if (typeof mention === "string" && mention === userId) {
      return true;
    }
    if (isRecord(mention)) {
      const id = mention.user_id ?? mention.userId ?? mention.id;
      if (id === userId) {
        return true;
      }
    }
  }
  for (const fragment of extractFragments(
    payload as ClawChatMessagePayload & Record<string, unknown>,
  )) {
    if (fragment.kind === "mention" && fragment.user_id === userId) {
      return true;
    }
  }
  return false;
}

function attachmentToFragment(attachment: Attachment): ClawChatFragment | null {
  if (!attachment.url) {
    return null;
  }
  return {
    kind: mediaKind(attachment.type, attachment.mimeType),
    url: attachment.url,
    name: attachment.name,
    mime: attachment.mimeType,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
  } as ClawChatFragment;
}

function mediaKind(kind: unknown, mimeType?: string): "image" | "file" | "audio" | "video" {
  if (kind === "image" || kind === "file" || kind === "audio" || kind === "video") {
    return kind;
  }
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType?.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType?.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function unwrapMediaUploadResult(value: unknown): ClawChatMediaUploadResult {
  if (!isRecord(value)) {
    return {};
  }
  if (isRecord(value.data)) {
    return value.data as ClawChatMediaUploadResult;
  }
  if (isRecord(value.payload)) {
    return value.payload as ClawChatMediaUploadResult;
  }
  return value as ClawChatMediaUploadResult;
}

function streamChunkToText(chunk: string | StreamChunk): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk.type === "markdown_text") {
    return chunk.text;
  }
  return "";
}
