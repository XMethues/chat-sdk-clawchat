import { describe, expect, it } from "vitest";

import { ClawChatAdapter } from "./adapter";
import type { ClawChatEnvelope } from "./types";

function adapter(): ClawChatAdapter {
  return new ClawChatAdapter({
    autoConnect: false,
    token: "token",
    userId: "usr_bot",
    websocketUrl: "wss://example.test/ws",
  });
}

describe("ClawChatAdapter thread IDs", () => {
  it("roundtrips chat thread ids", () => {
    const subject = adapter();
    const encoded = subject.encodeThreadId({ chatId: "cnv_123" });

    expect(encoded).toMatch(/^clawchat:/);
    expect(subject.decodeThreadId(encoded)).toEqual({ chatId: "cnv_123", messageId: undefined });
  });

  it("roundtrips reply-capable thread ids", () => {
    const subject = adapter();
    const encoded = subject.encodeThreadId({ chatId: "cnv_123", messageId: "msg-abc:with:colon" });

    expect(subject.decodeThreadId(encoded)).toEqual({
      chatId: "cnv_123",
      messageId: "msg-abc:with:colon",
    });
  });

  it("rejects invalid ids", () => {
    const subject = adapter();
    expect(() => subject.decodeThreadId("slack:C123:1")).toThrow("Invalid ClawChat");
  });
});

describe("ClawChatAdapter parseMessage", () => {
  it("parses text and mention fragments", () => {
    const subject = adapter();
    const raw: ClawChatEnvelope = {
      version: "2",
      event: "message.send",
      trace_id: "trace-1",
      emitted_at: 1_700_000_000_000,
      chat_id: "cnv_123",
      chat_type: "group",
      sender: { id: "usr_alice", nick_name: "Alice", type: "direct" },
      payload: {
        message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
        message: {
          body: {
            fragments: [
              { kind: "text", text: "hello " },
              { kind: "mention", user_id: "usr_bot", display: "Bot" },
            ],
          },
          context: { mentions: [{ user_id: "usr_bot", display: "Bot" }], reply: null },
        },
      },
    };

    const message = subject.parseMessage(raw);

    expect(message.id).toBe("msg-01HVB6S7K8L9M0N1P2Q3R4S5T6");
    expect(message.text).toBe("hello @Bot");
    expect(message.isMention).toBe(true);
    expect(message.author.userId).toBe("usr_alice");
    expect(message.author.isMe).toBe(false);
    expect(subject.isDM(message.threadId)).toBe(false);
  });

  it("extracts media fragments as attachments", () => {
    const subject = adapter();
    const raw: ClawChatEnvelope = {
      event: "message.send",
      chat_id: "cnv_123",
      chat_type: "direct",
      sender: { id: "usr_alice", nick_name: "Alice" },
      payload: {
        message_id: "msg-media",
        message: {
          body: {
            fragments: [
              {
                kind: "image",
                url: "https://cdn.example/img.png",
                name: "img.png",
                mime: "image/png",
              },
            ],
          },
          context: { mentions: [], reply: null },
        },
      },
    };

    const message = subject.parseMessage(raw);

    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]?.type).toBe("image");
    expect(message.text).toContain("https://cdn.example/img.png");
    expect(subject.isDM(message.threadId)).toBe(true);
  });
});
