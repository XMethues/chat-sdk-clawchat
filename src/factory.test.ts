import { afterEach, describe, expect, it } from "vitest";

import { createClawChatAdapter } from "./factory";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("createClawChatAdapter", () => {
  it("creates an adapter from explicit config", () => {
    const adapter = createClawChatAdapter({
      autoConnect: false,
      token: "token",
      userId: "usr_bot",
      websocketUrl: "wss://example.test/ws",
    });

    expect(adapter.name).toBe("clawchat");
    expect(adapter.userName).toBe("clawchat-bot");
    expect(adapter.botUserId).toBe("usr_bot");
  });

  it("reads environment variables as fallback", () => {
    process.env.CLAWCHAT_TOKEN = "token";
    process.env.CLAWCHAT_USER_ID = "usr_bot";
    process.env.CLAWCHAT_WEBSOCKET_URL = "wss://example.test/ws";
    process.env.CLAWCHAT_BOT_USERNAME = "bot";

    const adapter = createClawChatAdapter({ autoConnect: false });

    expect(adapter.userName).toBe("bot");
    expect(adapter.botUserId).toBe("usr_bot");
  });

  it("throws when token is missing", () => {
    expect(() =>
      createClawChatAdapter({
        autoConnect: false,
        userId: "usr_bot",
        websocketUrl: "wss://example.test/ws",
      }),
    ).toThrow("bearer token");
  });

  it("throws when user id is missing", () => {
    expect(() =>
      createClawChatAdapter({
        autoConnect: false,
        token: "token",
        websocketUrl: "wss://example.test/ws",
      }),
    ).toThrow("user id");
  });
});
