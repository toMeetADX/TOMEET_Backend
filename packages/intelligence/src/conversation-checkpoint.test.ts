import { randomUUID } from "node:crypto";
import { MockAgentIntelligence } from "@tomeet/agent-core";
import { MemoryStore } from "@tomeet/data";
import { MockMatchmakingIntelligence } from "@tomeet/matchmaking";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobProcessor } from "./index.js";

describe("conversation checkpoint maintenance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not block an Agent reply while an overdue conversation summary is still running", async () => {
    const store = new MemoryStore();
    const agent = new MockAgentIntelligence();
    const processor = new JobProcessor(store, agent, new MockMatchmakingIntelligence());
    const userId = randomUUID();
    await store.ensureUser(userId, "长对话用户");
    for (let index = 0; index < 16; index += 1) {
      await store.appendMessage({
        userId,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `历史消息 ${index + 1}`
      });
    }
    const userMessage = await store.appendMessage({
      userId,
      role: "user",
      content: "都是"
    });

    let rejectSummary!: (error: Error) => void;
    const summaryStarted = new Promise<void>((resolve) => {
      vi.spyOn(agent, "summarizeConversation").mockImplementation(() => {
        resolve();
        return new Promise<string>((_resolve, reject) => {
          rejectSummary = reject;
        });
      });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await store.enqueueJob({
      type: "agent_reply",
      payload: {
        userId,
        content: userMessage.content,
        userMessageId: userMessage.id,
        sourceChannel: "wechat"
      },
      idempotencyKey: `checkpoint-nonblocking:${userMessage.id}`,
      partitionKey: `user:${userId}`
    });

    const result = await Promise.race([
      processor.process(job),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Agent reply waited for conversation summary")), 500);
      })
    ]);

    expect(result.message).toMatchObject({ role: "assistant" });
    await summaryStarted;
    rejectSummary(new Error("LLM 未返回内容"));
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("conversation_summary_deferred"));
    });
    expect(await store.getConversationState(userId)).toMatchObject({
      rollingSummary: "",
      summarizedMessageCount: 0
    });
  });
});
