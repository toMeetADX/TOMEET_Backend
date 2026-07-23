import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Spectrum } from "@spectrum-ts/core";
import type { Message, Space } from "@spectrum-ts/core";
import { config as loadDotEnv } from "dotenv";
import { wechat } from "photon-wechat-sdk";
import { loadWeChatGatewayConfig } from "./config.js";
import { KeyedSerialExecutor } from "./keyed-executor.js";
import { TomeetApiClient } from "./tomeet-client.js";

loadDotEnv({ path: resolve(process.cwd(), ".env") });
loadDotEnv({ path: resolve(process.cwd(), "../../.env"), override: false });

const config = loadWeChatGatewayConfig();
const tomeet = new TomeetApiClient({
  baseUrl: config.tomeetApiUrl,
  internalApiToken: config.tomeetInternalApiToken
});
const spectrum = await Spectrum({
  providers: [
    wechat.config({
      baseUrl: config.agentWechatUrl,
      token: config.agentWechatToken,
      pollIntervalMs: config.pollIntervalMs,
      sendPacingMs: config.sendPacingMs,
      groups: config.groups,
      waitForLogin: true,
      logQr: true
    })
  ]
});
const executor = new KeyedSerialExecutor();
const activeTasks = new Set<Promise<void>>();

type WeChatMessage = Message & {
  senderName?: string;
  isSelf?: boolean;
  chatType?: "dm" | "group";
};

function identityFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function handleMessage(
  space: Space,
  message: WeChatMessage
): Promise<void> {
  if (
    message.direction !== "inbound" ||
    message.isSelf ||
    message.content.type !== "text" ||
    !message.sender?.id
  ) {
    return;
  }

  const externalUserId = message.sender.id;
  const fingerprint = identityFingerprint(externalUserId);
  const identity = await tomeet.resolveWeChatIdentity(externalUserId);
  if (!identity) {
    await space.send(
      "你的微信尚未绑定 TOMEET 账号。请先在 TOMEET Web 端生成绑定码，然后在这里发送“绑定 + 空格 + 绑定码”。"
    );
    console.info(
      JSON.stringify({ level: "info", event: "wechat_identity_unlinked", user: fingerprint })
    );
    return;
  }

  const reply = await tomeet.sendText({
    identity,
    displayName: message.senderName ?? identity.displayName ?? "微信用户",
    content: message.content.text,
    channelMessageId: message.id
  });
  await space.send(reply);
  console.info(
    JSON.stringify({
      level: "info",
      event: "wechat_message_completed",
      user: fingerprint,
      chatType: message.chatType ?? "unknown"
    })
  );
}

console.info(
  JSON.stringify({
    level: "info",
    event: "wechat_gateway_started",
    groups: config.groups,
    pollIntervalMs: config.pollIntervalMs
  })
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void spectrum.stop().finally(() => process.exit(0));
  });
}

for await (const [space, message] of spectrum.messages) {
  const senderId = message.sender?.id;
  if (!senderId) continue;
  const task = executor
    .run(senderId, () => handleMessage(space, message))
    .catch(async (error) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "wechat_message_failed",
          user: identityFingerprint(senderId),
          error: error instanceof Error ? error.message : String(error)
        })
      );
      await space.send("TOMEET 暂时无法回复，请稍后再试。").catch(() => undefined);
    });
  activeTasks.add(task);
  void task.finally(() => activeTasks.delete(task));
}

await Promise.allSettled(activeTasks);
