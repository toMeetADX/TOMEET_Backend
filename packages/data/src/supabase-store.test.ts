import { llmJobSchema } from "@tomeet/contracts";
import { describe, expect, it, vi } from "vitest";
import { SupabaseStore } from "./supabase-store.js";

const userId = "cc998b7e-1c59-45d6-b0eb-09ffb6230e96";
const updatedAt = "2026-07-24T09:52:32.91018+00:00";

function userRow(identity: Record<string, unknown>) {
  return {
    vibe_narrative: "",
    long_term_profile: {},
    current_intent: {},
    social_history: [],
    feedback_memory: [],
    multimodal_understanding: {},
    user_model_version: 0,
    user_model_updated_at: updatedAt,
    ...identity
  };
}

function mockUserRead(store: SupabaseStore, row: Record<string, unknown>) {
  const single = vi.fn().mockResolvedValue({ data: row, error: null });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  Object.defineProperty(store, "client", {
    value: { from: vi.fn().mockReturnValue({ select }) }
  });
  vi.spyOn(store, "ensureUser").mockResolvedValue(undefined);
}

describe("SupabaseStore timestamp mapping", () => {
  it("normalizes PostgreSQL offset timestamps before contract validation", async () => {
    const store = new SupabaseStore("https://example.supabase.co", "test-service-role-key");
    Object.defineProperty(store, "client", {
      value: {
        rpc: vi.fn().mockResolvedValue({
          data: {
            id: "f86efec3-a247-47f9-9f20-fdcac7856f67",
            user_id: "cc998b7e-1c59-45d6-b0eb-09ffb6230e96",
            role: "user",
            content: "hello",
            created_at: "2026-07-24T09:52:32.91018+00:00"
          },
          error: null
        })
      }
    });

    const message = await store.appendMessage({
      userId: "cc998b7e-1c59-45d6-b0eb-09ffb6230e96",
      role: "user",
      content: "hello"
    });

    expect(message.createdAt).toBe("2026-07-24T09:52:32.910Z");
  });

  it("normalizes memory profile source watermark offset timestamps", async () => {
    const store = new SupabaseStore("https://example.supabase.co", "test-service-role-key");
    const single = vi.fn().mockResolvedValue({
      data: {
        user_id: userId,
        profile_narrative: "",
        matching_narrative: "",
        source_memory_ids: [],
        source_watermark: "2026-07-25 11:54:19.205+00",
        version: 3,
        stale: false,
        updated_at: updatedAt
      },
      error: null
    });
    const eq = vi.fn().mockReturnValue({ single });
    const select = vi.fn().mockReturnValue({ eq });
    Object.defineProperty(store, "client", {
      value: {
        from: vi.fn().mockReturnValue({ select }),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null })
      }
    });
    vi.spyOn(store, "ensureUser").mockResolvedValue(undefined);

    const profile = await store.getMemoryProfile(userId);

    expect(profile.sourceWatermark).toBe("2026-07-25T11:54:19.205Z");
    expect(profile.updatedAt).toBe("2026-07-24T09:52:32.910Z");
  });
});

describe("SupabaseStore user model mapping", () => {
  it("maps users.id while processing the complete agent_reply payload shape", async () => {
    const store = new SupabaseStore("https://example.supabase.co", "test-service-role-key");
    const job = llmJobSchema.parse({
      id: "041816cf-8e1d-4ca7-b7ae-6a04eb923896",
      type: "agent_reply",
      status: "processing",
      payload: {
        connectionId: "ab1816cf-8e1d-4ca7-b7ae-6a04eb923896",
        content: "hello",
        generationToken: "generation-token",
        sourceChannel: "wechat",
        userId,
        userMessageId: "bb1816cf-8e1d-4ca7-b7ae-6a04eb923896"
      },
      result: null,
      error: null,
      attempts: 1,
      maxAttempts: 3,
      partitionKey: `user:${userId}`,
      runAt: "2026-07-25T10:28:52.185Z",
      createdAt: "2026-07-25T10:28:52.185Z",
      updatedAt: "2026-07-25T10:28:52.185Z"
    });
    mockUserRead(store, userRow({
      id: userId,
      user_id: "00000000-0000-4000-8000-000000000001"
    }));

    const model = await store.getUserModel(job.payload.userId as string);

    expect(model.userId).toBe(userId);
    expect(model.updatedAt).toBe("2026-07-24T09:52:32.910Z");
  });

  it("maps a users.id row returned after saving a user model", async () => {
    const store = new SupabaseStore("https://example.supabase.co", "test-service-role-key");
    const maybeSingle = vi.fn().mockResolvedValue({
      data: userRow({ id: userId, user_model_version: 1 }),
      error: null
    });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const versionEq = vi.fn().mockReturnValue({ select });
    const idEq = vi.fn().mockReturnValue({ eq: versionEq });
    const update = vi.fn().mockReturnValue({ eq: idEq });
    Object.defineProperty(store, "client", {
      value: { from: vi.fn().mockReturnValue({ update }) }
    });

    const model = await store.saveUserModel({
      userId,
      vibeNarrative: "",
      longTermProfile: {},
      currentIntent: {},
      socialHistory: [],
      feedbackMemory: [],
      multimodalUnderstanding: {},
      version: 1,
      updatedAt: "2026-07-24T09:52:32.910Z"
    }, 0);

    expect(model.userId).toBe(userId);
    expect(model.version).toBe(1);
  });

  it.each([
    ["snake_case", { user_id: userId }],
    ["camelCase", { userId }]
  ])("keeps compatibility with %s user id rows", async (_name, identity) => {
    const store = new SupabaseStore("https://example.supabase.co", "test-service-role-key");
    mockUserRead(store, userRow(identity));

    await expect(store.getUserModel(userId)).resolves.toMatchObject({ userId });
  });
});
