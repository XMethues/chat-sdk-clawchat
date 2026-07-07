# @clawling/chat-sdk-clawchat

ClawChat Protocol v2 adapter for [Chat SDK](https://chat-sdk.dev/).

## Install

```bash
npm install chat @clawling/chat-sdk-clawchat @chat-adapter/state-memory
```

## Usage

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createClawChatAdapter } from "@clawling/chat-sdk-clawchat";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    clawchat: createClawChatAdapter(),
  },
  state: createMemoryState(),
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});

bot.onNewMention(async (thread) => {
  await thread.subscribe();
  await thread.post("I'm listening to this ClawChat conversation now.");
});

await bot.initialize(); // opens the ClawChat WebSocket
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `CLAWCHAT_TOKEN` | Yes | Opaque bearer token for the ClawChat WebSocket and media upload API. |
| `CLAWCHAT_USER_ID` | Yes | Bot/runtime ClawChat user id, used to drop self-echoes. |
| `CLAWCHAT_WEBSOCKET_URL` / `CLAWCHAT_WS_URL` | No | Overrides the exported `CLAWCHAT_WEBSOCKET_URL` default, currently the Hermes plugin default `wss://app.clawling.com/ws`. |
| `CLAWCHAT_BASE_URL` | No | Defaults to `https://app.clawling.com`. |
| `CLAWCHAT_MEDIA_UPLOAD_URL` | No | Defaults to `${CLAWCHAT_BASE_URL}/media/upload`. |
| `CLAWCHAT_DEVICE_ID` | Recommended | Stable device id for ClawChat replay cursors. |
| `CLAWCHAT_BOT_USERNAME` | No | Mention/display username. Defaults to `clawchat-bot`. |

## Transport

ClawChat uses an outbound WebSocket (`/ws`), not HTTP webhooks. `handleWebhook()` intentionally returns HTTP 501. Run this adapter in a long-running process and call `bot.initialize()` during startup.

## Implemented

- Protocol v2 challenge/response handshake
- Incoming `message.send`, `message.reply`, and completed `message.done` dispatch into Chat SDK
- Self-echo filtering by `CLAWCHAT_USER_ID`
- `message.send` / `message.reply` posting with `message.ack` correlation
- Typing updates
- Native ClawChat streaming (`message.created` → `message.add` → `message.done`)
- Media upload to `/media/upload` for Chat SDK file uploads
- Markdown/AST/card fallback rendering into text fragments

## Limitations

ClawChat Protocol v2 does not currently expose edit, delete, or reaction operations, so the corresponding Chat SDK adapter methods throw `NotImplementedError`. Conversation history is expected to be persisted through the Chat SDK state adapter (`persistThreadHistory = true`).
