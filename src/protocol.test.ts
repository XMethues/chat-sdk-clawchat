import { describe, expect, it } from "vitest";

import {
  buildConnectFrame,
  buildMessageSendFrame,
  buildStreamAddFrame,
  buildStreamDoneFrame,
  DEFAULT_CAPABILITIES,
  newMessageId,
} from "./protocol";

describe("protocol helpers", () => {
  it("generates protocol-compatible message ids", () => {
    expect(newMessageId()).toMatch(/^msg-[0-9A-HJ-NP-TV-Z]{26}$/);
  });

  it("builds connect frames with default capabilities", () => {
    const frame = buildConnectFrame({ token: "token", nonce: "nonce", capabilities: {} });

    expect(frame.event).toBe("connect");
    expect(frame.payload).toMatchObject({
      token: "token",
      nonce: "nonce",
      capabilities: DEFAULT_CAPABILITIES,
    });
  });

  it("builds materialized message frames", () => {
    const frame = buildMessageSendFrame({
      chatId: "cnv_123",
      messageId: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
      fragments: [{ kind: "text", text: "hello" }],
    });

    expect(frame.event).toBe("message.send");
    expect(frame.chat_id).toBe("cnv_123");
    expect(frame.payload?.message_id).toBe("msg-01HVB6S7K8L9M0N1P2Q3R4S5T6");
  });

  it("builds streaming add/done frames", () => {
    const add = buildStreamAddFrame({
      chatId: "cnv_123",
      messageId: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
      sequence: 0,
      text: "hello",
      delta: "hello",
    });
    const done = buildStreamDoneFrame({
      chatId: "cnv_123",
      messageId: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
      sequence: 0,
      text: "hello",
    });

    expect(add.event).toBe("message.add");
    expect(done.event).toBe("message.done");
  });
});
