import { ValidationError } from "@chat-adapter/shared";
import { ConsoleLogger, type Logger } from "chat";

import { ClawChatAdapter } from "./adapter";
import { CLAWCHAT_WEBSOCKET_URL, DEFAULT_BASE_URL } from "./protocol";
import type { ClawChatAdapterConfig } from "./types";

export type CreateClawChatAdapterConfig = Partial<ClawChatAdapterConfig> & {
  logger?: Logger;
};

export function createClawChatAdapter(config: CreateClawChatAdapterConfig = {}): ClawChatAdapter {
  const baseUrl = stripTrailingSlash(
    config.baseUrl ?? env("CLAWCHAT_BASE_URL") ?? DEFAULT_BASE_URL,
  );
  const websocketUrl =
    config.websocketUrl ??
    env("CLAWCHAT_WEBSOCKET_URL") ??
    env("CLAWCHAT_WS_URL") ??
    CLAWCHAT_WEBSOCKET_URL;
  const mediaUploadUrl =
    config.mediaUploadUrl ?? env("CLAWCHAT_MEDIA_UPLOAD_URL") ?? `${baseUrl}/media/upload`;
  const token = config.token ?? env("CLAWCHAT_TOKEN");
  const userId = config.userId ?? env("CLAWCHAT_USER_ID");

  if (!websocketUrl) {
    throw new ValidationError(
      "clawchat",
      "ClawChat websocket URL is required. Pass websocketUrl or set CLAWCHAT_WEBSOCKET_URL.",
    );
  }
  if (!token) {
    throw new ValidationError(
      "clawchat",
      "ClawChat bearer token is required. Pass token or set CLAWCHAT_TOKEN.",
    );
  }
  if (!userId) {
    throw new ValidationError(
      "clawchat",
      "ClawChat user id is required for self-echo filtering. Pass userId or set CLAWCHAT_USER_ID.",
    );
  }

  return new ClawChatAdapter({
    ...config,
    baseUrl,
    websocketUrl,
    mediaUploadUrl,
    token,
    userId,
    deviceId: config.deviceId ?? env("CLAWCHAT_DEVICE_ID"),
    userName: config.userName ?? env("CLAWCHAT_BOT_USERNAME") ?? "clawchat-bot",
    logger: config.logger ?? new ConsoleLogger("info", "clawchat"),
  });
}

function env(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
