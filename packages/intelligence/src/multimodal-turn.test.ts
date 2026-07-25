import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MockAgentIntelligence } from "@tomeet/agent-core";
import { MemoryStore } from "@tomeet/data";
import { MockMatchmakingIntelligence } from "@tomeet/matchmaking";
import { JobProcessor } from "./index.js";

async function enqueueImageTurn(store: MemoryStore, userId: string) {
  const storagePath = `${userId}/${randomUUID()}.jpg`;
  await store.uploadFile(storagePath, "image/jpeg", new Uint8Array([1, 2, 3]));
  const inputId = await store.saveMultimodalInput({
    userId,
    kind: "image",
    storagePath,
    mimeType: "image/jpeg",
    sizeBytes: 3
  });
  await store.appendMessage({ userId, role: "user", content: "[发送了一张图片]" });
  return store.enqueueJob({
    type: "multimodal_understanding",
    payload: {
      userId,
      kind: "image",
      inputIds: [inputId],
      storagePaths: [storagePath],
      mimeTypes: ["image/jpeg"],
      sourceChannel: "wechat"
    },
    idempotencyKey: `multimodal:${inputId}`,
    partitionKey: `user:${userId}`
  });
}

describe("image turns run through the single Agent persona", () => {
  it("publishes a question about the user instead of the vision model's own words", async () => {
    const store = new MemoryStore();
    const processor = new JobProcessor(store, new MockAgentIntelligence(), new MockMatchmakingIntelligence(), {
      adventurexMatchingV1: true
    });
    const userId = randomUUID();
    await store.ensureUser(userId, "现场用户");

    const job = await enqueueImageTurn(store, userId);
    const result = await processor.process(job);

    const published = (result.message as { content: string }).content;
    expect(published).toBe("这件事你是去看的，还是自己上手做的？");
    expect(published).not.toContain("图片");

    const messages = await store.listRecentMessages(userId, 10);
    expect(messages.at(-1)?.role).toBe("assistant");
    expect(messages.at(-1)?.content).toBe(published);
  });

  it("keeps image observations out of matchable social hooks and out of the onboarding shortcut", async () => {
    const store = new MemoryStore();
    const processor = new JobProcessor(store, new MockAgentIntelligence(), new MockMatchmakingIntelligence(), {
      adventurexMatchingV1: true
    });
    const userId = randomUUID();
    await store.ensureUser(userId, "现场用户");

    const result = await processor.process(await enqueueImageTurn(store, userId));

    expect(result.savedSocialHookCount).toBe(0);
    expect(await store.listActiveSocialHooks(userId, 10)).toEqual([]);
    expect((await store.ensureAdventurexOnboardingState(userId)).stage).toBe("exploring");
  });
});
